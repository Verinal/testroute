// 参数校验与错误类型。所有工具层错误统一抛 ToolError，协议层转成 MCP isError 结果。
export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ToolError(code, message);
}

function isStr(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function reqStr(args, key) {
  const v = args?.[key];
  if (!isStr(v)) fail('E_INVALID_ARGS', `缺少必填参数 "${key}"（非空 string）`);
  return v.trim();
}

export function optStr(args, key, dflt = '') {
  const v = args?.[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'string' && v.trim() === '') return dflt; // 空串视同未提供（LLM 常见手误，不值得消耗宿主一轮）
  if (typeof v !== 'string') fail('E_INVALID_ARGS', `参数 "${key}" 必须是 string`);
  return v.trim();
}

export function optNumber(args, key, dflt = null) {
  const v = args?.[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  // 自癒：数字字符串（LLM 把 timeoutMs 传成 "60000" 是常见手误）
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  fail('E_INVALID_ARGS', `参数 "${key}" 必须是 number`);
}

export function optBool(args, key, dflt = false) {
  const v = args?.[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'boolean') return v;
  // 自癒：布尔字符串（"true"/"false"/"True"…，JSON schema 描述没被遵守时的常见形态）
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
  }
  fail('E_INVALID_ARGS', `参数 "${key}" 必须是 boolean（也接受 "true"/"false" 字符串）`);
}

export function reqObject(args, key) {
  const v = args?.[key];
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    fail('E_INVALID_ARGS', `缺少必填参数 "${key}"（object）`);
  }
  return v;
}

export function reqArray(args, key, { minLen = 1 } = {}) {
  const v = args?.[key];
  if (!Array.isArray(v) || v.length < minLen) {
    fail('E_INVALID_ARGS', `缺少必填参数 "${key}"（array，至少 ${minLen} 项）`);
  }
  return v;
}

export function optArray(args, key) {
  const v = args?.[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail('E_INVALID_ARGS', `参数 "${key}" 必须是 array`);
  return v;
}

export function oneOf(v, list, key) {
  if (list.includes(v)) return v;
  // 自癒：字符串枚举大小写/首尾空白容错（"Passed"→passed、"p0"→P0），省掉宿主一轮重试
  if (typeof v === 'string') {
    const s = v.trim();
    const hit = list.find((x) => typeof x === 'string' && x.toLowerCase() === s.toLowerCase());
    if (hit) return hit;
  }
  fail('E_INVALID_ARGS', `参数 "${key}" 必须是 [${list.join(' | ')}] 之一，收到 "${v}"`);
}

export function truncate(s, n = 600) {
  if (s == null) return '';
  s = String(s);
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[已截断，原文共 ${s.length} 字符，完整内容见归档 raw 文件]`;
}
