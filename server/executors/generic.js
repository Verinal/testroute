import fs from 'node:fs';
import path from 'node:path';
import { emptySummary } from '../result.js';

// 通用执行器：跑任意命令行（自定义冒烟脚本、npm run xxx、node --test 等）。
// 判定依据 exit code；并尽力从输出解析**用例级结果**，让归档的 summary/checkpoint/报告
// 拿到逐用例明细而不是只有汇总数字（"passed 但无用例级结果"会让报告失信——update_phase
// 的用例级结果门禁会拦下这种 passed）。
//
// 识别的结果来源（按优先级）：
// 1) 结果文件: 环境变量 TESTROUTE_RESULTS_FILE 指向的 JSON 数组，元素为
//    { name, status: "passed"|"failed"|"skipped", message?, durationMs? } 或 "PASS | 名称" 字符串
// 2) 逐行结果: 以 "PASS |" / "FAIL |" / "SKIP |"（或 "ok - " / "not ok - "，TAP 的 "not ok N - "）开头的行，
//    竖线/破折号后是用例名 → 解析成具名用例
// 3) 汇总行:  Total: 25, Passed: 23, Failed: 2   （skipped = total-passed-failed）
//    ——只有汇总行解析不出用例名，cases 仍为空；这种 run 不许以 passed 收口（门禁在 updatePhase）
// 4) exit code 兜底
const LINE_RE = /^(PASS\s*\||FAIL\s*\||SKIP\s*\||ok\s+-\s|not\s+ok(?:\s+\d+)?\s+-\s)/;
const SUMMARY_RE = /Total:\s*(\d+),\s*Passed:\s*(\d+),\s*Failed:\s*(\d+)/i;

function caseFromLine(line) {
  const t = line.trim();
  const m = LINE_RE.exec(t);
  if (!m) return null;
  const head = m[1];
  let name = t.slice(head.length).trim();
  if (!name) return null;
  let status = 'passed';
  if (/^FAIL/.test(head) || /^not ok/.test(head)) status = 'failed';
  else if (/^SKIP/.test(head)) status = 'skipped';
  return { name, status };
}

function caseFromEntry(e) {
  if (typeof e === 'string') return caseFromLine(e) || { name: e.trim(), status: 'passed' };
  if (!e || typeof e !== 'object' || typeof e.name !== 'string' || !e.name.trim()) return null;
  const status = ['passed', 'failed', 'skipped'].includes(e.status) ? e.status : 'passed';
  const c = { name: e.name.trim(), status };
  if (typeof e.message === 'string' && e.message.trim()) c.message = e.message.trim();
  if (Number.isFinite(e.durationMs)) c.durationMs = e.durationMs;
  return c;
}

export const generic = {
  id: 'generic',
  label: '通用命令',
  artifactName: null,
  buildCommand({ command }) {
    return command;
  },
  parse({ proc, outDir }) {
    const stdout = String(proc.stdout || '');
    const stderr = String(proc.stderr || '');
    const summary = emptySummary();
    const warnings = [];
    let parseStatus = 'exit-code-only';

    // ① 结果文件（最结构化）：逐用例 name/status/message
    let cases = [];
    if (outDir) {
      try {
        const rf = path.join(outDir, 'case-results.json');
        if (fs.statSync(rf).isFile()) {
          const arr = JSON.parse(fs.readFileSync(rf, 'utf8'));
          if (Array.isArray(arr)) {
            cases = arr.map(caseFromEntry).filter(Boolean);
            if (cases.length) parseStatus = 'results-file';
          }
        }
      } catch {
        /* 结果文件缺失/损坏 → 落到逐行解析 */
      }
    }

    // ② 逐行结果（PASS | 名称 / ok - 名称 / not ok - 名称）。stdout 为主，stderr 并入扫描
    //（不少 runner 把失败行打到 stderr，如 tape/自研 assert 脚本），按 内容+状态 去重
    if (!cases.length) {
      const seen = new Set();
      for (const line of `${stdout}\n${stderr}`.split(/\r?\n/)) {
        const c = caseFromLine(line);
        if (!c) continue;
        const key = `${c.status}|${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cases.push(c);
      }
      if (cases.length) parseStatus = 'stdout-cases';
    }

    // ③ 汇总行：只有数字，没有用例名（cases 仍为空——汇总行不算用例级结果）
    const totalLine = SUMMARY_RE.exec(stdout);
    if (cases.length) {
      // 用例级结果优先：summary 从逐用例推导（汇总行数字若与逐用例矛盾，以用例为准并警告）
      summary.total = cases.length;
      summary.passed = cases.filter((c) => c.status === 'passed').length;
      summary.failed = cases.filter((c) => c.status === 'failed').length;
      summary.skipped = cases.filter((c) => c.status === 'skipped').length;
      if (totalLine) {
        const lt = Number(totalLine[1]);
        const lp = Number(totalLine[2]);
        if (lt !== summary.total || lp !== summary.passed) {
          warnings.push(
            `stdout 汇总行（Total: ${lt}, Passed: ${lp}）与逐用例结果（${summary.total} 条 / ${summary.passed} 过）不一致，以逐用例为准——汇总行只是打印数字，用例级结果才是账本。`
          );
        }
      }
    } else if (totalLine) {
      summary.total = Number(totalLine[1]);
      summary.passed = Number(totalLine[2]);
      summary.failed = Number(totalLine[3]);
      summary.skipped = Math.max(0, summary.total - summary.passed - summary.failed);
      parseStatus = 'stdout-summary';
      warnings.push(
        'generic run 只解析到汇总行、没有任何用例级结果——update_phase 标 passed 会被用例级结果门禁拦下。' +
          '让脚本逐用例写 TESTROUTE_RESULTS_FILE 指向的文件（JSON 数组，元素 {name, status, message?}），或逐行输出 "PASS | 用例名" / "FAIL | 用例名"。'
      );
    } else if (proc.exitCode === 0) {
      warnings.push(
        'generic run 未解析到任何用例级结果（仅 exit code）——update_phase 标 passed 会被用例级结果门禁拦下。' +
          '让脚本逐用例写 TESTROUTE_RESULTS_FILE 指向的文件，或逐行输出 "PASS | 用例名" / "FAIL | 用例名"，或输出 "Total: N, Passed: X, Failed: Y" 汇总行。'
      );
    }

    // 失败时若无任何用例级结果，合成一条伪用例（id='run'，与 record_triage 的约定 caseId 一致）：
    // 让 failures 列表与失败指纹能锚定这条失败，而不是只靠 summary 数字
    const commandFailed = proc.exitCode !== 0 || summary.failed > 0;
    const tailLine = (s) =>
      String(s || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || '';
    const pseudoCase = commandFailed && !cases.length
      ? [
          {
            name: 'generic',
            cases: [
              {
                id: 'run',
                name: '命令执行（generic 伪用例）',
                status: 'failed',
                message: tailLine(stderr) || tailLine(stdout) || `命令退出码 ${proc.exitCode}`,
              },
            ],
          },
        ]
      : [];

    const suites = cases.length
      ? [
          {
            name: 'generic',
            cases: cases.map((c) => {
              const out = { id: c.name, ...c };
              if (out.status === 'failed' && !out.message) {
                out.message = tailLine(stderr) || tailLine(stdout) || '用例失败';
              }
              return out;
            }),
          },
        ]
      : pseudoCase;

    return {
      suites,
      summary,
      parseStatus,
      artifacts: [],
      warnings,
    };
  },
};
