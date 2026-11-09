// jest / vitest JSON 报告解析（两者 JSON reporter 格式基本一致）
import path from 'node:path';
import { truncate } from '../validate.js';

export function parseJestJson(jsonText, root) {
  const data = JSON.parse(jsonText);
  const suites = [];
  const results = data.testResults || [];
  for (const tr of results) {
    const file = tr.name ? path.relative(root, tr.name).split(path.sep).join('/') : '';
    const cases = [];
    for (const ar of tr.assertionResults || []) {
      const ancestors = Array.isArray(ar.ancestorTitles) ? ar.ancestorTitles : [];
      const status =
        ar.status === 'passed'
          ? 'passed'
          : ar.status === 'failed'
            ? 'failed'
            : 'skipped'; // pending / skipped / todo / disabled
      cases.push({
        id: `${file}::${ancestors.join(' > ')}::${ar.title || ar.fullName || 'case'}`,
        name: ar.title || ar.fullName || 'case',
        file,
        status,
        durationMs: typeof ar.duration === 'number' ? ar.duration : null,
        message: ar.status === 'failed' ? truncate((ar.failureMessages || [])[0] || '', 2000) : '',
      });
    }
    suites.push({ name: file || 'suite', cases });
  }
  return suites;
}
