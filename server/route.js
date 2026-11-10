// route.json 契约 + 阶段状态机。确定性门禁全部在工具层强制执行（不依赖 LLM 服从性）。
import path from 'node:path';
import fs from 'node:fs';
import { fail, truncate } from './validate.js';
import { readJson, writeJson, nowIso } from './paths.js';
import { verifyTestGate, acknowledgeTestGate, gateViolationError } from './testgate.js';
import { STAGE_CATALOG, knownStageIds } from './stages.js';
import { loadApiSurface } from './apimap.js';
import { detectFrontend, loadWebSurface } from './detect.js';
import { hasTrackedChanges } from './git.js';
import { failureFingerprint } from './result.js';
import { engineIdentity } from './version.js';

export const ROUTE_FILE = 'route.json';

export const ROUTE_MODES = ['generate-only', 'generate-and-execute'];
export const ROUTE_SCOPES = ['full', 'targeted'];
export const ROUTE_STATUSES = ['draft', 'approved', 'in-progress', 'completed', 'aborted', 'abandoned'];
export const PHASE_KINDS = ['planning', 'generate', 'execute', 'manual'];
export const EXECUTOR_IDS = ['vitest', 'jest', 'pytest', 'generic', 'health', 'sca', 'e2e', 'playwright', 'secrets', 'security-probe'];
export const E2E_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const PHASE_STATUSES = [
  'pending',
  'in-progress',
  'awaiting-approval',
  'passed',
  'failed',
  'blocked',
  'skipped',
];
export const ON_FAILURE = ['block', 'continue', 'ask', 'abort'];
export const TRIAGE_CLASSES = ['test-bug', 'code-bug', 'environment'];

const PHASE_ID_RE = /^[a-z][a-z0-9-]*$/;
const TERMINAL = new Set(['passed', 'failed', 'blocked', 'skipped']);

export function routePath(archiveDir) {
  return path.join(archiveDir, ROUTE_FILE);
}

export function loadRoute(archiveDir) {
  const p = routePath(archiveDir);
  const route = readJson(p);
  if (!route) {
    fail('E_NOT_FOUND', `未找到 route.json（${p}）。请先用 save_route 写入测试路线。`);
  }
  // 归档完整性：route.status 必须是合法状态机状态——手改归档（如把 status 写成 "passed"）
  // 会让后续所有门禁建立在假状态上，这里直接拒绝读出，报错引导重建归档。
  if (!ROUTE_STATUSES.includes(route.status)) {
    fail(
      'E_GATE',
      `route.json 已被手改（status="${route.status}" 不是合法状态：${ROUTE_STATUSES.join('/')}）。` +
        `手改归档/伪造状态会让全部门禁失效——归档不可信，请重建归档重跑；最终报告只能由 finalize_report 产出。`
    );
  }
  return route;
}

export function saveRoute(archiveDir, route) {
  return writeJson(routePath(archiveDir), route);
}

// ---------- 响应摘要（宿主上下文预算）----------
// route.json 全文只留在磁盘；返回给宿主 LLM 的永远是紧凑摘要（get_route detail="full" 才内联全文）。
export function summarizeRoute(route) {
  const phases = (route.phases || []).map((p) => {
    const runs = Array.isArray(p.runs) ? p.runs : [];
    const last = runs.length ? runs[runs.length - 1] : null;
    const row = {
      id: p.id,
      kind: p.kind,
      executor: p.executor || null,
      status: p.status,
      runs: runs.length,
    };
    if (last) {
      row.lastRun = {
        runId: last.runId,
        status: last.status,
        exitCode: last.exitCode,
        summary: last.summary
          ? {
              total: last.summary.total,
              passed: last.summary.passed,
              failed: last.summary.failed,
              skipped: last.summary.skipped,
            }
          : null,
        triaged: !!last.triage,
      };
    }
    if (last?.triage?.carriedFrom) row.lastRun.triageCarriedFrom = last.triage.carriedFrom;
    if (p.checkpoint) row.checkpoint = p.checkpoint;
    if (p.reason) row.reason = truncate(p.reason, 160);
    if (p.onFailure && p.onFailure !== 'block') row.onFailure = p.onFailure;
    return row;
  });
  return {
    mode: route.mode,
    status: route.status,
    scope: route.scope || null,
    userRequest: route.userRequest ? truncate(route.userRequest, 200) : null,
    engine: engineIdentity(),
    terminated: route.terminated || null,
    phaseCount: phases.length,
    phases,
  };
}

// coverage 只回 totals；文件级明细在 runs/<id>/result.json 与 lcov 源文件里（报告从那里取）。
export function summarizeCoverage(coverage) {
  if (!coverage || coverage.type !== 'lcov' || !coverage.totals) return coverage || null;
  const t = coverage.totals;
  return {
    type: coverage.type,
    source: coverage.source,
    files: t.files,
    totals: {
      linesPct: t.linesPct,
      functionsPct: t.functionsPct,
      branchesPct: t.branchesPct,
    },
  };
}

export function validateRoute(route) {
  const issues = [];
  const push = (s) => issues.push(s);
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    fail('E_INVALID_ROUTE', 'route 必须是 object');
  }
  if (route.schemaVersion !== 1) push('schemaVersion 必须为 1');
  if (!ROUTE_MODES.includes(route.mode)) {
    push(`mode 必须是 [${ROUTE_MODES.join(' | ')}] 之一`);
  }
  if (!ROUTE_STATUSES.includes(route.status)) {
    push(`status 必须是 [${ROUTE_STATUSES.join(' | ')}] 之一`);
  }
  if (!route.project || typeof route.project !== 'object') {
    push('project 必须是 object（至少含 name）');
  } else if (typeof route.project.name !== 'string' || !route.project.name.trim()) {
    push('project.name 必须是非空 string');
  }
  // 用户原话（范围对照锚）：不强制 scope 收窄，但强制「用户怎么说的」进归档——批准摘要与最终报告
  // 都以它做范围对照，"用户要 A+B、路线测了 12 个阶段"这类扩张至少必须发生在用户眼前。
  if (typeof route.userRequest !== 'string' || !route.userRequest.trim()) {
    push('userRequest 必填：用户对本次测试请求的原话（逐字引用，不改写、不概括、不翻译）——批准摘要与最终报告以此做范围对照');
  }

  const phases = route.phases;
  if (!Array.isArray(phases) || phases.length === 0) {
    push('phases 必须是非空 array（阶段按数组顺序执行）');
  } else {
    const seen = new Set();
    phases.forEach((p, i) => {
      const at = `phases[${i}]`;
      if (!p || typeof p !== 'object') {
        push(`${at} 必须是 object`);
        return;
      }
      if (typeof p.id !== 'string' || !PHASE_ID_RE.test(p.id)) {
        push(`${at}.id 必须匹配 /^[a-z][a-z0-9-]*$/（如 unit、smoke、env-check）`);
      } else if (seen.has(p.id)) {
        push(`${at}.id "${p.id}" 重复`);
        seen.add(p.id);
      } else {
        seen.add(p.id);
      }
      if (!PHASE_KINDS.includes(p.kind)) {
        push(`${at}.kind 必须是 [${PHASE_KINDS.join(' | ')}] 之一`);
      }
      if (!PHASE_STATUSES.includes(p.status)) {
        push(`${at}.status 必须是 [${PHASE_STATUSES.join(' | ')}] 之一`);
      }
      if (p.kind === 'manual') {
        if (p.executor) {
          push(`${at}.executor 在 kind="manual" 时不应设置（人工阶段不由执行器跑）`);
        }
      }
      if (p.kind === 'execute') {
        if (!EXECUTOR_IDS.includes(p.executor)) {
          push(`${at}.executor 在 kind="execute" 时必须是 [${EXECUTOR_IDS.join(' | ')}] 之一`);
        }
        // 浏览器 E2E 阶段必须由 playwright 执行器跑：真实浏览器执行 + 证据链（trace/video/截图）
        // 由该执行器强制注入；executor="e2e" 是声明式 HTTP 步骤，不产生浏览器证据
        if (typeof p.id === 'string' && /browser/i.test(p.id) && p.executor !== 'playwright') {
          push(
            `${at}.id 含 "browser"（浏览器 E2E 阶段）必须用 executor="playwright"——` +
              'trace.zip/video.webm/逐步截图证据链只有该执行器会强制注入；executor="e2e" 是声明式 HTTP 步骤，没有浏览器证据'
          );
        }
        if (p.executor === 'generic' && (typeof p.command !== 'string' || !p.command.trim())) {
          push(`${at}.command 在 executor="generic" 时必填（要执行的命令行）`);
        }
        if (p.executor === 'health') {
          if (!Array.isArray(p.targets) || p.targets.length === 0) {
            push(`${at}.targets 在 executor="health" 时必填（http(s) URL 数组）`);
          } else if (p.targets.some((t) => typeof t !== 'string' || !/^https?:\/\//i.test(t.trim()))) {
            push(`${at}.targets 必须是 http(s) URL 数组`);
          }
        }
        if (p.executor === 'e2e') {
          const steps = p.steps;
          if (!Array.isArray(steps) || steps.length === 0) {
            push(`${at}.steps 在 executor="e2e" 时必填（声明式 HTTP 步骤数组，会写进路线供批准评审）`);
          } else {
            steps.forEach((s, si) => {
              const sat = `${at}.steps[${si}]`;
              if (!s || typeof s !== 'object') {
                push(`${sat} 必须是 object`);
                return;
              }
              if (typeof s.name !== 'string' || !s.name.trim()) push(`${sat}.name 必填（非空 string）`);
              if (typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url.trim())) {
                push(`${sat}.url 必须是 http(s) 绝对地址`);
              }
              if (s.method !== undefined && !E2E_METHODS.includes(String(s.method).toUpperCase())) {
                push(`${sat}.method 必须是 [${E2E_METHODS.join(' | ')}] 之一（缺省 GET）`);
              }
              if (s.headers !== undefined && (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers))) {
                push(`${sat}.headers 必须是 object（字符串键值）`);
              }
              if (s.expect?.status !== undefined && !Number.isInteger(s.expect.status)) {
                push(`${sat}.expect.status 必须是整数状态码`);
              }
              if (s.expect?.bodyContains !== undefined && typeof s.expect.bodyContains !== 'string') {
                push(`${sat}.expect.bodyContains 必须是 string`);
              }
              if (s.expect?.json !== undefined && (typeof s.expect.json !== 'object' || s.expect.json === null || Array.isArray(s.expect.json))) {
                push(`${sat}.expect.json 必须是 object（点路径 → 期望值）`);
              }
              if (s.save !== undefined) {
                if (typeof s.save !== 'object' || s.save === null || Array.isArray(s.save)) {
                  push(`${sat}.save 必须是 object（变量名 → "json:点路径" | status | body）`);
                } else if (Object.values(s.save).some((v) => typeof v !== 'string')) {
                  push(`${sat}.save 的取值描述必须是 string`);
                }
              }
            });
          }
        }
      }
      if (p.onFailure !== undefined && !ON_FAILURE.includes(p.onFailure)) {
        push(`${at}.onFailure 必须是 [${ON_FAILURE.join(' | ')}] 之一`);
      }
      if (p.paths !== undefined && !Array.isArray(p.paths)) {
        push(`${at}.paths 必须是 string array（测试文件 glob 或目录）`);
      }
      if (p.config !== undefined && (typeof p.config !== 'object' || p.config === null || Array.isArray(p.config))) {
        push(`${at}.config 必须是 object（执行器配置，如 dast 的 { baseUrl, token }）`);
      }
      if (p.runs !== undefined && !Array.isArray(p.runs)) {
        push(`${at}.runs 必须是 array`);
      }
    });
  }

  // 准入链路硬顺序：connectivity 必须第一；smoke 必须先于其他 execute/generate 阶段
  if (Array.isArray(phases) && phases.length > 0) {
    const ci = phases.findIndex((p) => p && p.id === 'connectivity');
    const si = phases.findIndex((p) => p && p.id === 'smoke');
    if (ci !== -1 && ci !== 0) {
      push('准入链路：connectivity 必须是第一个阶段');
    }
    if (si !== -1) {
      if (ci !== -1 && ci > si) {
        push('准入链路：connectivity 必须先于 smoke');
      }
      const firstWork = phases.findIndex(
        (p) => p && (p.kind === 'execute' || p.kind === 'generate') && p.id !== 'connectivity' && p.id !== 'smoke'
      );
      if (firstWork !== -1 && firstWork < si) {
        push('准入链路：smoke 必须先于其他 execute/generate 阶段（冒烟失败则版本不可测）');
      }
    }
    // 准入失败必须终止全链路：传播默认是 block（见 updatePhase），connectivity 省略 onFailure 会把硬门禁弱化成普通阻断
    const conn = phases.find((p) => p && p.id === 'connectivity');
    if (conn && conn.onFailure !== 'abort') {
      push('准入链路：connectivity 的 onFailure 必须显式为 "abort"（连通性不通=服务不可用，须终止全链路；省略时传播默认为 block）');
    }
  }

  if (route.specials !== undefined) {
    if (!Array.isArray(route.specials) || route.specials.some((s) => typeof s !== 'string')) {
      push('specials 必须是 string array（记录本次开启的专项开关，如 ["load","chaos","dast"]）');
    }
  }

  if (route.securityWaiver !== undefined) {
    const w = route.securityWaiver;
    if (!w || typeof w !== 'object' || Array.isArray(w) || typeof w.reason !== 'string' || !w.reason.trim()) {
      push('securityWaiver 必须是 object 且含非空 reason（记录用户明确放弃安全段的理由）');
    }
  }

  if (route.depthWaiver !== undefined) {
    const w = route.depthWaiver;
    if (!w || typeof w !== 'object' || Array.isArray(w) || typeof w.reason !== 'string' || !w.reason.trim()) {
      push('depthWaiver 必须是 object 且含非空 reason（记录用户明确裁剪深度基线阶段的理由）');
    }
  }

  // 覆盖豁免：finalize 覆盖硬门禁的逃生阀。整项目豁免（depthWaiver/securityWaiver）粒度太粗——
  // 个别端点确实测不了（第三方代理端点、只读账号缺凭据）时逐端点/逐页面留痕，报告如实标注。
  if (route.coverageWaiver !== undefined) {
    const w = route.coverageWaiver;
    if (!Array.isArray(w) || w.length === 0) {
      push('coverageWaiver 必须是非空 array（豁免项 { endpoint?, page?, reason }，逐端点/逐页面留痕）');
    } else {
      w.forEach((item, i) => {
        const at = `coverageWaiver[${i}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          push(`${at} 必须是 object`);
          return;
        }
        const hasEndpoint = typeof item.endpoint === 'string' && item.endpoint.trim();
        const hasPage = typeof item.page === 'string' && item.page.trim();
        if (!hasEndpoint && !hasPage) {
          push(`${at} 必须含 endpoint（"METHOD /path"，路径参数写 {p}）或 page（页面路径）其一`);
        }
        // endpoint 豁免必须带 method（"GET /api/x"）："api/x" 这种写法在覆盖矩阵里对不上端点，
        // 等于没豁免还让人误以为豁免了——缺 method 直接拒收。
        if (hasEndpoint && !/^[a-zA-Z]+\s+\//.test(item.endpoint.trim())) {
          push(`${at}.endpoint 必须写 "METHOD /path"（如 "GET /api/users"，路径参数写 {p}）——缺 method 的写法与覆盖矩阵对不上，拒收`);
        }
        if (typeof item.reason !== 'string' || !item.reason.trim()) {
          push(`${at}.reason 必须是非空 string（豁免理由留痕，报告会原样引用）`);
        }
      });
    }
  }

  // scope（全流程 vs 定向）：缺省由 save_route 自动置 "full"——专家级齐全测试是本 skill 的默认契约，
  // 不依赖 LLM 自觉；"targeted"（单独测某个阶段/某类）是显式选择，必须留一句理由进归档。
  // 旧归档（无 scope 字段）不回溯：全流程门禁只在 scope === "full" 时生效。
  if (route.scope !== undefined) {
    if (!ROUTE_SCOPES.includes(route.scope)) {
      push(`scope 必须是 [${ROUTE_SCOPES.join(' | ')}] 之一（缺省 full；targeted=只测部分阶段，须附 scopeReason 留痕）`);
    }
    if (route.scope === 'targeted' && (typeof route.scopeReason !== 'string' || !route.scopeReason.trim())) {
      push('scope="targeted"（只测部分阶段）必须附非空 scopeReason（一句话说明为何不做全流程，进归档留痕）');
    }
  }

  // 全流程豁免：scope=full 时逐阶段放弃强制集的逃生阀（mirror coverageWaiver 的留痕风格）。
  // 豁免是逐项、留痕、有理由的例外——须先向用户确认；整条路线不测完收工不被允许。
  if (route.fullFlowWaiver !== undefined) {
    const w = route.fullFlowWaiver;
    if (!Array.isArray(w) || w.length === 0) {
      push('fullFlowWaiver 必须是非空 array（逐项 { phase, reason }，phase 为标准阶段 id）');
    } else {
      const seen = new Set();
      w.forEach((item, i) => {
        const at = `fullFlowWaiver[${i}]`;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          push(`${at} 必须是 object`);
          return;
        }
        if (typeof item.phase !== 'string' || !item.phase.trim()) {
          push(`${at}.phase 必须是非空 string（标准阶段 id）`);
        } else if (!knownStageIds().includes(item.phase)) {
          push(`${at}.phase "${item.phase}" 不是标准阶段 id（可选: ${knownStageIds().join('、')}）`);
        } else if (seen.has(item.phase)) {
          push(`${at}.phase "${item.phase}" 重复（一个阶段一条豁免）`);
        } else {
          seen.add(item.phase);
        }
        if (typeof item.reason !== 'string' || !item.reason.trim()) {
          push(`${at}.reason 必须是非空 string（豁免理由留痕，报告会原样引用）`);
        }
      });
    }
  }

  if (issues.length > 0) {
    fail('E_INVALID_ROUTE', `route.json 校验失败（共 ${issues.length} 处）:\n- ` + issues.join('\n- '));
  }
  return route;
}

// ---------- 安全段政策 ----------

const SECURITY_STAGE_IDS = new Set(STAGE_CATALOG.filter((s) => s.group === '安全').map((s) => s.id));

export function securityCoverage(route) {
  const included = (route.phases || []).map((p) => p.id).filter((id) => SECURITY_STAGE_IDS.has(id));
  const allSecurity = [...SECURITY_STAGE_IDS];
  const excluded = allSecurity.filter((id) => !included.includes(id));
  const waived = !!route.securityWaiver?.reason;
  return { included, excluded, waived, allSecurity };
}

// 批准检查点（两道）：① generate-and-execute 路线必须覆盖至少一个安全阶段，或记录用户明确放弃（securityWaiver）；
// ② API 项目（盘点 ≥ API_DEPTH_THRESHOLD 个端点）必须纳入 dast 动态探测——内置探测器全量打盘点端点，
// 没有它「安全全项目通用化」就漏了最大的一块。没有 connectivity targets 推不出 baseUrl 时不许静默放过：
// 补 targets / 显式加 dast / 用户明确放弃留痕，三选一。
export function enforceSecurityPolicyOnApprove(route, apiSurface = null) {
  if (route.mode !== 'generate-and-execute') return;
  const cov = securityCoverage(route);
  if (cov.included.length === 0 && !cov.waived) {
    fail(
      'E_GATE',
      `路线不包含任何安全阶段（安全目录: ${cov.allSecurity.join(' | ')}）。` +
        `默认至少纳入 secrets 扫描与 sca 依赖扫描（成本极低）；若用户明确放弃安全段，请先向其确认，` +
        `然后在 route.securityWaiver 写入 { reason: "<用户放弃的理由>" } 后重新批准。`
    );
  }
  const isApi = (apiSurface?.total ?? 0) >= API_DEPTH_THRESHOLD;
  if (isApi && !cov.waived && !cov.included.includes('dast')) {
    fail(
      'E_GATE',
      `API 项目（盘点 ${apiSurface.total} 个端点）的路线没有动态安全探测（dast）阶段——安全探测全项目强制，不随 LLM 规划缺位而缺位。出路任选：\n` +
        `① 重新 save_route，把可连通的基址写进 connectivity 阶段 targets（如 http://127.0.0.1:8000/），工具会自动注入 dast；\n` +
        `② 在路线里显式加入 dast 阶段（executor="security-probe"，config.baseUrl 必填）；\n` +
        `③ 用户明确不要动态探测（服务不可达/未获授权）→ 先向用户确认，再在 route.securityWaiver 写 { reason: "<理由>" } 留痕后重新批准。`
    );
  }
}

// ---------- 深度基线政策（API 项目）----------
// 资深测试专家级下限：盘点出 API 端点的项目，全流程路线必须包含功能主流程 + negative + boundary，
// 有受保护端点时还须含 authz（越权）。之前只做安全段门禁，LLM 把 boundary/negative/authz 全裁掉
// 也能 approve——产出一支主流程脚本就收工（真实案例：113 端点的后端只测了 31 案）。工具层强制。
const FUNCTIONAL_STAGE_IDS = new Set(['api-functional', 'e2e', 'integration']);

// API 项目判定阈值：盘点端点数 ≥ 该值才按「API 项目」执行深度门禁（避免把极小项目/纯前端拦下）
export const API_DEPTH_THRESHOLD = 5;

// apiSurface: project-map.json 里的 apiSurface（scanApiSurface 产物）或 null
export function depthCoverage(route, apiSurface) {
  const ids = (route.phases || []).map((p) => p.id);
  const has = (id) => ids.includes(id);
  const functional = [...FUNCTIONAL_STAGE_IDS].some(has);
  const negative = has('negative');
  const boundary = has('boundary');
  const authz = has('authz');
  const dast = has('dast');
  const authzNeeded = (apiSurface?.protectedCount ?? 0) > 0 || (apiSurface?.total ?? 0) > 0 && (apiSurface?.publicCount ?? 0) === 0;
  // dast 可行性 = API 项目 + 路线里有 connectivity targets（有可发包的基址才谈动态探测）
  const baseUrl = (route.phases || []).find((p) => p?.id === 'connectivity')?.targets?.[0] || null;
  const dastNeeded = baseUrl != null;
  const gaps = [];
  if (!functional) gaps.push({ stage: 'api-functional', reason: 'API 项目缺少功能主流程阶段（api-functional / e2e / integration 任一）' });
  if (!negative) gaps.push({ stage: 'negative', reason: 'API 项目缺少异常输入测试阶段（非法输入下稳不稳）' });
  if (!boundary) gaps.push({ stage: 'boundary', reason: 'API 项目缺少边界值测试阶段（极值/空值/超长）' });
  if (authzNeeded && !authz) gaps.push({ stage: 'authz', reason: '盘点到受保护端点但路线无越权测试阶段（水平/垂直越权是硬缺陷）' });
  if (dastNeeded && !dast)
    gaps.push({ stage: 'dast', reason: '服务可发包（connectivity targets 已知）但路线无 dast 动态安全探测阶段（内置 security-probe 按盘点端点全量探测：未认证访问/伪造凭据/注入/信息泄漏/安全响应头/CORS/限流）' });
  const waived = !!route.depthWaiver?.reason;
  return { isApiProject: (apiSurface?.total ?? 0) >= API_DEPTH_THRESHOLD, functional, negative, boundary, authz, dast, authzNeeded, dastNeeded, gaps, waived, apiTotal: apiSurface?.total ?? 0, baseUrl };
}

// 批准检查点：API 项目的路线深度基线（缺阶段且有豁免 → 拦）。apiSurface 为 null 时跳过（无盘点不拦）。
export function enforceDepthPolicyOnApprove(route, apiSurface) {
  if (route.mode !== 'generate-and-execute') return;
  if (!apiSurface || (apiSurface.total ?? 0) < API_DEPTH_THRESHOLD) return;
  const cov = depthCoverage(route, apiSurface);
  if (cov.gaps.length && !cov.waived) {
    fail(
      'E_GATE',
      `路线未达到 API 项目深度基线（盘点到 ${cov.apiTotal} 个端点）:\n- ` +
        cov.gaps.map((g) => `${g.stage}: ${g.reason}`).join('\n- ') +
        `\n资深测试专家级全流程必须覆盖：功能主流程 + 异常输入 + 边界值（+ 越权 + 动态安全探测）。` +
        `请把这些阶段补进路线（dast 用内置 security-probe 执行器即可，config 从 connectivity targets 推导）；` +
        `用户明确要求裁剪时，先向其确认，再在 route.depthWaiver 写入 { reason: "<裁剪理由>" } 后重新批准。`
    );
  }
}

// ---------- 全流程强制集政策（scope=full）----------
// 「任何 AI 用这个 skill 做全流程测试，产出的都是专家级齐全的路线」不能靠 SKILL.md 劝说——
// 这里把强制集变成引擎门禁：scope=full 的路线缺任何适用阶段，approve 直接拦下，列明缺口与出路。
// 单独测某个阶段仍允许：显式 scope="targeted" + scopeReason 留痕（validateRoute 强制）。
// 条件判定用 stages.js 的 fullFlow 标签 + fullFlowContext 算出的上下文（盘点/前端/git 脏区），
// 条件不满足的阶段自动不要求；resilience/chaos/pentest/canary/dast 永不强制（opt-in）。

// 浏览器 E2E 最低流程级用例数：max(4, ceil(页面盘点数/4))；页面盘点拿不到时 fallback 4。
// 每条流程级用例覆盖一个完整业务流（登录登出、核心模块 UI CRUD、异步生成等待、表单错误态），
// 页面走查最多算 1 条——「1 条走查用例过关」在 scope=full 下不可能再发生。
export function browserE2eMinCases(pagesTotal) {
  const n = Number(pagesTotal);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.max(4, Math.ceil(n / 4));
}

// 浏览器 E2E 流程基线（scope=full）：从项目盘点推导「必测业务流清单」——登录登出 + 每模块 UI CRUD
// + 表单错误态。深度门禁由清单驱动而非纯公式：最低用例数 = max(公式下限, 流程数)；passed 前逐条
// 对账（用例标题带 @flow:<id> 标签，纯页面走查没有标签、对不上账）。清单随 save_route 响应返回，
// 进批准摘要给用户评审——测什么业务流不靠 LLM 现场发挥，也不靠用户事后抽查。
export function browserE2eFlowBaseline(apiSurface, pagesTotal) {
  const flows = [];
  if ((apiSurface?.protectedCount ?? 0) > 0) {
    flows.push({ id: 'auth', why: '登录→核心操作→登出（含登出后访问受保护页跳回登录、服务端会话失效）' });
  }
  // modules 形如 [{ name, file, count }]（容错兼容纯 string）
  const modules = Array.isArray(apiSurface?.modules)
    ? apiSurface.modules.map((m) => (typeof m === 'string' ? m : m?.name)).filter((m) => typeof m === 'string' && m.trim())
    : [];
  for (const m of modules) {
    flows.push({ id: `crud-${m}`, why: `模块 "${m}" 的 UI 增删改查主流程` });
  }
  flows.push({ id: 'form-error', why: '表单错误态：必填缺失/非法输入的前端拦截与错误提示流程' });
  return {
    flows,
    minCases: Math.max(browserE2eMinCases(pagesTotal), flows.length),
  };
}

// 全流程门禁上下文：盘点（apiSurface）、前端标志、页面盘点（pages）、git 脏区。
// save_route 与 finalize_report 共用，保证 approve 拦截口径与报告对照口径一致。
export function fullFlowContext(root, archiveDir) {
  const apiSurface = loadApiSurface(root, archiveDir);
  let frontend = false;
  try {
    frontend = detectFrontend(root).detected === true;
  } catch {
    frontend = false;
  }
  // project-map.json 是 scan_project 的落盘产物，优先取（避免重复扫描）；缺失/损坏才以现场探测为准
  let pages = null;
  try {
    const map = readJson(path.join(archiveDir, 'project-map.json'));
    if (map?.frontend?.detected === true) frontend = true;
    if (map?.webSurface?.pages) pages = map.webSurface;
  } catch {
    /* 地图缺失 → 用上面的现场探测结果 */
  }
  if (!pages) {
    try {
      pages = loadWebSurface(root, archiveDir);
    } catch {
      pages = null;
    }
  }
  // git 脏区：untracked 不计；排除 test-archives/**（本归档产物）与 provision 台账路径
  //（依赖安装自己改动的 package.json/锁文件——playwright 安装不应触发 regression 强制）
  const exclude = [];
  try {
    const ledger = readJson(path.join(archiveDir, 'provision.json'));
    for (const m of ledger?.modifications || []) if (m?.path) exclude.push(String(m.path));
    if ((ledger?.installs || []).length > 0) {
      for (const name of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']) {
        exclude.push(name);
      }
    }
  } catch {
    /* 无台账 → 无需排除 */
  }
  let gitDirty = false;
  try {
    gitDirty = hasTrackedChanges(root, exclude);
  } catch {
    gitDirty = false;
  }
  return { apiSurface, frontend, pages, pagesTotal: pages?.total ?? null, gitDirty };
}

function fullFlowConditionMet(cond, route, ctx) {
  const conn = (route.phases || []).find((p) => p?.id === 'connectivity');
  const hasTargets = Array.isArray(conn?.targets) && conn.targets.length > 0;
  const apiTotal = ctx?.apiSurface?.total ?? 0;
  const isApi = apiTotal >= API_DEPTH_THRESHOLD;
  const conds = Array.isArray(cond) ? cond : [cond];
  return conds.every((c) => {
    switch (c) {
      case 'always':
        return true;
      case 'service':
        return hasTargets || isApi;
      case 'api':
        return isApi;
      case 'api-multi-module':
        return isApi && (ctx?.apiSurface?.modules?.length ?? 0) >= 2;
      case 'openapi':
        return (ctx?.apiSurface?.sources || []).some((s) => /openapi/i.test(String(s)));
      case 'frontend':
        return ctx?.frontend === true;
      case 'git-dirty':
        return ctx?.gitDirty === true;
      case 'authz-needed':
        return (ctx?.apiSurface?.protectedCount ?? 0) > 0 || (apiTotal > 0 && (ctx?.apiSurface?.publicCount ?? 0) === 0);
      case 'never':
        return false;
      default:
        return false;
    }
  });
}

const FULL_FLOW_WHY = {
  always: '恒必需（专家级全流程的基本盘）',
  service: '有可测服务（connectivity targets 已知或 API 项目）',
  api: 'API 项目（盘点端点达标）',
  'api-multi-module': 'API 项目且盘点到多个模块',
  openapi: '盘点到机器可读契约（openapi/swagger）',
  frontend: '前端项目',
  'git-dirty': 'git 工作区有真实源码变更',
  'authz-needed': '盘点到受保护端点',
};

// scope=full 的强制集对照：required（条件适用且必需）/ present / missing / waived / skipped。
// 条件不满足的进 inapplicable（informational，不拦）；fullFlow='never' 的进 optional（保持 opt-in）。
export function fullFlowCoverage(route, ctx = null) {
  const scope = route.scope === 'targeted' ? 'targeted' : 'full';
  const ids = (route.phases || []).map((p) => p?.id);
  const waiverByPhase = new Map();
  for (const w of Array.isArray(route.fullFlowWaiver) ? route.fullFlowWaiver : []) {
    if (w?.phase && !waiverByPhase.has(w.phase)) waiverByPhase.set(w.phase, String(w.reason || ''));
  }
  const required = [];
  const present = [];
  const missing = [];
  const waived = [];
  const skipped = [];
  const inapplicable = [];
  const optional = [];
  for (const meta of STAGE_CATALOG) {
    const cond = meta.fullFlow || 'never';
    if (cond === 'never') {
      optional.push(meta.id);
      continue;
    }
    const conds = Array.isArray(cond) ? cond : [cond];
    if (!fullFlowConditionMet(cond, route, ctx)) {
      inapplicable.push({ id: meta.id, condition: conds.join('+'), why: conds.map((c) => FULL_FLOW_WHY[c]).filter(Boolean).join(' 且 ') });
      continue;
    }
    const entry = { id: meta.id, title: meta.title, group: meta.group, condition: conds.join('+'), why: conds.map((c) => FULL_FLOW_WHY[c]).filter(Boolean).join(' 且 ') };
    required.push(entry);
    if (ids.includes(meta.id)) {
      const p = route.phases.find((x) => x?.id === meta.id);
      if (p.status === 'skipped') skipped.push({ id: meta.id, reason: p.reason || '' });
      else present.push(meta.id);
    } else if (waiverByPhase.has(meta.id)) {
      waived.push({ id: meta.id, reason: waiverByPhase.get(meta.id) });
    } else {
      missing.push(entry);
    }
  }
  return {
    scope,
    required,
    present,
    missing,
    waived,
    skipped,
    inapplicable,
    optional,
    counts: { required: required.length, present: present.length, missing: missing.length, waived: waived.length },
  };
}

// 批准检查点（第三道）：scope=full 的路线必须覆盖全部条件适用的阶段，缺一即拦。
// 三条出路：补阶段 / 条件不满足时修正判断依据重判 / 用户确认后逐项 fullFlowWaiver 留痕。
export function enforceFullFlowPolicyOnApprove(route, ctx = null) {
  if (route.mode !== 'generate-and-execute') return;
  if (route.scope === 'targeted') return; // 定向测试已在 validateRoute 强制 scopeReason 留痕，放行
  const cov = fullFlowCoverage(route, ctx);
  if (!cov.missing.length) return;
  fail(
    'E_GATE',
    `路线为全流程（scope=full），但缺少 ${cov.missing.length} 个必需阶段:\n- ` +
      cov.missing.map((m) => `${m.id}（${m.group}层 · 纳入原因: ${m.why}）`).join('\n- ') +
      `\n全流程 = 专家级齐全测试：条件适用的阶段一项都不能少（条件不满足的自动不要求）。出路三选一:\n` +
      `① 重新 save_route 把这些阶段补进路线（uat 为 manual 阶段会自动注入；load/stress/soak 耗时长可放宽强度，但不可缺席）；\n` +
      `② 某项的纳入条件其实不满足（如并非 API 项目/无前端/工作区干净）→ 说明实情后重新 save，引擎按条件重判（不要硬凑不存在的条件）；\n` +
      `③ 用户明确确认裁剪某阶段 → 先向用户确认，再在 route.fullFlowWaiver 逐项写 { phase: "<阶段id>", reason: "<理由>" } 留痕后重新批准` +
      `（禁止为省事默认 targeted；禁止整条路线不测完收工）。`
  );
}

// 全流程默认覆盖（save_route 调用，mirror injectSecurityDefaults）：scope=full 且缺 uat 且未豁免 → 自动补
// uat（manual 阶段、无执行器、不执行任何命令，安全）。其余必需阶段不自动注入：执行器选择依赖项目栈
//（k6/JMeter/pytest…），由 LLM 补齐 + approve 门禁兜底；只有 manual 的 uat 能安全地自动补。
export function injectFullFlowDefaults(route) {
  if (!route || route.mode !== 'generate-and-execute' || !Array.isArray(route.phases)) return [];
  if (route.scope === 'targeted') return [];
  if ((Array.isArray(route.fullFlowWaiver) ? route.fullFlowWaiver : []).some((w) => w?.phase === 'uat' && String(w?.reason || '').trim())) return [];
  if (route.phases.some((p) => p?.id === 'uat')) return [];
  const meta = STAGE_BY_ID.get('uat');
  const phase = {
    id: 'uat',
    kind: meta.defaultKind,
    status: 'pending',
    onFailure: meta.defaultOnFailure,
    notes: `默认全流程覆盖（save_route 自动补齐，非 LLM 规划）：${meta.title}——${meta.essence}。产出验收清单到 manual-cases/，由业务方执行；用户明确不要时先向其确认，再移除本阶段并用 fullFlowWaiver 留痕`,
  };
  const acceptIdx = route.phases.findIndex((p) => STAGE_BY_ID.get(p?.id)?.group === '验收');
  if (acceptIdx === -1) route.phases.push(phase);
  else route.phases.splice(acceptIdx, 0, phase);
  return ['uat'];
}

// ---------- 落地规范（save_route 调用；不依赖 LLM 服从性）----------

const STAGE_BY_ID = new Map(STAGE_CATALOG.map((s) => [s.id, s]));

// 执行器 → 唯一对应的标准阶段 id。pytest/vitest/jest/generic 是多用途执行器（unit/integration/… 都可能用），不做映射。
const EXECUTOR_STAGE_ALIASES = {
  health: 'connectivity',
  e2e: 'e2e',
  playwright: 'browser-e2e',
  sca: 'sca',
  secrets: 'secrets',
  'security-probe': 'dast',
};

// 阶段 id 规范化：修掉 "smoke-01" 式 run 序号后缀、以及执行器能唯一映射的自定义 id，
// 让准入硬顺序、安全覆盖判定、报告「层」列都能按标准 id 命中。碰撞或目录覆盖不了的自定义 id 原样保留
//（unknownStageIds 会照常报出）。返回改动清单 [{from,to}] 供 save_route 回显。
export function canonicalizePhaseIds(route) {
  if (!route || !Array.isArray(route.phases)) return [];
  const originals = new Set(route.phases.map((p) => p?.id).filter((v) => typeof v === 'string'));
  const assigned = new Set();
  const changes = [];
  for (const p of route.phases) {
    if (!p || typeof p.id !== 'string') continue;
    const before = p.id;
    let id = p.id;
    const stripped = id.replace(/[-_]\d+$/, '');
    if (id !== stripped && STAGE_BY_ID.has(stripped) && !originals.has(stripped) && !assigned.has(stripped)) {
      id = stripped;
    }
    if (!STAGE_BY_ID.has(id)) {
      const alias = EXECUTOR_STAGE_ALIASES[p.executor];
      if (alias && !originals.has(alias) && !assigned.has(alias)) id = alias;
    }
    assigned.add(id);
    if (id !== before) {
      changes.push({ from: before, to: id });
      p.id = id;
    }
  }
  return changes;
}

// 默认安全覆盖：generate-and-execute 路线的安全段缺口由工具直接补齐（目录序），插在第一个验收阶段前。
// ① 完全没有安全阶段 → 补 sca + secrets（内置零依赖执行器、不发包）；
// ② API 项目且 connectivity targets 可推导基址 → 补 dast（内置 security-probe，按盘点端点全量动态探测），
//    config.baseUrl 直接取 connectivity targets[0]，LLM 漏规划也不产生"安全探测缺位"。
// 安全门禁因此前移到保存时——LLM 漏规划不再产生"approve 必被打回"的死胡同；
// 豁免（securityWaiver）仍只能由用户明示。返回注入的阶段 id。
export function injectSecurityDefaults(route, apiSurface = null) {
  if (!route || route.mode !== 'generate-and-execute' || !Array.isArray(route.phases)) return [];
  if (route.securityWaiver?.reason) return [];
  const injected = [];
  const insertPhase = (id, extra = {}) => {
    if (route.phases.some((p) => p?.id === id)) return;
    const meta = STAGE_BY_ID.get(id);
    const phase = {
      id,
      kind: meta.defaultKind,
      executor: meta.defaultExecutor,
      status: 'pending',
      onFailure: meta.defaultOnFailure,
      notes: `默认安全覆盖（save_route 自动补齐，非 LLM 规划）：${meta.title}——${meta.essence}`,
      ...extra,
    };
    const uatIdx = route.phases.findIndex((p) => STAGE_BY_ID.get(p?.id)?.group === '验收');
    if (uatIdx === -1) route.phases.push(phase);
    else route.phases.splice(uatIdx, 0, phase);
    injected.push(id);
  };
  const hasAnySecurity = route.phases.some((p) => p && SECURITY_STAGE_IDS.has(p.id));
  if (!hasAnySecurity) {
    for (const id of ['sca', 'secrets']) insertPhase(id);
  }
  const baseUrl = route.phases.find((p) => p?.id === 'connectivity')?.targets?.[0] || null;
  const isApi = (apiSurface?.total ?? 0) >= API_DEPTH_THRESHOLD;
  if (isApi && baseUrl) {
    insertPhase('dast', {
      config: { baseUrl },
      notes: `默认安全覆盖（save_route 自动补齐，非 LLM 规划）：动态安全探测——内置 security-probe 按盘点的 ${apiSurface.total} 个端点全量探测（未认证访问/伪造凭据/注入/信息泄漏/安全响应头/CORS/限流），baseUrl 取自 connectivity targets。用户明确不要动态探测时移除本阶段并向用户确认后用 securityWaiver 留痕`,
    });
  }
  return injected;
}

// ---------- 状态机 ----------

const TRANSITIONS = {
  pending: ['in-progress', 'skipped', 'blocked'],
  'in-progress': ['passed', 'failed', 'blocked', 'skipped', 'awaiting-approval'],
  'awaiting-approval': ['in-progress', 'passed', 'skipped'],
  passed: [],
  failed: ['in-progress', 'skipped', 'blocked'],
  blocked: ['in-progress', 'skipped'],
  skipped: [],
};

// 阶段 id 容错解析：精确 → 大小写/下划线归一 → 唯一前缀 → 唯一包含。
// LLM 手写 id 的小差异（"Unit"、"unit_test"）不该消耗宿主一整轮重试；歧义时报出候选。
export function resolvePhaseId(route, phaseId) {
  const ids = (route.phases || []).map((p) => p.id);
  const raw = String(phaseId ?? '').trim();
  if (ids.includes(raw)) return raw;
  const norm = raw.toLowerCase().replace(/_/g, '-');
  const byNorm = ids.find((id) => String(id).toLowerCase().replace(/_/g, '-') === norm);
  if (byNorm) return byNorm;
  const prefixes = ids.filter((id) => String(id).toLowerCase().startsWith(norm));
  const candidates = prefixes.length === 1 ? prefixes : ids.filter((id) => String(id).toLowerCase().includes(norm));
  if (candidates.length === 1) return candidates[0];
  const hint = candidates.length > 1 ? `；"${phaseId}" 可能指: ${candidates.join('、')}，请用完整 id` : '';
  fail('E_NOT_FOUND', `路线中不存在阶段 "${phaseId}"（现有阶段: ${ids.join('、') || '无'}）${hint}`);
}

function phaseByIdx(route, phaseId) {
  const id = resolvePhaseId(route, phaseId);
  const idx = route.phases.findIndex((p) => p.id === id);
  return { phase: route.phases[idx], idx };
}

function lastRunOf(phase) {
  if (!Array.isArray(phase.runs) || phase.runs.length === 0) return null;
  return phase.runs[phase.runs.length - 1];
}

function requireProgressible(route) {
  if (route.status === 'draft') {
    fail(
      'E_ROUTE_NOT_APPROVED',
      '路线仍为 draft 状态。请先把路线方案提交用户评审，用户确认后调用 save_route(action="approve") 后才能推进阶段。'
    );
  }
  if (route.status === 'completed' || route.status === 'aborted' || route.status === 'abandoned') {
    fail('E_GATE', `路线已处于终态 "${route.status}"，不能再更新阶段。`);
  }
}

function serializeRunRef(run) {
  return {
    runId: run.runId,
    resultPath: run.resultPath,
    status: run.status,
    exitCode: run.exitCode,
    parseStatus: run.parseStatus || null,
    summary: run.summary,
    triage: run.triage || null,
    fingerprint: run.fingerprint || null,
    git: run.git || null,
    coverage: run.coverage || null,
  };
}

export function updatePhase(archiveDir, { phaseId, status, reason, notes, allowTestFileChanges = false }) {
  const route = loadRoute(archiveDir);
  requireProgressible(route);
  const { phase, idx } = phaseByIdx(route, phaseId);
  const prev = phase.status;

  // 仅更新备注（状态不变）始终允许，用于断点续跑 checkpoint
  if (prev !== status) {
    const allowed = TRANSITIONS[prev] || [];
    if (!allowed.includes(status)) {
      fail(
        'E_GATE',
        `阶段 "${phaseId}" 不允许从 "${prev}" 迁移到 "${status}"。允许的目标状态: [${allowed.join(' | ') || '（终态，不可迁移）'}]`
      );
    }
    if (status === 'skipped' && !reason) {
      fail('E_GATE', `将阶段标记为 skipped 必须给出 reason。`);
    }

    if (status === 'in-progress') {
      // 串行强制：更早的阶段必须处于终态
      for (let j = 0; j < idx; j++) {
        const earlier = route.phases[j];
        if (!TERMINAL.has(earlier.status)) {
          fail(
            'E_GATE',
            `前置阶段 "${earlier.id}" 尚未完成（当前 ${earlier.status}）。默认串行推进，请先完成或显式标记 skipped。`
          );
        }
      }
      if (route.status === 'approved') route.status = 'in-progress';
      // 终止方阶段返工 → 解除全链路终止
      if (route.terminated && route.terminated.byPhase === phaseId) {
        delete route.terminated;
        phase.notes = appendNote(phase.notes, '[gate] 终止方阶段返工，解除全链路终止');
      }
      // 解锁/返工时清掉传播期写下的过期 reason（如"上游阶段被跳过，默认阻断"），
      // 否则阶段最终通过后，final-report 仍会显示早已失效的阻断原因误导读者
      if (reason === undefined) delete phase.reason;
    }

    if (status === 'passed') {
      if (phase.kind === 'execute') {
        const run = lastRunOf(phase);
        if (!run) {
          fail('E_GATE', `阶段 "${phaseId}" 是 execute 类，通过前必须先 run_tests 产生一次执行记录。`);
        }
        if (run.exitCode !== 0 || (run.summary && run.summary.failed > 0)) {
          // 例外：所有失败用例均被 triage 为 environment 时允许放行
          const envOk = allFailuresTriagedEnvironment(run);
          if (!envOk) {
            fail(
              'E_GATE',
              `阶段 "${phaseId}" 最近一次执行未通过（exitCode=${run.exitCode}, 失败用例=${run.summary?.failed ?? '?'}）。` +
                `请先 record_triage 归因（test-bug→修沙箱内用例重跑；code-bug→阶段标 failed 并划 P0–P3，不修被测代码；environment→修环境重跑），或将阶段标记为 failed / skipped(reason)。`
            );
          }
          phase.notes = appendNote(phase.notes, '[gate] 失败用例全部归因为环境问题，允许通过');
        }
        // 证据链硬门禁（playwright 阶段）：passed 前核对最近一次 run 的证据附件是否逐用例落地——
        // 「跑是跑了、trace/video/截图全无」的执行不许以 passed 收口。evidence=off（显式降级+理由留痕）豁免。
        if (phase.executor === 'playwright') {
          const runEvidence = String(run.evidence || phase.evidence || 'full');
          if (runEvidence !== 'off') {
            let eg = run.evidenceGate || null;
            if (!eg) {
              try {
                eg = findRunResultPath(archiveDir, run.runId).result?.evidenceGate || null;
              } catch {
                eg = null;
              }
            }
            if (eg && eg.compliant === false) {
              const miss = (eg.warnings || []).slice(0, 4).join('；') || '证据附件不齐';
              fail(
                'E_GATE',
                `阶段 "${phaseId}" 证据链不达标，不可 passed：${miss}\n` +
                  `处理：① 查 run warnings 与 runs/${run.runId}/raw/artifacts/（video/自动截图由工具注入的证据 wrapper 提供，--trace on 由命令兜底）；\n` +
                  `② 环境确实产不出（如 ffmpeg 缺失）→ run_tests(evidence="trace", evidenceReason=…) 降级重跑；\n` +
                  `③ 用户明写不要证据 → run_tests(evidence="off", evidenceReason=…)（留痕，最终报告如实标注）。`
              );
            }
          }
        }
        // 用例级结果门禁（generic 执行器）：只有 exit code / 汇总行、解析不出任何具名用例的 run，
        // 不许以 passed 收口——"passed 但报告里无用例级结果"是报告失信的直接来源
        //（真实事故：整份报告一排「无用例级结果」，读者无从核对到底测了什么）。
        if (phase.executor === 'generic') {
          let caseCount = 0;
          try {
            const { result: rr } = findRunResultPath(archiveDir, run.runId);
            caseCount = (rr?.suites || []).reduce((n, s) => n + (s.cases?.length || 0), 0);
          } catch {
            caseCount = 0;
          }
          if (caseCount === 0) {
            fail(
              'E_GATE',
              `阶段 "${phaseId}" 最近一次 generic run 没有任何用例级结果（只有 exit code 或汇总行数字）——「passed 但无用例明细」不可收口。\n` +
                `修沙箱脚本二选一后重跑：① 逐用例写环境变量 TESTROUTE_RESULTS_FILE 指向的文件（JSON 数组，元素 {name, status: "passed"|"failed"|"skipped", message?}）；\n` +
                `② 逐行输出 "PASS | 用例名" / "FAIL | 用例名"（也认 "ok - " / "not ok - "）。逐用例结果会进最终报告的「全量用例清单」，无明细 = 报告失信。`
            );
          }
        }
        // ① 数量：最低数 = max(4, ceil(页面盘点数/4), 流程基线数)，页面盘点拿不到时公式下限 4；
        // ② 对账：盘点推导的必测业务流（登录登出/每模块 UI CRUD/表单错误态）逐项要有带
        //    @flow:<id> 标题标签的用例——纯页面走查没有标签，对不上账。
        // fullFlowWaiver（phase: browser-e2e）整体留痕可豁免两项。
        if (route.scope === 'full' && phase.executor === 'playwright') {
          const waivedMin = (Array.isArray(route.fullFlowWaiver) ? route.fullFlowWaiver : []).some(
            (w) => (w?.phase === phase.id || w?.phase === 'browser-e2e') && String(w?.reason || '').trim()
          );
          let pagesTotal = null;
          try {
            pagesTotal = loadWebSurface(route.project?.root, archiveDir)?.total ?? null;
          } catch {
            pagesTotal = null;
          }
          let ffApiSurface = null;
          try {
            ffApiSurface = loadApiSurface(route.project?.root, archiveDir);
          } catch {
            ffApiSurface = null;
          }
          const baseline = browserE2eFlowBaseline(ffApiSurface, pagesTotal);
          const caseTotal = run.summary?.total;
          if (!waivedMin && !(Number.isFinite(caseTotal) && caseTotal >= baseline.minCases)) {
            fail(
              'E_GATE',
              `阶段 "${phaseId}" 全流程深度门禁未达标（scope=full）：浏览器 E2E 至少 ${baseline.minCases} 条流程级用例` +
                `${pagesTotal != null ? `（页面盘点 ${pagesTotal} 页、流程基线 ${baseline.flows.length} 条 → max(4, ceil(${pagesTotal}/4), ${baseline.flows.length})）` : '（页面盘点不可得，取公式下限与流程基线的较大值）'}，` +
                `最近一次 run 解析到 ${Number.isFinite(caseTotal) ? caseTotal : 0} 条。\n` +
                `每条流程级用例覆盖一个完整业务流（登录登出、核心模块 UI 增删改查、异步生成等待、表单错误态）；页面走查最多算 1 条。\n` +
                `出路：① 补流程级用例后重跑（生成用例前先 browser_probe 抓真实 DOM）；` +
                `② 用户明确确认裁剪 → 在 route.fullFlowWaiver 写 { phase: "browser-e2e", reason: "<理由>" } 留痕后重新保存路线。`
            );
          }
          if (!waivedMin && Number.isFinite(caseTotal) && caseTotal > 0) {
            const tagged = new Set();
            try {
              const { result: rr } = findRunResultPath(archiveDir, run.runId);
              for (const suite of rr?.suites || []) {
                for (const c of suite.cases || []) {
                  const re = /@flow:([^\s›]+)/g;
                  let m;
                  while ((m = re.exec(String(c?.name || '')))) tagged.add(m[1]);
                }
              }
            } catch {
              // 结果不可读 → 视为无标签，对账拦下（诚实优先）
            }
            const missingFlows = baseline.flows.filter((f) => !tagged.has(f.id));
            if (missingFlows.length) {
              fail(
                'E_GATE',
                `阶段 "${phaseId}" 全流程浏览器 E2E 基线对账未过（scope=full）：以下必测业务流没有任何带 @flow:<id> 标签的用例——` +
                  missingFlows.map((f) => `${f.id}（${f.why}）`).join('、') + `。\n` +
                  `流程清单由项目盘点推导（登录登出/每模块 UI CRUD/表单错误态），随 save_route 响应的 browserE2eFlowBaseline 返回；` +
                  `每条用例标题末尾加 "@flow:<id>"（如 "注册登录主流程 @flow:auth"），纯页面走查没有标签、对不上账。\n` +
                  `出路：① 按清单补对应用例后重跑（生成用例前先 browser_probe 抓真实 DOM）；` +
                  `② 用户明确确认裁剪 → 在 route.fullFlowWaiver 写 { phase: "browser-e2e", reason: "<理由>" } 留痕后重新保存路线。`
              );
            }
          }
        }
      }
      // 测试脚本只读门禁：项目自有测试文件在归档创建后被修改/删除 → 拦下
      const root = route.project?.root;
      if (root && (phase.kind === 'execute' || phase.kind === 'generate')) {
        const violation = verifyTestGate(root, archiveDir);
        if (violation.enforced && !violation.ok) {
          if (!allowTestFileChanges) {
            gateViolationError(phaseId, violation);
          }
          acknowledgeTestGate(root, archiveDir);
          phase.notes = appendNote(
            phase.notes,
            `[gate] 用户知情确认测试脚本改动（modified=${violation.modified.length}, deleted=${violation.deleted.length}），基线已重建`
          );
        }
      }
    }

    phase.status = status;
    if (reason !== undefined) phase.reason = reason;
    if (notes !== undefined) phase.notes = notes;

    // 传播规则：失败/跳过阶段影响后续阶段（由本阶段自己的 onFailure 决定）
    const propagated = propagate(route, idx, status);
    if (status === 'failed' && (phase.onFailure || 'block') === 'abort') {
      route.terminated = {
        at: nowIso(),
        byPhase: phase.id,
        reason: phase.reason || `阶段 ${phase.id} 失败（连通性/冒烟未通过，准入链路终止）`,
      };
    }
    route.updatedAt = nowIso();
    saveRoute(archiveDir, route);
    return { route, phase, propagated };
  }

  if (notes !== undefined) phase.notes = notes;
  if (reason !== undefined) phase.reason = reason;
  route.updatedAt = nowIso();
  saveRoute(archiveDir, route);
  return { route, phase, propagated: [] };
}

function allFailuresTriagedEnvironment(run) {
  const failedCount = run.summary?.failed ?? 0;
  if (failedCount === 0) return false;
  const cls = run.triage?.classifications || [];
  const envIds = new Set(cls.filter((c) => c.classification === 'environment').map((c) => c.caseId));
  if (envIds.size === 0) return false;
  // 用例级失败数 <= 已归因 environment 的去重 caseId 数即视为全部归因
  return failedCount <= envIds.size;
}

function appendNote(existing, note) {
  const stamp = `[${nowIso()}]`;
  return `${existing ? existing + '\n' : ''}${stamp} ${note}`;
}

function propagate(route, failedIdx, outcome) {
  const phase = route.phases[failedIdx];
  const onFailure = phase.onFailure || 'block';
  const propagated = [];
  if (outcome !== 'failed' && outcome !== 'skipped') return propagated;
  if (outcome === 'failed' && onFailure === 'continue') return propagated;

  for (let j = failedIdx + 1; j < route.phases.length; j++) {
    const later = route.phases[j];
    if (later.status !== 'pending') continue;
    if (outcome === 'skipped') {
      later.status = 'blocked';
      later.reason = `上游阶段 "${phase.id}" 被跳过，默认阻断；如确认无依赖可显式置回 in-progress`;
      propagated.push({ phaseId: later.id, status: 'blocked' });
    } else if (onFailure === 'block' || onFailure === 'abort') {
      later.status = 'blocked';
      later.reason =
        onFailure === 'abort'
          ? `上游阶段 "${phase.id}" 失败（onFailure=abort，准入链路终止）`
          : `上游阶段 "${phase.id}" 失败（onFailure=block）`;
      propagated.push({ phaseId: later.id, status: 'blocked' });
    } else if (onFailure === 'ask') {
      later.status = 'awaiting-approval';
      later.reason = `上游阶段 "${phase.id}" 失败（onFailure=ask），等待用户指示`;
      propagated.push({ phaseId: later.id, status: 'awaiting-approval' });
    }
  }
  return propagated;
}

// 失败判定统一口径：run 状态失败 / 退出码非 0 / 解析出失败用例，三者任一即视为失败 run。
export function isFailedRun(run) {
  if (!run) return false;
  return run.status === 'failed' || run.exitCode !== 0 || (run.summary?.failed ?? 0) > 0;
}

// route-reset 会清掉 phase.runs 但保留 runs/ 目录文件——执行历史的权威来源是磁盘。
// route 内引用 + 磁盘 run 合并（按 runId 去重、按时间排序）：归因继承、重跑门禁、收口计数
// 都必须看全量历史，否则 reset 一次就绕过一轮归因。
export function listDiskRuns(archiveDir, phaseId = null) {
  const runsDir = path.join(archiveDir, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const out = [];
  for (const name of fs.readdirSync(runsDir)) {
    const resultPath = path.join(runsDir, name, 'result.json');
    if (!fs.existsSync(resultPath)) continue;
    const result = readJson(resultPath);
    if (!result?.runId) continue;
    if (phaseId && result.phaseId !== phaseId) continue;
    out.push({
      runId: result.runId,
      resultPath: toPosixRunRef(result.runId),
      status: result.status,
      exitCode: result.exitCode,
      parseStatus: result.parseStatus || null,
      command: result.command || null,
      summary: result.summary || null,
      triage: result.triage || null,
      // 未归因 run 的 result.json 不存指纹（指纹只在 record_triage 时落盘）——现场重算，
      // 否则 route-reset 后磁盘上的未归因失败 run 没有指纹，继承与收口计数都失明。
      fingerprint: result.triage?.fingerprint || result.fingerprint || failureFingerprint(result) || null,
      git: result.git || null,
      coverage: null,
      startedAt: result.startedAt || '',
      finishedAt: result.finishedAt || '',
      durationMs: result.durationMs ?? null,
      _fromDisk: true,
    });
  }
  out.sort((a, b) => String(a.startedAt || a.finishedAt).localeCompare(String(b.startedAt || b.finishedAt)));
  return out;
}

function toPosixRunRef(runId) {
  return `runs/${runId}/result.json`;
}

export function mergedPhaseRuns(archiveDir, phase) {
  const disk = new Map();
  for (const r of listDiskRuns(archiveDir, phase.id)) disk.set(r.runId, r);
  const known = new Map();
  for (const r of Array.isArray(phase.runs) ? phase.runs : []) {
    if (!r?.runId) continue;
    const d = disk.get(r.runId) || null;
    // route 引用为主（coverage/evidenceGate 等 route 侧注解），磁盘回填引用里缺的事实字段
    //（serializeRunRef 不存时间——没有回填，route-reset 后重新引用的 run 会因空时间排错序）
    known.set(r.runId, {
      ...r,
      ...(d
        ? {
            startedAt: r.startedAt || d.startedAt || '',
            finishedAt: r.finishedAt || d.finishedAt || '',
            triage: r.triage || d.triage || null,
            fingerprint: r.fingerprint || d.fingerprint || null,
            command: r.command || d.command || null,
            durationMs: r.durationMs ?? d.durationMs ?? null,
          }
        : {}),
    });
  }
  for (const [id, r] of disk) {
    if (!known.has(id)) known.set(id, r);
  }
  return [...known.values()].sort((a, b) =>
    String(a.startedAt || a.finishedAt).localeCompare(String(b.startedAt || b.finishedAt))
  );
}

// 失败 run 未归因 → 禁止再次执行。没有这道门禁，"triage 里写已修"与"修复实际生效"之间的
// 落差（重跑仍失败）会在归档里不可见——失败 run 必须逐次归因。
// 视线覆盖 route-reset 前的磁盘历史：reset 清 phase.runs 不等于历史归因义务消失。
export function requireTriageForRerun(archiveDir, phase) {
  const runs = mergedPhaseRuns(archiveDir, phase);
  const run = runs[runs.length - 1];
  if (!run) return;
  if (isFailedRun(run) && !run.triage) {
    fail(
      'E_TRIAGE_REQUIRED',
      `阶段 "${phase.id}" 上一次执行（${run.runId}）失败且未归因。请先 record_triage(runId="${run.runId}") ` +
        `逐条归因（test-bug→修用例重跑；code-bug→标记 failed 阻断；environment→修复环境后重跑），再重跑本阶段。`
    );
  }
}

// 失败指纹继承：本次失败与历史已归因失败的指纹完全一致（同一批用例、同样报错前缀）→
// 自动继承该轮归因并留痕（carriedFrom），宿主不再为同一失败重复交 record_triage 一轮。
// 指纹不同（修复生效/新失败）照旧拦截。这是"逐次归因"的唯一放宽，全程留痕可审计。
// 历史视线含 route-reset 前的磁盘 runs——reset 不重置归因义务，也不重置继承资格。
export function maybeCarryOverTriage(archiveDir, route, phase) {
  const runs = mergedPhaseRuns(archiveDir, phase);
  const last = runs[runs.length - 1];
  if (!last || last.triage) return null;
  if (!isFailedRun(last) || !last.fingerprint) return null;
  for (let i = runs.length - 2; i >= 0; i--) {
    const prev = runs[i];
    if (prev.triage && prev.fingerprint && prev.fingerprint === last.fingerprint) {
      last.triage = { ...prev.triage, carriedFrom: prev.runId, carriedAt: nowIso() };
      delete last.triage.updatedAt;
      // route 内引用同步：last 可能只存在于磁盘（route-reset 后），把继承结果回写 route 引用，
      // 保证 route.json 自身就完整记录该 run 与其归因（归档不依赖重新扫盘才可见）。
      const ref = (phase.runs = Array.isArray(phase.runs) ? phase.runs : []).find((r) => r?.runId === last.runId);
      if (ref) ref.triage = last.triage;
      else phase.runs.push(serializeRunRef({ ...last, triage: last.triage }));
      try {
        const { resultPath, result } = findRunResultPath(archiveDir, last.runId);
        result.triage = last.triage;
        writeJson(resultPath, result);
      } catch {
        // result.json 缺失不阻断：route 侧引用已带归因
      }
      route.updatedAt = nowIso();
      saveRoute(archiveDir, route);
      return { runId: last.runId, carriedFrom: prev.runId };
    }
  }
  return null;
}

// 同指纹收口计数：从最近一次 run 往前数，连续失败且指纹完全一致的 run 数。
// 同一失败指纹连续多轮＝宿主在原地打转（修了没生效/没修在重试）——达到阈值后 run_tests
// 拒绝再跑，逼着换做法（改变用例/数据/环境使指纹变化）或如实归因收尾，不许无限重试。
export function consecutiveSameFingerprintFailures(archiveDir, phase) {
  const runs = mergedPhaseRuns(archiveDir, phase);
  let end = runs.length - 1;
  while (end >= 0 && !isFailedRun(runs[end])) end--;
  if (end < 0) return { count: 0, fingerprint: null, runIds: [] };
  const fp = runs[end].fingerprint;
  if (!fp) return { count: 0, fingerprint: null, runIds: [] };
  const runIds = [];
  for (let i = end; i >= 0; i--) {
    const r = runs[i];
    if (!isFailedRun(r) || r.fingerprint !== fp) break;
    runIds.unshift(r.runId);
  }
  // 锚定批次的命令：调用方可对比本次命令是否已换做法（换命令/换脚本 = 已按门禁指引调整，不再拦）
  return { count: runIds.length, fingerprint: fp, runIds, command: runs[end]?.command ?? null };
}

export function approveRoute(archiveDir, { apiSurface = null, fullFlowCtx = null } = {}) {
  const route = loadRoute(archiveDir);
  if (route.status !== 'draft') {
    fail('E_GATE', `只有 draft 路线可以被 approve，当前状态: ${route.status}`);
  }
  enforceSecurityPolicyOnApprove(route, apiSurface);
  enforceDepthPolicyOnApprove(route, apiSurface);
  enforceFullFlowPolicyOnApprove(route, fullFlowCtx);
  route.status = 'approved';
  route.approvedAt = nowIso();
  route.updatedAt = nowIso();
  saveRoute(archiveDir, route);
  return route;
}

export function computeNextActions(route) {
  const acts = [];
  if (route.terminated) {
    acts.push(
      `链路已被阶段 "${route.terminated.byPhase}" 终止（${route.terminated.reason}）。处置路径协议已定死，不询问用户：先 record_triage 归因（code-bug 必划 P0–P3）——test-bug/environment 是我方用例或环境问题，沙箱内修好后 update_phase(该阶段, status="in-progress") 解除终止并重跑；code-bug 是被测产品缺陷，绝不修产品代码：换用合法数据/绕开缺陷路径能让该阶段完成本职验证就调整沙箱内用例后解除终止重跑（缺陷本体安排在对应深度阶段如 negative 如实覆盖），核心流被阻断且无替代路径则直接 finalize_report 如实收尾（outcome=aborted，缺陷置顶）。禁止把"修不修/要不要继续/跳不跳过"编成选项抛给用户。`
    );
  }
  if (route.status === 'draft') {
    acts.push('将路线方案（阶段列表、每阶段范围与准入门禁）展示给用户评审；用户确认后调用 save_route(action="approve")。');
  }
  const inProg = route.phases.find((p) => p.status === 'in-progress');
  const awaiting = route.phases.find((p) => p.status === 'awaiting-approval');
  const nextPending = route.phases.find((p) => p.status === 'pending');
  const allTerminal = route.phases.every((p) => TERMINAL.has(p.status));

  if (awaiting) {
    acts.push(`阶段 "${awaiting.id}" 处于 awaiting-approval：把失败情况如实呈现给用户并等待指示；呈现的选项不得包含"修复被测代码"（只测不修，修复建议写进 triage note 与最终报告即可）。`);
  }
  if (!route.terminated) {
    const blocked = route.phases.find((p) => p.status === 'blocked');
    if (blocked) {
      acts.push(
        `阶段 "${blocked.id}" 被 block（${blocked.reason || '上游失败/跳过传播'}）。上游按失败归因协议处置（test-bug 修沙箱内用例复跑；code-bug 只记录划级、不修被测代码）后 update_phase(phaseId="${blocked.id}", status="in-progress") 显式解锁，处置全程不询问用户。`
      );
    }
  }
  if (inProg) {
    if (route.mode === 'generate-only') {
      acts.push(`阶段 "${inProg.id}"：仅生成模式下不执行测试；用 host 的写文件工具产出用例后 update_phase(status="passed")，或将 execute 类阶段标记 skipped。`);
    } else if (inProg.kind === 'execute') {
      const run = lastRunOf(inProg);
      if (!run) {
        acts.push(`阶段 "${inProg.id}"（execute）：用例就绪后调用 run_tests(phaseId="${inProg.id}")。`);
      } else if (run.status === 'failed' || run.exitCode !== 0 || (run.summary?.failed ?? 0) > 0) {
        const zeroCases = run.exitCode !== 0 && (run.summary?.total ?? 0) === 0;
        if (zeroCases) {
          acts.push(
            `阶段 "${inProg.id}" 执行崩溃且解析到 0 个用例（${run.runId}，exit=${run.exitCode}）：通常是命令/环境问题，查 runDir 下 raw/ 与 console-*.log。` +
              `此状态 environment 归因无法放行 passed——修复后重跑，或将阶段标记 failed / skipped(reason)。`
          );
        } else {
          acts.push(
            `阶段 "${inProg.id}" 上次执行失败（${run.runId}，失败 ${run.summary?.failed ?? '?'} 条）：record_triage(runId="${run.runId}") 逐条归因（test-bug→修用例重跑；code-bug→标记 failed 阻断；environment→修复环境后重跑）。`
          );
        }
      } else {
        acts.push(`阶段 "${inProg.id}" 上次执行通过：update_phase(phaseId="${inProg.id}", status="passed")。`);
      }
    } else {
      acts.push(`阶段 "${inProg.id}"（${inProg.kind}）：完成该阶段的生成/分析工作后 update_phase(status="passed")。`);
    }
  } else if (!allTerminal && nextPending && route.status !== 'draft') {
    acts.push(`update_phase(phaseId="${nextPending.id}", status="in-progress") 开始下一阶段。`);
  }
  if (allTerminal && route.status === 'completed') {
    acts.push('本归档已完成，报告见 final-report.md。有新任务请 init_archive 开新归档。');
  } else if (allTerminal && route.status !== 'completed') {
    acts.push('所有阶段已终态：调用 finalize_report 生成最终汇总报告。');
  }
  return acts;
}

export function findRunResultPath(archiveDir, runId) {
  const runsDir = path.join(archiveDir, 'runs');
  if (!fs.existsSync(runsDir)) {
    fail('E_NOT_FOUND', `归档中没有任何执行记录（${runsDir} 不存在）`);
  }
  for (const name of fs.readdirSync(runsDir)) {
    const resultPath = path.join(runsDir, name, 'result.json');
    if (!fs.existsSync(resultPath)) continue;
    const result = readJson(resultPath);
    if (result?.runId === runId) return { runDir: path.join(runsDir, name), resultPath, result };
  }
  fail('E_NOT_FOUND', `未找到 runId="${runId}" 的执行记录`);
}

export { serializeRunRef, lastRunOf, TERMINAL };
