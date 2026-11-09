// Playwright JSON 报告解析（--reporter=json）。
// 结构: suites[]（按项目/嵌套 describe 层级）→ specs[] → tests[]（status: expected|unexpected|flaky|skipped）
//       results[]（status: passed|failed|timedOut|skipped|interrupted；含 errors 与截图/trace attachments）。
import { summarizeCases } from '../result.js';
import { truncate } from '../validate.js';

function mapStatus(t) {
  const s = t?.status || (t?.results || []).at(-1)?.status;
  switch (s) {
    case 'expected':
    case 'passed':
      return 'passed';
    case 'flaky':
      return 'passed'; // 重试后通过：算过，但留警告
    case 'skipped':
      return 'skipped';
    default:
      return 'failed';
  }
}

function collectErrors(t) {
  const msgs = [];
  for (const r of t?.results || []) {
    for (const e of r?.errors || []) {
      if (e?.message) msgs.push(String(e.message));
    }
  }
  return msgs;
}

// 附件分类：trace=官方证据文件（拖进 trace viewer 逐步重播）；video=浏览器直接播放；
// screenshot=截图（显式逐步截图 + playwright 自动截图）；error-context=失败时页面快照。
function classifyAttachment(a) {
  const name = String(a?.name || '').toLowerCase();
  const ct = String(a?.contentType || '').toLowerCase();
  if (name === 'trace' || ct.includes('zip')) return 'trace';
  if (name === 'video' || ct.includes('video/')) return 'video';
  if (ct.startsWith('image/') || name.includes('screenshot')) return 'screenshot';
  if (name === 'error-context' || ct.includes('markdown')) return 'error-context';
  return 'attachment';
}

function collectAttachments(t) {
  const out = [];
  for (const r of t?.results || []) {
    for (const a of r?.attachments || []) {
      if (!a?.path) continue;
      out.push({ kind: classifyAttachment(a), name: String(a?.name || ''), path: a.path });
    }
  }
  return out;
}

export function parsePlaywrightJson(jsonText, root) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch (e) {
    return {
      suites: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      parseStatus: 'parse-error',
      artifacts: [],
      warnings: [`Playwright JSON 报告解析失败: ${e?.message || e}`],
    };
  }

  const cases = [];
  const warnings = [];

  const walk = (suite, path) => {
    const titlePath = [...path, suite?.title].filter(Boolean);
    for (const spec of suite?.specs || []) {
      for (const t of spec.tests || []) {
        const status = mapStatus(t);
        if (t?.status === 'flaky') warnings.push(`flaky（重试后通过）: ${spec.title}`);
        const errors = collectErrors(t);
        const attachments = collectAttachments(t);
        const relFile = spec.file ? String(spec.file) : '';
        const id = [relFile, ...titlePath, spec.title].filter(Boolean).join('::');
        const projectName = (t?.projectId || titlePath[0] || '').toString();
        const duration = (t?.results || []).reduce((n, r) => n + (r?.duration || 0), 0);
        const message = errors.length
          ? truncate(errors.join('\n'), 600) +
            (attachments.length ? `\n证据: ${attachments.map((a) => a.path).join(', ')}` : '')
          : status === 'skipped'
            ? 'skipped'
            : `passed${projectName ? ` [${projectName}]` : ''}`;
        cases.push({
          id,
          name: [projectName, ...titlePath.slice(1), spec.title].filter(Boolean).join(' › '),
          file: relFile,
          status,
          durationMs: duration,
          message,
          // 证据链随用例结构化存储（过与不过都有）：报告逐用例引用，不再只拼进失败 message
          ...(attachments.length ? { attachments } : {}),
        });
      }
    }
    for (const child of suite?.suites || []) walk(child, titlePath);
  };

  for (const s of data?.suites || []) walk(s, []);

  if (!cases.length) warnings.push('Playwright 报告中没有用例（可能测试匹配为空或报告格式不认识）');

  // artifacts = 全部用例附件按 path 去重（trace/video/截图进归档产物索引）
  const seen = new Set();
  const artifacts = [];
  for (const c of cases) {
    for (const a of c.attachments || []) {
      const key = String(a.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(a);
    }
  }

  return {
    suites: cases.length ? [{ name: 'playwright', cases }] : [],
    summary: summarizeCases(cases),
    parseStatus: 'parsed',
    artifacts,
    warnings,
  };
}
