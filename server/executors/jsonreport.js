import path from 'node:path';
import fs from 'node:fs';
import { truncate } from '../validate.js';
import { summarizeCases, emptySummary } from '../result.js';
import { parseJestJson } from './jestjson.js';

function quote(p) {
  return `"${String(p).replace(/"/g, '')}"`;
}

function readOutFile(outFile) {
  try {
    if (fs.existsSync(outFile)) return fs.readFileSync(outFile, 'utf8');
  } catch {}
  return null;
}

// ---------- vitest ----------
export const vitest = {
  id: 'vitest',
  label: 'Vitest',
  artifactName: 'vitest-report.json',
  buildCommand({ paths, outFile, command }) {
    if (command && String(command).trim()) return String(command).trim();
    const p = (paths || []).map(quote).join(' ');
    return `npx --no-install vitest run ${p} --reporter=json --outputFile=${quote(outFile)}`.replace(/\s+/g, ' ').trim();
  },
  parse({ root, outFile, proc }) {
    const text = readOutFile(outFile);
    if (text) {
      try {
        const suites = parseJestJson(text, root);
        const summary = summarizeCases(suites.flatMap((s) => s.cases));
        return {
          suites,
          summary,
          parseStatus: 'json',
          artifacts: [{ kind: 'json', path: outFile }],
          warnings: [],
        };
      } catch (e) {
        return fallback(proc, `JSON 报告解析失败: ${e.message}`);
      }
    }
    return fallback(proc, '未找到 JSON 报告文件（可能 vitest 不存在或版本不支持 --outputFile）');
  },
};

// ---------- jest ----------
export const jestAdapter = {
  id: 'jest',
  label: 'Jest',
  artifactName: 'jest-report.json',
  buildCommand({ paths, outFile, command }) {
    if (command && String(command).trim()) return String(command).trim();
    const p = (paths || []).map(quote).join(' ');
    return `npx --no-install jest --ci --passWithNoTests ${p} --json --outputFile=${quote(outFile)}`.replace(/\s+/g, ' ').trim();
  },
  parse({ root, outFile, proc }) {
    const text = readOutFile(outFile);
    if (text) {
      try {
        const suites = parseJestJson(text, root);
        const summary = summarizeCases(suites.flatMap((s) => s.cases));
        return {
          suites,
          summary,
          parseStatus: 'json',
          artifacts: [{ kind: 'json', path: outFile }],
          warnings: [],
        };
      } catch (e) {
        return fallback(proc, `JSON 报告解析失败: ${e.message}`);
      }
    }
    return fallback(proc, '未找到 JSON 报告文件（可能 jest 未安装或 --outputFile 失败）');
  },
};

function fallback(proc, warning) {
  const summary = emptySummary();
  const status = proc.exitCode === 0 ? 'passed-empty' : 'failed';
  return {
    suites: [],
    summary,
    parseStatus: 'exit-code-only',
    artifacts: [],
    warnings: [warning, '已降级为 exit code 判定，用例级结果不可用'],
    _status: status,
  };
}
