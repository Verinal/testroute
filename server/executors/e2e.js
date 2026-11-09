// 声明式 HTTP E2E 执行器（内置）：按 phase.steps 顺序发请求、校验期望、跨步骤传变量。
// steps 是路线的一部分 → 批准时人工可评审"将要发出哪些请求"，且无需在项目里安装任何测试框架。
// step 格式: { name, method?, url, headers?, body?, expect?: { status?, bodyContains?, json? }, save?: { 变量名: 'json:点路径' } }
import { summarizeCases } from '../result.js';
import { truncate } from '../validate.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

function getByPath(obj, dotPath) {
  let cur = obj;
  for (const key of String(dotPath).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function eq(a, b) {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

function interpolate(tpl, vars) {
  return String(tpl).replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (raw, name) => {
    if (name in vars) return String(vars[name]);
    throw new Error(`插值变量 {{${name}}} 不存在（前置步骤失败或未 save？）`);
  });
}

// 深度插值：对象 body 里的字符串值（如 { msg: "hello {{token}}" }）也要替换
function deepInterpolate(v, vars) {
  if (typeof v === 'string') return interpolate(v, vars);
  if (Array.isArray(v)) return v.map((x) => deepInterpolate(x, vars));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = deepInterpolate(val, vars);
    return out;
  }
  return v;
}

async function runStep(step, vars, timeoutMs) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) {
      headers[k] = interpolate(v, vars);
    }
    let body;
    if (step.body !== undefined && step.body !== null) {
      const interpolated = deepInterpolate(step.body, vars);
      body = typeof step.body === 'string' ? interpolated : JSON.stringify(interpolated);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json';
      }
    }
    const res = await fetch(step.url, {
      method: step.method || 'GET',
      headers,
      body: body === undefined ? undefined : body,
      signal: ac.signal,
      redirect: 'follow',
    });
    const text = await res.text().catch(() => '');
    const ms = Date.now() - started;
    return { res, text, ms };
  } finally {
    clearTimeout(timer);
  }
}

function checkExpectations(step, res, text) {
  const problems = [];
  const expect = step.expect || {};
  if (expect.status !== undefined) {
    if (res.status !== expect.status) {
      problems.push(`期望状态码 ${expect.status}，实际 ${res.status}`);
    }
  } else if (res.status >= 400) {
    problems.push(`未指定期望状态码，默认要求 <400，实际 ${res.status}`);
  }
  if (expect.bodyContains !== undefined && !text.includes(expect.bodyContains)) {
    problems.push(`响应体不包含 ${JSON.stringify(truncate(expect.bodyContains, 80))}（响应体: ${JSON.stringify(truncate(text, 120))}）`);
  }
  if (expect.json && typeof expect.json === 'object') {
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`期望校验 json 但响应体不是合法 JSON: ${JSON.stringify(truncate(text, 120))}`);
    }
    if (parsed !== null) {
      for (const [path, want] of Object.entries(expect.json)) {
        const actual = getByPath(parsed, path);
        if (!eq(actual, want)) {
          problems.push(`json["${path}"] 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
        }
      }
    }
  }
  return problems;
}

function applySave(step, res, text, vars) {
  if (!step.save) return;
  let parsed = null;
  const canParse = Object.values(step.save).some((v) => String(v).startsWith('json:'));
  if (canParse) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`save 需要解析 JSON，但响应体不是合法 JSON: ${JSON.stringify(truncate(text, 120))}`);
    }
  }
  for (const [name, spec] of Object.entries(step.save)) {
    const s = String(spec);
    if (s === 'status') {
      vars[name] = res.status;
    } else if (s === 'body') {
      vars[name] = text;
    } else if (s.startsWith('json:')) {
      vars[name] = getByPath(parsed, s.slice(5));
    } else {
      throw new Error(`save.${name} 的取值描述 "${s}" 不认识（支持 status / body / json:点路径）`);
    }
  }
}

export const e2e = {
  id: 'e2e',
  label: '声明式 HTTP E2E',
  artifactName: null,

  // 内置执行器：无需外部命令，按步骤串行请求
  async run({ steps, timeoutMs = 300000 }) {
    const list = Array.isArray(steps) ? steps : [];
    if (list.length === 0) {
      const cases = [
        {
          id: 'e2e::no-steps',
          name: 'steps 未配置',
          file: '',
          status: 'failed',
          durationMs: null,
          message: 'executor="e2e" 需要在阶段里配置 steps（声明式 HTTP 步骤数组）',
        },
      ];
      return {
        proc: { exitCode: 1, stdout: '', stderr: 'e2e: 未配置 steps', timedOut: false, command: '(e2e http)' },
        parsed: {
          suites: [{ name: 'e2e', cases }],
          summary: summarizeCases(cases),
          parseStatus: 'builtin',
          artifacts: [],
          warnings: [],
        },
      };
    }

    const perStep = Math.min(30000, Math.max(3000, Math.floor(timeoutMs / list.length)));
    // 内置变量：让声明式步骤可重入（每次 run 生成唯一测试数据，避免唯一索引冲突导致复跑必挂）
    // {{__TIMESTAMP__}} → 毫秒时间戳；{{__UNIQUE__}} → 本次运行唯一后缀
    const vars = {
      __TIMESTAMP__: String(Date.now()),
      __UNIQUE__: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    };
    const cases = [];
    for (const step of list) {
      const name = String(step?.name || '未命名步骤');
      const label = `${step?.method || 'GET'} ${step?.url || '(无 url)'}`;
      if (!step || !METHODS.has(String(step.method || 'GET').toUpperCase()) || !/^https?:\/\//i.test(String(step.url || ''))) {
        cases.push({
          id: `e2e::step::${name}`,
          name: label,
          file: '',
          status: 'failed',
          durationMs: null,
          message: '步骤定义非法：method 须是标准 HTTP 方法、url 须是 http(s) 绝对地址',
        });
        continue;
      }
      try {
        const started = Date.now();
        const url = interpolate(step.url, vars);
        const { res, text, ms } = await runStep({ ...step, url }, vars, perStep);
        const problems = checkExpectations(step, res, text);
        if (problems.length === 0) {
          applySave(step, res, text, vars);
          cases.push({ id: `e2e::step::${name}`, name: `${label} → HTTP ${res.status}`, file: '', status: 'passed', durationMs: ms, message: `HTTP ${res.status}（${ms}ms）` });
        } else {
          cases.push({ id: `e2e::step::${name}`, name: label, file: '', status: 'failed', durationMs: ms, message: problems.join('；') });
        }
      } catch (e) {
        const code = e?.cause?.code || '';
        const msg = e?.name === 'AbortError' ? `超时（>${perStep}ms）` : String(e?.message || e) + (code ? ` (${code})` : '');
        cases.push({ id: `e2e::step::${name}`, name: label, file: '', status: 'failed', durationMs: Date.now() - started, message: msg });
      }
    }

    const stdout = cases.map((c) => `${c.status === 'passed' ? 'ok' : 'not ok'} - ${c.name}: ${c.message}`).join('\n');
    return {
      proc: {
        exitCode: cases.some((c) => c.status === 'failed') ? 1 : 0,
        stdout: stdout + '\n',
        stderr: '',
        timedOut: false,
        command: `e2e http: ${list.length} steps`,
      },
      parsed: {
        suites: [{ name: 'e2e', cases }],
        summary: summarizeCases(cases),
        parseStatus: 'builtin',
        artifacts: [],
        warnings: [],
      },
    };
  },

  parse({ proc }) {
    return {
      suites: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      parseStatus: 'exit-code-only',
      artifacts: [],
      warnings: ['e2e 执行器应通过 run() 返回结果，此分支不应被触发'],
    };
  },
};
