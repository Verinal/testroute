// 归档脚手架：目录结构由工具确定性创建（不允许 LLM 手搓），manifest 记录事件流。
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fail, truncate } from './validate.js';
import { engineIdentity, engineLabel } from './version.js';
import {
  ensureDir,
  nowIso,
  nowStamp,
  archivesDir,
  listArchives,
  resolveArchiveDir,
  slug,
  readJson,
  writeJson,
  fileExists,
  relFrom,
  toPosix,
  resolveDottedModulePath,
} from './paths.js';
import { loadRoute, saveRoute, findRunResultPath, securityCoverage, fullFlowContext, fullFlowCoverage, browserE2eMinCases, mergedPhaseRuns, maybeCarryOverTriage, isFailedRun, ROUTE_FILE } from './route.js';
import { failureFingerprint } from './result.js';
import { loadProvision, buildUninstallBlock, detectWorkspaceChanges, recordModification } from './provision.js';
import { snapshotTestGate, verifyTestGate, acknowledgeTestGate, gateViolationError } from './testgate.js';
import { testfileManifest } from './testfile.js';
import { getStage } from './stages.js';
import { coverageAgainstInventory, coverageMatrix, loadApiSurface, normalizeEndpoint, looseMatch } from './apimap.js';
import { loadWebSurface, normalizePagePath } from './detect.js';
import { scanManifestTaints } from './integrity.js';

export const STRUCTURE_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const SANDBOX_DIR = 'sandbox';

// 解析降级态：此时 summary 计数不代表真实用例数（0过/0败/0跳 ≠ 未执行），报告必须明示
const UNPARSED_PARSE = new Set(['exit-code-only', 'parse-error']);

// 阶段 → 覆盖深度种类默认归类（与 tools.js 的 kindsForPhase 同一语义）：run 上报的端点若未显式
// 声明 kinds，按所在阶段计入对应深度（negative 阶段的触及=negative 用例；其余=functional）。
const PHASE_KIND_DEFAULT = { negative: ['negative'], boundary: ['boundary'], authz: ['authz'] };

export function sandboxDirOf(archiveDir) {
  return path.join(archiveDir, SANDBOX_DIR);
}

function applyGitignore(root, archiveDir) {
  const gi = path.join(root, '.gitignore');
  let content = '';
  if (fs.existsSync(gi)) content = fs.readFileSync(gi, 'utf8');
  if (/^test-archives\/?$/m.test(content)) return false;
  const line = 'test-archives/\n';
  fs.writeFileSync(gi, content + (content.endsWith('\n') || !content ? '' : '\n') + line, 'utf8');
  appendEvent(archiveDir, 'gitignore', '已将 test-archives/ 追加到 .gitignore');
  // 唯一一次对项目文件的改动，登记进台账（final-report 的改动登记表会列出；删除 test-archives/ 后该行可留可删）
  recordModification(root, archiveDir, [{ path: '.gitignore', kind: 'modified', note: '追加 test-archives/ 忽略行（gitignore=true），防归档进 git' }]);
  return true;
}

// runs/ 下递归统计 result.json——执行证据的唯一口径（只有空 raw/ 目录不算执行记录）
function countRunResults(archiveDir) {
  const runsDir = path.join(archiveDir, 'runs');
  if (!fs.existsSync(runsDir)) return 0;
  let n = 0;
  const stack = [runsDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(path.join(dir, e.name));
      else if (e.isFile() && e.name === 'result.json') n++;
    }
  }
  return n;
}

// route 引用但 runs/ 下已无 result.json 的 runId（残骸判定用；route 缺失/损坏返回 []，损坏由调用方另行标记）
function phantomRunRefs(archiveDir, route) {
  if (!route || !Array.isArray(route.phases)) return [];
  const missing = [];
  for (const p of route.phases) {
    for (const r of p.runs || []) {
      const runId = typeof r === 'string' ? r : r?.runId;
      if (runId && !fs.existsSync(path.join(archiveDir, 'runs', String(runId), 'result.json'))) {
        missing.push(String(runId));
      }
    }
  }
  return missing;
}

export function initArchive(root, { label = '', gitignore = false } = {}) {
  const archivesRoot = archivesDir(root);
  const latestName = listArchives(root)[0];
  const latest = latestName ? path.join(archivesRoot, latestName) : null;
  let forkedFrom = null;

  // 最新归档的四种状态（执行证据一律以 runs/ 下的 result.json 计数）：
  //   ① 空壳（无路线、零执行证据、事件流干净）→ 幂等复用。否则重复 init 会静默切到第二个空归档，
  //     后续缺省 archiveDir 的调用状态"看起来全丢了"。
  //   ② 残骸（零执行证据，但留有执行尝试或损坏痕迹：孤儿 run 事件 / route 引用不存在的 run /
  //     未知事件类型 / manifest 或 route 损坏）→ 就地重置：旧 manifest/route 备份留证后重建，归档名
  //     不变。典型成因是宿主把 test-archives/ 删除或部分还原（编辑器 checkpoint 回滚会按旧账本把
  //     manifest/route 复活，执行记录却已随目录消失）——续用会让 run 事件永远无法对账（整份归档
  //     永久 TAMPERED），静默分叉则制造"一次测试两个结果"的困惑，重置是唯一两全的出口。
  //   ③ 纯草稿残留（有路线、零执行证据、无任何执行尝试痕迹）→ 另开新归档（尊重 label 分叉语义），
  //     响应带 forkedFrom 说明，不再静默。
  //   ④ 已有执行记录/报告 → 另开新归档（历史证据不可扰动），响应带 forkedFrom 说明。
  if (latest && fs.existsSync(path.join(latest, MANIFEST_FILE))) {
    const runResults = countRunResults(latest);
    const hasReport = fs.existsSync(path.join(latest, 'final-report.md'));
    if (runResults > 0 || hasReport) {
      forkedFrom = {
        archive: latestName,
        archiveDir: latest,
        reason: `最新归档 ${latestName} 已有${runResults > 0 ? ` ${runResults} 份执行记录` : ''}${
          hasReport ? `${runResults > 0 ? '与' : ''}最终报告` : ''
        }——保留为历史证据，本次另开新归档（后续缺省 archiveDir 落在新归档）。`,
      };
    } else {
      const routeFile = path.join(latest, ROUTE_FILE);
      const routeFileExists = fs.existsSync(routeFile);
      let route = null;
      if (routeFileExists) {
        try {
          route = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
        } catch {
          route = null; // 损坏 → 按残骸处理（readJson 会直接抛错，残骸判定必须"损坏也可判"）
        }
      }
      const taints = scanManifestTaints(latest);
      const phantom = phantomRunRefs(latest, route);
      const traces =
        taints.corrupt ||
        (routeFileExists && !route) ||
        taints.runEventIds.length > 0 ||
        taints.unknownTypes.length > 0 ||
        phantom.length > 0;

      if (!routeFileExists && !traces) {
        // ① 空壳幂等复用
        const ignored = gitignore ? applyGitignore(root, latest) : false;
        appendEvent(latest, 'init', 'init_archive 复用空归档（幂等，未新建）');
        return {
          archiveDir: latest,
          archiveName: latestName,
          manifestPath: path.join(latest, MANIFEST_FILE),
          sandboxDir: sandboxDirOf(latest),
          reused: true,
          ...(ignored ? { gitignoreAdded: true } : {}),
        };
      }

      if (traces) {
        // ② 残骸就地重置
        const stamp = nowStamp();
        const reasons = [];
        if (taints.corrupt) reasons.push('manifest.json 损坏');
        if (routeFileExists && !route) reasons.push('route.json 损坏');
        if (taints.runEventIds.length) {
          reasons.push(`manifest 留有 ${taints.runEventIds.length} 个 run 事件但执行记录（result.json）已全部缺失`);
        }
        if (phantom.length) reasons.push(`route 引用了 ${phantom.length} 个不存在的 run（${phantom.slice(0, 3).join('、')}）`);
        if (taints.unknownTypes.length) reasons.push(`manifest 含未知事件类型（${taints.unknownTypes.join('、')}）`);
        // 备份留证：残骸不销毁证据，只移出主位
        const backedUp = [];
        if (fs.existsSync(path.join(latest, MANIFEST_FILE))) {
          const bak = `manifest-residual-${stamp}.json`;
          fs.copyFileSync(path.join(latest, MANIFEST_FILE), path.join(latest, bak));
          backedUp.push(bak);
        }
        if (routeFileExists) {
          const bak = `route-residual-${stamp}.json`;
          fs.copyFileSync(routeFile, path.join(latest, bak));
          fs.rmSync(routeFile);
          backedUp.push(bak);
        }
        // 只读基线缺失时重建（残骸常连 testfile-hashes.json 一起丢失）；基线尚存时不覆盖，
        // 避免把项目测试脚本在此期间的改动静默吸收进基线
        let gateFileCount = null;
        if (!fs.existsSync(path.join(latest, 'testfile-hashes.json'))) {
          gateFileCount = snapshotTestGate(root, latest);
        }
        for (const sub of ['runs', 'testcases', 'manual-cases', SANDBOX_DIR]) {
          ensureDir(path.join(latest, sub));
        }
        writeJson(path.join(latest, MANIFEST_FILE), {
          archiveId: latestName,
          structureVersion: STRUCTURE_VERSION,
          createdAt: nowIso(),
          projectRoot: root,
          ...(gateFileCount !== null ? { testGateFiles: gateFileCount } : {}),
          events: [
            {
              at: nowIso(),
              type: 'init',
              detail: `残骸归档已就地重置（${reasons.join('；')}）——零执行证据，续用会让 run 事件永远无法对账；旧 manifest/route 备份为 ${backedUp.join('、') || '（无）'}，本归档继续使用`,
            },
          ],
        });
        const ignored = gitignore ? applyGitignore(root, latest) : false;
        return {
          archiveDir: latest,
          archiveName: latestName,
          manifestPath: path.join(latest, MANIFEST_FILE),
          sandboxDir: sandboxDirOf(latest),
          huskReset: {
            reasons,
            orphanRunEvents: taints.runEventIds.length,
            phantomRunRefs: phantom.length,
            unknownEventTypes: taints.unknownTypes,
            manifestCorrupt: taints.corrupt,
            backedUp,
          },
          ...(ignored ? { gitignoreAdded: true } : {}),
        };
      }

      // ③ 纯草稿残留 → 另开新归档（label 分叉语义），说明原因
      forkedFrom = {
        archive: latestName,
        archiveDir: latest,
        reason: `最新归档 ${latestName} 有路线但零执行记录（纯草稿/规划残留，无执行尝试痕迹）——按 label 语义另开新归档，旧归档保留备查。`,
      };
    }
  }

  const name = `${nowStamp()}${label ? '-' + slug(label) : ''}`;
  const dir = path.join(archivesRoot, name);
  if (fs.existsSync(dir)) fail('E_CONFLICT', `归档目录已存在: ${dir}`);
  ensureDir(dir);
  ensureDir(path.join(dir, 'runs'));
  ensureDir(path.join(dir, 'testcases'));
  ensureDir(path.join(dir, 'manual-cases'));
  ensureDir(sandboxDirOf(dir));

  // 只读门禁基线：项目自有测试脚本哈希快照（沙箱在 test-archives/ 下，天然排除在外）
  const gateFileCount = snapshotTestGate(root, dir);

  // 约定资料夹 .testfile/ 快照留痕：记录当时检测到的文件清单，报告可对账（只记录，不复制内容）
  let testfileNote = '';
  try {
    const tf = testfileManifest(root);
    if (tf) {
      writeJson(path.join(dir, 'testfile-manifest.json'), tf);
      testfileNote = `；.testfile/ 资料夹已登记（${tf.totalFiles} 个文件，清单见 testfile-manifest.json）`;
    }
  } catch {
    /* 检测失败不阻塞建档 */
  }

  const manifest = {
    archiveId: name,
    structureVersion: STRUCTURE_VERSION,
    createdAt: nowIso(),
    projectRoot: root,
    testGateFiles: gateFileCount,
    engine: engineIdentity(),
    events: [{ at: nowIso(), type: 'init', detail: `归档目录已创建（测试脚本只读基线 ${gateFileCount} 个文件）${testfileNote}｜引擎 ${engineLabel()}` }],
  };
  writeJson(path.join(dir, MANIFEST_FILE), manifest);

  if (gitignore) applyGitignore(root, dir);

  return {
    archiveDir: dir,
    archiveName: name,
    manifestPath: path.join(dir, MANIFEST_FILE),
    sandboxDir: sandboxDirOf(dir),
    ...(forkedFrom ? { forkedFrom } : {}),
  };
}

export function getArchiveContext(root, archiveDir) {
  const dir = resolveArchiveDir(root, archiveDir || '');
  if (!dir) {
    fail(
      'E_NOT_FOUND',
      `未找到归档目录（${archiveDir || 'root 下无归档'}）。请先调用 init_archive 创建归档。`
    );
  }
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const manifest = readJson(manifestPath);
  if (!manifest) fail('E_CORRUPT', `manifest.json 缺失或损坏: ${manifestPath}`);
  return { dir, name: path.basename(dir), manifest, manifestPath };
}

export function appendEvent(ctxOrDir, type, detail = '') {
  const dir = typeof ctxOrDir === 'string' ? ctxOrDir : ctxOrDir.dir;
  const manifestPath = path.join(dir, MANIFEST_FILE);
  const manifest = readJson(manifestPath) || { events: [] };
  manifest.events = manifest.events || [];
  manifest.events.push({ at: nowIso(), type, detail });
  writeJson(manifestPath, manifest);
}

// ---------- 执行记录 ----------

export function nextRunSlot(archiveDir, phaseId) {
  const runsDir = path.join(archiveDir, 'runs');
  ensureDir(runsDir);
  let max = 0;
  const re = new RegExp(`^${phaseId}-(\\d+)$`);
  for (const name of fs.readdirSync(runsDir)) {
    const m = re.exec(name);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  const index = max + 1;
  const runId = `${phaseId}-${String(index).padStart(2, '0')}`;
  const runDir = path.join(runsDir, runId);
  return { index, runId, runDir };
}

// 预分配槽位并建好 raw 目录（执行器在命令运行前就需要写出路径）
export function prepareRun(archiveDir, phaseId) {
  const slot = nextRunSlot(archiveDir, phaseId);
  const rawDir = path.join(slot.runDir, 'raw');
  ensureDir(rawDir);
  // 用例显式逐步截图（TESTROUTE_ARTIFACTS_DIR）与 playwright 产物（--output）的共同落点，先建好
  ensureDir(path.join(rawDir, 'artifacts'));
  return { ...slot, rawDir };
}

export function writeRun(archiveDir, phaseId, result, proc, slot) {
  if (!slot) slot = prepareRun(archiveDir, phaseId);
  const rawDir = slot.rawDir || path.join(slot.runDir, 'raw');
  ensureDir(rawDir);

  result.runId = slot.runId;
  if (proc) {
    if (proc.stdout) fs.writeFileSync(path.join(rawDir, 'console-stdout.log'), proc.stdout, 'utf8');
    if (proc.stderr) fs.writeFileSync(path.join(rawDir, 'console-stderr.log'), proc.stderr, 'utf8');
  }

  const resultPath = path.join(slot.runDir, 'result.json');
  writeJson(resultPath, result);
  appendEvent(archiveDir, 'run', `阶段 ${phaseId} 执行完成: ${slot.runId}`);
  return { runId: slot.runId, runDir: slot.runDir, resultPath, rawDir };
}

export function saveTriage(archiveDir, runId, triage) {
  const { resultPath, result } = findRunResultPath(archiveDir, runId);
  const fingerprint = failureFingerprint(result);
  result.triage = { ...triage, ...(fingerprint ? { fingerprint } : {}), updatedAt: nowIso() };
  writeJson(resultPath, result);
  return { resultPath, fingerprint };
}

// ---------- 用例快照 ----------

export function snapshotFiles(archiveDir, phaseId, root, files) {
  const written = [];
  const sandbox = sandboxDirOf(archiveDir);
  for (const rel of files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    if (!fileExists(abs)) fail('E_NOT_FOUND', `快照源文件不存在: ${rel}`);
    // 沙箱内文件按沙箱相对路径归档（否则会带上 test-archives/<id>/ 长前缀）
    const sourceBase = abs.toLowerCase().startsWith(sandbox.toLowerCase()) ? sandbox : root;
    const dest = path.join(archiveDir, 'testcases', phaseId, relFrom(sourceBase, abs));
    ensureDir(path.dirname(dest));
    fs.copyFileSync(abs, dest);
    written.push({ from: relFrom(root, abs), to: toPosix(relFrom(archiveDir, dest)) });
  }
  appendEvent(archiveDir, 'snapshot', `阶段 ${phaseId} 快照 ${written.length} 个文件`);
  return written;
}

// ---------- 案例卡 ----------
// 生成的测试文件档头注释（SKILL 证据规范强制）：@testroute 案例 + 目的/前置/步骤/资料/预期/清理。
// 兼容 JS/TS 块注释与行注释、Python docstring/行注释、简繁键名；缺卡返回 null（报告如实标注，不虚构）。
const CARD_LINE_RE =
  /^\s*(?:\/\/+|#+|\*+|"""|''')?\s*(目的|前置|步骤|步驟|资料|資料|数据|數據|预期|預期|清理)\s*[:：]\s*(.+?)\s*$/;
const CARD_KEY_MAP = {
  目的: '目的', 前置: '前置', 步骤: '步骤', 步驟: '步骤',
  资料: '资料', 資料: '资料', 数据: '资料', 數據: '资料',
  预期: '预期', 預期: '预期', 清理: '清理',
};

function cardFromFile(abs) {
  let text = '';
  try {
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  const markerAt = text.search(/@testroute\s*(案例|case)/i);
  if (markerAt < 0) return null;
  const card = {};
  for (const line of text.slice(markerAt, markerAt + 4000).split('\n').slice(0, 40)) {
    const m = CARD_LINE_RE.exec(line);
    if (!m) continue;
    const key = CARD_KEY_MAP[m[1]] || m[1];
    if (!card[key]) card[key] = truncate(m[2], 300);
  }
  return Object.keys(card).length ? card : null;
}

function extractCaseCard(root, relFile, extraRoots = []) {
  // 查找顺序：gateRoot → 归档 sandbox（沙箱生成的用例，run 结果里的 c.file 常是沙箱相对路径）→ 点号模块路径还原
  const bases = [root, ...extraRoots].filter(Boolean);
  for (const base of bases) {
    const abs = path.isAbsolute(relFile) ? relFile : path.join(base, relFile);
    const card = cardFromFile(abs);
    if (card) return card;
  }
  // 旧数据兼容：pytest junit 的点号模块路径曾被当作文件路径存进 run 结果，对照真实文件还原
  const hit = resolveDottedModulePath(root, relFile);
  if (hit) return cardFromFile(path.join(root, hit.file));
  return null;
}

// 证据文件转报告内链接：归档内的用归档相对路径（报告就在归档根），外的退回原路径展示
function evidenceLink(archiveDir, absPath) {
  try {
    const rel = path.relative(archiveDir, String(absPath));
    if (rel && !rel.startsWith('..')) return toPosix(rel);
  } catch {
    /* 非法路径退回原样 */
  }
  return toPosix(String(absPath).split(path.sep).join('/'));
}

// 内置执行器没有“生成的测试文件”：案例卡不适用，复现统一走 testroute_run_tests
const BUILTIN_EXECUTORS = new Set(['health', 'sca', 'secrets', 'e2e']);

// markdown 表格单元格净化：管道符转义、换行折叠为空格。
// 单元格里出现裸换行会把表格行拆成两行、整表错位；truncate() 的截断后缀自带换行，故表格内禁用 truncate。
function mdCell(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*[\r\n]+\s*/g, ' ');
}

// 用例级复现指令：playwright/vitest/jest/pytest 精确到单条用例；其余执行器复现整个 run
function caseReproLine(p, c, result, root = null) {
  const title = String(c.name || c.id).split('›').pop().trim().replace(/"/g, "'");
  if (p.executor === 'playwright' && c.file) {
    return `\`npx --no-install playwright test ${toPosix(String(c.file))} --grep "${title}"\`（工作目录=项目根）`;
  }
  if (p.executor === 'vitest' && c.file) return `\`npx vitest run ${toPosix(String(c.file))} -t "${title}"\``;
  if (p.executor === 'jest' && c.file) return `\`npx jest ${toPosix(String(c.file))} -t "${title}"\``;
  if (p.executor === 'pytest' && String(c.id).includes('::')) {
    let nodeid = String(c.id);
    // 旧数据兼容：id 头部若是点号模块路径（pytest junit 无 file 属性），还原为真实文件路径的 nodeid
    const idx = nodeid.indexOf('::');
    const head = nodeid.slice(0, idx);
    const hit = root ? resolveDottedModulePath(root, head) : null;
    if (hit) nodeid = [hit.file, ...hit.classes, nodeid.slice(idx + 2)].filter(Boolean).join('::');
    return `\`pytest "${nodeid.replace(/"/g, "'")}"\``;
  }
  if (BUILTIN_EXECUTORS.has(p.executor)) {
    return `\`testroute_run_tests { phaseId: "${p.id}" }\`（内置执行器${p.executor === 'e2e' ? '，声明式 steps 见 route.json 可逐条评审' : ''}）`;
  }
  // bullet 内的代码 span：反引号换成单引号防提前闭合；换行折叠为空格（截断后缀自带换行会拆断条目，
  // 且复现命令必须完整可复制）；不转义管道——代码 span 内 `\|` 在非表格 markdown 会原样显示
  const cmd = result?.command ? String(result.command).replace(/`/g, "'").replace(/\s*[\r\n]+\s*/g, ' ') : null;
  if (!cmd) return `\`testroute_run_tests { phaseId: "${p.id}" }\``;
  const fileNote = c.file ? `；本用例在 \`${toPosix(String(c.file))}\`` : '';
  return `\`${cmd}\`（工作目录=项目根${fileNote}）`;
}

// ---------- 最终报告 ----------

export function finalizeReport(archiveDir, { acknowledgeTestFileChanges = false } = {}) {
  const route = loadRoute(archiveDir);
  const { manifest } = { manifest: readJson(path.join(archiveDir, MANIFEST_FILE)) || {} };

  // route-reset 会清 phase.runs 但保留 runs/ 目录——执行历史的权威来源是磁盘。报告统计前先把
  // 磁盘 run 合并回各阶段（按 runId 去重、按时间排序）并尝试同指纹归因继承：否则 reset 一次，
  // 报告就丢失此前全部失败归因与执行计数（真实案例：10 次 run 的归档，报告只统计 reset 后 1 次）。
  for (const p of route.phases) {
    const carried = maybeCarryOverTriage(archiveDir, route, p);
    if (carried) {
      appendEvent(archiveDir, 'triage-carry', `${carried.runId} finalize 时继承 ${carried.carriedFrom} 的归因（失败指纹一致）`);
    }
    p.runs = mergedPhaseRuns(archiveDir, p);
  }

  // 收尾门禁：任一阶段最近一次执行是失败且未归因 → 拒绝出报告。没有这道门，reset 后未归因的
  // 失败会静默从报告里消失（真实案例：reset 后失败 run 未归因，报告只字未提）。历史失败已被
  // 同指纹继承归因（上方 carry）或被后续通过的 run 收口的不拦——只拦"未收口且未归因"。
  for (const p of route.phases) {
    const runs = Array.isArray(p.runs) ? p.runs : [];
    const last = runs[runs.length - 1];
    if (last && isFailedRun(last) && !last.triage) {
      fail(
        'E_TRIAGE_REQUIRED',
        `阶段 "${p.id}" 最近一次执行（${last.runId}）失败且未归因，无法生成最终报告。` +
          `请先 record_triage(runId="${last.runId}") 逐条归因（test-bug→修用例重跑；code-bug→标记 failed 并划优先级；environment→修复环境后重跑）。`
      );
    }
  }

  // 缺陷优先级门禁：code-bug 归因必须划 P0–P3，否则拒绝出报告（报告的核心交付物之一）。
  // 同一用例被多轮 triage/继承重复归因时以最近一次为准（按 caseId 去重）——缺陷清单按缺陷计数，
  // 不按归因轮次计数，否则 P1×2 会被继承链放大成 P1×6。
  const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
  const bugByCase = new Map();
  for (const p of route.phases) {
    for (const run of p.runs || []) {
      for (const c of run.triage?.classifications || []) {
        if (c.classification === 'code-bug') {
          bugByCase.set(c.caseId, { phaseId: p.id, runId: run.runId, caseId: c.caseId, priority: c.priority || null, note: c.note || '' });
        }
      }
    }
  }
  const bugItems = [...bugByCase.values()];
  const missingPriority = bugItems.filter((b) => !b.priority);
  if (missingPriority.length) {
    fail(
      'E_GATE',
      `以下 code-bug 缺陷未划优先级，无法生成最终报告（门禁：报告必须给出 P0–P3 分级）:\n  - ` +
        missingPriority.map((b) => `${b.phaseId}/${b.runId}/${b.caseId}`).join('\n  - ') +
        `\n请用 record_triage 重新归因并补上 priority: P0（阻断：主流程不可用/安全漏洞/数据丢失）、P1（严重：核心功能缺陷）、P2（一般：次要功能/边界）、P3（轻微：体验/建议）。`
    );
  }
  const prioCounts = {};
  for (const b of bugItems) prioCounts[b.priority] = (prioCounts[b.priority] || 0) + 1;
  const prioSummary = PRIORITIES.filter((pr) => prioCounts[pr])
    .map((pr) => `${pr}×${prioCounts[pr]}`)
    .join('，');

  // ---------- 全流程覆盖对照（盘点 vs 实测）+ 覆盖硬门禁 ----------
  // "测了多少条用例"说不出覆盖面，"125 个端点只测了 33 个"才说得出——而它必须拦在 finalize，
  // 不只是写进报告：此前覆盖只有 26% 也能出"completed"报告（真实案例），门禁化后不可能。
  // 覆盖 = 端点 × 深度用例种类（functional/negative/boundary/authz）+ 前端页面。
  // 各 run 上报合并；kinds 未声明时按阶段默认归类。authz/functional 缺口恒拦；
  // negative/boundary 仅在路线含对应非跳过阶段时拦（阶段被裁剪/豁免 → 该类要求整体降级）；
  // 页面仅在前端盘点 ≥5 页且路线含非跳过 browser-e2e 时拦。逐项豁免走 route.coverageWaiver。
  // 门禁只在"路线走完且未终止"时强制：aborted/incomplete 的报告不宣称完成，如实标注缺口即可。
  const apiRoot = route.project?.root;
  const apiInv = apiRoot ? loadApiSurface(apiRoot, archiveDir) : null;
  const webInv = apiRoot ? loadWebSurface(apiRoot, archiveDir) : null;
  let apiCmp = null;
  let apiCovRuns = [];
  let apiCoveredKeys = [];
  const covByKind = new Map(); // 端点键 → Set<kind>（全部 run 上报合并）
  const pagesCovered = new Set(); // 归一化页面路径
  if (apiInv && Array.isArray(apiInv.endpoints) && apiInv.total >= 5) {
    const coveredKeys = [];
    for (const p of route.phases) {
      const phaseKinds = PHASE_KIND_DEFAULT[p.id] || ['functional'];
      for (const r of p.runs || []) {
        try {
          const { result } = findRunResultPath(archiveDir, r.runId);
          if (Array.isArray(result?.apiCoverage?.endpoints) && result.apiCoverage.endpoints.length) {
            coveredKeys.push(...result.apiCoverage.endpoints);
            apiCovRuns.push(`${r.runId}(${result.apiCoverage.total})`);
            for (const k of result.apiCoverage.endpoints) {
              const set = covByKind.get(k) || new Set();
              for (const kind of result.apiCoverage.kinds?.[k] || phaseKinds) set.add(kind);
              covByKind.set(k, set);
            }
          }
          if (Array.isArray(result?.pageCoverage?.pages)) {
            for (const pg of result.pageCoverage.pages) pagesCovered.add(String(pg));
          }
        } catch {
          /* result.json 缺失不阻塞报告 */
        }
      }
    }
    if (coveredKeys.length) {
      apiCoveredKeys = coveredKeys;
      apiCmp = coverageAgainstInventory(apiInv, coveredKeys, { full: false });
    }
  }
  const matrix = apiInv?.total >= 5 ? coverageMatrix(apiInv, covByKind) : null;

  // 覆盖豁免（route.coverageWaiver）：endpoint（"METHOD /path"，写 {p} 或具体 id 都能对上）或 page。
  // 豁免不改变矩阵统计，只把对应缺口从门禁里除名，报告原样引用理由——豁免是留痕的例外，不是删除。
  const waivers = Array.isArray(route.coverageWaiver) ? route.coverageWaiver : [];
  const waivedEndpoints = [];
  const waivedPages = [];
  for (const w of waivers) {
    if (w?.endpoint) {
      // "METHOD /path"（也容忍缺前导斜杠/缺方法）；与盘点同走 normalizeEndpoint（数字/UUID 段折叠 {p}）再精确对上
      const raw = String(w.endpoint).trim();
      const m = /^([a-zA-Z]+)\s+\/?(.*)$/.exec(raw);
      const key = m ? normalizeEndpoint(m[1], '/' + m[2]) : normalizeEndpoint('GET', raw);
      waivedEndpoints.push({ key, reason: String(w.reason || '') });
    }
    if (w?.page) {
      const norm = normalizePagePath(String(w.page)) || String(w.page).trim();
      if (norm) waivedPages.push({ key: norm, reason: String(w.reason || '') });
    }
  }
  const matchEndpointWaiver = (gapKey) => {
    const hit = waivedEndpoints.find((w) => w.key === gapKey);
    if (hit) return hit.reason;
    const staticSegs = new Set(
      gapKey
        .slice(gapKey.indexOf(' ') + 1)
        .split('/')
        .filter((s) => s && s !== '{p}')
    );
    const loose = waivedEndpoints.find((w) => w.key !== gapKey && looseMatch(w.key, gapKey, staticSegs));
    return loose ? loose.reason : null;
  };
  const matchPageWaiver = (pagePath) => {
    const hit = waivedPages.find((w) => w.key === pagePath);
    if (hit) return hit.reason;
    const a = pagePath.split('/');
    const loose = waivedPages.find((w) => {
      const b = w.key.split('/');
      if (a.length !== b.length) return false;
      return a.every((seg, i) => seg === b[i] || seg === '{p}' || b[i] === '{p}');
    });
    return loose ? loose.reason : null;
  };

  const phaseActive = (id) => route.phases.some((p) => p.id === id && p.status !== 'skipped');
  const TERMINAL_STATUSES = new Set(['passed', 'failed', 'blocked', 'skipped']);
  const allTerminalNow = route.phases.every((p) => TERMINAL_STATUSES.has(p.status));
  const coverageGateApplies = route.mode === 'generate-and-execute' && allTerminalNow && !route.terminated;

  // 深度用例种类缺口（仅统计"必须"的种类——negative/boundary 在对应阶段缺席时整体降级不拦）
  const requireKind = {
    functional: true,
    negative: phaseActive('negative'),
    boundary: phaseActive('boundary'),
    authz: phaseActive('authz'),
  };
  const hardGaps = [];
  const waivedGapItems = [];
  if (matrix) {
    for (const g of matrix.gaps) {
      if (!requireKind[g.kind]) continue;
      const reason = matchEndpointWaiver(g.key);
      if (reason) waivedGapItems.push({ ...g, reason });
      else hardGaps.push(g);
    }
  }
  // 页面缺口（browser-e2e 已纳入且盘点 ≥5 页时强制）
  const pageGateApplies = !!webInv && webInv.total >= 5 && phaseActive('browser-e2e');
  const pageGaps = [];
  const pageWaivedItems = [];
  if (pageGateApplies) {
    for (const pg of webInv.pages) {
      const covered = pagesCovered.has(pg.path) || [...pagesCovered].some((c) => {
        const a = c.split('/');
        const b = pg.path.split('/');
        return a.length === b.length && a.every((seg, i) => seg === b[i] || seg === '{p}' || b[i] === '{p}');
      });
      if (covered) continue;
      const reason = matchPageWaiver(pg.path);
      if (reason) pageWaivedItems.push({ page: pg.path, reason });
      else pageGaps.push(pg.path);
    }
  }

  if (coverageGateApplies && (hardGaps.length || (pageGateApplies && pageGaps.length))) {
    const byKindLine = Object.entries(matrix.byKind)
      .map(([k, v]) => `${k} ${v.covered}/${v.required}`)
      .join(' · ');
    const parts = [];
    if (hardGaps.length) {
      parts.push(
        `API 覆盖矩阵缺口 ${hardGaps.length} 项（${byKindLine}）——每端点按输入面/鉴权要求 深度用例：functional 恒必需、有输入面需 negative+boundary、受保护需 authz`
      );
    }
    if (pageGateApplies && pageGaps.length) {
      parts.push(`页面覆盖缺口 ${pageGaps.length}/${webInv.total}（browser-e2e 用例须经 TESTROUTE_PAGES_COVERAGE_FILE 上报访问过的页面）`);
    }
    fail(
      'E_GATE',
      `全流程覆盖门禁未达标，无法生成最终报告:\n- ` +
        parts.join('\n- ') +
        `\n处理：补测到缺口清零——沙箱脚本按环境变量 TESTROUTE_ENDPOINTS_FILE 指向的盘点清单逐端点铺满，` +
        `把触及端点写入 TESTROUTE_COVERAGE_FILE（"METHOD /path" 或 {method, path, kinds:[…]}）；` +
        `browser-e2e 把访问页面写入 TESTROUTE_PAGES_COVERAGE_FILE；然后重跑相关阶段、重新 finalize。` +
        `\n个别端点/页面确实无法测试（第三方代理端点、只读账号缺凭据等）时，在 route.coverageWaiver 逐项登记 ` +
        `{ endpoint: "METHOD /path" 或 page: "页面路径", reason: "<理由>" }（save_route 保存，报告如实标注豁免理由）。` +
        `\n豁免与本拦截不同：豁免是逐项、留痕、有理由的例外；整条路线不测完就收工不被允许。`
    );
  }

  // 全流程完整性对照（scope=full）：强制集逐项对账——纳入/状态/run 数/豁免，报告里无处遁形。
  // finalize 时重判条件（运行中可能变化，如 provisioning 触发 gitDirty → regression 成为必需）；
  // 有缺口不拦 finalize（诚实原则优先：aborted/incomplete 本就不宣称完成），但缺什么必须写出来。
  const fullFlowApplies = route.scope === 'full' && route.mode === 'generate-and-execute';
  let ffCov = null;
  let ffCtx = null;
  if (fullFlowApplies && route.project?.root) {
    try {
      ffCtx = fullFlowContext(route.project.root, archiveDir);
      ffCov = fullFlowCoverage(route, ffCtx);
    } catch {
      ffCov = null;
      ffCtx = null;
    }
  }

  // 只读门禁：项目自有测试脚本在归档创建后被修改/删除 → 拒绝出报告（用户知情确认后可重建基线）
  const gateRoot = route.project?.root;
  let changesBlock = '';
  if (gateRoot) {
    const violation = verifyTestGate(gateRoot, archiveDir);
    if (violation.enforced && !violation.ok) {
      if (!acknowledgeTestFileChanges) {
        gateViolationError(null, violation);
      }
      acknowledgeTestGate(gateRoot, archiveDir);
      appendEvent(
        archiveDir,
        'testgate-ack',
        `用户知情确认测试脚本改动，基线已重建（modified=${violation.modified.length}, deleted=${violation.deleted.length}）`
      );
    }

    // 改动与卸载说明块（报告开头 + 要求最终答复原样引用）
    const ledger = loadProvision(archiveDir);
    const lines2 = ['## 本次对项目的改动与卸载说明', ''];
    lines2.push(buildUninstallBlock(gateRoot, ledger));
    lines2.push('');
    lines2.push(
      '本次测试的全部产物（生成的用例、日志、报告、覆盖率、截图等）都写在归档目录 `test-archives/` 内：不需要时**删除整个 test-archives/ 目录**即完成清理。项目里可能残留的改动只有上方登记的依赖安装与文件改动（按上方说明处理）。'
    );
    if ((manifest.events || []).some((e) => e.type === 'gitignore')) {
      lines2.push('项目 `.gitignore` 里追加过一行 `test-archives/`（防归档进 git），可保留或随手删除。');
    }
    const recorded = ledger?.modifications || [];
    if (recorded.length) {
      lines2.push('');
      lines2.push('TestRoute 记录的对项目文件的改动（**不会自动还原**，请自行审阅保留或回退）：');
      lines2.push('');
      lines2.push('| 文件 | 类型 | 说明 |');
      lines2.push('| --- | --- | --- | --- |');
      // 上下文预算：表格封顶 20 行，全量在 provision.json
      const shownRecorded = recorded.slice(0, 20);
      for (const m of shownRecorded) {
        lines2.push(`| ${m.path} | ${m.kind} | ${mdCell(m.note) || '-'} |`);
      }
      if (recorded.length > shownRecorded.length) {
        lines2.push(`（另有 ${recorded.length - shownRecorded.length} 条改动记录未逐一列出，完整见归档内 \`provision.json\`）`);
      }
    }
    const ws = detectWorkspaceChanges(gateRoot, ledger);
    if (ws.isRepo && ws.changes.length) {
      // 工作区变化只落盘备查，不进报告：没有运行前基线时无法区分「本次新增」与「运行前已有」，展示出来会误导
      const added = ws.changes.filter((c) => c.status === '新增（未跟踪）');
      const others = ws.changes.filter((c) => c.status !== '新增（未跟踪）');
      writeJson(path.join(archiveDir, 'workspace-changes.json'), {
        generatedAt: nowIso(),
        baseline: ledger?.preState?.gitStatus?.length
          ? 'provision.preState（运行前 git status 快照）'
          : 'none（无运行前快照：addedFiles 为当前全部未跟踪文件，不一定是本次运行创建）',
        addedFiles: added,
        modifiedOrDeleted: others,
      });
    }
    changesBlock = lines2.join('\n');
  }

  const TERMINAL = new Set(['passed', 'failed', 'blocked', 'skipped']);
  const allTerminal = route.phases.every((p) => TERMINAL.has(p.status));
  const failedOrBlocked = route.phases.some((p) => p.status === 'failed' || p.status === 'blocked');
  // skipped 放行不是“通过”：结论与下一步必须如实呈现，否则“全部阶段通过”会误导
  const skippedPhases = route.phases.filter((p) => p.status === 'skipped');
  const outcome = route.terminated
    ? 'aborted'
    : !allTerminal
      ? 'incomplete'
      : route.mode === 'generate-only'
        ? 'planned-only'
        : failedOrBlocked
          ? 'with-issues'
          : 'passed';

  // 从未批准的草稿路线收尾 → abandoned（诚实：不能谎报 completed）
  const wasDraft = route.status === 'draft' || route.status === 'abandoned';
  route.status = wasDraft ? 'abandoned' : 'completed';
  route.outcome = outcome;
  route.completedAt = nowIso();

  const lines = [];
  lines.push(`# 最终测试报告`);
  lines.push('');
  lines.push(`- 归档: \`${path.basename(archiveDir)}\``);
  lines.push(`- 项目: ${route.project?.name || '-'}（\`${route.project?.root || '-'}\`）`);
  lines.push(`- 模式: ${route.mode === 'generate-only' ? '仅生成' : '生成+执行'}`);
  lines.push(`- 结论: **${outcome}**（aborted=准入链路终止 / incomplete=存在未完成阶段 / planned-only=仅规划未执行 / passed=全部通过 / with-issues=存在失败或阻断）`);
  if (outcome === 'passed' && (skippedPhases.length || bugItems.length)) {
    const parts = [];
    if (skippedPhases.length) {
      parts.push(`阶段 ${skippedPhases.map((p) => p.id).join('、')} 以 skipped 放行（原因见「阶段备注与检查点」）`);
    }
    if (bugItems.length) {
      parts.push(`存在待修缺陷 ${prioSummary}（见「缺陷优先级」段，TestRoute 只测不修）`);
    }
    lines.push(`- 保留项: ${parts.join('；')}——“passed”仅指纳入路线的阶段最终全部通过，不包含上述保留项`);
  }
  if (route.terminated) {
    lines.push(`- 终止: 阶段 **${route.terminated.byPhase}** 于 ${route.terminated.at} 终止全链路（${route.terminated.reason}）`);
  }
  lines.push(`- 生成时间: ${manifest.createdAt || '-'} | 报告时间: ${route.completedAt}`);
  lines.push(`- 引擎: ${engineLabel()}`);
  if (route.userRequest) lines.push(`- 用户请求（原话）: 「${route.userRequest.trim()}」`);
  lines.push(
    `- 范围: scope=${route.scope === 'targeted' ? `targeted${route.scopeReason ? `（${route.scopeReason}）` : ''}` : 'full（全流程默认契约，超出用户点名范围的部分由标准链路补齐）'} · 阶段 ${(route.phases || []).length} 个: ${(route.phases || []).map((p) => p.id).join('、')}`
  );
  if (route.project?.techStack) lines.push(`- 技术栈: ${route.project.techStack}`);
  if (bugItems.length) lines.push(`- 缺陷优先级: ${prioSummary}（P0=阻断级，最高优先修复；分级标准见「缺陷优先级」段）`);
  if (apiInv?.total >= 5) {
    // 头条口径与矩阵一致（矩阵是权威；coverageAgainstInventory 同样按盘点条目计数，两处数字必须能对上）
    const funcCovered = matrix ? matrix.byKind.functional.covered : apiCmp ? apiCmp.covered : 0;
    const funcPct = matrix ? Math.round((funcCovered / Math.max(1, apiInv.total)) * 1000) / 10 : apiCmp ? apiCmp.pct : null;
    lines.push(
      apiCmp || matrix
        ? `- API 覆盖: ${funcCovered}/${apiInv.total} 端点（${funcPct}%）（见「API 覆盖对照」段）`
        : `- API 覆盖: 盘点 ${apiInv.total} 个端点，但无 run 上报触及端点，无法统计（见「API 覆盖对照」段）`
    );
    if (matrix) {
      lines.push(`- 覆盖矩阵: ${Object.entries(matrix.byKind).map(([k, v]) => `${k} ${v.covered}/${v.required}`).join(' · ')}（端点 × 深度用例种类，见「覆盖矩阵」段）`);
    }
  }
  if (pageGateApplies) {
    lines.push(`- 页面覆盖: ${webInv.total - pageGaps.length - pageWaivedItems.length}/${webInv.total} 页面实测访问过${pageWaivedItems.length ? `（另豁免 ${pageWaivedItems.length}）` : ''}（见「页面覆盖对照」段）`);
  }
  if (ffCov) {
    const ffBits = [];
    if (ffCov.missing.length) ffBits.push(`缺 ${ffCov.missing.map((m) => m.id).join('、')}`);
    if (ffCov.waived.length) ffBits.push(`豁免 ${ffCov.waived.map((w) => w.id).join('、')}`);
    if (ffCov.skipped.length) ffBits.push(`跳过 ${ffCov.skipped.map((s) => s.id).join('、')}`);
    lines.push(
      `- 全流程完整性: scope=full 必需阶段 ${ffCov.counts.present}/${ffCov.counts.required} 纳入` +
        (ffBits.length ? `（${ffBits.join('；')}，见「全流程完整性对照」段）` : '（见「全流程完整性对照」段）')
    );
  }
  lines.push('');
  if (changesBlock) {
    lines.push(changesBlock);
    lines.push('');
  }
  lines.push(`## 下一步怎么做（按当前结论）`);
  lines.push('');
  lines.push(
    outcome === 'passed'
      ? `全部阶段完成${skippedPhases.length ? `（${skippedPhases.map((p) => p.id).join('、')} 以 skipped 放行）` : ''}：本归档可作为测试基线留档。后续代码变更时用 read_changes 做增量分析，复跑 regression 阶段即可。` +
        (bugItems.length
          ? `\n\n注意：仍有待修缺陷 ${prioSummary}（TestRoute 只测不修，见「缺陷优先级」段），应由项目维护者修复后复跑相关阶段。`
          : '')
      : outcome === 'with-issues'
        ? '存在失败或阻断：打开下方「失败与归因」表逐条处理——test-bug→修复用例后重跑；code-bug→**TestRoute 只测不修**，由项目维护者按「缺陷优先级」段（P0 最先）修复业务代码后返工重跑（TestRoute 绝不为让测试通过去改代码或改测试）；environment→修复环境后重跑（全部失败归因 environment 时工具允许放行）。'
        : outcome === 'aborted'
          ? '准入链路已终止（连通性/冒烟失败）：缺陷已在「失败与归因」表记录划级（TestRoute 只测不修）；由项目维护者修复服务问题后，再把终止阶段 update_phase 回 in-progress 解除终止并重跑验证。'
          : outcome === 'planned-only'
            ? '仅生成模式：全部用例已生成并归档，但未执行。可切换 generate-and-execute 模式执行，或人工执行 manual-cases/ 里的清单。'
            : '链路未走完：用 get_route 查看 nextActions，从断点继续推进（阶段 notes 里有 checkpoint）。'
  );
  if (wasDraft) {
    lines.push('');
    lines.push(`**注意**：本路线从未被用户批准（保存草稿后直接收尾，已标记 abandoned）。本报告仅供排查，不构成正式测试结论。`);
  }
  lines.push('');
  lines.push(`## 阶段汇总`);
  lines.push('');
  lines.push(`| 阶段 | 层 | 类型 | 执行器 | 状态 | 执行次数 | 最近结果 |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const p of route.phases) {
    const last = Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null;
    const unparsed = last && UNPARSED_PARSE.has(last.parseStatus) ? '，用例未解析' : '';
    const lastStr = last ? `${last.status}（exit=${last.exitCode}${unparsed}）` : '-';
    lines.push(
      `| ${p.id} | ${getStage(p.id)?.group || '自定义'} | ${p.kind} | ${p.executor || '-'} | ${p.status} | ${p.runs?.length || 0} | ${lastStr} |`
    );
  }
  lines.push('');
  // 安全覆盖段：安全专项不自动执行，纳入/未纳入/豁免必须显式呈现（Skill 承诺 securityWaiver 进最终报告）
  const secCov = securityCoverage(route);
  lines.push(`## 安全测试`);
  lines.push('');
  lines.push(
    `安全目录 ${secCov.allSecurity.length} 个阶段，本次路线纳入 ${secCov.included.length} 个；未纳入的安全专项不自动执行。`
  );
  if (route.securityWaiver?.reason) {
    lines.push('');
    lines.push(`安全段豁免（securityWaiver）：${String(route.securityWaiver.reason).replace(/\|/g, '\\|')}`);
  }
  lines.push('');
  lines.push(`| 阶段 | 定位 | 状态 | 结果摘要 |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const id of secCov.allSecurity) {
    const meta = getStage(id);
    const p = route.phases.find((x) => x.id === id);
    if (!p) {
      lines.push(`| ${id} | ${meta?.title || id} | 未纳入 | - |`);
      continue;
    }
    const last = Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null;
    let summary;
    if (last?.summary) {
      const s = last.summary;
      const counts = {};
      for (const c of last.triage?.classifications || []) {
        counts[c.classification] = (counts[c.classification] || 0) + 1;
      }
      const tri = Object.entries(counts)
        .map(([k, v]) => `${k}×${v}`)
        .join('、');
      const unparsed = UNPARSED_PARSE.has(last.parseStatus) ? '；用例未解析' : '';
      summary = `${s.passed ?? 0} 过 / ${s.failed ?? 0} 败 / ${s.skipped ?? 0} 跳${tri ? `；归因 ${tri}` : ''}${unparsed}`;
    } else {
      summary = p.reason ? truncate(p.reason, 80) : '-';
    }
    lines.push(`| ${id} | ${mdCell(meta?.title || id)} | ${p.status} | ${mdCell(summary) || '-'} |`);
  }
  lines.push('');
  // 通过证据：通过用例不进失败归因表，只看「N 过」分不清「扫了且干净」和「什么都没扫」——
  // 把安全阶段 passed 用例名列出来（名称自带扫描量，如「npm:frontend/package.json（856 依赖，0 漏洞）」）
  for (const id of secCov.allSecurity) {
    const p = route.phases.find((x) => x.id === id);
    const last = p && Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null;
    if (!last) continue;
    try {
      const { result } = findRunResultPath(archiveDir, last.runId);
      if (!result || UNPARSED_PARSE.has(result.parseStatus)) continue;
      const evidence = (result.suites || [])
        .flatMap((s) => s.cases || [])
        .filter((c) => c.status === 'passed')
        .map((c) => String(c.name || c.id))
        .slice(0, 8);
      if (evidence.length) lines.push(`- ${id} 通过证据: ${evidence.join('；')}`);
    } catch {
      /* result.json 缺失/损坏不阻塞报告生成 */
    }
  }
  lines.push('');
  // 全流程完整性对照（scope=full）：强制集逐项对账——批准门禁拦的是 save/approve 时点，
  // 运行中条件会变（如 provisioning 触发 git-dirty）、阶段也可能中途被 skipped；finalize 如实对账。
  if (ffCov) {
    lines.push(`## 全流程完整性对照（scope=full）`);
    lines.push('');
    lines.push(
      `全流程（scope=full）的强制集由引擎逐项判定：条件适用的阶段必须纳入，条件不满足的自动不要求（下表「不要求」行），` +
        `resilience/chaos/pentest/canary/dast 等保持 opt-in。`
    );
    lines.push('');
    lines.push(`| 阶段 | 层 | 纳入原因 | 状态 | 执行次数 | 说明 |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const r of ffCov.required) {
      const p = route.phases.find((x) => x.id === r.id);
      if (p) {
        const last = Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null;
        const s = last?.summary;
        const note =
          p.status === 'skipped'
            ? `skipped: ${mdCell(p.reason || '（未给理由）')}`
            : s
              ? `${s.passed ?? 0} 过 / ${s.failed ?? 0} 败 / ${s.skipped ?? 0} 跳`
              : '-';
        lines.push(`| ${r.id} | ${r.group} | ${mdCell(r.why)} | ${p.status} | ${p.runs?.length || 0} | ${note} |`);
      } else {
        const w = ffCov.waived.find((x) => x.id === r.id);
        lines.push(`| ${r.id} | ${r.group} | ${mdCell(r.why)} | 未纳入 | 0 | ${w ? `豁免: ${mdCell(w.reason)}` : '**缺失（未豁免）**'} |`);
      }
    }
    lines.push('');
    if (ffCtx?.pagesTotal != null && route.phases.some((p) => p.id === 'browser-e2e' && p.status !== 'skipped' && !ffCov.waived.some((w) => w.id === 'browser-e2e'))) {
      const b = route.phases.find((p) => p.id === 'browser-e2e');
      const lastB = Array.isArray(b.runs) && b.runs.length ? b.runs[b.runs.length - 1] : null;
      const caseTotal = lastB?.summary?.total;
      const min = browserE2eMinCases(ffCtx.pagesTotal);
      lines.push(
        `- 浏览器 E2E 流程级用例: ${Number.isFinite(caseTotal) ? caseTotal : 0}/${min} 条（页面盘点 ${ffCtx.pagesTotal} 页 → max(4, ceil(${ffCtx.pagesTotal}/4))；每条覆盖一个完整业务流，页面走查最多算 1 条）`
      );
      lines.push('');
    }
    if (ffCov.skipped.length) {
      lines.push(
        `**注意**：必需阶段 ${ffCov.skipped.map((s) => s.id).join('、')} 以 skipped 放行（理由见上表与「阶段备注与检查点」）——结论不含这些阶段，不是完整全流程。`
      );
      lines.push('');
    }
    if (ffCov.missing.length) {
      lines.push(
        `**缺失（未豁免）**：${ffCov.missing.map((m) => m.id).join('、')}——批准后被裁剪，或条件在运行中变化（如依赖安装触发 git-dirty 使 regression 成为必需）。报告如实呈现；此状态不构成完整的全流程测试。`
      );
      lines.push('');
    }
    if (ffCov.waived.length) {
      lines.push(`豁免均逐项留痕（fullFlowWaiver，理由见上表），豁免是经用户确认的例外，不是删除。`);
      lines.push('');
    }
    if (ffCov.inapplicable.length) {
      lines.push(`条件不满足、本次不要求: ${ffCov.inapplicable.map((x) => `${x.id}（${x.condition}）`).join('、')}。`);
      lines.push('');
    }
    lines.push(`保持 opt-in（本次未纳入不拦报告，需要时显式加进路线）: ${ffCov.optional.join('、')}。`);
    lines.push('');
  }
  if (bugItems.length) {
    lines.push(`## 缺陷优先级（P0 → P3）`);
    lines.push('');
    lines.push(
      `分级标准：**P0**=阻断级（主流程不可用/安全漏洞/数据丢失/服务崩溃，必须最先修复）· **P1**=严重（核心功能缺陷，主要场景受影响）· **P2**=一般（次要功能或边界条件）· **P3**=轻微（体验问题/建议项）。` +
        `TestRoute 只测不修：以下缺陷由项目维护者修复，本报告只提供定位与修复方向。`
    );
    lines.push('');
    lines.push(`| 优先级 | 阶段 | Run | 用例 | 说明 |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    for (const pr of PRIORITIES) {
      for (const b of bugItems.filter((x) => x.priority === pr)) {
        lines.push(`| **${pr}** | ${b.phaseId} | ${b.runId} | ${mdCell(b.caseId)} | ${mdCell(b.note) || '-'} |`);
      }
    }
    lines.push('');
  }
  lines.push(`## 代码版本（测试运行时锚点）`);
  lines.push('');
  const gitRows = [];
  for (const p of route.phases) {
    for (const r of p.runs || []) {
      if (r.git?.head) {
        gitRows.push(`| ${p.id} | ${r.runId} | \`${String(r.git.head).slice(0, 10)}\` | ${r.git.branch || '-'} | ${r.git.dirty ? '有未提交改动' : '干净'} |`);
      }
    }
  }
  if (gitRows.length === 0) {
    lines.push(`非 git 仓库或无执行记录，未锚定代码版本。`);
  } else {
    lines.push(`| 阶段 | Run | commit | 分支 | 工作区 |`);
    lines.push(`| --- | --- | --- | --- | --- |`);
    lines.push(...gitRows);
  }
  lines.push('');
  lines.push(`## 代码覆盖率`);
  lines.push('');
  let cov = null;
  let covPhase = null;
  for (const p of route.phases) {
    for (const r of p.runs || []) {
      if (r.coverage?.type === 'lcov') {
        covPhase = p.id;
        // 路线 runRef 里只存 totals；报告需要文件级明细，从该 run 的 result.json 取全量
        try {
          const { result } = findRunResultPath(archiveDir, r.runId);
          cov = result?.coverage?.type === 'lcov' ? result.coverage : r.coverage;
        } catch {
          cov = r.coverage;
        }
      }
    }
  }
  if (!cov) {
    lines.push(`本次运行未解析覆盖率。可选：目标项目配置 lcov 输出后，run_tests 传 coverageFile（或不传自动探测 coverage/lcov.info）。`);
  } else {
    const cell = (v, extra) => (v === null || v === undefined ? '-' : `${v}%${extra || ''}`);
    lines.push(`来源: \`${cov.source}\`（阶段 ${covPhase}，LCOV）`);
    lines.push('');
    lines.push(`| 指标 | 覆盖率 | 命中/总数 |`);
    lines.push(`| --- | --- | --- |`);
    lines.push(`| 行 | ${cell(cov.totals.linesPct)} | ${cov.totals.linesHit}/${cov.totals.linesFound} |`);
    lines.push(`| 函数 | ${cell(cov.totals.functionsPct)} | ${cov.totals.functionsHit}/${cov.totals.functionsFound} |`);
    lines.push(`| 分支 | ${cell(cov.totals.branchesPct)} | ${cov.totals.branchesHit}/${cov.totals.branchesFound} |`);
    const worst = (cov.files || [])
      .filter((f) => f.linesPct !== null)
      .sort((a, b) => a.linesPct - b.linesPct)
      .slice(0, 10);
    if (worst.length) {
      lines.push('');
      lines.push(`覆盖最低的文件（前 ${worst.length}，补测试优先从这里下手）：`);
      lines.push('');
      lines.push(`| 文件 | 行覆盖率 |`);
      lines.push(`| --- | --- |`);
      for (const f of worst) lines.push(`| ${f.file} | ${cell(f.linesPct)} |`);
    }
  }
  lines.push('');

  // API 覆盖对照（盘点 vs 实测）：数据已在上文算好（apiInv / apiCmp / apiCovRuns / matrix）
  if (apiInv && Array.isArray(apiInv.endpoints) && apiInv.total >= 5) {
    lines.push(`## API 覆盖对照（盘点 vs 实测）`);
    lines.push('');
    if (!apiCmp) {
      lines.push(
        `盘点到 **${apiInv.total} 个端点**（${apiInv.modules.length} 个模块，来源 ${(apiInv.sources || []).join('、')}），` +
          `但没有任何 run 上报触及端点——本段无法统计。` +
          `沙箱脚本应把触及端点写入环境变量 \`TESTROUTE_COVERAGE_FILE\` 指向的文件（JSON 数组，"METHOD /path"），重跑后此段才会给出真实覆盖面。`
      );
    } else {
      const cmp = apiCmp;
      lines.push(
        `- 盘点基准: project-map.json（${apiInv.total} 端点 / ${apiInv.modules.length} 模块，来源 ${(apiInv.sources || []).join('、')}）`
      );
      lines.push(`- 上报来源: ${apiCovRuns.join('、')}`);
      lines.push(`- **端点覆盖: ${cmp.covered}/${cmp.total}（${cmp.pct}%）**`);
      if (cmp.modules.length) {
        lines.push('');
        lines.push(`| 模块 | 已测/总数 | 覆盖率 |`);
        lines.push(`| --- | --- | --- |`);
        for (const m of cmp.modules) {
          lines.push(`| ${m.module} | ${m.covered}/${m.total} | ${Math.round((m.covered / m.total) * 100)}% |`);
        }
      }
      if (cmp.uncoveredTotal > 0) {
        lines.push('');
        lines.push(
          `**未覆盖端点 ${cmp.uncoveredTotal} 个**（补测优先级：auth=protected 的高于 unknown）——以下前 ${cmp.uncovered.length} 个，全量清单见归档 \`api-coverage.json\`：`
        );
        lines.push('');
        lines.push(`| 端点 | 模块 | 鉴权 | 定义位置 |`);
        lines.push(`| --- | --- | --- | --- |`);
        for (const u of cmp.uncovered) {
          lines.push(`| ${u.key} | ${u.module} | ${u.auth} | ${u.file} |`);
        }
      }
      lines.push('');
    }
    // 端点 × 深度用例矩阵：functional/negative/boundary/authz 逐类给 required/covered，
    // 「每个端点的每类必需用例是否齐备」可判定、可列缺口——补测清单按 kind 分组给全量
    if (matrix) {
      lines.push(`### 覆盖矩阵（端点 × 深度用例种类）`);
      lines.push('');
      lines.push(
        `每端点必需的深度用例：functional 恒必需；有输入面（body/path/query）→ negative + boundary；受保护端点 → authz。` +
          `negative/boundary/authz 在对应阶段被裁剪或跳过时该类要求整体降级（如实标注）。`
      );
      lines.push('');
      lines.push(`| 深度用例 | 已覆盖/必需 | 缺口 |`);
      lines.push(`| --- | --- | --- |`);
      for (const [kind, v] of Object.entries(matrix.byKind)) {
        const note = !requireKind[kind] && kind !== 'functional' ? '（对应阶段未纳入/已跳过，要求降级）' : '';
        lines.push(`| ${kind}${note} | ${v.covered}/${v.required} | ${v.required - v.covered} |`);
      }
      if (waivedGapItems.length) {
        lines.push('');
        lines.push(`**覆盖豁免（coverageWaiver，逐项留痕）** ${waivedGapItems.length} 项：`);
        lines.push('');
        lines.push(`| 端点 | 缺失深度 | 豁免理由 |`);
        lines.push(`| --- | --- | --- |`);
        for (const w of waivedGapItems.slice(0, 40)) {
          lines.push(`| ${w.key} | ${w.kind} | ${mdCell(w.reason)} |`);
        }
        if (waivedGapItems.length > 40) lines.push(`（其余 ${waivedGapItems.length - 40} 项见 api-coverage.json）`);
      }
      if (hardGaps.length) {
        lines.push('');
        lines.push(
          `**门禁缺口 ${hardGaps.length} 项**（本报告得以生成说明这些缺口已被补测或豁免——若为历史归档重新生成，以下清单即补测优先级）：`
        );
        lines.push('');
        lines.push(`| 端点 | 缺失深度 | 模块 | 鉴权 |`);
        lines.push(`| --- | --- | --- | --- |`);
        for (const g of hardGaps.slice(0, 40)) {
          lines.push(`| ${g.key} | ${g.kind} | ${g.module} | ${g.auth} |`);
        }
        if (hardGaps.length > 40) lines.push(`（其余 ${hardGaps.length - 40} 项见 api-coverage.json）`);
      }
      lines.push('');
    }
    // 全量未覆盖清单落盘备查（报告表格截断前 40）
    const fullCmp = coverageAgainstInventory(apiInv, apiCoveredKeys, { full: true });
    writeJson(path.join(archiveDir, 'api-coverage.json'), {
      generatedAt: nowIso(),
      inventoryTotal: apiInv.total,
      covered: matrix ? matrix.byKind.functional.covered : apiCmp ? apiCmp.covered : 0,
      pct: matrix ? Math.round((matrix.byKind.functional.covered / Math.max(1, apiInv.total)) * 1000) / 10 : apiCmp ? apiCmp.pct : null,
      uncoveredTotal: fullCmp.uncoveredTotal,
      uncovered: fullCmp.uncovered,
      reportedByRun: apiCovRuns,
      ...(matrix
        ? {
            matrix: {
              byKind: matrix.byKind,
              gapsTotal: matrix.gaps.length,
              hardGaps: hardGaps.slice(0, 500),
              waivedGaps: waivedGapItems,
              requirementDowngraded: Object.entries(requireKind)
                .filter(([k, v]) => !v && k !== 'functional')
                .map(([k]) => k),
            },
          }
        : {}),
      ...(pageGateApplies
        ? {
            pages: {
              inventoryTotal: webInv.total,
              covered: [...pagesCovered].filter((p) => !pageGaps.includes(p) && !pageWaivedItems.some((w) => w.page === p)),
              uncovered: pageGaps,
              waived: pageWaivedItems,
            },
          }
        : {}),
      coverageWaiver: waivers,
    });
  }
  // 页面覆盖对照（前端盘点 vs browser-e2e 实测）：browser-e2e 纳入路线且盘点 ≥5 页时强制对照
  if (pageGateApplies) {
    lines.push(`## 页面覆盖对照（盘点 vs 实测）`);
    lines.push('');
    lines.push(
      `- 页面盘点: ${webInv.total} 个（来源 ${(webInv.sources || []).join('、')}，全量见 project-map.json 的 webSurface.pages）` +
        `\n- 实测访问: ${webInv.total - pageGaps.length - pageWaivedItems.length} 个（browser-e2e 用例经 TESTROUTE_PAGES_COVERAGE_FILE 上报）` +
        (pageWaivedItems.length ? `\n- 豁免 ${pageWaivedItems.length} 个（逐项理由见下方「页面覆盖豁免」表，全量落盘 api-coverage.json 的 pages.waived）` : '')
    );
    if (pageGaps.length) {
      lines.push('');
      lines.push(`**未访问页面 ${pageGaps.length} 个**（历史归档重生成时即补测优先级，前 ${Math.min(pageGaps.length, 40)} 个）：`);
      lines.push('');
      lines.push(`| 页面 |`);
      lines.push(`| --- |`);
      for (const pg of pageGaps.slice(0, 40)) lines.push(`| ${pg} |`);
    }
    if (pageWaivedItems.length) {
      // 页面豁免逐项留痕进报告（理由原样引用，与端点豁免同级呈现，不允许只留一句汇总）
      lines.push('');
      lines.push(`**页面覆盖豁免（coverageWaiver，逐项留痕）** ${pageWaivedItems.length} 页：`);
      lines.push('');
      lines.push(`| 页面 | 豁免理由 |`);
      lines.push(`| --- | --- |`);
      for (const w of pageWaivedItems.slice(0, 40)) {
        lines.push(`| ${w.page} | ${mdCell(w.reason)} |`);
      }
      if (pageWaivedItems.length > 40) lines.push(`（其余 ${pageWaivedItems.length - 40} 页见 api-coverage.json 的 pages.waived）`);
    }
    lines.push('');
  }
  lines.push(`## 失败与归因（含全部失败 run）`);
  lines.push('');
  const failureRows = [];
  for (const p of route.phases) {
    for (const run of p.runs || []) {
      const isFailed = run.status === 'failed' || run.exitCode !== 0 || (run.summary?.failed ?? 0) > 0;
      if (!isFailed) continue;
      const cls = run.triage?.classifications || [];
      const attribution = mdCell(
        cls.length
          ? cls.map((c) => `${c.caseId}=${c.classification}${c.priority ? `（${c.priority}）` : ''}`).join('; ')
          : '**未归因**'
      );
      const note = mdCell(cls.map((c) => c.note).filter(Boolean).join(' / '));
      failureRows.push(`| ${p.id} | ${run.runId} | ${attribution} | ${note} |`);
    }
  }
  if (failureRows.length === 0) {
    lines.push(`无失败 run。`);
  } else {
    lines.push(`| 阶段 | Run | 归因 | 备注 |`);
    lines.push(`| --- | --- | --- | --- |`);
    lines.push(...failureRows);
  }
  lines.push('');
  // 全量用例清单：通过与失败都写明做法与复现方式（资深测试专家标准——测试报告是可复现的操作手册，
  // 不是只有失败才值得记录）。列最近一次 run 的全部用例；更早 run 见 runs/ 与失败归因表。
  lines.push(`## 全量用例清单（逐用例：结论・做法・复现・证据）`);
  lines.push('');
  lines.push(
    `每个执行过的阶段列出其最近一次 run 的全部用例，**通过与失败都写明做法与复现方式**。` +
      `trace.zip 拖进 https://trace.playwright.dev 即可逐步重播（本地渲染，不上传；离线用 \`npx playwright show-trace <路径>\`），video.webm 直接拖进浏览器播放。`
  );
  lines.push('');
  let listedCases = 0;
  for (const p of route.phases) {
    const runs = p.runs || [];
    if (!runs.length) continue;
    const last = runs[runs.length - 1];
    let result = null;
    try {
      ({ result } = findRunResultPath(archiveDir, last.runId));
    } catch {
      result = null;
    }
    const cases = (result?.suites || []).flatMap((s) => s.cases || []);
    lines.push(
      `### ${p.id}（${p.executor || p.kind} · ${last.runId}${runs.length > 1 ? `，共 ${runs.length} 次执行，列最近一次` : ''}）`
    );
    lines.push('');
    // 证据链统计（playwright）：证据门禁按解析出的附件核对 trace/截图/video 是否真的落地
    const gate = result?.evidenceGate;
    if (p.executor === 'playwright' && gate) {
      const n = gate.total ?? cases.filter((c) => c.status !== 'skipped').length;
      const chain =
        gate.level === 'off'
          ? `证据链已关闭（evidence=off${gate.reason ? `，理由：${gate.reason}` : ''}）——本阶段无 trace/video/截图产物`
          : `trace ${gate.trace?.present ?? 0}/${n} · 截图 ${gate.screenshot?.present ?? 0}/${n} · video ${
              gate.video?.required ? `${gate.video?.present ?? 0}/${n}` : '关'
            }（evidence=${gate.level || 'full'}）${gate.compliant ? ' —— 证据门禁达标' : ' —— **⚠ 证据门禁未达标**（见 run warnings）'}`;
      lines.push(`- 证据链: ${chain}`);
      lines.push('');
    }
    if (!result || !cases.length) {
      lines.push(
        result && UNPARSED_PARSE.has(result.parseStatus)
          ? `用例未解析（${result.parseStatus}）：用例级清单不可用，通过与否以 exit code 判定，详情见 raw/ 日志。`
          : `无用例级结果。`
      );
      lines.push('');
      continue;
    }
    for (const c of cases) {
      listedCases++;
      const icon =
        c.status === 'passed'
          ? c.flaky
            ? '🔁 flaky（重跑后通过）'
            : '✅ 通过'
          : c.status === 'failed'
            ? '❌ 失败'
            : '⏭ 跳过';
      lines.push(`#### ${icon}｜${c.name || c.id}`);
      lines.push('');
      // 旧数据兼容：pytest junit 的点号模块路径曾被当文件路径存储，展示/提卡前先还原为真实相对路径
      let cFile = c.file ? String(c.file) : '';
      if (cFile && gateRoot && !cFile.includes('/') && !cFile.includes('\\')) {
        const hit = resolveDottedModulePath(gateRoot, cFile);
        if (hit) cFile = hit.file;
      }
      if (cFile) lines.push(`- 用例文件: \`${toPosix(cFile)}\``);
      if (Number.isFinite(c.durationMs) && c.durationMs > 0) lines.push(`- 耗时: ${c.durationMs}ms`);
      // 提卡优先 gateRoot，再试归档 sandbox（沙箱生成的用例 c.file 常为沙箱相对路径）
      const card =
        cFile && gateRoot ? extractCaseCard(gateRoot, cFile, [path.join(archiveDir, SANDBOX_DIR)]) : null;
      if (card) {
        lines.push(`- 做法:`);
        for (const k of ['目的', '前置', '步骤', '资料', '预期', '清理']) {
          if (card[k]) lines.push(`  - ${k}: ${String(card[k]).replace(/\|/g, '\\|')}`);
        }
      } else if (c.status !== 'skipped' && cFile && !BUILTIN_EXECUTORS.has(p.executor)) {
        // 无文件路径的用例（connectivity/health/e2e steps/sca/secrets 等内置执行器）与被扫描的目标文件
        // 本就无案例卡可言，不打扰；只有「有测试文件却没写卡」才如实标注
        lines.push(`- 做法: （案例卡缺失——生成用例时应在档头写 \`@testroute 案例\` 注释：目的/前置/步骤/资料/预期/清理）`);
      }
      lines.push(`- 复现: ${caseReproLine(p, c, result, gateRoot)}`);
      const atts = c.attachments || [];
      if (atts.length) {
        lines.push(`- 证据:`);
        for (const a of atts.slice(0, 20)) {
          const link = evidenceLink(archiveDir, a.path);
          const note =
            a.kind === 'trace'
              ? '（拖进 https://trace.playwright.dev 逐步重播；离线 `npx playwright show-trace <路径>`）'
              : a.kind === 'video'
                ? '（拖进浏览器直接播放）'
                : '';
          lines.push(`  - [${a.kind}] \`${link}\`${note}`);
        }
        for (const s of atts.filter((a) => a.kind === 'screenshot').slice(0, 5)) {
          lines.push(`  ![步骤截图](${encodeURI(evidenceLink(archiveDir, s.path))})`);
        }
      } else if (p.executor === 'playwright' && c.status !== 'skipped') {
        lines.push(
          `- 证据: （无附件——工具已强制注入证据配置（evidence=${result?.evidenceGate?.level || 'full'}）：trace/video/截图开关由 evidence wrapper config 提供、--trace on/--output 由命令兜底。仍缺失时查 run warnings 与归档 raw/artifacts/；手工复现（不经 testroute）需用例 test.use({ video: 'on', screenshot: 'on' }) 且命令带 --trace on）`
        );
      }
    }
    lines.push('');
  }
  if (listedCases === 0) {
    lines.push(`本次无可解析的已执行用例（仅生成模式，或准入链路未走完）。`);
    lines.push('');
  }
  // 复现指南：环境指纹 + 前置条件 + 逐阶段命令——任何人按此可从头复现整条路线
  lines.push(`## 复现指南（环境・前置・逐阶段命令）`);
  lines.push('');
  let envRow = null;
  for (const p of route.phases) {
    const runs = p.runs || [];
    if (!runs.length) continue;
    try {
      const { result } = findRunResultPath(archiveDir, runs[runs.length - 1].runId);
      if (result?.env) envRow = { phaseId: p.id, ...result.env };
    } catch {
      /* result.json 缺失不阻塞报告 */
    }
  }
  lines.push(
    envRow
      ? `- 运行环境: ${envRow.platform || '-'} / Node ${envRow.node || '-'}（取自 run ${envRow.phaseId} 的环境指纹）`
      : `- 运行环境: 本次 run 未记录环境指纹。`
  );
  try {
    const probesDir = path.join(archiveDir, 'probes');
    const probeFiles = fs.existsSync(probesDir)
      ? fs.readdirSync(probesDir).filter((n) => n.endsWith('.json')).map((n) => path.join(probesDir, n))
      : [];
    probeFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const probe = probeFiles.length ? readJson(probeFiles[0]) : null;
    if (probe && (probe.browserVia || probe.playwrightVersion || probe.browserVersion)) {
      lines.push(
        `- 浏览器/依赖: ${probe.browserVia || '未知来源'}${
          probe.browserVersion ? `（浏览器 ${probe.browserVersion}）` : ''
        }${probe.playwrightVersion ? ` · Playwright ${probe.playwrightVersion}` : ''}（来自 browser_probe，完整探针见 \`probes/\`）`
      );
    }
  } catch {
    /* 探针缺失不阻塞报告 */
  }
  lines.push(`- 依赖安装与卸载: 见开头「改动与卸载说明」（台账 \`provision.json\`）`);
  const connPhase = route.phases.find((x) => x.id === 'connectivity');
  if (connPhase?.targets?.length) {
    lines.push(`- 被测服务: ${connPhase.targets.join('、')}（服务启动方式见「阶段备注与检查点」各阶段 notes）`);
  }
  lines.push('');
  lines.push(`| 阶段 | Run | 复现命令 | 最近结果 |`);
  lines.push(`| --- | --- | --- | --- |`);
  for (const p of route.phases) {
    const runs = p.runs || [];
    if (!runs.length) continue;
    const last = runs[runs.length - 1];
    let cmd = null;
    let sum = null;
    try {
      const { result } = findRunResultPath(archiveDir, last.runId);
      cmd = result?.command;
      sum = result?.summary;
    } catch {
      /* 不阻塞 */
    }
    const s = sum || last.summary || {};
    const resultStr = `${s.passed ?? 0} 过 / ${s.failed ?? 0} 败 / ${s.skipped ?? 0} 跳`;
    // 复现命令必须完整可复制执行，不截断（截断的命令没法用，截断后缀的换行还会拆散表格）；
    // 反引号换成单引号防代码 span 提前闭合，mdCell 保证单元格单行
    const repro = cmd && !String(cmd).startsWith('(内置')
      ? `\`${mdCell(String(cmd).replace(/`/g, "'"))}\``
      : `\`testroute_run_tests { phaseId: "${p.id}" }\``;
    lines.push(`| ${p.id} | ${last.runId} | ${repro} | ${resultStr} |`);
  }
  lines.push('');
  lines.push(`- 用例级复现与证据见「全量用例清单」逐条；工作目录均为项目根。`);
  lines.push('');
  lines.push(`## 阶段备注与检查点`);
  lines.push('');
  for (const p of route.phases) {
    if (p.notes || p.reason || p.checkpoint) {
      lines.push(`### ${p.id}（${p.status}）`);
      if (p.reason) lines.push(`- 原因: ${p.reason}`);
      if (p.checkpoint) lines.push(`- 检查点: ${p.checkpoint}`);
      // 解析透明度：最近一次执行若结果未解析或有执行器警告，必须如实列出——否则“0过/0败/0跳”会被读成“没有测试”
      const last = Array.isArray(p.runs) && p.runs.length ? p.runs[p.runs.length - 1] : null;
      if (last) {
        try {
          const { result: lastResult } = findRunResultPath(archiveDir, last.runId);
          const warns = (lastResult?.warnings || []).slice(0, 5);
          if (UNPARSED_PARSE.has(lastResult?.parseStatus) || warns.length) {
            lines.push(
              `- 结果解析: ${lastResult.parseStatus}${
                UNPARSED_PARSE.has(lastResult?.parseStatus)
                  ? '（用例级结果未解析：计数不代表执行了个数，通过与否以 exit code 判定，详情见 raw/ 日志）'
                  : ''
              }`
            );
            for (const w of warns) {
              lines.push(`  - 警告: ${truncate(String(w), 200).replace(/\n/g, ' ')}`);
            }
          }
        } catch {
          /* result.json 缺失/损坏不阻塞报告生成 */
        }
      }
      if (p.notes) lines.push(`- 备注:\n\n  ${p.notes.replace(/\n/g, '\n  ')}`);
      lines.push('');
    }
  }
  lines.push(`## 产物索引`);
  lines.push('');
  lines.push(`- 路线计划: \`route.json\``);
  if (fs.existsSync(path.join(archiveDir, 'project-map.json'))) {
    lines.push(`- 项目地图: \`project-map.json\``);
  }
  lines.push(`- 执行记录: \`runs/<阶段>-<序号>/result.json\`（含原始日志 raw/）`);
  // 浏览器证据目录：有内容才列（trace.zip=逐步重播 · video.webm=视频 · NN-*.png=逐步截图）
  try {
    const runsDir = path.join(archiveDir, 'runs');
    const withArtifacts = [];
    if (fs.existsSync(runsDir)) {
      for (const n of fs.readdirSync(runsDir)) {
        const ad = path.join(runsDir, n, 'raw', 'artifacts');
        try {
          if (fs.statSync(ad).isDirectory() && fs.readdirSync(ad).length) {
            withArtifacts.push(`\`runs/${n}/raw/artifacts/\``);
          }
        } catch {
          /* 非目录或不可读跳过 */
        }
      }
    }
    if (withArtifacts.length) {
      lines.push(`- 浏览器证据: ${withArtifacts.join('、')}（trace.zip=拖进 trace.playwright.dev 逐步重播 · video.webm=浏览器直接播放 · NN-*.png=逐步截图）`);
    }
  } catch {
    /* 不阻塞报告 */
  }
  const tcDir = path.join(archiveDir, 'testcases');
  const tcPhases = fs.existsSync(tcDir)
    ? fs.readdirSync(tcDir).filter((n) => {
        try {
          return fs.statSync(path.join(tcDir, n)).isDirectory() && fs.readdirSync(path.join(tcDir, n)).length > 0;
        } catch {
          return false;
        }
      })
    : [];
  if (tcPhases.length) {
    lines.push(`- 用例快照: \`testcases/<阶段>/\`（本次: ${tcPhases.join('、')}）`);
  }
  const mcDir = path.join(archiveDir, 'manual-cases');
  const mcCount = fs.existsSync(mcDir) ? fs.readdirSync(mcDir).filter((n) => !n.startsWith('.')).length : 0;
  if (mcCount) {
    lines.push(`- 人工用例: \`manual-cases/\`（${mcCount} 个文件）`);
  }
  lines.push(
    fs.existsSync(path.join(archiveDir, 'workspace-changes.json'))
      ? `- 工作区变化全量清单: \`workspace-changes.json\``
      : `- 工作区变化全量清单: 未落盘（非 git 仓库，或对比台账快照本次无新增工作区变化）`
  );
  lines.push('');

  const reportPath = path.join(archiveDir, 'final-report.md');
  // 报告封章：正文 sha256 同时写进报告尾注、route.report 与 manifest 事件——三处对不上 = 报告被手改/伪造，
  // get_route 会亮红。手写 final-report.md 再伪造 finalize 事件绕过 finalize_report 的路就此堵死。
  const body = lines.join('\n');
  const reportSha = createHash('sha256').update(body + '\n', 'utf8').digest('hex');
  route.report = { path: 'final-report.md', sha256: reportSha, at: route.completedAt };
  saveRoute(archiveDir, route);
  appendEvent(archiveDir, 'finalize', `最终报告已生成，outcome=${outcome}${wasDraft ? '（路线从未被批准，标记 abandoned）' : ''}，report-sha256=${reportSha.slice(0, 16)}…`);
  fs.writeFileSync(reportPath, `${body}\n<!-- testroute-report-seal sha256=${reportSha} -->\n`, 'utf8');
  return { reportPath, outcome, route, changesBlock };
}

// 校验最终报告封章：报告尾注的 sha256 必须与正文一致，且与 route.report.sha256 对得上。
// 返回 { ok, present, reason? }；报告不存在不算篡改（present=false）。
export function verifyReportSeal(archiveDir) {
  const reportPath = path.join(archiveDir, 'final-report.md');
  if (!fs.existsSync(reportPath)) return { ok: true, present: false };
  const text = fs.readFileSync(reportPath, 'utf8');
  const m = /\n?<!-- testroute-report-seal sha256=([0-9a-f]{64}) -->\s*$/.exec(text);
  if (!m) return { ok: false, present: true, reason: 'final-report.md 没有 testroute 封章——报告不是 finalize_report 生成（手写报告），或封章被删除' };
  const seal = m[1];
  const bodyHash = createHash('sha256').update(text.slice(0, m.index) + '\n', 'utf8').digest('hex');
  if (bodyHash !== seal) return { ok: false, present: true, reason: 'final-report.md 正文与封章 sha256 不符——报告在生成后被改动' };
  const route = loadRoute(archiveDir);
  if (route.report?.sha256 && route.report.sha256 !== seal) {
    return { ok: false, present: true, reason: 'final-report.md 封章与 route.report.sha256 不符——route.json 与报告对不上（归档被手改）' };
  }
  return { ok: true, present: true };
}

export { listArchives, truncate };
