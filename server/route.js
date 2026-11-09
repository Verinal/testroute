// route.json 契约 + 阶段状态机。确定性门禁全部在工具层强制执行（不依赖 LLM 服从性）。
import path from 'node:path';
import fs from 'node:fs';
import { fail, truncate } from './validate.js';
import { readJson, writeJson, nowIso } from './paths.js';
import { verifyTestGate, acknowledgeTestGate, gateViolationError } from './testgate.js';
import { STAGE_CATALOG } from './stages.js';

export const ROUTE_FILE = 'route.json';

export const ROUTE_MODES = ['generate-only', 'generate-and-execute'];
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
                `请先 record_triage 归因并修复后重跑，或将阶段标记为 failed / skipped(reason)。`
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

// 失败 run 未归因 → 禁止再次执行。没有这道门禁，"triage 里写已修"与"修复实际生效"之间的
// 落差（重跑仍失败）会在归档里不可见——失败 run 必须逐次归因。
export function requireTriageForRerun(phase) {
  const run = lastRunOf(phase);
  if (!run) return;
  const failed = run.status === 'failed' || run.exitCode !== 0 || (run.summary?.failed ?? 0) > 0;
  if (failed && !run.triage) {
    fail(
      'E_TRIAGE_REQUIRED',
      `阶段 "${phase.id}" 上一次执行（${run.runId}）失败且未归因。请先 record_triage(runId="${run.runId}") ` +
        `逐条归因（test-bug→修用例重跑；code-bug→标记 failed 阻断；environment→修复环境后重跑），再重跑本阶段。`
    );
  }
}

// 失败指纹继承：本次失败与上一轮已归因失败的指纹完全一致（同一批用例、同样报错前缀）→
// 自动继承上轮归因并留痕（carriedFrom），宿主不再为同一失败重复交 record_triage 一轮。
// 指纹不同（修复生效/新失败）照旧拦截。这是"逐次归因"的唯一放宽，全程留痕可审计。
export function maybeCarryOverTriage(archiveDir, route, phase) {
  const runs = Array.isArray(phase.runs) ? phase.runs : [];
  const last = runs[runs.length - 1];
  if (!last || last.triage) return null;
  const failed = last.status === 'failed' || last.exitCode !== 0 || (last.summary?.failed ?? 0) > 0;
  if (!failed || !last.fingerprint) return null;
  for (let i = runs.length - 2; i >= 0; i--) {
    const prev = runs[i];
    if (prev.triage && prev.fingerprint && prev.fingerprint === last.fingerprint) {
      last.triage = { ...prev.triage, carriedFrom: prev.runId, carriedAt: nowIso() };
      delete last.triage.updatedAt;
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

export function approveRoute(archiveDir, { apiSurface = null } = {}) {
  const route = loadRoute(archiveDir);
  if (route.status !== 'draft') {
    fail('E_GATE', `只有 draft 路线可以被 approve，当前状态: ${route.status}`);
  }
  enforceSecurityPolicyOnApprove(route, apiSurface);
  enforceDepthPolicyOnApprove(route, apiSurface);
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
      `链路已被阶段 "${route.terminated.byPhase}" 终止（${route.terminated.reason}）。修复后 update_phase(该阶段, status="in-progress") 解除终止并重跑，或废弃本次归档重新开始。`
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
    acts.push(`阶段 "${awaiting.id}" 处于 awaiting-approval：把失败情况与选项呈现给用户，等待指示后 update_phase。`);
  }
  if (!route.terminated) {
    const blocked = route.phases.find((p) => p.status === 'blocked');
    if (blocked) {
      acts.push(
        `阶段 "${blocked.id}" 被 block（${blocked.reason || '上游失败/跳过传播'}）。上游修复后 update_phase(phaseId="${blocked.id}", status="in-progress") 显式解锁。`
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
