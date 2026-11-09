import { emptySummary } from '../result.js';

// 通用执行器：跑任意命令行（自定义冒烟脚本、npm run xxx、node --test 等）。
// 判定依据 exit code；并尽力从 stdout 解析用例计数，让归档的 summary/checkpoint 拿到真实数字
// 而不是 0/0/0（否则只看 route.json 的人会以为什么都没跑）。
//
// 识别的输出约定（按优先级）：
// 1) 汇总行:  Total: 25, Passed: 23, Failed: 2   （TestRoute 生成脚本的约定，skipped = total-passed-failed）
// 2) 逐行结果: 以 "PASS |" / "FAIL |"（或 "ok - " / "not ok - "）开头的行计数
export const generic = {
  id: 'generic',
  label: '通用命令',
  artifactName: null,
  buildCommand({ command }) {
    return command;
  },
  parse({ proc }) {
    const stdout = String(proc.stdout || '');
    const summary = emptySummary();
    let parseStatus = 'exit-code-only';

    const totalLine = /Total:\s*(\d+),\s*Passed:\s*(\d+),\s*Failed:\s*(\d+)/i.exec(stdout);
    if (totalLine) {
      summary.total = Number(totalLine[1]);
      summary.passed = Number(totalLine[2]);
      summary.failed = Number(totalLine[3]);
      summary.skipped = Math.max(0, summary.total - summary.passed - summary.failed);
      parseStatus = 'stdout-summary';
    } else {
      let passed = 0;
      let failed = 0;
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (/^(PASS\s*\||ok\s+-\s)/.test(t)) passed++;
        else if (/^(FAIL\s*\||not ok\s+-\s)/.test(t)) failed++;
      }
      if (passed + failed > 0) {
        summary.passed = passed;
        summary.failed = failed;
        summary.total = passed + failed;
        parseStatus = 'stdout-lines';
      }
    }

    const warnings =
      parseStatus === 'exit-code-only'
        ? [
            'generic 执行器未能从 stdout 解析用例计数（约定：输出一行 "Total: N, Passed: X, Failed: Y"，或逐行 "PASS |"/"FAIL |"），判定依据为 exit code',
          ]
        : [];

    // 失败时合成一条伪用例（id='run'，与 record_triage 的约定 caseId 一致）：
    // 让 failures 列表与失败指纹能锚定这条失败，而不是只靠 summary 数字
    const commandFailed = proc.exitCode !== 0 || summary.failed > 0;
    const tailLine = (s) =>
      String(s || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() || '';
    const pseudoCase = commandFailed
      ? [
          {
            name: 'generic',
            cases: [
              {
                id: 'run',
                name: '命令执行（generic 伪用例）',
                status: 'failed',
                message: tailLine(proc.stderr) || tailLine(proc.stdout) || `命令退出码 ${proc.exitCode}`,
              },
            ],
          },
        ]
      : [];

    return {
      suites: pseudoCase,
      summary,
      parseStatus,
      artifacts: [],
      warnings,
    };
  },
};
