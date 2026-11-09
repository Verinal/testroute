// 工具注册表：JSON Schema 定义 + handler。所有领域工具以 testroute_ 为前缀。
import path from 'node:path';
import fs from 'node:fs';
import {
  fail, ToolError, reqStr, optStr, optNumber, optBool, reqObject, reqArray, optArray, oneOf, truncate,
} from './validate.js';
import { resolveRoot, archivesDir, listArchives, fileExists, readJson, writeJson, ensureDir, relFrom, toPosix, slug, nowStamp, resolveArchiveDir } from './paths.js';
import { scanProject, detectFrontend, loadWebSurface, normalizePagePath } from './detect.js';
import { scanApiSurface, loadApiSurface, readApiCoverageFile, endpointsFromE2eSteps, coverageMatrix, readPagesCoverageFile, COVERAGE_KINDS } from './apimap.js';
import { changedFiles, gitState } from './git.js';
import { withArchiveLock } from './lock.js';
import { initArchive, getArchiveContext, appendEvent, writeRun, prepareRun, saveTriage, snapshotFiles, finalizeReport, sandboxDirOf, verifyReportSeal } from './archive.js';
import { verifyArchiveIntegrity } from './integrity.js';
import {
  validateRoute, loadRoute, saveRoute, updatePhase, approveRoute, computeNextActions,
  findRunResultPath, requireTriageForRerun, maybeCarryOverTriage, resolvePhaseId, securityCoverage,
  canonicalizePhaseIds, injectSecurityDefaults, depthCoverage,
  summarizeRoute, summarizeCoverage,
  ROUTE_FILE,
} from './route.js';
import { provisionDeps, recordModification, ensureProvision, checkPlaywrightReady, loadProvision } from './provision.js';
import { knownStageIds } from './stages.js';
import { execute, getExecutor, EXECUTORS } from './executors/index.js';
import { lintSpecs, PLAYWRIGHT_TEST_RE } from './executors/playwright.js';
import { collectFailures, mergeFlakyRetry, failureFingerprint } from './result.js';
import { resolveCoverageFile, applyCoverage } from './executors/lcov.js';
import { runCommand } from './run.js';
import { spawnSync } from 'node:child_process';

// 工具版本戳：写进每次 run 的 env 指纹——归档自验（integrity.js）据此把「工具产出」与
// 「旧版工具产出/手工补造」区分开（env+command 齐 = 工具签名；全无 = 待宽容的 legacy；只有一半 = 手工拼装）
export const TESTROUTE_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// ---------- helpers ----------

function detectPythonBin(root) {
  for (const bin of ['python', 'py']) {
    try {
      const r = spawnSync(bin, ['--version'], { cwd: root, timeout: 6000, shell: process.platform === 'win32', windowsHide: true, encoding: 'utf8' });
      if (r.status === 0) return bin === 'py' ? 'py -3' : bin;
    } catch {}
  }
  return null;
}

// ---------- 上下文预算 ----------
// 宿主（LLM）每轮都会把全部工具结果重发计费，工具响应默认仍有硬预算 + 分层压缩保险丝。
// v2 起默认放宽到 64000（全量用例清单/证据链需要携带完整明细），可用 TESTROUTE_RESPONSE_BUDGET 调整：
// 设为更小值回到紧凑模式；设为 0 表示不限制（不推荐，仅调试用）。
const RESPONSE_CHAR_LIMIT = (() => {
  const v = Number(process.env.TESTROUTE_RESPONSE_BUDGET);
  if (!Number.isFinite(v)) return 64000;
  return v <= 0 ? Number.MAX_SAFE_INTEGER : v;
})();

function shrinkValue(v, strMax, arrMax, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') {
    return v.length > strMax ? v.slice(0, strMax) + `…[已截断，原长 ${v.length} 字符，完整内容见归档文件]` : v;
  }
  if (Array.isArray(v)) {
    const out = v.slice(0, arrMax).map((x) => shrinkValue(x, strMax, arrMax, depth + 1));
    if (v.length > arrMax) out.push(`…[其余 ${v.length - arrMax} 项省略]`);
    return out;
  }
  if (typeof v === 'object') {
    if (depth > 6) return String(v);
    const o = {};
    for (const k of Object.keys(v)) o[k] = shrinkValue(v[k], strMax, arrMax, depth + 1);
    return o;
  }
  return v;
}

function text(payload) {
  let body = payload;
  let s = JSON.stringify(body);
  if (s.length > RESPONSE_CHAR_LIMIT) {
    for (const [strMax, arrMax] of [[1200, 60], [400, 20], [160, 8]]) {
      body = shrinkValue(body, strMax, arrMax);
      s = JSON.stringify(body);
      if (s.length <= RESPONSE_CHAR_LIMIT) break;
    }
    if (s.length > RESPONSE_CHAR_LIMIT) {
      body = {
        clipped: true,
        note: `响应超出 ${RESPONSE_CHAR_LIMIT} 字符预算，已压缩为最小摘要；完整数据在归档目录内`,
      };
      s = JSON.stringify(body);
    }
  }
  return { content: [{ type: 'text', text: s }] };
}

// ---------- tool: scan_project ----------

// 项目地图的紧凑摘要：宿主只需要分布轮廓与少量样例；全量地图落盘 project-map.json。
function compactScanMap(map) {
  const m = { ...map };
  m.existingTests = {
    total: map.existingTests?.total ?? 0,
    byDir: (map.existingTests?.byDir || []).slice(0, 12).map((d) => ({
      dir: d.dir,
      count: d.count,
      samples: (d.samples || []).slice(0, 2),
    })),
  };
  m.sourceLayout = (map.sourceLayout || []).slice(0, 12);
  m.entryHints = (map.entryHints || []).slice(0, 6);
  const scriptKeys = Object.keys(map.npmTestScripts || {});
  if (scriptKeys.length > 8) {
    m.npmTestScripts = Object.fromEntries(scriptKeys.slice(0, 8).map((k) => [k, map.npmTestScripts[k]]));
    m.npmTestScriptsTruncated = `其余 ${scriptKeys.length - 8} 个脚本见 project-map.json`;
  }
  // API 端点面：只回摘要（模块分布 + 少量样例端点），全量端点清单在 project-map.json
  if (map.apiSurface?.total > 0) {
    m.apiSurface = {
      total: map.apiSurface.total,
      protectedCount: map.apiSurface.protectedCount,
      sources: map.apiSurface.sources,
      modules: (map.apiSurface.modules || []).slice(0, 15).map((x) => ({ name: x.name, count: x.count, file: x.file })),
      sampleEndpoints: (map.apiSurface.endpoints || []).slice(0, 10).map((e) => `${e.method} ${e.path}`),
      endpointList: `全量 ${map.apiSurface.total} 个端点见 project-map.json 的 apiSurface.endpoints——规划时按模块对照，全部端点都该被某个阶段覆盖`,
    };
  } else {
    delete m.apiSurface;
  }
  // 前端页面对：只回摘要（来源 + 样例页面），全量页面清单在 project-map.json
  if (map.webSurface?.total > 0) {
    m.webSurface = {
      total: map.webSurface.total,
      sources: map.webSurface.sources,
      samplePages: (map.webSurface.pages || []).slice(0, 10).map((p) => p.path),
      pageListNote: `全量 ${map.webSurface.total} 个页面路由见 project-map.json 的 webSurface.pages——browser-e2e 规划按此对照，实测访问过的页面经 TESTROUTE_PAGES_COVERAGE_FILE 上报（finalize 按盘点对照）`,
    };
  } else {
    delete m.webSurface;
  }
  // 约定资料夹 .testfile/：只回清单概览 + 内联的说明类文件；无则整段不出现（兼容）
  if (map.testfile?.present) {
    m.testfile = {
      present: true,
      dir: map.testfile.dir,
      totalFiles: map.testfile.totalFiles,
      totalBytes: map.testfile.totalBytes,
      truncated: map.testfile.truncated || undefined,
      files: (map.testfile.files || []).slice(0, 20).map((f) => `${f.path} (${f.size}B)`),
      fileListNote: map.testfile.files.length > 20 ? `其余 ${map.testfile.files.length - 20} 个文件见 project-map.json` : undefined,
      instructions: map.testfile.instructions,
      usage: `用户约定的测试资料夹：数据/配置生成用例时优先取用（只读），运行时经 TESTROUTE_TESTFILE_DIR 环境变量读取；说明类文件是用户的测试要求，规划前必读`,
    };
  } else {
    delete m.testfile;
  }
  return m;
}

async function scanProjectTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const map = scanProject(root);

  // 若已有归档（显式指定或最新），把地图落盘
  let mapPath = null;
  let archiveWarning = null;
  try {
    const ctx = getArchiveContext(root, args.archiveDir);
    mapPath = path.join(ctx.dir, 'project-map.json');
    writeJson(mapPath, map);
    appendEvent(ctx, 'scan', '项目地图已更新');
  } catch (e) {
    archiveWarning = `项目地图未能写入归档（无归档或归档不可用）：${e?.message || e}。地图仅本次返回，规划前请先 init_archive。`;
  }
  return text({
    projectMap: compactScanMap(map),
    savedTo: mapPath,
    fullMap: mapPath ? relFrom(root, mapPath) : null,
    note: '以上为紧凑摘要；完整项目地图（全部分布与样例）见 fullMap 路径的 project-map.json。',
    ...(archiveWarning ? { archiveWarning } : {}),
  });
}

// ---------- tool: init_archive ----------

async function initArchiveTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const label = optStr(args, 'label', '');
  const gitignore = optBool(args, 'gitignore', false);
  const created = initArchive(root, { label, gitignore });
  // 分叉时附上旧归档的自验结论：旧归档若有硬伤（执行记录被外部删除/事件流被手改），宿主当场
  // 就知道旧归档不可引用，而不是事后核对才发现"一次测试两个结果"该信哪个。
  let forkedFrom = created.forkedFrom || null;
  if (forkedFrom) {
    try {
      const old = verifyArchiveIntegrity(forkedFrom.archiveDir);
      forkedFrom = { ...forkedFrom, integrity: { verdict: old.verdict, fails: old.fails.length, warns: old.warns.length } };
    } catch {
      /* 旧归档无法自验时保持原样（reason 已足够说明分叉原因） */
    }
  }
  return text({
    archiveDir: created.archiveDir,
    archiveName: created.archiveName,
    sandboxDir: created.sandboxDir,
    ...(created.reused
      ? { reused: true, note: '最新归档仍是空壳（无路线、无执行记录），本次直接复用、未新建归档——后续调用缺省 archiveDir 会落在这里，状态不会"丢失"。' }
      : {}),
    ...(created.huskReset
      ? {
          huskReset: created.huskReset,
          note:
            `检测到残骸归档（${created.huskReset.reasons.join('；')}），已就地重置并继续使用本归档——` +
            `旧 manifest/route 备份为 ${created.huskReset.backedUp.join('、') || '（无）'}留证，一次测试仍对应一个归档。` +
            '此前零执行证据、无历史可丢；请从 save_route 重新起草路线。',
        }
      : {}),
    ...(forkedFrom
      ? {
          forkedFrom,
          note: `${forkedFrom.reason}${
            forkedFrom.integrity
              ? `旧归档自验：${forkedFrom.integrity.verdict}（硬伤 ${forkedFrom.integrity.fails} / 疑点 ${forkedFrom.integrity.warns}）——TAMPERED 时旧归档结论不可引用，也不要往旧归档手写补档。`
              : ''
          }`,
        }
      : {}),
    structure: {
      'manifest.json': '归档元信息与事件流（含测试脚本只读基线文件数）',
      'route.json': '（save_route 后生成）测试路线与阶段状态',
      'project-map.json': '（scan_project 后生成）项目地图',
      'sandbox/': '【生成的测试用例一律写这里】归档专属沙箱，不污染项目源码树',
      'runs/<阶段>-<序号>/': '每次执行: result.json + raw/ 原始日志',
      testcases: '生成的测试用例快照（按阶段分组）',
      'manual-cases/': '人工测试用例（markdown）',
      'provision.json': '依赖安装台账（首次安装依赖后生成）',
      'testfile-hashes.json': '项目自有测试脚本只读基线（哈希）',
      'final-report.md': '（finalize_report 后生成）最终汇总报告',
    },
    hint: '下一步：结合项目地图起草路线，然后 save_route(action="save") 保存 draft。生成的测试用例一律写入 sandbox/，禁止改动项目自有测试脚本（有哈希门禁）。',
  });
}

// ---------- tool: save_route ----------

// browser-e2e 默认建议（软建议，不拦批准）：前端项目 + 生成+执行模式 + 路线没有 browser-e2e 阶段 → 提示。
// 与安全默认注入（自动补阶段）不同：browser-e2e 只「默认建议开启、用户可裁掉」——
// 裁掉须在批准摘要向用户确认，并把理由写进路线 notes 留痕。
function detectFrontendFlag(root, archiveDir) {
  try {
    const mapPath = path.join(archiveDir, 'project-map.json');
    const map = fs.existsSync(mapPath) ? readJson(mapPath) : null;
    if (map && typeof map.frontend?.detected === 'boolean') return map.frontend.detected;
  } catch {
    /* 地图缺失/损坏 → 现场探测 */
  }
  try {
    return detectFrontend(root).detected === true;
  } catch {
    return false;
  }
}

function browserE2eSuggested(route, root, archiveDir) {
  if (route.mode !== 'generate-and-execute') return false;
  if ((route.phases || []).some((p) => p.id === 'browser-e2e')) return false;
  return detectFrontendFlag(root, archiveDir);
}

async function saveRouteTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const route = reqObject(args, 'route');
  const action = oneOf(optStr(args, 'action', 'save'), ['save', 'approve'], 'action');
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));

  validateRoute(route);
  // 归档内的路线固定记录项目根，避免漂移
  route.project = { ...(route.project || {}), root };
  const apiSurface = loadApiSurface(root, ctx.dir);
  // 落地规范（不依赖 LLM 服从性；approve 的 E_GATE 仍是兜底）：
  // 1) 阶段 id 规范化（"smoke-01" 式序号后缀 / 执行器可唯一映射的自定义 id）
  // 2) 默认安全覆盖：安全段缺口自动补齐—— sca+secrets（完全没安全段时）；
  //    API 项目且 connectivity targets 可推导基址时补 dast（内置 security-probe 全量动态探测）
  const normalizedIds = canonicalizePhaseIds(route);
  const securityDefaultsInjected = injectSecurityDefaults(route, apiSurface);
  if (normalizedIds.length || securityDefaultsInjected.length) validateRoute(route);
  if (action === 'approve') {
    if (route.status !== 'draft') {
      fail('E_GATE', `只有 draft 状态的路线可以 approve（当前 ${route.status}）。请直接保存后重新走评审。`);
    }
  }

  // 合并保护：磁盘上已有非 draft 路线（有执行进度）时，重发/重试旧参数不得静默抹掉执行记录。
  // 要完全重来必须显式 resetRoute=true（runs/ 目录文件保留，仅清空路线内引用）。
  const resetRoute = optBool(args, 'resetRoute', false);
  let diskRoute = null;
  try {
    diskRoute = loadRoute(ctx.dir);
  } catch {
    diskRoute = null; // 无路线或损坏 → 按首次保存处理（损坏文件被本次合法内容替换）
  }
  let alreadyApproved = false;
  if (diskRoute && !resetRoute) {
    const hasProgress = (diskRoute.phases || []).some((p) => (p.runs?.length || 0) > 0) || diskRoute.status !== 'draft';
    if (hasProgress && action === 'approve') {
      alreadyApproved = true; // 重复 approve → 幂等返回现状，不覆盖
    } else if (hasProgress) {
      const newIds = new Set(route.phases.map((p) => p.id));
      const droppedWithRuns = diskRoute.phases.filter((p) => !newIds.has(p.id) && (p.runs?.length || 0) > 0);
      if (droppedWithRuns.length) {
        fail(
          'E_GATE',
          `本次保存会删除已有执行记录的阶段（${droppedWithRuns.map((p) => p.id).join('、')}）。` +
            `执行记录不可静默丢弃：确认要重置路线请显式传 resetRoute=true（阶段状态与执行引用清空，runs/ 目录文件保留并记录事件）。`
        );
      }
      // 对存续阶段保留执行进度（status/runs/checkpoint）；计划字段（executor/command/paths/notes…）以新路线为准
      const diskById = new Map(diskRoute.phases.map((p) => [p.id, p]));
      for (const p of route.phases) {
        const old = diskById.get(p.id);
        if (!old) continue;
        p.status = old.status;
        if (old.runs?.length) p.runs = old.runs;
        if (old.checkpoint) p.checkpoint = old.checkpoint;
        if (old.reason !== undefined && p.reason === undefined) p.reason = old.reason;
      }
      route.status = diskRoute.status;
      if (diskRoute.terminated) route.terminated = diskRoute.terminated;
      if (diskRoute.approvedAt) route.approvedAt = diskRoute.approvedAt;
    }
  }

  let finalRoute;
  if (alreadyApproved) {
    finalRoute = diskRoute;
    appendEvent(ctx, 'approve', '重复 approve（幂等：返回现状，未覆盖任何内容）');
  } else {
    if (resetRoute && diskRoute) {
      appendEvent(ctx, 'route-reset', '显式 resetRoute=true：路线被重发覆盖（阶段状态与执行引用以新路线为准；runs/ 目录文件保留）');
    }
    saveRoute(ctx.dir, route);
    finalRoute = action === 'approve' ? approveRoute(ctx.dir, { apiSurface }) : loadRoute(ctx.dir);
    appendEvent(ctx, action === 'approve' ? 'approve' : 'save-route', `路线${action === 'approve' ? '已批准' : '已保存'}（${route.phases.length} 个阶段）`);
  }
  const unknownStageIds = (finalRoute.phases || [])
    .map((p) => p.id)
    .filter((id) => !knownStageIds().includes(id));
  let hint =
    '批准前必须向用户完整呈现路线：层-阶段清单（含每阶段范围 notes）、阻断语义（abort/block/ask/continue）、' +
    '安全段包含/跳过清单（对照返回的 security 字段，不可静默裁掉）、需要安装的依赖（走 provision 同意流程）。';
  if (unknownStageIds.length) {
    hint += `非标准阶段 id：${unknownStageIds.join('、')}（自定义 id 仅用于标准目录覆盖不了的场景；能映射到标准 id 的已自动改写，见 normalizedIds）。`;
  }
  if (securityDefaultsInjected.length) {
    hint += `安全段缺口已自动补齐：${securityDefaultsInjected.join('、')}（默认安全覆盖，返回 securityDefaultsInjected）；这些也必须写进批准摘要；用户明确不要对应安全探测时先向其确认，再用 securityWaiver 留痕。`;
  }
  const suggestE2e = alreadyApproved ? false : browserE2eSuggested(route, root, ctx.dir);
  if (suggestE2e) {
    hint +=
      `检测到前端项目但路线未纳入 browser-e2e（真实浏览器 E2E：全流程截图 + trace.zip 重播 + video 证据）：默认建议开启——` +
      `请在批准摘要向用户呈现并确认；用户确认不需要时才可裁掉，并把理由写进该决策对应的 notes 留痕（browserE2eSuggested）。`;
  }
  // 深度基线（API 项目）：盘点端点 → 缺 negative/boundary/功能主流程/authz 时提示；approve 阶段由工具硬拦
  let depth = null;
  let depthGaps = [];
  if (action !== 'approve' || !alreadyApproved) {
    try {
      depth = depthCoverage(route, apiSurface);
      depthGaps = alreadyApproved ? [] : depth.gaps;
    } catch {
      depth = null;
      depthGaps = [];
    }
  }
  if (depth?.isApiProject && depthGaps.length) {
    hint +=
      `API 深度基线缺口（盘点 ${depth.apiTotal} 个端点）: ${depthGaps.map((g) => g.stage).join('、')} 未纳入路线。` +
      `save 阶段仅提示；approve 时工具会拦（E_GATE），补齐这些阶段或经用户确认后写 depthWaiver。`;
  }
  return text({
    saved: true,
    action,
    ...(alreadyApproved
      ? { alreadyApproved: true, note: '路线此前已批准，本次重复 approve 未做任何改动（幂等）。要修改阶段请用 resetRoute=true 重置或开新归档。' }
      : {}),
    routeStatus: finalRoute.status,
    routePath: path.join(ctx.dir, ROUTE_FILE),
    ...(normalizedIds.length ? { normalizedIds } : {}),
    ...(securityDefaultsInjected.length ? { securityDefaultsInjected } : {}),
    ...(suggestE2e ? { browserE2eSuggested: true } : {}),
    ...(depth && depth.isApiProject
      ? {
          depthBaseline: {
            isApiProject: true,
            apiTotal: depth.apiTotal,
            functional: depth.functional,
            negative: depth.negative,
            boundary: depth.boundary,
            authz: depth.authz,
            dast: depth.dast,
            gaps: depthGaps,
            waived: depth.waived,
          },
        }
      : {}),
    unknownStageIds,
    security: securityCoverage(finalRoute),
    hint,
    nextActions: computeNextActions(finalRoute),
  });
}

// ---------- tool: get_route ----------

async function getRouteTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const route = loadRoute(ctx.dir);
  // 报告防伪校验：手写 final-report.md / 生成后改动 / route.json 与报告哈希对不上 → get_route 直接亮红
  const seal = verifyReportSeal(ctx.dir);
  // 归档自验常驻红牌：伪造 result.json / 抽走执行记录 / 手改 route 状态，不必等到 verify_archive
  // 才发现——宿主每次 get_route 都会撞上（TRUSTED 时整段缺席，零噪音）。
  const integrity = verifyArchiveIntegrity(ctx.dir);
  // 响应预算：默认只回路线摘要（阶段状态 + 最近 run 概况）；detail="full" 才内联 route.json 全文
  const detail = oneOf(optStr(args, 'detail', 'summary'), ['summary', 'full'], 'detail');
  let provision = null;
  try {
    const ledger = loadProvision(ctx.dir);
    provision = ledger
      ? { installs: ledger.installs.length, modifications: ledger.modifications.length, preStateCapturedAt: ledger.preState?.capturedAt || null }
      : null;
  } catch {
    provision = null;
  }
  return text({
    archiveDir: ctx.dir,
    archiveName: ctx.name,
    sandboxDir: sandboxDirOf(ctx.dir),
    provision,
    ...(detail === 'full' ? { route } : { routeSummary: summarizeRoute(route) }),
    ...(seal.present && !seal.ok
      ? {
          reportIntegrity: {
            ok: false,
            reason: seal.reason,
            note: '该归档的最终报告不可信（防伪校验失败）：请以 finalize_report 重新产出报告，或重建归档重跑。',
          },
        }
      : {}),
    ...(integrity.verdict !== 'TRUSTED'
      ? {
          integrity: {
            verdict: integrity.verdict,
            fails: integrity.fails.length,
            warns: integrity.warns.length,
            topFails: integrity.fails.slice(0, 3).map((f) => `[${f.area}${f.subject ? '/' + f.subject : ''}] ${truncate(f.message, 160)}`),
          },
          integrityNote:
            integrity.verdict === 'TAMPERED'
              ? '该归档自验 TAMPERED（存在硬伤）：结论不可引用，也不得手写补档掩盖——按缺口用工具重跑相关阶段，或 init_archive 重建（残骸会被就地重置复用）；详见 testroute_verify_archive。'
              : '该归档自验 SUSPECT（有疑点未构成硬伤）：引用结论前先复核疑点项；确认全部 run 来自旧版工具可用 testroute_verify_archive(allowLegacy=true) 复验。',
        }
      : {}),
    nextActions: computeNextActions(route),
    allArchives: listArchives(root).slice(0, 10),
  });
}

// ---------- tool: update_phase ----------

async function updatePhaseTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const phaseId = reqStr(args, 'phaseId');
  const status = oneOf(reqStr(args, 'status'), ['pending', 'in-progress', 'awaiting-approval', 'passed', 'failed', 'blocked', 'skipped'], 'status');
  const reason = args.reason !== undefined ? optStr(args, 'reason', '') : undefined;
  const notes = args.notes !== undefined ? optStr(args, 'notes', '') : undefined;
  const allowTestFileChanges = optBool(args, 'allowTestFileChanges', false);
  const res = updatePhase(ctx.dir, { phaseId, status, reason, notes, allowTestFileChanges });
  appendEvent(ctx, 'phase', `${res.phase.id}: ${res.phase.status}${allowTestFileChanges ? '（测试脚本改动已确认，基线重建）' : ''}`);
  return text({
    phaseId: res.phase.id,
    status: res.phase.status,
    propagated: res.propagated,
    nextActions: computeNextActions(res.route),
  });
}

// ---------- tool: read_changes ----------

async function readChangesTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const changes = changedFiles(root);
  if (changes.isRepo) {
    const map = scanProject(root);
    changes.testFileIndex = {
      total: map.fileStats.testFiles,
      byDir: map.existingTests.byDir.slice(0, 10),
    };
    changes.hint =
      changes.summary.source + changes.summary.tests === 0
        ? '工作区无变更，可按全量模式规划路线。'
        : '建议：变更的源文件若无对应测试 → 该模块纳入生成范围；已有测试的模块 → 纳入回归范围。';
  }
  return text(changes);
}

// ---------- tool: run_tests ----------

// 阶段 → 覆盖深度的默认归类：某 run 触及的端点按所在阶段计入对应 kind 的覆盖
//（negative 阶段的触及计入 negative，boundary 阶段计入 boundary，authz 阶段计入 authz；
// 其余阶段计入 functional）。沙箱脚本可在覆盖清单里显式声明 kinds（{method, path, kinds:[…]}），
// 与阶段默认取并集——脚本比阶段语义更清楚时以脚本为准地加码，工具不做减法。
const PHASE_KIND_COVER = { negative: ['negative'], boundary: ['boundary'], authz: ['authz'] };
const kindsForPhase = (phaseId) => PHASE_KIND_COVER[phaseId] || ['functional'];

// 把 API 端点盘点与页面盘点快照写进归档（run_tests 时刷新），供沙箱脚本经
// TESTROUTE_ENDPOINTS_FILE / TESTROUTE_PAGES_FILE 环境变量读取——脚本按盘点系统性铺满端点，
// 而不是凭感觉挑几个端点测（33/125 那种"测了个寂寞"的覆盖就是这样来的）。
function writeSurfaceSnapshots(root, archiveDir) {
  const inv = loadApiSurface(root, archiveDir);
  if (inv && Array.isArray(inv.endpoints) && inv.endpoints.length) {
    writeJson(
      path.join(archiveDir, 'api-endpoints.json'),
      inv.endpoints.map((e) => ({
        key: `${e.method} ${e.path}`,
        method: e.method,
        path: e.path,
        auth: e.auth,
        module: e.module,
        ...(e.hasBody ? { hasBody: true } : {}),
        ...(e.hasParams ? { hasParams: true } : {}),
      }))
    );
  }
  const ws = loadWebSurface(root, archiveDir);
  if (ws && Array.isArray(ws.pages) && ws.pages.length) {
    writeJson(
      path.join(archiveDir, 'web-pages.json'),
      ws.pages.map((p) => ({ path: p.path, source: p.source }))
    );
  }
  return { inv, ws };
}

async function runTestsTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));

  const route = loadRoute(ctx.dir);
  if (route.status === 'draft') {
    fail('E_ROUTE_NOT_APPROVED', '路线尚未批准（draft）。先走用户评审并 save_route(action="approve")。');
  }
  if (route.mode !== 'generate-and-execute') {
    fail('E_MODE_READONLY', '当前路线为仅生成模式（generate-only），不允许执行测试。');
  }
  // phaseId 容错解析（大小写/下划线/唯一包含），报错列出现有 ids
  const phaseId = resolvePhaseId(route, reqStr(args, 'phaseId'));
  const phase = route.phases.find((p) => p.id === phaseId);
  if (phase.kind !== 'execute') {
    fail('E_GATE', `阶段 "${phaseId}" 的 kind=${phase.kind}，只有 kind="execute" 的阶段可以执行测试。`);
  }
  if (phase.status !== 'in-progress') {
    if (phase.status === 'passed' || phase.status === 'skipped') {
      fail(
        'E_GATE',
        `阶段 "${phaseId}" 已是终态 ${phase.status}，不可再执行。要重测：save_route 重新提交包含该阶段的路线（会保留执行历史），或 init_archive 开新归档；` +
          `passed/skipped 是状态机终态，不能改回 in-progress。`
      );
    }
    fail('E_GATE', `阶段 "${phaseId}" 状态为 ${phase.status}，请先 update_phase(phaseId="${phaseId}", status="in-progress")。`);
  }
  // 失败指纹继承：本次失败与上一轮已归因失败指纹完全一致 → 自动继承归因（carriedFrom 留痕），不重复交 record_triage
  const carried = maybeCarryOverTriage(ctx.dir, route, phase);
  if (carried) appendEvent(ctx, 'triage-carry', `${carried.runId} 继承 ${carried.carriedFrom} 的归因（失败指纹一致）`);
  // 仍在拦截的情形：未归因且无一致指纹（新失败/修复生效）→ 必须逐次归因
  requireTriageForRerun(phase);

  const executorId = oneOf(
    optStr(args, 'executor', phase.executor || ''),
    ['vitest', 'jest', 'pytest', 'generic', 'health', 'sca', 'e2e', 'playwright', 'secrets', 'security-probe'],
    'executor'
  );
  const command = optStr(args, 'command', phase.command || '');
  if (executorId === 'generic' && !command) {
    fail('E_INVALID_ARGS', 'executor="generic" 需要 command 参数（或阶段里预置 command）。');
  }
  const paths = args.paths !== undefined ? optArray(args, 'paths') : phase.paths || [];
  const targets = args.targets !== undefined ? optArray(args, 'targets') : phase.targets || [];
  if (executorId === 'health' && targets.length === 0) {
    fail('E_INVALID_ARGS', 'executor="health" 需要 targets（http(s) URL 数组，可放参数或阶段定义）。');
  }
  const steps = Array.isArray(args.steps) ? args.steps : phase.steps || [];
  if (executorId === 'e2e' && steps.length === 0) {
    fail('E_INVALID_ARGS', 'executor="e2e" 需要 steps（声明式 HTTP 步骤数组，可放参数或阶段定义）。');
  }
  const timeoutMs = optNumber(args, 'timeoutMs', 300000);
  // flaky 识别：失败后自动复跑一次，复跑通过的用例标 flaky（不稳定），不按真实失败阻断
  const retryFailedOnce = optBool(args, 'retryFailedOnce', false);
  // 覆盖率：显式开关（coverage: true 才解析），默认关闭。开启时 coverageFile 缺省自动探测。
  const wantCoverage = optBool(args, 'coverage', false);
  const coverageFileArg = args.coverageFile !== undefined ? optStr(args, 'coverageFile', '') : '';
  const coveragePath = wantCoverage ? resolveCoverageFile(root, coverageFileArg) : null;
  // 证据链（playwright 阶段）硬约定：默认 full（trace+video+截图，工具强制注入 config 与命令开关）。
  // 降级/关闭必须有理由留痕——evidenceReason 必填；'off' 仅当 .testfile/用户明写不用证据才允许传。
  const evidence = args.evidence !== undefined
    ? oneOf(optStr(args, 'evidence', 'full'), ['full', 'trace', 'off'], 'evidence')
    : oneOf(String(phase.evidence || 'full'), ['full', 'trace', 'off'], 'phase.evidence');
  const evidenceReason = args.evidenceReason !== undefined ? optStr(args, 'evidenceReason', '') : String(phase.evidenceReason || '');
  if (evidence !== 'full' && !evidenceReason.trim()) {
    fail(
      'E_INVALID_ARGS',
      `evidence="${evidence}" 必须附 evidenceReason（引用 .testfile/用户的明写要求，或 ffmpeg 缺失等依据）——证据链默认强制开启，降级必须留痕。`
    );
  }

  let pythonBin;
  if (executorId === 'pytest') {
    pythonBin = optStr(args, 'pythonBin', detectPythonBin(root) || 'python');
  }

  // 沙箱-only 门禁：TestRoute 只执行自己生成到沙箱的用例；项目自有测试只读参考（不执行、不修改）。
  // 这样全部测试产物都落在归档目录内——不需要时删除整个 test-archives/ 即完成清理。
  const sandboxAbs = sandboxDirOf(ctx.dir);
  const sandboxRel = toPosix(relFrom(root, sandboxAbs));
  const sandboxVariants = [sandboxAbs, toPosix(sandboxAbs), sandboxRel, sandboxRel.split('/').join('\\')].map((v) => v.toLowerCase());
  const inSandbox = (s) => sandboxVariants.some((v) => String(s).toLowerCase().includes(v));
  const PATH_EXECUTORS = ['vitest', 'jest', 'pytest', 'playwright'];
  const cmdStr = String(command || '');
  // executor=playwright 的自定义命令必须由 playwright test 驱动：node 脚本挂名 playwright 会绕开
  // 证据注入（evidencePlan 只补丁 playwright test 命令），trace/video/截图必然全无——直接拒绝。
  if (executorId === 'playwright' && cmdStr.trim() && !PLAYWRIGHT_TEST_RE.test(cmdStr)) {
    fail(
      'E_GATE',
      `executor="playwright" 的自定义命令必须包含 "playwright test"（如 npx playwright test …）。` +
        `自管 node 脚本会绕开证据链注入（--config 证据 wrapper / --trace on / --output），证据必然缺失——` +
        `要么改成 playwright test 命令，要么改用 executor="generic" 并自行产出 TESTROUTE_ARTIFACTS_DIR 证据。`
    );
  }
  // 命令串先抹掉沙箱路径（绝对/相对、两种分隔符）再找项目测试目录痕迹，避免沙箱内 "tests/" 误报
  let scrubbed = cmdStr;
  for (const v of [sandboxAbs, toPosix(sandboxAbs), sandboxRel, sandboxRel.split('/').join('\\')]) {
    scrubbed = scrubbed.split(v).join('\u0000');
  }
  scrubbed = scrubbed.toLowerCase();
  if (PATH_EXECUTORS.includes(executorId) && !cmdStr.trim() && paths.length === 0) {
    fail(
      'E_GATE',
      `executor="${executorId}" 必须显式传 paths 指向沙箱内用例（${sandboxRel}/ 下）；缺省会让测试框架跑到项目自有测试。项目自有测试只读参考，不执行。`
    );
  }
  const outsidePaths = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
    const rel = relFrom(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // 项目外路径不归本门禁管
    const lowerAbs = abs.toLowerCase();
    if (lowerAbs === sandboxAbs.toLowerCase() || lowerAbs.startsWith(sandboxAbs.toLowerCase() + path.sep)) continue;
    if (PATH_EXECUTORS.includes(executorId) || /(^|[\\/])(tests?|__tests__|spec|cypress|e2e)([\\/]|$)/.test(rel)) {
      outsidePaths.push(toPosix(rel));
    }
  }
  const cmdDirRef = /(^|[\s\\/"'=,(])(tests?|__tests__|spec|cypress|e2e)[\\/]/.exec(scrubbed);
  if (cmdDirRef) {
    fail(
      'E_GATE',
      `命令引用了沙箱外的测试目录（…${cmdDirRef[2]}/…）。项目自有测试只读参考、不执行——请执行沙箱（${sandboxRel}/）内生成的用例。`
    );
  }
  if (/\b(npm|yarn|pnpm|bun)\s+(run\s+)?test\b/.test(scrubbed)) {
    fail(
      'E_GATE',
      '命令在执行项目自有的测试脚本（npm/yarn/pnpm test）。按约定项目自有测试只读参考、不执行——请在沙箱生成 TestRoute 自己的用例并执行它们。'
    );
  }
  if ((/\b(vitest|jest|pytest)\b/.test(scrubbed) || /\bplaywright\s+test\b/.test(scrubbed)) && !inSandbox(cmdStr)) {
    fail(
      'E_GATE',
      `命令调用了测试框架但没有指向沙箱内用例（缺省会落到项目自有测试）。请在 paths 或 command 中显式指向沙箱（${sandboxRel}/）内的用例。`
    );
  }
  if (outsidePaths.length) {
    fail(
      'E_GATE',
      `以下路径在沙箱外且属于/疑似项目自有测试（约定只读参考，不执行）：\n  - ${outsidePaths.join('\n  - ')}\n请把用例生成到沙箱（${sandboxRel}/）后执行沙箱内的用例。`
    );
  }

  const git = gitState(root);
  // 环境指纹：每次 run 记录执行环境（透明可复现——复现指南按此对齐环境）
  const envFingerprint = { platform: process.platform, node: process.version, testroute: TESTROUTE_VERSION };
  // 盘点快照：API 端点 + 前端页面写进归档（脚本经环境变量读取，按盘点铺满端点/页面）
  const { inv: surfaceInv, ws: surfaceWs } = writeSurfaceSnapshots(root, ctx.dir);
  const runRefs = [];
  const runOnce = async () => {
    const slot = prepareRun(ctx.dir, phaseId);
    const { result, proc } = await execute({
      root,
      executorId,
      command,
      paths,
      targets,
      steps,
      outDir: slot.rawDir,
      timeoutMs,
      pythonBin,
      archiveDir: ctx.dir,
      config: phase.config || {},
      evidence,
      evidenceReason,
    });
    result.phaseId = phaseId;
    result.git = git;
    result.env = envFingerprint;
    result.evidenceReason = evidenceReason || null; // 证据降级/关闭的理由留痕（evidence=full 时为 null）
    // 覆盖收集：
    // - 端点：沙箱脚本按约定写入 TESTROUTE_COVERAGE_FILE（execute 注入的落点）；e2e 阶段直接从
    //   声明式 steps 推导。kinds 语义：脚本可显式声明（{method, path, kinds}），未声明按所在阶段
    //   默认归类（kindsForPhase）——finalize 覆盖矩阵据此判定「每端点每类必需用例」是否齐备。
    // - 页面：browser-e2e 用例把实际访问过的页面路由写入 TESTROUTE_PAGES_COVERAGE_FILE。
    const covRaw = readApiCoverageFile(path.join(slot.rawDir, 'api-coverage.json'));
    let endpointKeys = covRaw ? covRaw.keys : null;
    let endpointKinds = covRaw ? covRaw.kinds : {};
    if (!endpointKeys && executorId === 'e2e' && steps.length) {
      endpointKeys = endpointsFromE2eSteps(steps);
      endpointKinds = {};
    }
    if (endpointKeys?.length) {
      const kinds = {};
      for (const k of endpointKeys) {
        kinds[k] = [...new Set([...(endpointKinds[k] || []), ...kindsForPhase(phaseId)])].filter((x) => COVERAGE_KINDS.includes(x));
      }
      result.apiCoverage = { type: 'api-endpoints', total: endpointKeys.length, endpoints: endpointKeys, kinds };
    } else if (['generic', 'pytest', 'vitest', 'jest'].includes(executorId)) {
      if (surfaceInv && surfaceInv.total >= 5) {
        result.warnings.push(
          '未产出 API 覆盖清单：沙箱脚本应把本次触及的端点写入环境变量 TESTROUTE_COVERAGE_FILE 指向的文件' +
            `（JSON 数组，元素为 "METHOD /path" 或 {method, path}；盘点清单在环境变量 TESTROUTE_ENDPOINTS_FILE 指向的文件，共 ${surfaceInv.total} 个端点，按它铺满）。` +
            '没有覆盖上报，finalize 覆盖门禁只能按缺口拦截——API 项目未铺满盘点端点是过不了验收的。'
        );
      }
    }
    // 页面上报按页面口径归一（normalizePagePath，与盘点/豁免同一把尺，大小写敏感）
    const pagesCovered = readPagesCoverageFile(path.join(slot.rawDir, 'pages-coverage.json'), normalizePagePath);
    if (pagesCovered?.length) {
      result.pageCoverage = { type: 'pages', total: pagesCovered.length, pages: pagesCovered };
    } else if (executorId === 'playwright') {
      try {
        const ws = loadWebSurface(root, ctx.dir);
        if (ws && ws.total >= 5) {
          result.warnings.push(
            '未产出页面覆盖清单：browser-e2e 用例应把实际访问过的页面路由写入环境变量 TESTROUTE_PAGES_COVERAGE_FILE 指向的文件' +
              `（JSON 数组，元素 "/login" 或 {path}；页面盘点在环境变量 TESTROUTE_PAGES_FILE 指向的文件，共 ${ws.total} 个页面）。` +
              '没有它，finalize 的「页面覆盖对照」按缺口拦截。'
          );
        }
      } catch {
        /* 页面盘点不可得 → 不提醒 */
      }
    }
    // 证据规范 lint（软约束，只警告不拦）：playwright 用例缺 test.use 全量证据开关或缺逐步截图时提醒
    if (executorId === 'playwright' && paths.length) {
      result.warnings.push(...lintSpecs({ root, paths }));
    }
    applyCoverage(result, { root, coveragePath });
    const written = writeRun(ctx.dir, phaseId, result, proc, slot);
    runRefs.push({
      runId: written.runId,
      resultPath: relFrom(ctx.dir, written.resultPath),
      status: result.status,
      exitCode: result.exitCode,
      parseStatus: result.parseStatus,
      summary: result.summary,
      triage: null,
      fingerprint: failureFingerprint(result),
      git: result.git,
      // 路线里只存 coverage totals（文件级明细在 result.json / lcov 源文件），防止 route.json 随覆盖率膨胀
      coverage: summarizeCoverage(result.coverage),
      // API 覆盖同理只存数量；端点全量清单在该 run 的 result.json 里
      ...(result.apiCoverage ? { apiCoverage: { type: 'api-endpoints', total: result.apiCoverage.total } } : {}),
      ...(result.pageCoverage ? { pageCoverage: { type: 'pages', total: result.pageCoverage.total } } : {}),
      // 证据门禁结论镜像进路线（updatePhase 的 passed 门禁以此为准，result.json 缺失也能判）；
      // 完整统计（trace/screenshot/video 计数、warnings）在该 run 的 result.json 里
      ...(result.evidenceGate
        ? {
            evidenceGate: {
              level: result.evidenceGate.level,
              compliant: result.evidenceGate.compliant,
              ...(result.evidenceGate.reason ? { reason: result.evidenceGate.reason } : {}),
              ...(Array.isArray(result.evidenceGate.missing) && result.evidenceGate.missing.length ? { missing: result.evidenceGate.missing } : {}),
            },
          }
        : {}),
      ...(evidence !== 'full' ? { evidence, evidenceReason } : {}),
    });
    return { result, written };
  };

  let current = await runOnce();
  let retryInfo = null;
  if (retryFailedOnce && (current.result.summary.failed > 0 || current.result.exitCode !== 0)) {
    const first = current;
    const second = await runOnce();
    const flakyCases = mergeFlakyRetry(first.result, second.result);
    retryInfo = {
      attempted: true,
      firstRunId: first.written.runId,
      retriedRunId: second.written.runId,
      flakyCases,
    };
    current = second;
  }
  const { result, written } = current;

  // 回写路线
  const freshRoute = loadRoute(ctx.dir);
  const freshPhase = freshRoute.phases.find((p) => p.id === phaseId);
  freshPhase.runs = freshPhase.runs || [];
  freshPhase.runs.push(...runRefs);
  // 解析降级（exit-code-only/parse-error）且 0 用例时，“0过/0败/0跳”只代表"未解析"而非"未执行"——检查点措辞必须防止误读
  const summaryUnparsed =
    (result.summary?.total ?? 0) === 0 && ['exit-code-only', 'parse-error'].includes(result.parseStatus);
  freshPhase.checkpoint = `[${result.finishedAt}] ${written.runId}: ${result.status}（${
    summaryUnparsed
      ? `用例未解析，仅按 exit code 判定（exit=${result.exitCode}）`
      : `${result.summary.passed}过/${result.summary.failed}败/${result.summary.skipped}跳`
  }）`;
  freshRoute.updatedAt = result.finishedAt;
  saveRoute(ctx.dir, freshRoute);
  appendEvent(
    ctx,
    'run-complete',
    `${written.runId} → ${result.status}${retryInfo ? `（复跑识别 flaky: ${retryInfo.flakyCases.length}）` : ''}`
  );

  // 累计覆盖快照：合并归档内全部 run 的端点/页面上报（按阶段默认 kinds 归类），
  // 回传矩阵与剩余缺口——宿主每轮执行后都知道「还差哪些端点没测」，循环收口有依据。
  let coverageNow = null;
  try {
    if ((surfaceInv?.total ?? 0) > 0 || (surfaceWs?.total ?? 0) > 0) {
      const byKey = new Map();
      const pages = new Set();
      for (const p of freshRoute.phases || []) {
        const phaseKinds = kindsForPhase(p.id);
        for (const run of p.runs || []) {
          let r = null;
          try {
            r = readJson(path.join(ctx.dir, run.resultPath || ''));
          } catch {
            r = null;
          }
          const ac = r?.apiCoverage;
          if (ac && Array.isArray(ac.endpoints)) {
            for (const k of ac.endpoints) {
              const set = byKey.get(k) || new Set();
              for (const kind of ac.kinds?.[k] || phaseKinds) set.add(kind);
              byKey.set(k, set);
            }
          }
          const pc = r?.pageCoverage;
          if (pc && Array.isArray(pc.pages)) for (const pg of pc.pages) pages.add(pg);
        }
      }
      const matrix = coverageMatrix(surfaceInv, byKey);
      coverageNow = {
        endpointMatrix: matrix.byKind,
        endpointGaps: { total: matrix.gaps.length, sample: matrix.gaps.slice(0, 40).map((g) => `${g.key} 缺[${g.kind}]`) },
        pages: { inventory: surfaceWs?.total ?? 0, coveredSoFar: pages.size },
        note: '端点覆盖矩阵按「盘点 × 深度用例种类」累计（functional/negative/boundary/authz）；缺口清零前 finalize 覆盖门禁会拦——逐端点补测或走 coverageWaiver 逐项留痕。',
      };
    }
  } catch {
    coverageNow = null;
  }

  // 0 用例崩溃出口：exitCode≠0 且解析到 0 个用例 → environment 归因也放行不了，必须给出路
  const noCasesParsed = result.exitCode !== 0 && (result.summary?.total ?? 0) === 0;
  return text({
    runId: written.runId,
    previousRunIds: runRefs.slice(0, -1).map((r) => r.runId),
    resultPath: relFrom(ctx.dir, written.resultPath),
    rawDir: relFrom(ctx.dir, written.rawDir),
    status: result.status,
    exitCode: result.exitCode,
    summary: result.summary,
    failures: collectFailures(result, 20),
    // 全量用例清单（过与不过都回，宿主可直接引用证据路径）；超大时预算保险丝会自动压缩
    cases: (result.suites || []).flatMap((s) => s.cases || []).map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.file ? { file: c.file } : {}),
      status: c.status,
      durationMs: c.durationMs,
      ...(c.flaky ? { flaky: true } : {}),
      ...(Array.isArray(c.attachments) && c.attachments.length ? { attachments: c.attachments } : {}),
    })),
    warnings: result.warnings,
    retry: retryInfo,
    git,
    // 证据门禁结果（playwright 阶段）：trace/截图/video 落地统计 + 是否达标；evidence=off 时含理由
    ...(result.evidenceGate
      ? { evidenceGate: result.evidenceGate, ...(evidence !== 'full' ? { evidence, evidenceReason } : {}) }
      : {}),
    // coverage 只回 totals；文件级明细在 resultPath（result.json）与 lcov 源文件
    coverage: summarizeCoverage(result.coverage),
    // 本次 run 触及的 API 端点（来自沙箱脚本上报 / e2e steps 推导），含深度 kinds 标记
    ...(result.apiCoverage
      ? { apiCoverage: { total: result.apiCoverage.total, endpoints: result.apiCoverage.endpoints.slice(0, 60), kinds: result.apiCoverage.kinds } }
      : {}),
    ...(result.pageCoverage ? { pageCoverage: { total: result.pageCoverage.total, pages: result.pageCoverage.pages.slice(0, 80) } } : {}),
    ...(coverageNow ? { coverageNow } : {}),
    consoleLog: relFrom(ctx.dir, path.join(written.rawDir, 'console-stdout.log')),
    ...(carried ? { triageCarriedFrom: carried.carriedFrom } : {}),
    ...(noCasesParsed
      ? {
          noCasesParsed: true,
          note: '执行崩溃且解析到 0 个用例：先查 rawDir 下的 console-*.log 定位命令/环境问题；此状态 environment 归因无法放行 passed——修复后重跑，或将阶段标记 failed / skipped(reason)。',
        }
      : {}),
    nextActions: computeNextActions(freshRoute),
  });
}

// ---------- tool: browser_probe ----------

// 浏览器探针脚本（CJS，由 node 子进程执行）：借助被测项目安装的 playwright 打开页面，
// 导出标题/控制台错误/交互元素大纲/aria 快照 —— browser-e2e 用例的选择器必须来自这里，不许凭空写。
const PROBE_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const os = require('os');",
  "const [url, outFile, root] = process.argv.slice(2);",
  "let pw = null; let usedPkg = ''; let pwVersion = '';",
  // 解析候选：根目录 + 一层子项目目录（monorepo 布局 playwright 常装在 frontend/ 等子目录）
  "const resolveCands = [root];",
  "try { for (const e of fs.readdirSync(root, { withFileTypes: true })) { if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue; const c = path.join(root, e.name); if (fs.existsSync(path.join(c, 'package.json')) || fs.existsSync(path.join(c, 'node_modules'))) resolveCands.push(c); } } catch (e) {}",
  "for (const name of ['playwright', 'playwright-core', '@playwright/test']) {",
  "  try {",
  "    const entry = require.resolve(name, { paths: resolveCands });",
  "    pw = require(entry); usedPkg = name;",
  "    try { pwVersion = String(JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')).version || ''); } catch (e) {}",
  "    break;",
  "  } catch (e) {}",
  "}",
  "function done(obj, code) { fs.writeFileSync(outFile, JSON.stringify(obj, null, 2)); process.exit(code); }",
  "if (!pw || !pw.chromium) done({ error: '被测项目未安装 playwright（需 playwright / playwright-core / @playwright/test 之一在项目内可解析，可走 testroute_provision_deps）' }, 2);",
  // 第一层：编辑器内置浏览器 CDP 端点发现（与 builtin-browser MCP 同源）。
  "function findCdpEndpoints() {",
  "  const out = [];",
  "  if (process.env.BROWSER_MCP_CDP_URL && process.env.BROWSER_MCP_CDP_URL.trim()) out.push({ url: process.env.BROWSER_MCP_CDP_URL.trim(), source: '环境变量 BROWSER_MCP_CDP_URL' });",
  "  const dirs = [];",
  "  if (process.env.BROWSER_MCP_USER_DATA_DIR) dirs.push(process.env.BROWSER_MCP_USER_DATA_DIR);",
  "  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');",
  "  for (const h of ['Vulcan', 'Cursor', 'Code', 'Code - OSS', 'Windsurf']) dirs.push(path.join(appData, h));",
  "  const seen = new Set();",
  "  for (const d of dirs) {",
  "    try {",
  "      const f = path.join(d, 'DevToolsActivePort');",
  "      if (!fs.existsSync(f)) continue;",
  "      const port = Number(fs.readFileSync(f, 'utf8').split(/\\r?\\n/)[0]);",
  "      if (Number.isInteger(port) && port > 0 && !seen.has(port)) { seen.add(port); out.push({ url: 'http://127.0.0.1:' + port, source: f }); }",
  "    } catch (e) {}",
  "  }",
  "  return out;",
  "}",
  "async function cdpAlive(u) {",
  "  try { const res = await fetch(new URL('/json/version', u).toString(), { signal: AbortSignal.timeout(2000) }); return res.ok; } catch (e) { return false; }",
  "}",
  "(async () => {",
  "  let browser = null; let launchVia = ''; let lastErr = null; let attached = false; let page = null;",
  // ① 编辑器内置浏览器（CDP 附着，零下载）→ ② 系统 Chrome/Edge（channel）→ ③ chromium 缓存（最后手段）。
  // 附着模式绝不 browser.close()（可能关掉宿主编辑器的浏览器），只关自己开的页面，进程退出即断连。
  // 「可用」的判定包含建页：部分编辑器内嵌浏览器 CDP 能连上但拒绝 Target.createBrowserContext，
  // 连上建不了页 = 该层不可用，关闭连接降级下一层，不把整次探针打死。
  "  async function openPage(b) {",
  "    try { return await b.newPage(); } catch (e) { lastErr = e; return null; }",
  "  }",
  "  for (const ep of findCdpEndpoints()) {",
  "    if (!(await cdpAlive(ep.url))) { lastErr = new Error('CDP 端点无响应: ' + ep.url + '（' + ep.source + '）'); continue; }",
  "    let b = null;",
  "    try { b = await pw.chromium.connectOverCDP(ep.url, { timeout: 5000 }); } catch (e) { lastErr = e; continue; }",
  "    const p = await openPage(b);",
  "    if (!p) { try { await b.close(); } catch (e) {} continue; }",
  "    browser = b; page = p; launchVia = 'editor-internal (CDP ' + ep.url + ')'; attached = true; break;",
  "  }",
  "  if (!browser) for (const opt of [{ channel: 'chrome' }, { channel: 'msedge' }, {}]) {",
  "    let b = null;",
  "    try { b = await pw.chromium.launch({ headless: true, ...opt }); } catch (e) { lastErr = e; continue; }",
  "    const p = await openPage(b);",
  "    if (!p) { try { await b.close(); } catch (e) {} continue; }",
  "    browser = b; page = p; launchVia = opt.channel || 'chromium-cache'; break;",
  "  }",
  "  if (!browser) done({ error: '浏览器不可用（优先级：编辑器内置 CDP 附着 > 系统 Chrome/Edge channel > chromium 缓存；不要自行 npx playwright install，浏览器获取走 testroute_provision_deps 计划审批）；最后尝试错误: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 300) }, 1);",
  "  let browserVersion = '';",
  "  try { browserVersion = String(browser.version() || ''); } catch (e) {}",
  "  try {",
  "    const consoleErrors = [];",
  "    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 200)); });",
  "    page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String((e && e.message) || e).slice(0, 200)));",
  "    const resp = await page.goto(url, { waitUntil: 'load', timeout: 20000 });",
  "    try { await page.waitForLoadState('networkidle', { timeout: 4000 }); } catch (e) {}",
  "    let ariaSnapshot = null;",
  "    try { ariaSnapshot = await page.locator('body').ariaSnapshot(); } catch (e) {}",
  "    let a11yTree = null;",
  "    if (!ariaSnapshot) { try { a11yTree = await page.accessibility.snapshot(); } catch (e) {} }",
  "    const outline = await page.evaluate(() => {",
  "      const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [role=\"button\"], [role=\"link\"], [role=\"textbox\"], h1, h2, h3');",
  "      const seen = new Set(); const items = [];",
  "      for (const el of nodes) {",
  "        if (items.length >= 200) break;",
  "        const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('href') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);",
  "        const key = el.tagName + '|' + text;",
  "        if (!text || seen.has(key)) continue;",
  "        seen.add(key);",
  "        items.push({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', text });",
  "      }",
  "      return items;",
  "    });",
  "    const payload = { url, finalUrl: page.url(), title: await page.title(), httpStatus: resp ? resp.status() : null, consoleErrors: consoleErrors.slice(0, 10), ariaSnapshot, a11yTree, outline, via: usedPkg, browserVia: launchVia, browserVersion, playwrightVersion: pwVersion };",
  "    if (attached) { try { await page.close(); } catch (e) {} }",
  "    done(payload, 0);",
  "  } finally { if (!attached) { await browser.close().catch(() => {}); } }",
  "})().catch((e) => done({ error: String((e && e.message) || e) }, 1));",
].join('\n');

async function browserProbeTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const url = reqStr(args, 'url');
  if (!/^https?:\/\//i.test(url.trim())) fail('E_INVALID_ARGS', 'url 必须是 http(s) 绝对地址');
  const timeoutMs = optNumber(args, 'timeoutMs', 60000);
  const archiveDirArg = optStr(args, 'archiveDir', '');

  // 有归档则把完整探针结果落盘 probes/；无归档也能用（只回传不落盘）
  let probeDir = null;
  try {
    const ctx = getArchiveContext(root, archiveDirArg);
    probeDir = path.join(ctx.dir, 'probes');
    ensureDir(probeDir);
  } catch {
    probeDir = null;
  }

  const fs = await import('node:fs');
  const os = await import('node:os');
  const stamp = nowStamp();
  const scriptPath = path.join(os.tmpdir(), `testroute-probe-${stamp}.cjs`);
  const outPath = path.join(probeDir || os.tmpdir(), `probe-${slug(url)}-${stamp}.json`);
  fs.writeFileSync(scriptPath, PROBE_SCRIPT, 'utf8');
  try {
    const command = `node "${scriptPath}" "${url.trim()}" "${outPath}" "${root}"`;
    const proc = await runCommand({ cwd: root, command, timeoutMs });
    const data = fs.existsSync(outPath) ? readJson(outPath) : null;
    if (!data || data.error) {
      const detail = data?.error || proc.stderr?.trim().slice(0, 300) || `退出码 ${proc.exitCode}`;
      fail('E_GATE', `浏览器探针失败: ${detail}。提示：浏览器优先级 = ① 编辑器内置浏览器（CDP 附着）> ② 系统 Chrome/Edge（channel）> ③ chromium 缓存；三层都缺才考虑下载，且不要自行执行 npx playwright install（浏览器获取走 testroute_provision_deps 计划审批）`);
    }
    if (probeDir) {
      try {
        appendEvent(getArchiveContext(root, archiveDirArg), 'probe', url);
      } catch {}
    }
    return text({
      url: data.url,
      finalUrl: data.finalUrl,
      title: data.title,
      httpStatus: data.httpStatus,
      consoleErrors: data.consoleErrors || [],
      interactiveElements: (data.outline || []).length,
      outline: (data.outline || []).slice(0, 60),
      ariaSnapshot: truncate(data.ariaSnapshot || JSON.stringify(data.a11yTree || ''), 6000),
      probePackage: data.via,
      browserVia: data.browserVia || null,
      ...(data.browserVersion ? { browserVersion: data.browserVersion } : {}),
      ...(data.playwrightVersion ? { playwrightVersion: data.playwrightVersion } : {}),
      fullResult: probeDir ? relFrom(root, outPath) : null,
      note: 'browser-e2e 用例中的选择器/断言必须基于以上真实结构（优先 role + name），禁止凭空编写。生成用例时按 browserVia 选择 channel（chrome/msedge），档头 test.use({ trace: \'on\', video: \'on\', screenshot: \'on\' })。',
    });
  } finally {
    try { fs.rmSync(scriptPath, { force: true }); } catch {}
  }
}

// ---------- tool: record_triage ----------

async function recordTriageTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const runId = reqStr(args, 'runId');
  const classifications = reqArray(args, 'classifications');

  // runId 容错：先列出归档内现有执行记录，避免宿主盲猜重试
  const route = loadRoute(ctx.dir);
  const allRuns = route.phases.flatMap((p) => (p.runs || []).map((r) => r.runId));
  if (!allRuns.includes(runId)) {
    fail(
      'E_NOT_FOUND',
      `未找到 runId="${runId}"（归档内现有执行记录: ${allRuns.slice(-10).join('、') || '无'}）。runId 形如 <阶段>-<序号>（如 unit-01），可在 run_tests 响应或 get_route 摘要里拿到。`
    );
  }

  const cleaned = classifications.map((c, i) => {
    if (!c || typeof c !== 'object') fail('E_INVALID_ARGS', `classifications[${i}] 必须是 object`);
    const caseId = reqStr(c, 'caseId');
    const classification = oneOf(reqStr(c, 'classification'), ['test-bug', 'code-bug', 'environment'], 'classification');
    let prio = c.priority;
    if (typeof prio === 'number' && prio >= 0 && prio <= 3) prio = `P${prio}`; // 数字 0-3 自癒为 P0-P3
    const priority =
      prio === undefined || prio === null || prio === ''
        ? null
        : oneOf(String(prio), ['P0', 'P1', 'P2', 'P3'], `classifications[${i}].priority`);
    return { caseId, classification, priority, note: optStr(c, 'note', '') };
  });

  const { resultPath, fingerprint } = saveTriage(ctx.dir, runId, { classifications: cleaned });

  // 同步到路线的 runs 引用（含失败指纹，供重跑时识别同型失败自动继承归因）
  for (const p of route.phases) {
    for (const run of p.runs || []) {
      if (run.runId === runId) run.triage = { classifications: cleaned, ...(fingerprint ? { fingerprint } : {}) };
    }
  }
  route.updatedAt = new Date().toISOString();
  saveRoute(ctx.dir, route);
  appendEvent(ctx, 'triage', `${runId} 归因 ${cleaned.length} 条`);

  return text({
    updated: true,
    runId,
    resultPath: relFrom(ctx.dir, resultPath),
    rule:
      'test-bug→修复用例后重跑；code-bug→update_phase(status="failed") 阻断后续，且必须划 priority（P0=阻断：主流程不可用/安全漏洞/数据丢失；P1=严重：核心功能缺陷；P2=一般：次要功能/边界；P3=轻微：体验/建议）——code-bug 缺 priority 时 finalize_report 会拒绝出报告；' +
      'environment→修复环境后重跑（全部归因 environment 时允许直接放行）。TestRoute 只测不修：修复由项目维护者完成，报告只给定位与修复方向。',
    nextActions: computeNextActions(route),
  });
}

// ---------- tool: snapshot_files ----------

async function snapshotFilesTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const phaseId = reqStr(args, 'phaseId');
  const files = reqArray(args, 'files');
  if (!ctx.manifest || !routeExists(ctx.dir)) {
    fail('E_NOT_FOUND', `归档中还没有路线（${ROUTE_FILE}）。测试用例快照挂在阶段下，请先 save_route。`);
  }
  const route = loadRoute(ctx.dir);
  // phaseId 容错解析（大小写/下划线/唯一包含），报错列出现有 ids
  const resolvedPhaseId = resolvePhaseId(route, phaseId);
  const written = snapshotFiles(ctx.dir, resolvedPhaseId, root, files);
  // 不回显全量 from/to 映射（1:1 随输入膨胀）；样例 5 条，全量在归档 testcases/<阶段>/ 与事件流
  return text({
    snapshotCount: written.length,
    sample: written.slice(0, 5),
    ...(written.length > 5 ? { note: `全部 ${written.length} 个快照映射见归档 testcases/${resolvedPhaseId}/` } : {}),
  });
}

function routeExists(archiveDir) {
  return fileExists(path.join(archiveDir, ROUTE_FILE));
}

// ---------- tool: verify_archive ----------

// 归档自验（只读取证，不写任何文件、不加锁）：manifest 事件连续性 + result.json 工具指纹 +
// 报告封章三方一致。用途：怀疑归档被手改 / 上一轮曾绕过工具时，以及 finalize 前主动自证。
// 详见 server/integrity.js 与 CLI scripts/check-archive.mjs（MCP 离线时同款检查）。
function verifyArchiveTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const report = verifyArchiveIntegrity(ctx.dir, { allowLegacy: optBool(args, 'allowLegacy', false) });
  return text({
    ...report,
    hint:
      report.verdict === 'TRUSTED'
        ? '归档自洽，未发现伪造痕迹。'
        : report.verdict === 'SUSPECT'
          ? '归档有疑点（未构成硬伤）：引用结论前先复核疑点项；确认全部 run 来自旧版工具可用 allowLegacy=true 复验。'
          : 'TAMPERED：归档存在硬伤，整份作废——不得引用其结论，也不得手写补档掩盖；按缺口用工具重跑或重建归档。',
  });
}

// ---------- tool: finalize_report ----------

async function finalizeReportTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  if (!routeExists(ctx.dir)) fail('E_NOT_FOUND', `归档中还没有路线，无法生成报告。`);
  // 封章门禁：TAMPERED 归档拒绝封章——带伤的 "completed" 会把污染洗白成可信结论。
  // SUSPECT 放行（旧版工具产出的归档只是疑点，不是硬伤），由 get_route 常驻红牌提示复核。
  const integrity = verifyArchiveIntegrity(ctx.dir);
  if (integrity.verdict === 'TAMPERED') {
    fail(
      'E_GATE',
      `归档自验 TAMPERED（硬伤 ${integrity.fails.length} 条），拒绝生成最终报告——带伤封章会把污染洗白成"completed"。硬伤摘要:\n` +
        integrity.fails
          .slice(0, 5)
          .map((f) => `- [${f.area}${f.subject ? '/' + f.subject : ''}] ${truncate(f.message, 140)}`)
          .join('\n') +
        (integrity.fails.length > 5 ? `\n（其余 ${integrity.fails.length - 5} 条用 testroute_verify_archive 查看）` : '') +
        '\n处理：执行记录缺失/事件流被手改无法原位修复——init_archive 重建归档（残骸会被就地重置复用，旧文件备份留证）后按路线重跑；严禁手写 result.json/route.json/manifest.json 补档。'
    );
  }
  const acknowledgeTestFileChanges = optBool(args, 'acknowledgeTestFileChanges', false);
  const { reportPath, outcome, route, changesBlock } = finalizeReport(ctx.dir, { acknowledgeTestFileChanges });
  return text({
    reportPath: relFrom(ctx.dir, reportPath),
    archiveDir: ctx.dir,
    outcome,
    changesBlock,
    summary: {
      phases: route.phases.map((p) => ({ id: p.id, status: p.status, runs: p.runs?.length || 0 })),
      totalRuns: route.phases.reduce((n, p) => n + (p.runs?.length || 0), 0),
    },
    hint:
      '归档完成。向用户展示 final-report.md 的阶段汇总、安全测试覆盖（纳入/未纳入/豁免，不可静默略过）、' +
      '缺陷优先级（P0 缺陷必须置顶明示）、失败归因，以及全量用例清单与复现指南（通过与失败都写明做法/复现/证据）。' +
      '浏览器证据的播放方式要向用户说明：trace.zip 拖进 https://trace.playwright.dev 逐步重播（本地渲染不上传；离线 npx playwright show-trace <路径>），video.webm 直接拖进浏览器播放。' +
      '最终答复必须原样引用 changesBlock（「本次对项目的改动与卸载说明」），告知用户本次安装了什么、如何卸载。' +
      'TestRoute 只测不修：向用户交付的是缺陷清单与修复方向，不要提议由你动手修复。',
  });
}

// ---------- tool: provision_deps ----------

async function provisionDepsTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const packages = args.packages !== undefined ? optArray(args, 'packages') : ['playwright'];
  const confirm = optBool(args, 'confirm', false);
  const purpose = optStr(args, 'purpose', '');
  const res = await provisionDeps(root, ctx.dir, { packages, confirm, purpose });
  if (res.status === 'installed' || res.status === 'ready') {
    appendEvent(ctx, 'provision', `${res.status}: ${(packages || []).join(', ')}`);
  }
  return text(res);
}

// ---------- tool: record_change ----------

async function recordChangeTool(args) {
  const root = resolveRoot(reqStr(args, 'root'));
  const ctx = getArchiveContext(root, optStr(args, 'archiveDir', ''));
  const changes = reqArray(args, 'changes');
  const cleaned = changes.map((c, i) => {
    if (!c || typeof c !== 'object') fail('E_INVALID_ARGS', `changes[${i}] 必须是 object`);
    const kind = oneOf(reqStr(c, 'kind'), ['created', 'modified', 'deleted'], `changes[${i}].kind`);
    return { path: reqStr(c, 'path'), kind, note: optStr(c, 'note', '') };
  });
  const total = recordModification(root, ctx.dir, cleaned);
  appendEvent(ctx, 'record-change', `${cleaned.length} 条改动记录（累计 ${total}）`);
  return text({
    recorded: cleaned.length,
    totalRecorded: total,
    rule: '对项目源码的修改不会自动还原；这些记录会出现在最终报告「对项目的改动与卸载说明」段。',
  });
}

// ---------- 注册表 ----------

const str = (description) => ({ type: 'string', description });
const arr = (description) => ({ type: 'array', items: { type: 'string' }, description });

export const TOOL_DEFS = [
  {
    name: 'testroute_scan_project',
    description: '扫描目标项目，生成项目地图：技术栈、测试框架、现有测试分布、源码布局、环境就绪探针。规划测试路线前必调。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录（绝对路径）'),
        archiveDir: str('可选：归档目录名或绝对路径，缺省用最新归档；地图会写入其中的 project-map.json'),
      },
      required: ['root'],
    },
    handler: scanProjectTool,
  },
  {
    name: 'testroute_init_archive',
    description:
      '创建带时间戳的标准化归档目录（固定结构 + manifest）。开始一次测试任务前必调。' +
      '对最新归档按状态分流：空壳（零事件零路线）幂等复用不新建；残骸（零执行记录但有孤儿 run 事件/幽灵 route 引用/未知事件类型/manifest 损坏）就地重置复用——旧 manifest/route 备份为 *-residual-*.json 留证；' +
      '纯草稿残留或已有执行记录/最终报告则另开新归档并在响应带 forkedFrom（旧归档名 + 自验结论）。一次测试始终对应一个归档，响应里的 reused/huskReset/forkedFrom 段务必读后再行动。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        label: str('可选：归档名附加标签（如 feat-login）'),
        gitignore: { type: 'boolean', description: '可选：将 test-archives/ 追加到项目 .gitignore' },
      },
      required: ['root'],
    },
    handler: initArchiveTool,
  },
  {
    name: 'testroute_save_route',
    description:
      '校验并保存测试路线 route.json（自动规范化阶段 id；安全段缺口自动补齐：无安全段补 sca+secrets，API 项目可发包时补 dast 内置探测器）。action="approve" 表示用户已批准路线（人工检查点，不可跳过）。覆盖豁免用 route.coverageWaiver（[{endpoint|page, reason}] 逐项留痕，finalize 覆盖门禁的逐项逃生阀）。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        action: str('可选：save（保存草稿，默认）| approve（用户已批准）'),
        route: {
          type: 'object',
          description: '路线对象：{ schemaVersion:1, mode, status, project:{name,techStack?}, phases:[{id,kind,executor?,command?,paths?,config?,onFailure?,status,notes?}], coverageWaiver?: [{endpoint?|page?, reason}] }',
        },
      },
      required: ['root', 'route'],
    },
    handler: saveRouteTool,
  },
  {
    name: 'testroute_get_route',
    description: '读取路线阶段状态与 nextActions（默认返回紧凑摘要，不内联 route.json；除错才传 detail:"full"）。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        detail: str('可选：summary（默认，返回阶段状态紧凑摘要）| full（内联 route.json 全文，仅除错时用）'),
      },
      required: ['root'],
    },
    handler: getRouteTool,
  },
  {
    name: 'testroute_update_phase',
    description: '更新阶段状态（状态机强制门禁：串行推进、execute 阶段须先跑测试才能 passed、失败按 onFailure 传播 block/ask/continue）。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        phaseId: str('阶段 id'),
        status: str('pending | in-progress | awaiting-approval | passed | failed | blocked | skipped'),
        reason: str('skipped/failed/blocked 时的原因（skipped 必填）'),
        notes: str('可选：备注 / 断点续跑 checkpoint'),
        allowTestFileChanges: {
          type: 'boolean',
          description: '可选：确认项目自有测试脚本的改动来自用户本人（需先向用户核实）。确认后重建只读基线并放行 passed。默认 false',
        },
      },
      required: ['root', 'phaseId', 'status'],
    },
    handler: updatePhaseTool,
  },
  {
    name: 'testroute_read_changes',
    description: '读取 git 工作区变更并分类（新增/修改/未跟踪、是否测试文件、是否源码），用于增量回归规划。非 git 仓库时优雅降级。',
    inputSchema: {
      type: 'object',
      properties: { root: str('目标项目根目录') },
      required: ['root'],
    },
    handler: readChangesTool,
  },
  {
    name: 'testroute_run_tests',
    description:
      '执行指定阶段的测试，产出 TestResult 存入归档（git 锚点、可选覆盖率、flaky 复跑）。门禁：路线 approved、阶段 in-progress、失败 run 已归因；沙箱-only——paths/command 只许指向沙箱内用例，项目自有测试只读不执行。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        phaseId: str('阶段 id（kind 必须为 execute）'),
        executor: str('可选：vitest | jest | pytest | generic | health | sca | e2e | playwright | secrets | security-probe（dast 内置动态安全探测，读阶段 config.baseUrl/token），缺省用阶段定义'),
        command: str('可选：命令行覆盖（generic 必填；vitest/jest/pytest 可覆盖以启用覆盖率等，如 "npx vitest run --coverage"）'),
        paths: arr('可选：测试路径/glob（必须指向沙箱内用例），缺省用阶段定义'),
        targets: arr('可选：health 连通性目标（http(s) URL），缺省用阶段定义'),
        steps: {
          type: 'array',
          items: { type: 'object' },
          description: '可选：executor=e2e 的声明式 HTTP 步骤，缺省用阶段定义',
        },
        retryFailedOnce: { type: 'boolean', description: '可选：失败后自动复跑一次，复跑通过的用例标 flaky（不稳定）而非失败。默认 false' },
        evidence: { type: 'string', enum: ['full', 'trace', 'off'], description: '可选（playwright 阶段）：证据链档位，默认 full——工具强制注入证据 config（use.trace/video/screenshot=on）并给命令补 --trace on/--output；trace=video 关（ffmpeg 缺失降级用）；off=完全不要证据，仅当 .testfile/用户明写不用时才允许' },
        evidenceReason: { type: 'string', description: 'evidence≠full 时必填：引用 .testfile/用户的明写要求或 ffmpeg 缺失等依据，理由留痕进 run 记录与最终报告' },
        coverage: { type: 'boolean', description: '可选：显式开启覆盖率解析（默认关闭）。开启后目标项目须已产出 LCOV；建议让测试框架把覆盖率输出到沙箱内（如 vitest --coverage.reportsDirectory "<sandboxDir>/coverage"），随归档一起清理' },
        coverageFile: str('可选：LCOV 覆盖率文件（相对 root 或绝对路径）；需 coverage=true，缺省自动探测 coverage/lcov.info 与 coverage.lcov。建议指向沙箱内输出的覆盖率文件（产物随归档清理）'),
        timeoutMs: { type: 'number', description: '可选：超时毫秒，默认 300000' },
        pythonBin: str('可选：pytest 用的解释器，缺省自动探测'),
      },
      required: ['root', 'phaseId'],
    },
    handler: runTestsTool,
  },
  {
    name: 'testroute_browser_probe',
    description: '浏览器探针：playwright 无头打开页面，导出标题/控制台错误/交互元素大纲/aria 快照。browser-e2e 生成用例前必调——选择器必须来自探针结果，禁止凭空编写。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录（playwright 从这里的 node_modules 解析）'),
        url: str('要打开的页面 http(s) 绝对地址'),
        archiveDir: str('可选：归档目录，缺省用最新归档；完整探针结果写入其 probes/ 下'),
        timeoutMs: { type: 'number', description: '可选：整体超时毫秒，默认 60000' },
      },
      required: ['root', 'url'],
    },
    handler: browserProbeTool,
  },
  {
    name: 'testroute_record_triage',
    description: '记录失败归因与缺陷优先级：test-bug（修用例）/ code-bug（被测代码缺陷，必划 P0–P3，缺级时 finalize 拒绝出报告）/ environment（修环境）。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        runId: str('执行记录 id（如 unit-01）'),
        classifications: {
          type: 'array',
          description: '[{ caseId, classification: test-bug|code-bug|environment, priority?: P0|P1|P2|P3, note? }]；generic 执行器无用例 id 时 caseId 用 "run"',
          items: {
            type: 'object',
            properties: {
              caseId: str('用例 id，generic 执行器用 "run"'),
              classification: str('test-bug | code-bug | environment'),
              priority: str('code-bug 必填：P0=阻断（主流程不可用/安全漏洞/数据丢失）| P1=严重（核心功能缺陷）| P2=一般（次要功能/边界）| P3=轻微（体验/建议）'),
              note: str('可选：归因说明（code-bug 建议写清复现路径与修复方向）'),
            },
            required: ['caseId', 'classification'],
          },
        },
      },
      required: ['root', 'runId', 'classifications'],
    },
    handler: recordTriageTool,
  },
  {
    name: 'testroute_snapshot_files',
    description: '把项目里生成的测试用例文件快照进归档（按阶段分组），供评审与二次分析。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        phaseId: str('阶段 id'),
        files: arr('要快照的文件相对路径列表'),
      },
      required: ['root', 'phaseId', 'files'],
    },
    handler: snapshotFilesTool,
  },
  {
    name: 'testroute_finalize_report',
    description:
      '汇总路线、执行记录与 triage，生成 final-report.md（含改动与卸载说明、缺陷 P0–P3 分级）。任务收尾必调；草稿路线 finalize 标记 abandoned。门禁：code-bug 缺优先级、API 覆盖矩阵有缺口（functional/authz 恒拦；negative/boundary 在对应阶段未跳过时拦）、页面覆盖有缺口（有 browser-e2e 且盘点 ≥5 页时拦）——个别端点/页面确实测不了走 route.coverageWaiver 逐项留痕。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        acknowledgeTestFileChanges: {
          type: 'boolean',
          description: '可选：确认项目自有测试脚本的改动来自用户本人（需先向用户核实）。确认后重建只读基线并出报告。默认 false',
        },
      },
      required: ['root'],
    },
    handler: finalizeReportTool,
  },
  {
    name: 'testroute_provision_deps',
    description: '为被测项目安装测试依赖（默认 playwright），带同意检查点：不带 confirm 返回安装计划，用户同意后 confirm=true 执行；已就绪则直接 ready。浏览器按「编辑器内置（CDP 附着）> 系统 Chrome/Edge > chromium 缓存 > 下载（永远最后）」优先级获取，不随包下载。安装记入 provision.json 台账。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        packages: { type: 'array', items: { type: 'string' }, description: '可选：要安装的 npm 包，默认 ["playwright"]（浏览器按「编辑器内置 CDP > 系统 Chrome/Edge > chromium 缓存」复用，三层全无才在计划里出现 npx playwright install chromium，且须用户 confirm）' },
        purpose: str('可选：安装用途说明（写入台账与报告）'),
        confirm: { type: 'boolean', description: '用户已同意安装时传 true。首次调用不要传，先拿 plan 征求用户同意' },
      },
      required: ['root'],
    },
    handler: provisionDepsTool,
  },
  {
    name: 'testroute_record_change',
    description: '登记对被测项目文件的实际改动（created/modified/deleted），进最终报告的改动与卸载说明段。正常应为空（用例在沙箱内不计入）；一旦改动项目文件必须逐文件如实登记。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        changes: {
          type: 'array',
          description: '[{ path: "相对路径", kind: "created|modified|deleted", note?: "改动说明" }]',
          items: {
            type: 'object',
            properties: {
              path: str('文件相对路径'),
              kind: str('created | modified | deleted'),
              note: str('可选：改动说明（改了什么、为什么）'),
            },
            required: ['path', 'kind'],
          },
        },
      },
      required: ['root', 'changes'],
    },
    handler: recordChangeTool,
  },
  {
    name: 'testroute_verify_archive',
    description:
      '归档自验（只读取证）：核对 manifest 事件连续性（词表/格式/时间戳/run 三方对账/阶段状态机）、result.json 工具指纹（必填字段 + env/command 签名）、final-report.md 封章三方一致。怀疑归档被手改或上一轮曾绕过工具时必调；finalize 前主动自证。verdict: TRUSTED | SUSPECT（有疑点）| TAMPERED（有硬伤，整份作废）。',
    inputSchema: {
      type: 'object',
      properties: {
        root: str('目标项目根目录'),
        archiveDir: str('可选：归档目录，缺省用最新归档'),
        allowLegacy: { type: 'boolean', description: '可选：全部 run 都缺工具签名（env/command）时按旧版工具宽容（降为备注）。默认 false' },
      },
      required: ['root'],
    },
    handler: verifyArchiveTool,
  },
];

export const TOOL_MAP = new Map(TOOL_DEFS.map((t) => [t.name, t]));

// 写类工具在归档目录上加 advisory 锁：多编辑器各拉起 server 进程时防止同时写同一归档。
const LOCKED_TOOLS = new Set([
  'testroute_init_archive',
  'testroute_scan_project',
  'testroute_save_route',
  'testroute_update_phase',
  'testroute_run_tests',
  'testroute_record_triage',
  'testroute_snapshot_files',
  'testroute_finalize_report',
  'testroute_browser_probe',
  'testroute_provision_deps',
  'testroute_record_change',
]);

function lockDirFor(name, args) {
  if (!LOCKED_TOOLS.has(name) || !args?.root) return null;
  let root;
  try {
    root = path.resolve(String(args.root));
  } catch {
    return null;
  }
  if (!fs.existsSync(root)) return null;
  // init_archive 时归档还不存在，锁在 test-archives/ 上；其余锁在具体归档上
  const dir =
    name === 'testroute_init_archive'
      ? archivesDir(root)
      : resolveArchiveDir(root, String(args.archiveDir || ''));
  return dir && fs.existsSync(dir) ? dir : null;
}

export async function callTool(name, args) {
  const tool = TOOL_MAP.get(name);
  if (!tool) {
    throw new ToolError('E_UNKNOWN_TOOL', `未知工具: ${name}（可用工具: ${TOOL_DEFS.map((t) => t.name).join('、')}）`);
  }
  const lockDir = lockDirFor(name, args);
  try {
    if (lockDir) return await withArchiveLock(lockDir, () => tool.handler(args || {}));
    return await tool.handler(args || {});
  } catch (e) {
    if (e instanceof ToolError) throw e;
    // 完整堆栈只进服务器 stderr；宿主上下文里放堆栈是纯浪费（不可操作且占预算）
    process.stderr.write(`[testroute] internal error: ${e?.stack || String(e)}\n`);
    const firstLine = String(e?.message || e).split('\n')[0];
    throw new ToolError('E_INTERNAL', `内部错误: ${firstLine}（完整堆栈见服务器 stderr）`);
  }
}

export { truncate };
