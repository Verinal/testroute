// LCOV 覆盖率解析。TestRoute 零依赖：覆盖率由目标项目自己产出（vitest/jest/pytest 配 lcov reporter），
// 这里只负责把 lcov.info 解析成规范化结构，挂到 TestResult.coverage 与最终报告。
import path from 'node:path';
import fs from 'node:fs';
import { fail } from '../validate.js';
import { toPosix } from '../paths.js';

const MAX_FILES = 200; // result.json 只留前 200 个文件，全量数据在 lcov 源文件里

function pct(found, hit) {
  if (!found || found <= 0) return null;
  return Math.round((hit / found) * 1000) / 10;
}

export function parseLcov(lcovText, root) {
  const files = [];
  let cur = null;
  for (const raw of String(lcovText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('SF:')) {
      cur = { file: line.slice(3), linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0, branchesFound: 0, branchesHit: 0 };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('LF:')) {
      cur.linesFound = Number(line.slice(3)) || 0;
    } else if (line.startsWith('LH:')) {
      cur.linesHit = Number(line.slice(3)) || 0;
    } else if (line.startsWith('FNF:')) {
      cur.functionsFound = Number(line.slice(4)) || 0;
    } else if (line.startsWith('FNH:')) {
      cur.functionsHit = Number(line.slice(4)) || 0;
    } else if (line.startsWith('BRF:')) {
      cur.branchesFound = Number(line.slice(4)) || 0;
    } else if (line.startsWith('BRH:')) {
      cur.branchesHit = Number(line.slice(4)) || 0;
    } else if (line === 'end_of_record') {
      cur.linesPct = pct(cur.linesFound, cur.linesHit);
      cur.functionsPct = pct(cur.functionsFound, cur.functionsHit);
      cur.branchesPct = pct(cur.branchesFound, cur.branchesHit);
      cur.file = toPosix(path.relative(root, path.resolve(root, cur.file)));
      files.push(cur);
      cur = null;
    }
  }

  const sum = (key) => files.reduce((n, f) => n + (f[key] || 0), 0);
  const totals = {
    files: files.length,
    linesFound: sum('linesFound'),
    linesHit: sum('linesHit'),
    linesPct: pct(sum('linesFound'), sum('linesHit')),
    functionsFound: sum('functionsFound'),
    functionsHit: sum('functionsHit'),
    functionsPct: pct(sum('functionsFound'), sum('functionsHit')),
    branchesFound: sum('branchesFound'),
    branchesHit: sum('branchesHit'),
    branchesPct: pct(sum('branchesFound'), sum('branchesHit')),
  };
  return { totals, files };
}

// 解析 coverageFile 参数（相对 root 或绝对路径）。缺省时自动探测常见位置；显式给了但不存在 → 报错。
export function resolveCoverageFile(root, coverageFile = '') {
  const explicit = coverageFile && String(coverageFile).trim();
  const candidates = explicit
    ? [path.isAbsolute(explicit) ? explicit : path.join(root, explicit)]
    : [path.join(root, 'coverage', 'lcov.info'), path.join(root, 'coverage.lcov')];
  const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!found && explicit) {
    fail(
      'E_NOT_FOUND',
      `coverageFile 不存在: ${explicit}（相对于 root 或绝对路径，LCOV 格式；如 vitest --coverage 产出的 coverage/lcov.info）`
    );
  }
  return found || null;
}

export function applyCoverage(result, { root, coveragePath }) {
  if (!coveragePath) return; // 保持 result.coverage = { type: 'none' }
  const text = fs.readFileSync(coveragePath, 'utf8');
  const { totals, files } = parseLcov(text, root);
  result.coverage = {
    type: 'lcov',
    source: toPosix(path.relative(root, coveragePath)),
    totals,
    files: files.slice(0, MAX_FILES),
  };
  if (files.length > MAX_FILES) {
    result.warnings = result.warnings || [];
    result.warnings.push(`coverage 文件数 ${files.length} 超过 ${MAX_FILES}，result.json 已截断（全量数据见 ${result.coverage.source}）`);
  }
}
