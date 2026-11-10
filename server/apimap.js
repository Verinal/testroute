// API 端点面盘点：静态解析源码里的路由定义（FastAPI/Flask/Express/Fastify/Koa）+ OpenAPI 文档，
// 给路线规划提供「必须覆盖的端点清单」（save_route 深度门禁的基准），给最终报告提供「盘点 vs 实测」覆盖对照。
// 零依赖正则解析；识别不了就少报——宁缺勿错（误报端点会变成永远测不到的假覆盖缺口）。
import path from 'node:path';
import fs from 'node:fs';
import { readJson } from './paths.js';

export const APIMAP_MAX_FILES = 1500; // 读取上限（按 detect walk 的顺序取前 N 个源码文件）
export const APIMAP_MAX_ENDPOINTS = 3000;
const MAX_FILE_BYTES = 512 * 1024;

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const OPENAPI_FILE_RE = /(^|\/)(openapi|swagger)\.json$/i;
const PY_SOURCE_RE = /\.py$/i;
const JS_SOURCE_RE = /\.[cm]?[jt]sx?$/i;

// 端点键规范化：METHOD 大写、去 query、路径参数折叠为 {p}
//（具名参数 {id} / Flask <int:id> / ObjectId / UUID / 纯数字段都归并为 {p}，让「声明路径」与「实测路径」可对上）
function collapseSeg(seg) {
  if (/^\{.+\}$/.test(seg) || /^<[^<>]+>$/.test(seg)) return '{p}';
  if (/^[:*]/.test(seg)) return '{p}'; // Express/Fastify/Koa 参数段 :id / *path
  if (/^[0-9a-f]{24}$/i.test(seg)) return '{p}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{p}';
  if (/^\d+$/.test(seg)) return '{p}';
  return seg.toLowerCase();
}

export function normalizeEndpoint(method, rawPath) {
  let p = String(rawPath || '').split('?')[0].trim() || '/';
  if (!p.startsWith('/')) p = '/' + p;
  const m = String(method || 'GET').toUpperCase();
  return `${m} ${p.split('/').map(collapseSeg).join('/')}`;
}

// 从 e2e 声明式步骤推导覆盖端点（URL 里的 {{变量}} 插值段视为路径参数）
export function endpointsFromE2eSteps(steps) {
  const keys = new Set();
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s?.url) continue;
    const raw = String(s.url).replace(/^https?:\/\/[^/]+/i, '');
    const collapsed = raw
      .split('?')[0]
      .split('/')
      .map((seg) => (seg.includes('{{') || seg.includes('__UNIQUE__') ? '{p}' : collapseSeg(seg)))
      .join('/');
    keys.add(normalizeEndpoint(s.method, collapsed || '/'));
  }
  return [...keys].sort();
}

// 读取沙箱脚本写入的 API 覆盖清单（run_tests 通过环境变量 TESTROUTE_COVERAGE_FILE 告知落点）。
// 接受两种形态：字符串数组（"GET /api/x" 或 "GET/api/x"）或对象数组（{method, path, kinds?: [...]}）；
// 也接受 { endpoints: [...] } 包一层。无法解析返回 null。
// 返回 { keys: string[], kinds: { "<METHOD /path>": [kind...] } }——kinds 标记该端点被哪类深度用例触及
//（functional/negative/boundary/authz），finalize 覆盖矩阵据此判定「每个端点的每类必需用例」是否齐备。
export function readApiCoverageFile(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.endpoints) ? raw.endpoints : null;
  if (!arr) return null;
  const keys = new Set();
  const kinds = {};
  const addKind = (key, list) => {
    if (!Array.isArray(list)) return;
    for (const k of list) {
      if (typeof k !== 'string') continue;
      const kk = k.trim().toLowerCase();
      if (!COVERAGE_KINDS.includes(kk)) continue;
      kinds[key] = kinds[key] || new Set();
      kinds[key].add(kk);
    }
  };
  for (const e of arr) {
    if (typeof e === 'string') {
      const m = /^\s*([a-zA-Z]+)\s+\/?(.*)$/.exec(e);
      if (m) keys.add(normalizeEndpoint(m[1], '/' + m[2]));
      else if (e.trim().startsWith('/')) keys.add(normalizeEndpoint('GET', e));
    } else if (e && typeof e === 'object' && e.method && e.path) {
      const key = normalizeEndpoint(e.method, e.path);
      keys.add(key);
      addKind(key, e.kinds);
    }
  }
  if (!keys.size) return null;
  const kindObj = {};
  for (const [k, set] of Object.entries(kinds)) kindObj[k] = [...set].sort();
  return { keys: [...keys].sort(), kinds: kindObj };
}

function lineOf(content, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

function addEndpoint(map, { method, path, module, file, line, auth, hasBody, hasParams }) {
  const m = String(method || 'GET').toUpperCase();
  if (!HTTP_METHODS.includes(m) && m !== 'WS') return;
  if (!path) return;
  let p = String(path).split('?')[0].trim();
  if (!p.startsWith('/')) p = p ? '/' + p : '/'; // FastAPI @router.get("") → 仅 prefix（或根）
  const key = `${m} ${p}`;
  if (!map.has(key)) {
    const ep = { method: m, path: p, module: module || '-', file: file || '-', line: line || 0, auth: auth || 'unknown' };
    if (hasBody) ep.hasBody = true;
    if (hasParams) ep.hasParams = true;
    map.set(key, ep);
  }
}

// Python：FastAPI APIRouter(prefix=…) / Flask Blueprint + @x.get(“/p”) / @x.route(“/p”, methods=[…]) / @x.websocket
function parsePython(content, rel, map) {
  const prefixByVar = new Map();
  const fileLevelAuth = /dependencies\s*=\s*\[\s*Depends\(/.test(content);
  for (const m of content.matchAll(/(\w+)\s*=\s*(?:APIRouter|Blueprint)\s*\(([\s\S]{0,300}?)\)\s*$/gm)) {
    const pm = /prefix\s*=\s*["']([^"']+)["']/.exec(m[2] || '');
    prefixByVar.set(m[1], pm ? pm[1] : '');
  }
  const module = path.basename(rel, path.extname(rel));
  const decRe = /@(\w+)\.(get|post|put|patch|delete|head|options|route|websocket)\s*\(\s*["']([^"']*)["']\s*([\s\S]{0,200}?)\)\s*\n/g;
  for (const m of content.matchAll(decRe)) {
    const [, varName, verb, decPath, rest] = m;
    const line = lineOf(content, m.index);
    const prefix = prefixByVar.get(varName) ?? '';
    const auth = fileLevelAuth || /Depends\(/.test(rest) ? 'protected' : 'unknown';
    if (verb === 'websocket') {
      addEndpoint(map, { method: 'WS', path: prefix + decPath, module, file: rel, line, auth });
    } else if (verb === 'route') {
      const mm = /methods\s*=\s*\[([^\]]*)\]/.exec(rest || '');
      const methods = mm
        ? mm[1].match(/["'](\w+)["']/g)?.map((x) => x.replace(/["']/g, '')) || ['GET']
        : ['GET'];
      for (const meth of methods) {
        addEndpoint(map, { method: meth, path: prefix + decPath, module, file: rel, line, auth });
      }
    } else {
      addEndpoint(map, { method: verb, path: prefix + decPath, module, file: rel, line, auth });
    }
  }
}

// Node：Express/Fastify/Koa 风格 app|router|api|server.get(“/p”, …)（use/all 太泛，不识别）
function parseNode(content, rel, map) {
  const module = path.basename(path.dirname(rel)) !== '.' && /routes?|api|controller/i.test(path.dirname(rel))
    ? path.basename(rel, path.extname(rel))
    : path.basename(rel, path.extname(rel));
  const re = /\b(?:app|router|api|server|fastify)\.(get|post|put|patch|delete|head|options)\s*\(\s*["'`](\/[^"'`\s]*)["'`]/g;
  for (const m of content.matchAll(re)) {
    const auth = /requireAuth|authenticate|verifyToken|passport|isAuth|authMiddleware/i.test(content.slice(m.index, m.index + 400))
      ? 'protected'
      : 'unknown';
    addEndpoint(map, { method: m[1], path: m[2], module, file: rel, line: lineOf(content, m.index), auth });
  }
}

function parseOpenApi(content, rel, map) {
  let doc;
  try {
    doc = JSON.parse(content);
  } catch {
    return;
  }
  const module = path.basename(rel, path.extname(rel));
  for (const [p, item] of Object.entries(doc?.paths || {})) {
    for (const meth of Object.keys(item || {})) {
      const M = meth.toUpperCase();
      if (!HTTP_METHODS.includes(M)) continue;
      const sec = item[meth]?.security;
      const hasBody = !!item[meth]?.requestBody;
      const params = item[meth]?.parameters;
      const hasParams = Array.isArray(params) && params.length > 0;
      const ep = { method: M, path: p, module: item[meth]?.tags?.[0] || module, file: rel, line: 0, auth: sec === undefined ? 'unknown' : sec.length ? 'protected' : 'public' };
      if (hasBody) ep.hasBody = true;
      if (hasParams) ep.hasParams = true;
      addEndpoint(map, ep);
    }
  }
}

// 主入口：root + 相对路径清单（来自 detect.walk）→ { total, protectedCount, modules[], endpoints[], sources[] }
export function scanApiSurface(root, relFiles) {
  const map = new Map();
  const sources = new Set();
  let read = 0;
  const openApiFirst = relFiles.filter((f) => OPENAPI_FILE_RE.test(f));
  for (const rel of openApiFirst) {
    try {
      const content = fs.readFileSync(path.join(root, rel), 'utf8');
      parseOpenApi(content, rel, map);
      sources.add(`openapi:${rel}`);
      read++;
    } catch {
      /* 读不了就跳过 */
    }
  }
  for (const rel of relFiles) {
    if (read >= APIMAP_MAX_FILES || map.size >= APIMAP_MAX_ENDPOINTS) break;
    const isPy = PY_SOURCE_RE.test(rel);
    const isJs = JS_SOURCE_RE.test(rel);
    if (!isPy && !isJs) continue;
    if (/(^|\/)(node_modules|dist|build|\.venv|venv|__pycache__)\//.test(rel)) continue;
    try {
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(abs, 'utf8');
      read++;
      const before = map.size;
      if (isPy) parsePython(content, rel, map);
      else parseNode(content, rel, map);
      if (map.size > before) sources.add(isPy ? 'python-decorators' : 'node-route-calls');
    } catch {
      /* 读不了就跳过 */
    }
  }

  const endpoints = [...map.values()].slice(0, APIMAP_MAX_ENDPOINTS);
  const byModule = new Map();
  for (const e of endpoints) {
    const m = byModule.get(e.module) || { name: e.module, file: e.file, count: 0 };
    m.count++;
    byModule.set(e.module, m);
  }
  const protectedCount = endpoints.filter((e) => e.auth === 'protected').length;
  return {
    schemaVersion: 1,
    scannedFiles: read,
    sources: [...sources],
    total: endpoints.length,
    protectedCount,
    publicCount: endpoints.filter((e) => e.auth === 'public').length,
    modules: [...byModule.values()].sort((a, b) => b.count - a.count),
    endpoints,
    scannedAt: new Date().toISOString(),
  };
}

// API 端点面数据源：优先归档里的 project-map.json（scan_project 在归档存在时写入），
// 缺失时对项目根现场扫描兜底（scan_project 常在 init_archive 之前调用，归档里没有地图是常态而非异常）。
// save_route 深度门禁、run_tests 覆盖警告、finalize 覆盖对照都用它；读不到（无源码可扫）返回 null。
export function loadApiSurface(root, archiveDir) {
  try {
    const mapPath = path.join(archiveDir, 'project-map.json');
    if (fs.existsSync(mapPath)) {
      const map = readJson(mapPath);
      if (map?.apiSurface?.endpoints?.length) return map.apiSurface;
      if (map?.apiSurface && map.apiSurface.total === 0) return null; // 已扫描确认无 API
    }
  } catch {
    /* 地图缺失/损坏 → 现场扫描 */
  }
  try {
    // 归档里的沙箱/运行产物不该计入盘点：现场扫描时排除 test-archives
    const relFiles = [];
    const visit = (dir, depth) => {
      if (depth > 12 || relFiles.length >= 8000) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (relFiles.length >= 8000) return;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORE_SCAN_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github') || e.name === 'test-archives') continue;
          visit(abs, depth + 1);
        } else if (e.isFile()) {
          relFiles.push(path.relative(root, abs).split(path.sep).join('/'));
        }
      }
    };
    visit(root, 0);
    return scanApiSurface(root, relFiles);
  } catch {
    return null;
  }
}

const IGNORE_SCAN_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', 'env',
  '__pycache__', '.idea', '.vscode', 'coverage', 'target', 'vendor',
  '.next', '.nuxt', '.pytest_cache', '.mypy_cache', 'site-packages', '.tox',
]);

// ---- 覆盖对照：盘点（基准）vs 实测（沙箱脚本/e2e steps 上报的端点）----

// 宽松匹配：逐段对齐，长度相同但某段不一致时，该段若不是任何盘点路径的静态段则视为参数化段；
// 处理「盘点 /collections/{col_id}/recipes」 vs 实测 /collections/665f…/recipes 之外的场景
//（如盘点里带具体命名、实测里是任意 id——collapseSeg 已覆盖 ObjectId/UUID/数字，这里兜底剩余形态）。
// 导出给 finalize 的豁免匹配复用（coverageWaiver 写具体 id 也能对上 {p} 缺口）。
export function looseMatch(coverKey, invKey, invStaticSegs) {
  const cPath = coverKey.slice(coverKey.indexOf(' ') + 1);
  const iPath = invKey.slice(invKey.indexOf(' ') + 1);
  if (coverKey.split(' ')[0] !== invKey.split(' ')[0]) return false;
  const c = cPath.split('/');
  const i = iPath.split('/');
  if (c.length !== i.length) return false;
  for (let k = 0; k < c.length; k++) {
    if (c[k] === i[k]) continue;
    if (i[k] === '{p}' && !invStaticSegs.has(c[k])) continue;
    return false;
  }
  return true;
}

// 返回 { total, covered, pct, uncovered[], modules[] }。full=true 时 uncovered 不截断。
export function coverageAgainstInventory(inventory, coveredKeys, { full = false } = {}) {
  const inv = Array.isArray(inventory?.endpoints) ? inventory.endpoints : [];
  const covered = new Set((coveredKeys || []).map(String));
  if (!inv.length) return { total: 0, covered: 0, pct: null, uncovered: [], modules: [] };
  const invStaticSegs = new Set();
  for (const e of inv) {
    for (const seg of e.path.split('/')) {
      const c = collapseSeg(seg);
      if (c !== '{p}') invStaticSegs.add(c);
    }
  }
  const invKeys = inv.map((e) => normalizeEndpoint(e.method, e.path));
  const invKeySet = new Set(invKeys);
  const hit = new Set();
  for (const ck of covered) {
    if (invKeySet.has(ck)) {
      hit.add(ck);
      continue;
    }
    const loose = invKeys.find((ik) => ik !== ck && looseMatch(ck, ik, invStaticSegs));
    if (loose) hit.add(loose);
  }
  const uncoveredPairs = [];
  invKeys.forEach((k, i) => {
    if (!hit.has(k)) uncoveredPairs.push({ key: k, module: inv[i].module, file: inv[i].file, auth: inv[i].auth });
  });
  const byModule = new Map();
  inv.forEach((e, i) => {
    const m = byModule.get(e.module) || { module: e.module, total: 0, covered: 0 };
    m.total++;
    if (hit.has(invKeys[i])) m.covered++;
    byModule.set(e.module, m);
  });
  const cap = full ? Infinity : 40;
  // covered 按盘点条目数计（total - uncovered），不用 hit.size——盘点内近重复键（尾斜杠/同名参数
  // 两种写法）会被 Set 去重，hit.size 少计成假缺口（真实案例：125 端点全测了却报 122/125）。
  const coveredCount = inv.length - uncoveredPairs.length;
  return {
    total: inv.length,
    covered: coveredCount,
    pct: Math.round((coveredCount / inv.length) * 100),
    uncovered: uncoveredPairs.slice(0, cap),
    uncoveredTotal: uncoveredPairs.length,
    modules: [...byModule.values()].sort((a, b) => a.covered / a.total - b.covered / b.total),
  };
}

// ---------- 端点 × 用例深度矩阵（全流程覆盖门禁的判定基准）----------
// "全流程测过"不只是"端点被触及过"：每个端点按其输入面/鉴权标记还欠着哪几类深度用例
//（负向/边界/越权），必须可判定、可列缺口。工具层判定，不依赖 LLM 自觉。

// 深度用例种类：functional=正常主流程 / negative=非法输入 / boundary=极值 / authz=越权
export const COVERAGE_KINDS = ['functional', 'negative', 'boundary', 'authz'];

// 端点输入面：body（有请求体）/ path（路径参数）/ query（查询参数）/ none（无输入面——负向/边界对它没有意义）
export function endpointInput(ep) {
  const key = normalizeEndpoint(ep?.method, ep?.path);
  const method = key.split(' ')[0];
  const pathPart = key.slice(key.indexOf(' ') + 1);
  if (ep?.hasBody || ['POST', 'PUT', 'PATCH'].includes(method)) return 'body';
  if (pathPart.includes('{p}')) return 'path';
  if (ep?.hasParams) return 'query';
  return 'none';
}

// 每个端点必需的深度用例种类：
// functional 恒必需；有输入面（body/path/query）→ negative + boundary；受保护端点 → authz
export function requiredKindsFor(ep) {
  const req = ['functional'];
  if (endpointInput(ep) !== 'none') req.push('negative', 'boundary');
  if (ep?.auth === 'protected') req.push('authz');
  return req;
}

// 计算覆盖矩阵。kindCoverage: Map<端点键, Set<kind>>（各 run 上报合并）。
// 返回 { total, byKind: { functional: {required, covered}, ... }, gaps: [{key, kind, module, auth, file}] }
export function coverageMatrix(inventory, kindCoverage) {
  const inv = Array.isArray(inventory?.endpoints) ? inventory.endpoints : [];
  const byKind = {};
  for (const k of COVERAGE_KINDS) byKind[k] = { required: 0, covered: 0 };
  const gaps = [];
  const got = kindCoverage instanceof Map ? kindCoverage : new Map(Object.entries(kindCoverage || {}).map(([k, v]) => [k, new Set(v)]));
  for (const ep of inv) {
    const key = normalizeEndpoint(ep.method, ep.path);
    const have = got.get(key) || new Set();
    for (const kind of requiredKindsFor(ep)) {
      byKind[kind].required++;
      if (have.has(kind)) byKind[kind].covered++;
      else gaps.push({ key, kind, module: ep.module, auth: ep.auth, file: ep.file });
    }
  }
  return { total: inv.length, byKind, gaps };
}

// 读取沙箱脚本写入的页面覆盖清单（browser-e2e 用例经环境变量 TESTROUTE_PAGES_COVERAGE_FILE 上报访问过的页面路由）。
// 接受字符串数组（"/login"）或对象数组（{path}）。默认按端点口径折叠（数字段 {p} + 小写）；
// 传入 pageNormalize（detect.js 的 normalizePagePath）时按页面口径归一——页面路径大小写敏感，
// 盘点（web-pages.json）与豁免匹配都走 normalizePagePath，上报侧必须同一把尺，否则 /HomePage 会变成 /homepage 对不上。
//
// 返回 { pages, unclean }：
// - pages：规范路径（计入覆盖）；
// - unclean：含 "//" 的路径段（典型成因：BASE 已带斜杠又拼 '/xxx'、或 route 变量自带前导斜杠又补 '/'）。
//   这类条目是「用例拼接路径有 bug」的直接信号——静默归一会把症状洗掉（真实事故：'//shopping' 被洗成
//   '/shopping' 记成已覆盖，而截图证明页面从未跳转成功），所以拒收：不计入覆盖，由调用方警告点名。
// 无法解析返回 null。
export function readPagesCoverageFile(file, pageNormalize = null) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.pages) ? raw.pages : null;
  if (!arr) return null;
  const keys = new Set();
  const unclean = new Set();
  for (const e of arr) {
    const rawPath = typeof e === 'string' ? e : e && typeof e === 'object' ? e.path : null;
    if (typeof rawPath !== 'string') continue;
    const p = rawPath.trim().split('?')[0];
    if (!p) continue;
    if (pageNormalize) {
      if (p.includes('//')) {
        unclean.add(p);
        continue;
      }
      const norm = pageNormalize(p);
      if (norm) keys.add(norm);
      continue;
    }
    if (p.includes('//')) {
      unclean.add(p);
      continue;
    }
    keys.add('/' + p.replace(/^\/+/, '').split('/').map(collapseSeg).join('/'));
  }
  if (!keys.size && !unclean.size) return null;
  return { pages: [...keys].sort(), unclean: [...unclean].sort() };
}
