// 标准测试阶段目录：按执行链路分层（准入 → 代码 → 集成 → 系统 → 非功能 → 安全 → 验收）。
// 前轻后重：准入层做硬门禁（abort），越往后越重、做成可开关的专项。
export const STAGE_GROUPS = ['准入', '代码', '集成', '系统', '非功能', '安全', '验收'];

// fullFlow = scope="full"（全流程）时的纳入条件，由 fullFlowCoverage（route.js）逐项判定：
//   'always'           恒必需
//   'service'          有可测服务（connectivity targets 已知，或 API 项目）
//   'api'              API 项目（盘点端点 ≥ API_DEPTH_THRESHOLD）
//   'api-multi-module' API 项目且盘点 modules ≥ 2
//   'openapi'          API 盘点来源含 openapi（有机器可读契约）
//   'frontend'         前端项目
//   'git-dirty'        git 有真实源码变更（untracked 不计；排除 test-archives/** 与 provision 台账路径）
//   'authz-needed'     盘点到受保护端点（沿用深度基线的 protectedCount 判定）
//   'never'            永不强制（保持 opt-in，由用户显式开启；resilience/chaos/pentest/canary/dast）
// 条件不满足的阶段自动不要求；数组形式 = 多条件同时满足才要求（如 e2e 需 service+api）。
// dast 标 never：它由深度基线（depthCoverage，按 connectivity targets 判定）+ 安全默认注入强制，不重复设条件。
export const FULL_FLOW_CONDITIONS = [
  'always', 'service', 'api', 'api-multi-module', 'openapi', 'frontend', 'git-dirty', 'authz-needed', 'never',
];

export const STAGE_CATALOG = [
  // ---- 1. 准入/快速校验（最先跑，不通过直接拦停全链路）----
  {
    id: 'connectivity', group: '准入', title: '连通性/健康检查', essence: '能不能连上', fullFlow: 'service',
    defaultKind: 'execute', defaultExecutor: 'health', defaultOnFailure: 'abort', switchable: false,
    note: '端口、服务、health 接口、DNS/网络连通。失败 → 终止全链路，标记服务不可用。',
  },
  {
    id: 'smoke', group: '准入', title: '冒烟测试', essence: '能不能跑主流程', fullFlow: 'service',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'abort', switchable: false,
    note: '核心主流程跑一遍。连通性通过后才跑；冒烟失败 → 版本不可测，终止全链路。',
  },

  // ---- 2. 代码&模块内部（开发侧，提交阶段）----
  {
    id: 'unit', group: '代码', title: '单元测试', essence: '函数/类内部逻辑对不对', fullFlow: 'always',
    defaultKind: 'execute', defaultExecutor: null, defaultOnFailure: 'block', switchable: false,
    note: 'executor 按项目测试框架选 vitest/jest/pytest；都没有时 generic 或规划为 generate。paths/命令必须指向沙箱用例（项目自有测试只读参考，不执行）。',
  },
  {
    id: 'sast', group: '代码', title: '静态代码扫描 SAST', essence: '源码缺陷与不安全写法', fullFlow: 'always',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: false,
    note: '不跑服务，直接扫源码：硬编码密钥、不安全函数、语法缺陷。发现项默认只报告不阻断。',
  },

  // ---- 3. 模块之间、接口联调（集成层）----
  {
    id: 'integration', group: '集成', title: '集成测试', essence: '模块/服务之间对不对', fullFlow: 'api-multi-module',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'block', switchable: false,
    note: '接口和 DB、第三方依赖交互；参数传递、返回结构、事务、跨服务调用。',
  },
  {
    id: 'contract', group: '集成', title: '契约测试', essence: '接口契约是否一致', fullFlow: 'openapi',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'block', switchable: false,
    note: 'OpenAPI/schema 比对，防止接口改了消费端崩。',
  },
  {
    id: 'api-functional', group: '集成', title: '接口功能测试（API 黑盒）', essence: '每个接口正常参数返回对不对', fullFlow: 'api',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'block', switchable: false,
    note: '必填/可选参数、正常返回结构；用例由 LLM 生成后经 generic/pytest 执行。',
  },

  // ---- 4. 完整业务链路（系统级）----
  {
    id: 'e2e', group: '系统', title: '系统测试 / E2E', essence: '业务流程能不能走通', fullFlow: ['service', 'api'],
    defaultKind: 'execute', defaultExecutor: 'e2e', defaultOnFailure: 'block', switchable: false,
    note: '声明式 HTTP 步骤（内置执行器）：登录→取 token→业务操作→断言，steps 写进路线供批准评审。无服务可跑时降级为 planning。',
  },
  {
    id: 'browser-e2e', group: '系统', title: '浏览器 E2E（真实点击）', essence: '真实浏览器里业务流程走不走得通', fullFlow: 'frontend',
    defaultKind: 'execute', defaultExecutor: 'playwright', defaultOnFailure: 'continue', switchable: true,
    note: '前端项目默认建议开启（save_route 返回 browserE2eSuggested 提示），用户可裁掉但须把理由写进 notes 留痕。生成用例前必须 browser_probe 抓真实 DOM；证据链由工具强制注入（evidence=full：wrapper config 强制 use.trace/video/screenshot=on + 命令补 --trace on/--output，勿删）；用例内只需写关键步骤 page.screenshot 逐步截图（落 TESTROUTE_ARTIFACTS_DIR），trace.zip/video.webm 进归档可重播；降级/关证据须 evidence+evidenceReason 留痕（off 仅 .testfile/用户明写才允许）。浏览器按「编辑器内置 CDP > 系统 Chrome/Edge > chromium 缓存 > 下载（永远最后）」优先级获取，不随包下载。默认 continue：失败只记录归因划级、下游照跑，修不修由维护者看报告决定，运行中不打断询问。scope=full 时有最低流程级用例数门禁（browserE2eMinCases：每条覆盖一个完整业务流，页面走查最多算 1 条）。',
  },
  {
    id: 'boundary', group: '系统', title: '边界值测试', essence: '极值下对不对', fullFlow: 'api',
    defaultKind: 'execute', defaultExecutor: null, defaultOnFailure: 'block', switchable: false,
    note: '0、空串、超大长度、最大/最小值、空数组；用例由 LLM 生成。',
  },
  {
    id: 'negative', group: '系统', title: '异常输入测试（负面用例）', essence: '非法输入下稳不稳', fullFlow: 'api',
    defaultKind: 'execute', defaultExecutor: null, defaultOnFailure: 'block', switchable: false,
    note: '非法格式、乱码、错误类型参数。',
  },
  {
    id: 'regression', group: '系统', title: '回归测试', essence: '老功能有没有被改坏', fullFlow: 'git-dirty',
    defaultKind: 'execute', defaultExecutor: null, defaultOnFailure: 'block', switchable: false,
    note: 'git diff 驱动：有变更时触发。用例一律在沙箱新生成（项目已有测试只读参考，不执行）。',
  },

  // ---- 5. 非功能（可选开关的专项）----
  { id: 'load', group: '非功能', title: '负载测试', essence: '预期并发下表现', fullFlow: 'service', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: 'k6/JMeter 等；有可测服务时全流程必纳（scope=full）。' },
  { id: 'stress', group: '非功能', title: '压力测试', essence: '压到临界点看何时崩', fullFlow: 'service', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: '有可测服务时全流程必纳（scope=full）。' },
  { id: 'soak', group: '非功能', title: '稳定性/耐久测试', essence: '长时间跑有无泄漏', fullFlow: 'service', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: '内存/连接泄漏；有可测服务时全流程必纳（scope=full），耗时长可放宽强度。' },
  { id: 'resilience', group: '非功能', title: '故障恢复测试', essence: '杀进程断库能否恢复', fullFlow: 'never', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: '自动恢复、数据不丢。' },
  { id: 'chaos', group: '非功能', title: '混沌测试', essence: '随机故障下是否可控', fullFlow: 'never', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: '丢包/延迟/杀实例注入。' },
  { id: 'compatibility', group: '非功能', title: '兼容性测试', essence: '多环境表现一致', fullFlow: 'frontend', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: '多版本/浏览器/客户端/弱网；前端项目全流程必纳（scope=full）。' },

  // ---- 6. 安全（从基础权限 → 漏洞挖掘；须用户开启且目标已授权）----
  {
    id: 'authz', group: '安全', title: '权限测试（鉴权/授权/越权）', essence: '该进的进不来、不该进的进不去', fullFlow: 'authz-needed',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'block', switchable: true,
    note: '登录、token、角色权限、水平/垂直越权。安全段中唯一默认 block：越权是硬缺陷。',
  },
  { id: 'sca', group: '安全', title: '依赖扫描 SCA', essence: '第三方包有无已知漏洞', fullFlow: 'always', defaultKind: 'execute', defaultExecutor: 'sca', defaultOnFailure: 'continue', switchable: true, note: 'npm audit / pip-audit，内置执行器。' },
  { id: 'dast', group: '安全', title: '动态安全探测 DAST', essence: '跑起来的服务有无 OWASP 常见漏洞', fullFlow: 'never', defaultKind: 'execute', defaultExecutor: 'security-probe', defaultOnFailure: 'continue', switchable: true, note: '内置零依赖探测器，对运行中服务按盘点端点自动全量探测：未认证访问/伪造凭据/NoSQL·SQL 注入/错误信息泄漏/安全响应头/CORS/限流防刷，每端点一案。可用 config: { baseUrl, token?, credentials?, skipProbes? } 调整；结论交 triage 划级。强制条件在深度基线（有 connectivity targets 即要求），不在 fullFlow 重复设条件。' },
  { id: 'secrets', group: '安全', title: '密钥/敏感信息扫描', essence: '有没有泄露密钥与敏感数据', fullFlow: 'always', defaultKind: 'execute', defaultExecutor: 'secrets', defaultOnFailure: 'continue', switchable: true, note: '内置执行器：扫源码中的密钥/token 模式与被 git 跟踪的 .env；命中自动打码。反爬/限流类用例见 authz/business-logic。' },
  {
    id: 'business-logic', group: '安全', title: '业务逻辑漏洞测试', essence: '能不能绕开业务规则', fullFlow: 'api',
    defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true,
    note: '重复下单、刷积分、篡改价格、绕过审批；LLM 最擅长生成这类用例。',
  },
  { id: 'pentest', group: '安全', title: '渗透测试（高阶）', essence: '组合利用、横向移动、提权', fullFlow: 'never', defaultKind: 'execute', defaultExecutor: 'generic', defaultOnFailure: 'continue', switchable: true, note: '自动化仅覆盖子集，结论必须注明需人工渗透补充。' },

  // ---- 7. 验收（最后一关，人工）----
  { id: 'uat', group: '验收', title: 'UAT 用户验收测试', essence: '业务方验证符合需求', fullFlow: 'always', defaultKind: 'manual', defaultExecutor: null, defaultOnFailure: 'continue', switchable: false, note: 'LLM 产出验收清单到 manual-cases/，业务方执行。scope=full 缺省自动注入（manual 阶段，无执行器）。' },
  { id: 'canary', group: '验收', title: '金丝雀/灰度验证', essence: '少量真实流量观察', fullFlow: 'never', defaultKind: 'manual', defaultExecutor: null, defaultOnFailure: 'continue', switchable: false, note: '人工/运维流程，LLM 输出灰度检查单。' },
];

const BY_ID = new Map(STAGE_CATALOG.map((s) => [s.id, s]));

export function knownStageIds() {
  return [...BY_ID.keys()];
}

export function getStage(id) {
  return BY_ID.get(id) || null;
}
