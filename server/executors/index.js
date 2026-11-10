// 执行器注册表 + 统一执行入口（构建命令 → 执行 → 解析 → 规范化 TestResult）。
// 支持两类执行器：外部命令型（buildCommand + parse）与内置型（run 直接管执行，如 health/sca）。
import path from 'node:path';
import fs from 'node:fs';
import { runCommand } from '../run.js';
import { truncate } from '../validate.js';
import { statusFromRun } from '../result.js';
import { vitest, jestAdapter } from './jsonreport.js';
import { pytest } from './pytest.js';
import { generic } from './generic.js';
import { health } from './health.js';
import { sca } from './sca.js';
import { e2e } from './e2e.js';
import { playwright, verifyEvidenceGate } from './playwright.js';
import { secrets } from './secrets.js';
import { securityProbe } from './securityprobe.js';
import { engineIdentity } from '../version.js';

export const EXECUTORS = {
  vitest,
  jest: jestAdapter,
  pytest,
  generic,
  health,
  sca,
  e2e,
  playwright,
  secrets,
  'security-probe': securityProbe,
};

export function getExecutor(id) {
  const ex = EXECUTORS[id];
  if (!ex) {
    const ids = Object.keys(EXECUTORS).join(' | ');
    throw new Error(`未知执行器 "${id}"（可选: ${ids}）`);
  }
  return ex;
}

export async function execute({
  root,
  executorId,
  command,
  paths = [],
  outDir,
  timeoutMs = 300000,
  pythonBin,
  targets = [],
  steps = [],
  archiveDir,
  config = {},
  evidence = 'full',
  evidenceReason = '',
}) {
  const ex = getExecutor(executorId);
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  let cmd;
  let proc;
  let parsed;
  let outFile = null;
  let plan = null; // playwright 证据编排结果（wrapper 路径/命令补丁/notes）

  if (typeof ex.run === 'function') {
    // 内置执行器：自带执行逻辑（archiveDir/config 供 security-probe 等读取盘点与阶段配置）
    ({ proc, parsed } = await ex.run({ root, targets, steps, timeoutMs, archiveDir, config }));
    cmd = proc.command || `(内置执行器 ${ex.id})`;
  } else {
    outFile = ex.artifactName ? path.join(outDir, ex.artifactName) : null;
    // playwright：证据链硬约定（evidence=full 默认）——先做证据编排（生成证据 wrapper config、
    // 给自定义命令补 --trace on/--output/--config、探测 ffmpeg 决定 video 开关），再据此构建命令
    if (ex.id === 'playwright' && typeof ex.evidencePlan === 'function') {
      plan = ex.evidencePlan({ root, outDir, command, evidence });
      command = plan.command ?? command;
    }
    cmd = executorId === 'generic' ? command : ex.buildCommand({ paths, outFile, command, pythonBin, evidence, plan });
    const env = {
      // API 覆盖清单落点（全部外部执行器共用）：沙箱脚本把本次触及的端点写入这个文件（JSON 数组），
      // run_tests 收集进 run 记录，finalize 报告据此生成「盘点 vs 实测」API 覆盖对照
      TESTROUTE_COVERAGE_FILE: path.join(outDir, 'api-coverage.json'),
    };
    // 端点/页面盘点快照落点（run_tests 在调用前把盘点写入归档）：存在才注入，
    // 沙箱脚本据此对齐盘点路径（路径参数用 {p}），系统性铺满端点而不是凭感觉挑几个
    try {
      if (archiveDir && fs.statSync(path.join(archiveDir, 'api-endpoints.json')).isFile()) {
        env.TESTROUTE_ENDPOINTS_FILE = path.join(archiveDir, 'api-endpoints.json');
      }
    } catch {
      /* 无盘点快照 → 不设变量 */
    }
    try {
      if (archiveDir && fs.statSync(path.join(archiveDir, 'web-pages.json')).isFile()) {
        env.TESTROUTE_PAGES_FILE = path.join(archiveDir, 'web-pages.json');
      }
    } catch {
      /* 无页面盘点 → 不设变量 */
    }
    // 页面覆盖上报落点：browser-e2e 用例把实际访问过的页面路由写入（JSON 数组，"/login" 或 {path}）
    env.TESTROUTE_PAGES_COVERAGE_FILE = path.join(outDir, 'pages-coverage.json');
    // 逐用例结果上报落点：generic 脚本把每个用例的 {name, status, message?} 写入（JSON 数组）——
    // 只打汇总行/只有 exit code 的 run 没有用例级结果，update_phase 标 passed 会被门禁拦下
    env.TESTROUTE_RESULTS_FILE = path.join(outDir, 'case-results.json');
    // 约定资料夹 .testfile/（仅根目录生效）：存在时暴露绝对路径给沙箱脚本只读取用
    try {
      if (fs.statSync(path.join(root, '.testfile')).isDirectory()) {
        env.TESTROUTE_TESTFILE_DIR = path.join(root, '.testfile');
      }
    } catch {
      /* 无 .testfile → 不设变量（兼容） */
    }
    if (executorId === 'playwright' && outFile) {
      env.PLAYWRIGHT_JSON_OUTPUT_DIR = outDir;
      env.PLAYWRIGHT_JSON_OUTPUT_NAME = path.basename(outFile);
      // 显式逐步截图的落点（用例里 page.screenshot 引用），与 --output 同目录
      env.TESTROUTE_ARTIFACTS_DIR = path.join(outDir, 'artifacts');
    }
    proc = await runCommand({ cwd: root, command: cmd, timeoutMs, env });
    parsed = ex.parse({ root, outFile, proc, command: cmd, startedAt, outDir });
  }

  const durationMs = Date.now() - t0;
  const finishedAt = new Date().toISOString();

  const summary = parsed.summary || { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 };
  if (!summary.durationMs) summary.durationMs = durationMs; // 执行器未给出用例耗时 → 回退为整次运行墙钟时长

  let status = statusFromRun({ exitCode: proc.exitCode, summary });
  if (status === 'passed-empty' && proc.exitCode === 0) status = 'passed';
  if (parsed._status && summary.total === 0) status = parsed._status;
  if (proc.timedOut) status = 'failed';

  const result = {
    schemaVersion: 1,
    engine: engineIdentity(), // 版本锚：这份 result.json 由哪个版本/哪次构建的引擎产出
    runId: null, // writeRun 时回填
    phaseId: null, // 调用方回填
    executor: executorId,
    command: cmd,
    startedAt,
    finishedAt,
    durationMs,
    exitCode: proc.exitCode,
    timedOut: !!proc.timedOut,
    status,
    parseStatus: parsed.parseStatus,
    summary: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      skipped: summary.skipped,
      durationMs: summary.durationMs || 0,
    },
    suites: parsed.suites || [],
    coverage: { type: 'none' },
    artifacts: parsed.artifacts || [],
    raw: {
      stdoutTail: truncate(proc.stdout, 4000),
      stderrTail: truncate(proc.stderr, 4000),
    },
    triage: null,
    warnings: [
      ...(parsed.warnings || []),
      ...(plan?.notes || []),
      ...(proc.timedOut ? [`执行超时（>${timeoutMs}ms），进程树已被终止`] : []),
      ...(proc.spawnError ? [`spawn 异常: ${proc.spawnError}`] : []),
    ],
  };

  // 证据门禁（playwright）：run 结束后核对 trace/截图/video 附件是否真的落地；off 时只留痕不核对
  if (ex.id === 'playwright') {
    if (evidence === 'off') {
      result.evidenceGate = { level: 'off', reason: evidenceReason, compliant: null };
      result.warnings.push('证据链已显式关闭（evidence=off）——本 run 无 trace/video/截图证据，理由已留痕。');
    } else {
      const gate = verifyEvidenceGate({ suites: parsed.suites || [], level: evidence, videoEnabled: plan ? plan.videoEnabled : true });
      result.evidenceGate = { ...gate, reason: evidenceReason || null };
      result.warnings.push(...gate.warnings);
    }
  }

  return { result, proc, outFile, command: cmd };
}
