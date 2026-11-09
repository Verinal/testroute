// 动态安全探测执行器（内置零依赖）：按盘点的 API 端点面对运行中服务做全量黑盒安全探测，
// 让"安全测试普及到每个端点"成为默认行为，而不是 LLM 自觉。
// 探测集：未认证访问 / 伪造凭据 / NoSQL·SQL 注入（登录类端点）/ 错误信息泄漏（畸形输入）/
// 安全响应头 / CORS 反射 / 限流防刷。每端点每类探测一条用例，失败 = 疑似安全发现，交 triage 归因划级。
// 约束：只对 route.project.root 指向的服务或 config.baseUrl 显式给出的地址发包（授权边界由路线批准把关）。
import fs from 'node:fs';
import { summarizeCases } from '../result.js';
import { truncate } from '../validate.js';
import { loadApiSurface, normalizeEndpoint } from '../apimap.js';

const PER_REQUEST_TIMEOUT_MS = 12000;
const MAX_TOTAL_REQUESTS = 800;
const DISCLOSURE_MAX_ENDPOINTS = 100;

// 幂等/会话类端点：未认证调用返回 2xx 属常见设计（登出刷新令牌），不做未认证/伪造探测（避免误报）
const IDEMPOTENT_AUTH_RE = /\/(logout|signout|refresh|revoke)(\/|$)/i;
// 登录/注册类端点：注入与限流探测的目标
const AUTH_ENTRY_RE = /(login|signin|register|signup|auth\/token|session|password)/i;
// 内部信息泄漏特征：堆栈/框架异常细节（普通 4xx JSON 不算）
const LEAK_RE =
  /Traceback \(most recent call last\)|File "[^"]+\.py", line|at .+ \(.+:\d+:\d+\)|node_modules[\\/][\w@.-]+|TypeError:|ReferenceError:|NullPointerException|Exception in thread|pymongo\.errors|pymysql|sqlite3\.|BSONTypeError|MongooseError|SequelizeDatabaseError|stack\s*trace/i;

function fakeIdValue() {
  // 形似 ObjectId 的占位 id：减少「路径参数校验先于鉴权返回 4xx」导致的误判；仍 404/405 时按无法判定跳过
  return '000000000000000000000000';
}

function buildUrl(baseUrl, path) {
  return baseUrl.replace(/\/+$/, '') + path;
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = PER_REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: ac.signal,
      redirect: 'manual',
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, headers: res.headers, text, ms: Date.now() - started };
  } catch (e) {
    const code = e?.cause?.code || e?.name || 'error';
    return { error: code === 'AbortError' ? `超时（>${timeoutMs}ms）` : String(code), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// 判定「鉴权是否拒绝」：401/403 = 拒绝；2xx/3xx = 未拒绝（发现）；404/405 = 无法判定（盘点可能过期）
function authVerdict(status) {
  if (status === 401 || status === 403) return 'pass';
  if (status >= 200 && status < 400) return 'fail';
  return 'skip';
}

function pathHasParam(path) {
  return /\{p\}|\{[^/]+\}|:[\w-]+|<[a-z]+[:>]/i.test(path);
}

function substPathParams(path, value) {
  return path
    .split('/')
    .map((seg) => (pathHasParam('/' + seg) ? value : seg))
    .join('/');
}

// 受保护、可探测的端点（WS/HEAD/OPTIONS/幂等会话端点除外）
function probeableProtected(endpoints) {
  return endpoints.filter(
    (e) =>
      e.auth === 'protected' &&
      e.method !== 'WS' &&
      !['HEAD', 'OPTIONS'].includes(e.method) &&
      !IDEMPOTENT_AUTH_RE.test(e.path)
  );
}

// ---------- 各探测类别的用例生成 ----------

async function probeUnauth(ep, baseUrl, headersBase) {
  const url = buildUrl(baseUrl, substPathParams(normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path, fakeIdValue()));
  const method = ep.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined;
  const res = await request(url, { method, headers: headersBase, body });
  if (res.error) return { status: 'skip', message: `请求失败（${res.error}），无法判定` };
  const v = authVerdict(res.status);
  if (v === 'pass') return { status: 'passed', message: `未认证请求被拒绝（HTTP ${res.status}）` };
  if (v === 'fail')
    return {
      status: 'failed',
      message: `未认证请求返回 HTTP ${res.status}（应 401/403）——疑似缺少鉴权校验。请人工确认响应是否包含真实业务数据：是 → 按 code-bug 划 P0（未授权访问）；仅为空壳/幂等设计 → 说明理由后归因。`,
    };
  return { status: 'skipped', message: `未认证请求得到 HTTP ${res.status}（404/405 无法判定鉴权）：可能是盘点路径过期或方法不允许，如端点真实存在请人工复核` };
}

// 伪造凭据变体：垃圾串 / alg=none 未签名 JWT / 过期 JWT / 字面量 null
function forgedTokenVariants() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    ['垃圾字符串', 'X'.repeat(32)],
    ['alg=none 未签名 JWT', `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'attacker', role: 'admin' })}.`],
    ['过期 JWT', `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'attacker', exp: 1000 })}.${'f'.repeat(43)}`],
    ['字面量 null', 'null'],
  ];
}

async function probeForged(ep, baseUrl, headersBase) {
  const pathPart = normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path;
  const url = buildUrl(baseUrl, substPathParams(pathPart, fakeIdValue()));
  const method = ep.method;
  const body = ['POST', 'PUT', 'PATCH'].includes(method) ? {} : undefined;
  const escaped = [];
  for (const [label, token] of forgedTokenVariants()) {
    const res = await request(url, {
      method,
      headers: { ...headersBase, authorization: `Bearer ${token}` },
      body,
    });
    if (res.error) return { status: 'skipped', message: `请求失败（${res.error}），无法判定` };
    if (authVerdict(res.status) === 'fail') {
      escaped.push(`${label}（HTTP ${res.status}）`);
      break; // 一种逃逸即可定性，减少无谓请求
    }
  }
  if (escaped.length) {
    return {
      status: 'failed',
      message: `伪造凭据被接受：${escaped.join('；')}——JWT 校验缺失或签名/算法/过期未验证。请按 code-bug 划级（伪造管理员身份可达 → P0）。`,
    };
  }
  return { status: 'passed', message: '4 类伪造凭据（垃圾串/alg=none/过期/null）均被拒绝' };
}

const INJECTION_BODIES = [
  ['NoSQL $ne', { username: { $ne: null }, password: { $ne: null } }],
  ['NoSQL $ne (email)', { email: { $ne: null }, password: { $ne: null } }],
  ['NoSQL $gt', { username: { $gt: '' }, password: { $gt: '' } }],
  ['NoSQL $regex', { username: { $regex: '.*' }, password: { $regex: '.*' } }],
  ["SQL 恒真", { username: "' OR '1'='1", password: "' OR '1'='1" }],
  ['SQL 注释', { username: "admin'--", password: 'x' }],
];

async function probeInjection(ep, baseUrl, headersBase) {
  const pathPart = normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path;
  const url = buildUrl(baseUrl, pathPart);
  const escaped = [];
  for (const [label, body] of INJECTION_BODIES) {
    const res = await request(url, {
      method: 'POST',
      headers: { ...headersBase, 'content-type': 'application/json' },
      body,
    });
    if (res.error) break;
    if (res.status >= 200 && res.status < 300) {
      escaped.push(`${label}（HTTP ${res.status}）`);
      break;
    }
  }
  if (escaped.length) {
    return {
      status: 'failed',
      message: `注入载荷被登录端点接受：${escaped.join('；')}——请人工确认响应是否为有效会话（含 token/用户数据）：是 → 按代码错误划级为 P0（认证绕过）；否则注明「接受但未建立会话」。`,
    };
  }
  return { status: 'passed', message: 'NoSQL 操作符/SQL 恒真等 6 类注入载荷均未建立会话（4xx 拒绝）' };
}

// 错误信息泄漏：畸形输入（非法 JSON / 超长串 / 路径穿越 / NUL）→ 4xx 响应体不应携带内部细节
async function probeDisclosure(ep, baseUrl, headersBase, token) {
  const key = normalizeEndpoint(ep.method, ep.path);
  const pathPart = key.split(' ')[1] || ep.path;
  const method = ep.method;
  const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
  const attempts = [];
  if (hasBody) {
    attempts.push(['非法 JSON', buildUrl(baseUrl, pathPart), { method, headers: { ...headersBase, 'content-type': 'application/json' }, body: '{"malformed' }]);
    attempts.push(['超长字符串字段', buildUrl(baseUrl, pathPart), { method, headers: { ...headersBase, 'content-type': 'application/json' }, body: JSON.stringify({ data: 'A'.repeat(60000) }) }]);
  } else if (pathHasParam(pathPart)) {
    attempts.push(['路径穿越', buildUrl(baseUrl, substPathParams(pathPart, '..%2F..%2Fetc%2Fpasswd')), { method, headers: headersBase }]);
    attempts.push(['超长路径参数', buildUrl(baseUrl, substPathParams(pathPart, 'A'.repeat(9000))), { method, headers: headersBase }]);
  } else {
    attempts.push(['NUL 字节 query', buildUrl(baseUrl, pathPart) + '?q=%00', { method, headers: headersBase }]);
  }
  const leaked = [];
  let saw4xx = false;
  let sawAny = false;
  for (const [label, url, opts] of attempts) {
    const res = await request(url, opts);
    if (res.error) continue;
    sawAny = true;
    if (res.status >= 400 && res.status < 500) saw4xx = true;
    if (res.status >= 400 && res.text && LEAK_RE.test(res.text)) {
      const m = LEAK_RE.exec(res.text);
      leaked.push(`${label}（HTTP ${res.status}，命中「${truncate(m[0], 60)}」）`);
    }
  }
  if (leaked.length) {
    return {
      status: 'failed',
      message: `畸形输入触发内部信息泄漏：${leaked.join('；')}——响应体携带堆栈/框架异常细节。修复：全局异常处理器返回统一错误结构（按代码缺陷分级，泄漏配置/路径 → P1，一般堆栈 → P2）。`,
    };
  }
  if (!sawAny) return { status: 'skipped', message: '畸形输入请求全部失败（网络/服务不可达），无法判定' };
  if (!saw4xx) {
    return { status: 'passed', message: '畸形输入未触发 4xx 也未泄漏内部细节（可能被鉴权层直接拦截' + (token ? '' : '——未配置 token，受保护端点仅验证到鉴权层') + '）' };
  }
  return { status: 'passed', message: '畸形输入被干净拒绝（4xx，无内部细节泄漏）' };
}

async function probeHeaders(baseUrl, headersBase) {
  const res = await request(baseUrl.replace(/\/+$/, '') + '/', { headers: headersBase });
  if (res.error) return { status: 'skipped', message: `基线请求失败（${res.error}）` };
  const h = res.headers;
  const missing = [];
  if (!h.get('x-content-type-options')) missing.push('X-Content-Type-Options');
  if (!h.get('x-frame-options') && !h.get('content-security-policy')) missing.push('X-Frame-Options 或 Content-Security-Policy');
  if (baseUrl.startsWith('https') && !h.get('strict-transport-security')) missing.push('Strict-Transport-Security');
  if (missing.length) {
    return {
      status: 'failed',
      message: `安全响应头缺失：${missing.join('、')}（HTTP ${res.status}）。修复：在反向代理或框架中间件统一补齐；属于加固建议，通常 P3。`,
    };
  }
  return { status: 'passed', message: '安全响应头齐备（X-Content-Type-Options / X-Frame-Options|CSP' + (baseUrl.startsWith('https') ? ' / HSTS' : '') + '）' };
}

async function probeCors(baseUrl, headersBase, samplePath) {
  const target = buildUrl(baseUrl, samplePath || '/');
  const res = await request(target, { headers: { ...headersBase, origin: 'https://evil.example' } });
  if (res.error) return { status: 'skipped', message: `请求失败（${res.error}）` };
  const acao = res.headers.get('access-control-allow-origin');
  const acac = res.headers.get('access-control-allow-credentials');
  if (acao && acao !== '*') {
    return {
      status: 'failed',
      message: `CORS 反射任意 Origin：响应把 Access-Control-Allow-Origin 回显为 https://evil.example${acac === 'true' ? ' 且允许携带凭据（Access-Control-Allow-Credentials: true）' : ''}——任意网站可跨域读取该 API 响应。修复：Origin 白名单校验${acac === 'true' ? '；带凭据的反射属高危，通常 P1' : '，通常 P2'}。`,
    };
  }
  if (acao === '*') {
    return { status: 'passed', message: 'CORS 为通配 *（开放 API 常见配置；若浏览器端使用凭据 cookie 调用本 API 请收紧为白名单）' };
  }
  return { status: 'passed', message: '未反射任意 Origin（无 ACAO 或白名单）' };
}

async function probeRateLimit(ep, baseUrl, headersBase) {
  const pathPart = normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path;
  const url = buildUrl(baseUrl, pathPart);
  const statuses = [];
  for (let i = 0; i < 15; i++) {
    const res = await request(url, {
      method: 'POST',
      headers: { ...headersBase, 'content-type': 'application/json' },
      body: { username: `probe-${Date.now()}-${i}`, email: `probe-${Date.now()}-${i}@invalid`, password: 'wrong-password-' + i },
    });
    if (res.error) break;
    statuses.push(res.status);
  }
  if (!statuses.length) return { status: 'skipped', message: '限流探测请求全部失败，无法判定' };
  const blocked = statuses.filter((s) => [429, 423].includes(s)).length;
  if (blocked > 0) return { status: 'passed', message: `连发 15 次错误凭据，出现 ${blocked} 次限流响应（429/423）——有防刷机制` };
  return {
    status: 'failed',
    message: `连发 15 次错误凭据全部得到 HTTP ${statuses[0]}，无限流/锁定——可被暴力破解与撞库。修复：登录端点加速率限制（按 IP+账号）或失败锁定；通常 P3（有其他缓解时）/ P2（公网可直接爆破时）。`,
  };
}

// ---------- 主入口 ----------

export const securityProbe = {
  id: 'security-probe',
  label: '动态安全探测（内置）',
  artifactName: null,

  async run({ root, targets, timeoutMs = 300000, archiveDir, config = {} }) {
    const started = Date.now();
    const cases = [];
    const note = (name, status, message) =>
      cases.push({ id: `probe::${cases.length + 1}`, name, file: '', status, durationMs: null, message });

    // baseUrl：config.baseUrl > connectivity targets 推导
    let baseUrl = config.baseUrl || null;
    if (!baseUrl && Array.isArray(targets) && targets.length) baseUrl = targets[0];
    if (!baseUrl && archiveDir) {
      try {
        const route = JSON.parse(fs.readFileSync(archiveDir + '/route.json', 'utf8'));
        const conn = (route.phases || []).find((p) => p.id === 'connectivity');
        baseUrl = conn?.targets?.[0] || null;
      } catch {
        /* 无 route.json */
      }
    }

    const headersBase = {};
    if (config.headers && typeof config.headers === 'object') Object.assign(headersBase, config.headers);

    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
      note('[probe] 基址未配置', 'failed', '无法确定被测服务基址：请在 dast 阶段 config 写 { baseUrl: "http://…" }，或让路线包含 connectivity 阶段（从其 targets 推导）。');
      return finish(cases, 'security-probe: no baseUrl');
    }

    const surface = loadApiSurface(root, archiveDir || null) || null;
    const endpoints = surface?.endpoints || [];
    const skip = new Set(config.skipProbes || []);
    const token = config.token || '';
    const authHeaders = token ? { ...headersBase, authorization: `Bearer ${token}` } : headersBase;

    if (!endpoints.length) {
      note('[probe] 端点盘点', 'skipped', '未盘点到 API 端点（无 OpenAPI/路由定义可解析），仅执行响应头/CORS 基线探测。');
    } else {
      note(
        '[probe] 端点盘点',
        'passed',
        `盘点到 ${endpoints.length} 个端点（受保护 ${endpoints.filter((e) => e.auth === 'protected').length} 个），按端点全量探测${token ? '（已配置 token，可探测到鉴权之后的业务层）' : '（未配置 token，受保护端点仅探测到鉴权层）'}`
      );
    }

    let usedRequests = 0;
    const budget = () => usedRequests < MAX_TOTAL_REQUESTS && Date.now() - started < timeoutMs - 5000;

    const protectedEps = probeableProtected(endpoints);
    const authEntries = endpoints.filter((e) => e.method === 'POST' && AUTH_ENTRY_RE.test(e.path));

    // 1) 未认证访问（逐端点）
    if (!skip.has('unauth')) {
      for (const ep of protectedEps) {
        if (!budget()) break;
        usedRequests++;
        const pathPart = normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path;
        const r = await probeUnauth(ep, baseUrl, headersBase);
        note(`[unauth] ${ep.method} ${pathPart}`, r.status, r.message);
      }
    }

    // 2) 伪造凭据（逐端点）
    if (!skip.has('forged')) {
      for (const ep of protectedEps) {
        if (!budget()) break;
        usedRequests += 4;
        const pathPart = normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path;
        const r = await probeForged(ep, baseUrl, headersBase);
        note(`[forged] ${ep.method} ${pathPart}`, r.status, r.message);
      }
    }

    // 3) 注入（登录/注册类端点）
    if (!skip.has('injection')) {
      for (const ep of authEntries) {
        if (!budget()) break;
        usedRequests += 6;
        const r = await probeInjection(ep, baseUrl, headersBase);
        note(`[inject] ${ep.method} ${ep.path}`, r.status, r.message);
      }
      if (!authEntries.length && endpoints.length) {
        note('[inject] 登录类端点', 'skipped', '未在盘点中识别到登录/注册类端点（路径匹配 login|signin|register|signup|token|session），跳过注入探测。');
      }
    }

    // 4) 错误信息泄漏（畸形输入；上限 DISCLOSURE_MAX_ENDPOINTS，均匀抽样跨模块）
    if (!skip.has('disclosure') && endpoints.length) {
      let pool = endpoints.filter((e) => e.method !== 'WS');
      if (pool.length > DISCLOSURE_MAX_ENDPOINTS) {
        const step = pool.length / DISCLOSURE_MAX_ENDPOINTS;
        pool = Array.from({ length: DISCLOSURE_MAX_ENDPOINTS }, (_, i) => pool[Math.floor(i * step)]);
      }
      for (const ep of pool) {
        if (!budget()) break;
        usedRequests += 2;
        const pathPart = normalizeEndpoint(ep.method, ep.path).split(' ')[1] || ep.path;
        const r = await probeDisclosure(ep, baseUrl, authHeaders, token);
        note(`[disclosure] ${ep.method} ${pathPart}`, r.status, r.message);
      }
    }

    // 5) 安全响应头
    if (!skip.has('headers')) {
      usedRequests++;
      const r = await probeHeaders(baseUrl, headersBase);
      note('[headers] 安全响应头', r.status, r.message);
    }

    // 6) CORS 反射
    if (!skip.has('cors')) {
      usedRequests++;
      const sample = endpoints.find((e) => e.method === 'GET' && e.auth !== 'protected');
      const r = await probeCors(baseUrl, headersBase, sample ? sample.path : '/');
      note('[cors] Origin 反射', r.status, r.message);
    }

    // 7) 限流防刷（登录类端点）
    if (!skip.has('ratelimit')) {
      const loginEp = authEntries[0] || endpoints.find((e) => e.method === 'POST' && /login|signin|token/i.test(e.path));
      if (loginEp) {
        usedRequests += 15;
        const r = await probeRateLimit(loginEp, baseUrl, headersBase);
        note(`[ratelimit] ${loginEp.method} ${loginEp.path} ×15`, r.status, r.message);
      } else if (endpoints.length) {
        note('[ratelimit] 登录类端点', 'skipped', '未识别到登录类端点，跳过限流探测。');
      }
    }

    return finish(cases, `security-probe: baseUrl=${baseUrl}, endpoints=${endpoints.length}, cases=${cases.length}`);
  },

  parse({ proc }) {
    return {
      suites: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      parseStatus: 'exit-code-only',
      artifacts: [],
      warnings: ['security-probe 执行器应通过 run() 返回结果，此分支不应被触发'],
    };
  },
};

function finish(cases, commandLabel) {
  const stdout = cases.map((c) => `${c.status === 'passed' ? 'ok' : c.status === 'skipped' ? 'skip' : 'not ok'} - ${c.name}: ${truncate(c.message, 200)}`).join('\n');
  return {
    proc: {
      exitCode: cases.some((c) => c.status === 'failed') ? 1 : 0,
      stdout: stdout + '\n',
      stderr: '',
      timedOut: false,
      command: commandLabel,
    },
    parsed: {
      suites: [{ name: 'security-probe', cases }],
      summary: summarizeCases(cases),
      parseStatus: 'builtin',
      artifacts: [],
      warnings: [],
    },
  };
}
