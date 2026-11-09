import { truncate } from './validate.js';

// 统一用例状态：passed | failed | skipped
export const CASE_STATUSES = ['passed', 'failed', 'skipped'];

export function summarizeCases(cases) {
  const s = { total: cases.length, passed: 0, failed: 0, skipped: 0, durationMs: 0 };
  for (const c of cases) {
    if (c.status === 'passed') s.passed++;
    else if (c.status === 'failed') s.failed++;
    else s.skipped++;
    if (typeof c.durationMs === 'number') s.durationMs += c.durationMs;
  }
  return s;
}

export function statusFromRun({ exitCode, summary }) {
  if (exitCode !== 0) return 'failed';
  if (summary.failed > 0) return 'failed';
  if (summary.total === 0) return 'passed-empty';
  return 'passed';
}

// 收集失败用例（供 LLM 做 triage，不回传全量日志）
export function collectFailures(result, limit = 20) {
  const failures = [];
  for (const suite of result.suites || []) {
    for (const c of suite.cases || []) {
      if (c.status === 'failed') {
        failures.push({
          id: c.id,
          name: c.name,
          file: c.file || '',
          message: truncate(c.message, 400),
        });
        if (failures.length >= limit) return failures;
      }
    }
  }
  return failures;
}

// 失败指纹：全部失败用例的稳定签名（suite+用例 id+报错前缀哈希）。
// 用于识别"同一批失败的复跑"——指纹一致时 triage 归因可自动继承（carriedFrom 留痕），
// 指纹不同（修复生效/新失败）则照常要求重新归因。无失败用例（如崩溃 0 用例）返回 null。
export function failureFingerprint(result) {
  const parts = [];
  for (const suite of result?.suites || []) {
    for (const c of suite.cases || []) {
      if (c.status === 'failed') {
        // 消息按空白归一后再取前缀：同样的失败在不同格式化输出下指纹保持一致
        parts.push(`${suite.name || ''}|${c.id || c.name || ''}|${String(c.message || '').replace(/\s+/g, ' ').slice(0, 120)}`);
      }
    }
  }
  if (!parts.length) return null;
  parts.sort();
  const joined = parts.join('\n');
  let h = 5381;
  for (let i = 0; i < joined.length; i++) h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  return `fp${(h >>> 0).toString(16)}-${parts.length}`;
}

// flaky 识别：首次失败 → 复跑。把第一次的失败用例与第二次结果对账：
// 复跑通过的用例标 flaky（不稳定，不按真实失败处理），仍失败的如实保留。返回 flaky 用例 id 列表。
export function mergeFlakyRetry(first, second) {
  const failedIds = new Set();
  for (const suite of first.suites || []) {
    for (const c of suite.cases || []) {
      if (c.status === 'failed') failedIds.add(c.id);
    }
  }
  const flakyCases = [];
  for (const suite of second.suites || []) {
    for (const c of suite.cases || []) {
      if (c.status === 'passed' && failedIds.delete(c.id)) {
        c.flaky = true;
        c.message = `flaky：首次执行失败，复跑通过（不稳定用例）${c.message ? `\n${c.message}` : ''}`;
        flakyCases.push(c.id);
      }
    }
  }
  const notes = [];
  if (flakyCases.length) {
    notes.push(
      `flaky 识别：${flakyCases.length} 个用例首次失败、复跑通过（不稳定用例，先修用例稳定性再依赖）: ${flakyCases.slice(0, 10).join(', ')}`
    );
  } else if (failedIds.size) {
    notes.push(`复跑仍有 ${failedIds.size} 个用例失败（非 flaky，按真实失败处理）`);
  } else if (first.exitCode !== 0 && second.exitCode === 0) {
    notes.push(`flaky 识别：首次执行失败（exit=${first.exitCode}），复跑通过——疑似环境不稳定`);
  } else if (first.exitCode !== 0) {
    notes.push(`复跑仍失败（exit=${second.exitCode}），按真实失败处理`);
  }
  second.retryOf = first.runId || null;
  second.warnings = [...(second.warnings || []), ...notes];
  return flakyCases;
}

export function emptySummary() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 };
}
