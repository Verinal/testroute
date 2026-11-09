// 归档自验（完整性取证）：独立只读检查器——不复算、不修复、不改任何归档文件。
// 背景：宿主/Agent 可以绕过 testroute 工具手写归档（伪造 manifest 事件、补造 runs/*/result.json、
// 手写 final-report.md）。get_route 的 reportIntegrity 只覆盖报告封章一处，且只能"被动"发现；
// 这里把三类证据做成主动自验入口（MCP: testroute_verify_archive / CLI: scripts/check-archive.mjs）：
//   ① manifest 事件连续性：事件词表 + detail 格式 + 时间戳单调 + run 三方对账 + 阶段状态机
//   ② result.json 工具指纹：写入端（executors/index.js execute()）必填字段集 + env/command 签名类
//   ③ 报告封章：final-report.md ⇄ route.report.sha256 ⇄ finalize 事件三方一致（复用 verifyReportSeal）
// 判定：fail>0 → TAMPERED（任何一条 fail 都足以整份作废）；warn>0 → SUSPECT；否则 TRUSTED。
// 事件词表与 detail 格式必须与写入端同步演进（appendEvent 全部调用点在 archive.js / tools.js）。
import path from 'node:path';
import fs from 'node:fs';
import { MANIFEST_FILE, verifyReportSeal } from './archive.js';
import { ROUTE_FILE } from './route.js';
import { readJson } from './paths.js';

// manifest 事件词表（与写入端一致；新增事件类型时此处必须同步）
const EVENT_TYPES = new Set([
  'init', 'gitignore', 'scan', 'save-route', 'approve', 'route-reset',
  'phase', 'triage-carry', 'run', 'run-complete', 'snapshot', 'probe',
  'triage', 'provision', 'record-change', 'testgate-ack', 'finalize',
]);

// 阶段状态词表（route.json 与 phase 事件共用）
const PHASE_STATUSES = new Set(['pending', 'in-progress', 'awaiting-approval', 'passed', 'failed', 'blocked', 'skipped']);
// run 状态词表（result.status 的可能取值，含解析降级态）
const RUN_STATUSES = new Set(['passed', 'failed', 'skipped', 'blocked', 'passed-empty', 'parse-error', 'exit-code-only']);
// 需要前置 in-progress 才算合法推进的终态
const TERMINAL_PHASE = new Set(['passed', 'failed', 'blocked', 'skipped']);

// detail 格式（写入端是确定性格式，手搓条目几乎必然对不上）
const RE_RUN = /^阶段 (.+) 执行完成: (.+)$/;
const RE_RUN_COMPLETE = /^(.+) → ([a-z-]+)(（复跑识别 flaky: \d+）)?$/;
const RE_PHASE = /^([^:：]+): ([a-z-]+)(（测试脚本改动已确认，基线重建）)?$/;
const RE_TRIAGE = /^(\S+) 归因 \d+ 条$/;
const RE_TRIAGE_CARRY = /^(\S+) 继承 (\S+) 的归因（失败指纹一致）$/;
const RE_SNAPSHOT = /^阶段 (.+) 快照 \d+ 个文件$/;
const RE_FINALIZE = /^最终报告已生成，outcome=\S+?(（路线从未被批准，标记 abandoned）)?，report-sha256=[0-9a-f]{16}…$/;
const RE_SAVE_ROUTE = /^路线(已保存|已批准)（\d+ 个阶段）$/;
const RE_RECORD_CHANGE = /^\d+ 条改动记录（累计 \d+）$/;
const RE_TESTGATE_ACK = /^用户知情确认测试脚本改动，基线已重建（modified=\d+, deleted=\d+）$/;

// run 事件与 result.finishedAt 的最大合理时差：writeRun 在执行结束的同一时刻落盘
const RUN_EVENT_GAP_WARN_MS = 5 * 60_000;
const RUN_EVENT_GAP_FAIL_MS = 60 * 60_000;
// result.json 的 mtime 不可能早于 finishedAt（先定 finishedAt 再写文件）；无 triage 复写时两者只差数秒
const MTIME_SKEW_MS = 2 * 60_000;
const MTIME_LATE_WARN_MS = 30 * 60_000;

function finding(level, area, subject, message) {
  return { level, area, subject: subject || '', message };
}

function parseIso(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

// result.json 必填字段（executors/index.js execute() 无条件写入的契约面）。
// env/command 不在此列：它们单独走「工具签名类」判定（全无 = legacy 可宽容，半有 = 手工拼装必 fail），
// 若列为必填会把真旧版产出误判成硬伤，legacy 宽容就失去意义。
const REQUIRED_RESULT_FIELDS = [
  'schemaVersion', 'runId', 'phaseId', 'executor',
  'startedAt', 'finishedAt', 'durationMs', 'exitCode', 'timedOut',
  'status', 'parseStatus', 'summary', 'suites', 'coverage',
  'artifacts', 'raw', 'git', 'warnings',
];

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 单个 result.json 的工具指纹核查；返回 { fails, stamped, legacy }（fails 空 = 指纹完好）
function resultFingerprintFails(result, runId) {
  const fails = [];
  const missing = [];
  for (const key of REQUIRED_RESULT_FIELDS) {
    if (result[key] === undefined) missing.push(key);
  }
  if (missing.length) {
    fails.push(`缺必填字段: ${missing.join(', ')}（写入端 execute() 无条件写入这些字段——缺项说明不是工具产出）`);
  }
  if (result.runId !== undefined && result.runId !== runId) {
    fails.push(`result.runId=${result.runId} 与目录名 ${runId} 不符`);
  }

  const envOk = isPlainObject(result.env) && typeof result.env.platform === 'string' && typeof result.env.node === 'string';
  const cmdOk = typeof result.command === 'string' && result.command.length > 0;
  if (envOk !== cmdOk) {
    fails.push(`签名残缺: env=${envOk ? '有' : '无'} / command=${cmdOk ? '有' : '无'}——半签名是手工拼装的典型痕迹`);
  }
  return { fails, stamped: envOk && cmdOk, legacy: !envOk && !cmdOk };
}

// ---------- 残骸检测（init_archive 的复用/重置判定用） ----------
// 只读扫描 manifest 事件流，返回 { corrupt, runEventIds, unknownTypes }：
//   runEventIds = run/run-complete 事件宣告过的 runId（调用方结合 runs/ 盘点判断是否已成孤儿——
//   result.json 全缺时，任何 run 事件都是孤儿，续用会让事件永远无法对账）；
//   unknownTypes = 不在写入端词表内的事件类型（伪造痕迹）。
// manifest 损坏时返回 corrupt=true 而不抛错——残骸路径需要"损坏也可判"，不能用 readJson（直接 fail）。
function scanManifestTaints(archiveDir) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, MANIFEST_FILE), 'utf8'));
  } catch {
    return { corrupt: true, runEventIds: [], unknownTypes: [] };
  }
  const events = Array.isArray(manifest?.events) ? manifest.events : [];
  const runEventIds = new Set();
  const unknownTypes = new Set();
  for (const ev of events) {
    const type = ev?.type;
    const detail = typeof ev?.detail === 'string' ? ev.detail : '';
    if (!EVENT_TYPES.has(type)) {
      unknownTypes.add(String(type ?? '(无 type)'));
      continue;
    }
    if (type === 'run') {
      const m = RE_RUN.exec(detail);
      if (m) runEventIds.add(m[2]);
    } else if (type === 'run-complete') {
      const m = RE_RUN_COMPLETE.exec(detail);
      if (m) runEventIds.add(m[1]);
    }
  }
  return { corrupt: false, runEventIds: [...runEventIds], unknownTypes: [...unknownTypes] };
}

function verifyArchiveIntegrity(archiveDir, { allowLegacy = false } = {}) {
  const fails = [];
  const warns = [];
  const infos = [];

  // ---------- 0. 归档骨架 ----------
  const manifestPath = path.join(archiveDir, MANIFEST_FILE);
  const routePath = path.join(archiveDir, ROUTE_FILE);
  const manifest = readJson(manifestPath);
  const route = readJson(routePath);
  if (!manifest) {
    fails.push(finding('fail', 'manifest', 'manifest.json', '缺失或损坏——归档无法自证事件流（正常建档必写 manifest）'));
    return { archiveDir, verdict: 'TAMPERED', fails, warns, infos, stats: { events: 0, runs: 0, phases: 0 } };
  }
  if (!Array.isArray(manifest.events)) {
    fails.push(finding('fail', 'manifest', 'events', 'manifest.events 不是数组——事件流被改坏'));
    return { archiveDir, verdict: 'TAMPERED', fails, warns, infos, stats: { events: 0, runs: 0, phases: 0 } };
  }
  if (!route) {
    // 尚未起草路线的正常空档不算硬伤：init_archive 刚建的归档、残骸就地重置后的归档本来就没有
    // route.json（工具自身认可的状态）。一旦事件流里有"应有一条路线"的痕迹（save-route/phase/run/
    // finalize…）或 runs/ 已有产出，route 缺失就是证据被抽走 → 硬伤。
    const SCAFFOLD_TYPES = new Set(['init', 'gitignore', 'scan', 'probe', 'provision', 'record-change']);
    const virgin =
      manifest.events.every((ev) => SCAFFOLD_TYPES.has(ev?.type)) &&
      (!fs.existsSync(path.join(archiveDir, 'runs')) ||
        fs.readdirSync(path.join(archiveDir, 'runs')).every((n) => !fs.statSync(path.join(archiveDir, 'runs', n)).isDirectory())) &&
      !fs.existsSync(path.join(archiveDir, 'final-report.md'));
    if (virgin) {
      infos.push(finding('info', 'route', 'route.json', '尚未起草路线（save_route 后生成）——空档正常状态'));
    } else {
      fails.push(finding('fail', 'route', 'route.json', '缺失或损坏——无路线即无准入与执行依据'));
    }
  }

  const events = manifest.events;
  const stats = { events: events.length, runs: 0, phases: 0, stamped: 0, legacy: 0, hasReport: fs.existsSync(path.join(archiveDir, 'final-report.md')) };

  // ---------- ① manifest 事件连续性 ----------
  const runEvents = new Map(); // runId -> { at, index, phaseId }
  const runCompletes = new Map(); // runId -> [{ at, index, status }]
  const phaseEvents = new Map(); // phaseId -> [{ at, index, status }]
  let prevTs = null;
  let zeroMsRun = 0; // 连续毫秒为 0 的事件数
  let hasNonZeroMs = false;

  events.forEach((ev, index) => {
    const at = ev?.at;
    const type = ev?.type;
    const detail = typeof ev?.detail === 'string' ? ev.detail : '';
    const subject = `events[${index}] ${type || '(无 type)'}`;

    if (!EVENT_TYPES.has(type)) {
      fails.push(finding('fail', 'manifest', subject, `未知事件类型 "${type}"——不在写入端词表内（伪造事件）`));
      return;
    }
    const ts = parseIso(at);
    if (ts === null) {
      fails.push(finding('fail', 'manifest', subject, `时间戳非法: ${JSON.stringify(at)}`));
      return;
    }
    if (!detail && !['probe'].includes(type)) {
      fails.push(finding('fail', 'manifest', subject, 'detail 为空——写入端事件必带说明'));
    }
    if (prevTs !== null && ts < prevTs) {
      fails.push(finding('fail', 'manifest', subject, `时间戳倒退（${at} 早于上一事件）`));
    }
    prevTs = ts;

    const ms = ts % 1000;
    if (ms === 0) {
      zeroMsRun++;
    } else {
      if (zeroMsRun >= 3 && hasNonZeroMs) {
        warns.push(finding('warn', 'time', `events[${index - zeroMsRun}..${index - 1}]`, `${zeroMsRun} 个连续事件毫秒位全为 .000——真实事件流不会整批落在整秒上（手工编造的典型指纹）`));
      }
      zeroMsRun = 0;
      hasNonZeroMs = true;
    }

    switch (type) {
      case 'run': {
        const m = RE_RUN.exec(detail);
        if (!m) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 run 事件格式（期望「阶段 <phase> 执行完成: <runId>」）: ${detail}`));
          break;
        }
        if (!m[2].startsWith(`${m[1]}-`)) {
          fails.push(finding('fail', 'manifest', subject, `runId ${m[2]} 与阶段 ${m[1]} 前缀不符`));
        }
        runEvents.set(m[2], { at: ts, index, phaseId: m[1] });
        break;
      }
      case 'run-complete': {
        const m = RE_RUN_COMPLETE.exec(detail);
        if (!m) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 run-complete 格式（期望「<runId> → <状态>」）: ${detail}`));
          break;
        }
        if (!RUN_STATUSES.has(m[2])) {
          fails.push(finding('fail', 'manifest', subject, `未知 run 状态 "${m[2]}"`));
        }
        const list = runCompletes.get(m[1]) || [];
        list.push({ at: ts, index, status: m[2] });
        runCompletes.set(m[1], list);
        break;
      }
      case 'phase': {
        const m = RE_PHASE.exec(detail);
        if (!m) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 phase 事件格式（期望「<phase>: <状态>」）: ${detail}`));
          break;
        }
        if (!PHASE_STATUSES.has(m[2])) {
          fails.push(finding('fail', 'manifest', subject, `未知阶段状态 "${m[2]}"`));
        }
        const list = phaseEvents.get(m[1]) || [];
        list.push({ at: ts, index, status: m[2] });
        phaseEvents.set(m[1], list);
        break;
      }
      case 'triage': {
        if (!RE_TRIAGE.test(detail)) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 triage 格式（期望「<runId> 归因 N 条」）: ${detail}`));
        }
        break;
      }
      case 'triage-carry': {
        if (!RE_TRIAGE_CARRY.test(detail)) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 triage-carry 格式: ${detail}`));
        }
        break;
      }
      case 'snapshot': {
        if (!RE_SNAPSHOT.test(detail)) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 snapshot 格式（期望「阶段 <phase> 快照 N 个文件」）: ${detail}`));
        }
        break;
      }
      case 'finalize': {
        if (!RE_FINALIZE.test(detail)) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合 finalize 格式（期望「最终报告已生成，outcome=…，report-sha256=…」）: ${detail}`));
        }
        break;
      }
      case 'save-route':
      case 'approve': {
        if (!RE_SAVE_ROUTE.test(detail) && detail !== '重复 approve（幂等：返回现状，未覆盖任何内容）') {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合路线保存/批准格式: ${detail}`));
        }
        break;
      }
      case 'record-change': {
        if (!RE_RECORD_CHANGE.test(detail)) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合改动记录格式: ${detail}`));
        }
        break;
      }
      case 'testgate-ack': {
        if (!RE_TESTGATE_ACK.test(detail)) {
          fails.push(finding('fail', 'manifest', subject, `detail 不符合测试脚本基线确认格式: ${detail}`));
        }
        break;
      }
      default:
        break; // init/gitignore/scan/probe/route-reset/provision：类型已知即可，文案允许演进
    }
  });
  if (zeroMsRun >= 3 && hasNonZeroMs) {
    warns.push(finding('warn', 'time', `events[${events.length - zeroMsRun}..${events.length - 1}]`, `${zeroMsRun} 个连续事件毫秒位全为 .000——手工编造的典型指纹`));
  }

  // ---------- ② run 三方对账（run 事件 ⇄ run-complete ⇄ runs/ 目录 ⇄ route 引用） ----------
  const runsDir = path.join(archiveDir, 'runs');
  const runDirs = fs.existsSync(runsDir)
    ? fs.readdirSync(runsDir).filter((n) => fs.statSync(path.join(runsDir, n)).isDirectory())
    : [];
  stats.runs = runDirs.length;

  for (const [runId, ev] of runEvents) {
    const resultPath = path.join(runsDir, runId, 'result.json');
    if (!fs.existsSync(resultPath)) {
      fails.push(finding('fail', 'result', runId, 'manifest 有 run 事件，但 runs/ 下没有 result.json——执行记录被抽走'));
      continue;
    }
    const result = readJson(resultPath);
    if (!result || typeof result !== 'object') {
      fails.push(finding('fail', 'result', runId, 'result.json 无法解析'));
      continue;
    }
    const fp = resultFingerprintFails(result, runId);
    for (const message of fp.fails) fails.push(finding('fail', 'result', runId, message));
    if (fp.stamped) stats.stamped++;
    if (fp.legacy) stats.legacy++;

    // 时间自洽：run 事件发生在 writeRun 时刻（≈ finishedAt）；mtime 不可能早于 finishedAt
    const finishedAt = parseIso(result.finishedAt);
    const startedAt = parseIso(result.startedAt);
    if (finishedAt === null) {
      fails.push(finding('fail', 'result', runId, `finishedAt 非法: ${JSON.stringify(result.finishedAt)}`));
    }
    if (startedAt !== null && finishedAt !== null && startedAt > finishedAt) {
      fails.push(finding('fail', 'result', runId, 'startedAt 晚于 finishedAt——时间线倒置'));
    }
    if (finishedAt !== null) {
      const gap = ev.at - finishedAt;
      if (gap < -1000) {
        fails.push(finding('fail', 'time', runId, `run 事件时间早于 result.finishedAt ${Math.round(-gap / 1000)}s——事件不可能先于执行结束`));
      } else if (gap > RUN_EVENT_GAP_FAIL_MS) {
        fails.push(finding('fail', 'time', runId, `run 事件比 finishedAt 晚 ${Math.round(gap / 60000)} 分钟——writeRun 与执行结束同刻落盘，不可能差这么久`));
      } else if (gap > RUN_EVENT_GAP_WARN_MS) {
        warns.push(finding('warn', 'time', runId, `run 事件比 finishedAt 晚 ${Math.round(gap / 60000)} 分钟（正常应秒级）`));
      }
      let mtime = null;
      try {
        mtime = fs.statSync(resultPath).mtimeMs;
      } catch {
        /* 已 existence 检查过，理论上不会走到 */
      }
      if (mtime !== null) {
        if (mtime + MTIME_SKEW_MS < finishedAt) {
          fails.push(finding('fail', 'time', runId, `result.json 的修改时间早于 claimed finishedAt ${Math.round((finishedAt - mtime) / 60000)} 分钟——文件先落盘、时间戳后编造`));
        } else if (!result.triage && mtime - finishedAt > MTIME_LATE_WARN_MS) {
          warns.push(finding('warn', 'time', runId, `result.json 比 finishedAt 晚 ${Math.round((mtime - finishedAt) / 60000)} 分钟才落盘且无 triage 复写记录`));
        }
      }
    }
    if (result.executor === 'playwright' && !isPlainObject(result.evidenceGate)) {
      fails.push(finding('fail', 'result', runId, 'playwright run 缺 evidenceGate——证据门禁结论被抹掉'));
    }
  }

  for (const [runId, list] of runCompletes) {
    if (!runEvents.has(runId)) {
      fails.push(finding('fail', 'manifest', runId, '有 run-complete 事件但没有对应的 run 事件——无中生有的完成宣告'));
    }
    const resultPath = path.join(runsDir, runId, 'result.json');
    if (!fs.existsSync(resultPath)) {
      fails.push(finding('fail', 'result', runId, 'run-complete 宣告完成，但 runs/ 下没有 result.json'));
    }
  }

  for (const runId of runDirs) {
    if (runEvents.has(runId)) continue;
    if (fs.existsSync(path.join(runsDir, runId, 'result.json'))) {
      fails.push(finding('fail', 'result', runId, 'runs/ 下存在 result.json，但 manifest 没有 run 事件——工具链外的写入'));
    } else if (!runCompletes.has(runId)) {
      // 只有目录（通常含空的 raw/）而无任何事件：run_tests 先建目录再执行，事件在执行完成后才追加——
      // 这是「执行中」或「被中止」（如宿主逾时杀掉服务器进程）的正常残迹，不是伪造特征
      warns.push(finding('warn', 'result', runId, 'runs/ 下存在无 result.json、无任何 run 事件的空 run 目录——多半是执行中或被中止的 run（如宿主逾时杀进程），不是伪造特征；稍后重验，若长期保持此状态用 run_tests 重跑该阶段'));
    }
    // run-complete 有而 run 事件无的情形已由 runCompletes 循环报告
  }
  stats.results = runDirs.filter((n) => fs.existsSync(path.join(runsDir, n, 'result.json'))).length;

  // ---------- ③ 阶段状态机 + route 对账 ----------
  if (route && isPlainObject(route) && Array.isArray(route.phases)) {
    stats.phases = route.phases.length;
    for (const phase of route.phases) {
      const id = phase?.id;
      if (!id) continue;
      const timeline = phaseEvents.get(id) || [];
      let seenInProgress = false;
      for (const ev of timeline) {
        if (ev.status === 'in-progress') seenInProgress = true;
        else if (ev.status === 'passed' && !seenInProgress) {
          // 只有 passed 是"成功宣告"需要执行凭据；blocked/skipped/failed 可从 pending 直接合法
          // 到达（update_phase 状态机允许），对伪造者没有洗白价值，不要求 in-progress 前置
          fails.push(finding('fail', 'manifest', id, '阶段事件出现 passed，但此前没有 in-progress 事件——跳过了真实执行过程（伪造通过）'));
        }
      }
      if (TERMINAL_PHASE.has(phase.status) && phase.status !== 'blocked') {
        // blocked 豁免：上游失败/跳过时 propagate 直接把下游阶段写成 blocked（设计上不带事件），
        // 且 blocked 只声明"未执行"；passed/failed/skipped 仍须有事件凭据
        if (!timeline.some((ev) => ev.status === phase.status)) {
          fails.push(finding('fail', 'route', id, `route 阶段状态为 ${phase.status}，但 manifest 没有对应 phase 事件`));
        }
      } else if (phase.status === 'in-progress' && !timeline.some((ev) => ev.status === 'in-progress')) {
        warns.push(finding('warn', 'route', id, 'route 阶段状态为 in-progress，但 manifest 无 phase 事件'));
      }
      if (Array.isArray(phase.runs)) {
        for (const ref of phase.runs) {
          const runId = typeof ref === 'string' ? ref : ref?.runId;
          if (!runId) continue;
          if (!runEvents.has(runId)) {
            fails.push(finding('fail', 'route', runId, `route 阶段 ${id} 引用了 run ${runId}，但 manifest 没有它的 run 事件`));
          } else if (!fs.existsSync(path.join(runsDir, runId, 'result.json'))) {
            fails.push(finding('fail', 'route', runId, `route 引用的 run ${runId} 在 runs/ 下没有 result.json`));
          }
        }
      }
    }
    if (route.approvedAt && !events.some((ev) => ev.type === 'approve')) {
      fails.push(finding('fail', 'route', 'approvedAt', 'route 标记已批准，但 manifest 没有任何 approve 事件'));
    }
    if (!route.approvedAt && events.some((ev) => ev.type === 'approve' && RE_SAVE_ROUTE.test(ev.detail || '') && ev.detail.includes('批准'))) {
      warns.push(finding('warn', 'route', 'approvedAt', 'manifest 有批准事件，但 route.json 没有 approvedAt——两侧对不上'));
    }
  }

  // ---------- ④ 报告封章三方一致 ----------
  const finalizeEvents = events.filter((ev) => ev.type === 'finalize');
  const reportPath = path.join(archiveDir, 'final-report.md');
  const hasReport = stats.hasReport;
  const routeStatus = route?.status;

  if (routeStatus === 'completed' || routeStatus === 'abandoned') {
    if (finalizeEvents.length === 0) {
      fails.push(finding('fail', 'report', 'finalize', `route.status=${routeStatus} 但 manifest 没有 finalize 事件——完成态是无凭据的宣告`));
    }
    if (!route.report) {
      fails.push(finding('fail', 'report', 'route.report', `route.status=${routeStatus} 但 route.json 没有 report 封章锚点（finalize_report 必写）`));
    }
    if (!hasReport) {
      fails.push(finding('fail', 'report', 'final-report.md', `route.status=${routeStatus} 但最终报告文件不存在`));
    }
  }
  if (finalizeEvents.length > 0 && !hasReport) {
    fails.push(finding('fail', 'report', 'final-report.md', '有 finalize 事件但报告文件不存在——报告被删除'));
  }
  if (hasReport && finalizeEvents.length === 0 && routeStatus !== 'abandoned') {
    fails.push(finding('fail', 'report', 'finalize', '报告文件存在但没有 finalize 事件——报告写入无凭据（finalize_report 必同时落两处）'));
  }
  if (hasReport) {
    const seal = verifyReportSeal(archiveDir);
    if (!seal.ok) {
      fails.push(finding('fail', 'report', 'final-report.md', seal.reason || '报告封章校验失败'));
    } else if (!seal.present && (finalizeEvents.length > 0 || route?.report)) {
      fails.push(finding('fail', 'report', 'final-report.md', '报告文件存在但没有封章——手写报告冒充 finalize_report 产出'));
    } else if (seal.present && !route?.report) {
      fails.push(finding('fail', 'report', 'route.report', '报告带封章但 route.json 没有 report 锚点——两侧被拆开'));
    }
  }

  // ---------- 签名类汇总 ----------
  if (stats.runs > 0) {
    if (stats.stamped > 0 && stats.legacy > 0) {
      fails.push(finding('fail', 'result', '签名混用', `同一归档内 ${stats.stamped} 个 run 带完整工具签名、${stats.legacy} 个不带——两种来源混装（部分伪造）`));
    } else if (stats.stamped === 0) {
      const msg = `全部 ${stats.runs} 个 run 都缺工具签名（env/command）——旧版本工具产出，或整份手工补造`;
      if (allowLegacy) infos.push(finding('info', 'result', '签名', `${msg}（--allow-legacy 已确认按旧签名宽容）`));
      else warns.push(finding('warn', 'result', '签名', `${msg}；确认来自旧版工具可用 --allow-legacy 宽容`));
    }
  }

  const verdict = fails.length > 0 ? 'TAMPERED' : warns.length > 0 ? 'SUSPECT' : 'TRUSTED';
  return { archiveDir, verdict, fails, warns, infos, stats };
}

export { verifyArchiveIntegrity, scanManifestTaints };
