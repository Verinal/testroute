// 最小 JUnit XML 解析器（pytest / junit / vitest-junit 输出），零依赖。
function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) attrs[m[1]] = m[2];
  return attrs;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, '')).trim();
}

function caseStatus(body) {
  if (!body) return { status: 'passed', message: '' };
  const m = /<(failure|error|skipped)\b([^>]*)>([\s\S]*?)<\/\1>/.exec(body);
  if (!m) return { status: 'passed', message: '' };
  const kind = m[1];
  const attrs = parseAttrs(m[2] || '');
  const msg = attrs.message || stripTags(m[3]).slice(0, 2000);
  return {
    status: kind === 'skipped' ? 'skipped' : 'failed',
    message: msg,
  };
}

export function parseJunitXml(xml) {
  const suites = [];
  const suiteRe = /<testsuite\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testsuite>)/g;
  const caseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  let sm;
  while ((sm = suiteRe.exec(xml))) {
    const attrs = parseAttrs(sm[1] || '');
    const body = sm[2] || '';
    const cases = [];
    let cm;
    while ((cm = caseRe.exec(body))) {
      const cAttrs = parseAttrs(cm[1] || '');
      const { status, message } = caseStatus(cm[2] || '');
      const dur = cAttrs.time ? Math.round(parseFloat(cAttrs.time) * 1000) : null;
      cases.push({
        id: `${cAttrs.classname || cAttrs.file || 'suite'}::${cAttrs.name || 'case'}`,
        name: cAttrs.name || 'case',
        file: cAttrs.file || cAttrs.classname || '',
        status,
        durationMs: Number.isFinite(dur) ? dur : null,
        message,
      });
    }
    suites.push({ name: attrs.name || attrs.file || 'suite', cases });
  }

  // 顶层散落的 <testcase>（非常规输出）
  if (suites.length === 0) {
    const cases = [];
    let cm;
    while ((cm = caseRe.exec(xml))) {
      const cAttrs = parseAttrs(cm[1] || '');
      const { status, message } = caseStatus(cm[2] || '');
      cases.push({
        id: `${cAttrs.classname || 'suite'}::${cAttrs.name || 'case'}`,
        name: cAttrs.name || 'case',
        file: cAttrs.file || cAttrs.classname || '',
        status,
        durationMs: null,
        message,
      });
    }
    if (cases.length > 0) suites.push({ name: 'suite', cases });
  }
  return suites;
}
