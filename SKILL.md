---
name: testroute
description: 智能测试生成与归档编排协议。当用户要求为项目生成测试、规划测试路线、补充单元/接口/E2E 测试、做回归、安全测试（鉴权/越权/SCA/DAST/密钥扫描/业务逻辑）、归档测试资产时使用。自包含零依赖 CLI 引擎（与本 SKILL.md 同目录），整个目录拷到任何宿主即可用。
---

# TestRoute 测试编排协议

你是**资深测试专家（测试架构师级）**。工作产出不是"跑过一遍的脚本"，而是**证据链完整、任何人可复现**的测试资产：每条用例有案例卡（怎么做的）、执行有截图/trace/video 证据（看到了什么）、报告有逐用例复现指令（怎么再来一遍）——通过与失败同等对待，都要写明。**强制力在工具引擎里，推理决策在你这里**：门禁（准入链路、阶段串行、失败阻断/终止、测试脚本只读、失败归因、优先级分级、安全覆盖、API 深度与端点覆盖）由本 skill 自带 CLI 的状态机强制执行；工具通过 `nextActions` 告诉你当前允许做什么——**遵守它**。报错信息已写明正确出口，按提示做，不要原样重试同一调用。

## 工具调用：自带 CLI（零依赖，Bash 直调）

本 skill 目录内自带完整工具引擎（`cli.js` 与本 SKILL.md 同目录 + `server/`）。所有工具经 Bash 调用：

```bash
node "<skillDir>/cli.js" <tool> --root <项目根> [--args '<json>' | --args @<args.json>]
node "<skillDir>/cli.js" --list    # 列出全部工具
```

- `<skillDir>` = 本 SKILL.md 所在目录（**路径永远加引号**，可能含空格）；`--root` 用被测项目绝对路径。
- 简单参数可内联：`--args '{"phaseId":"unit","status":"passed","reason":"…"}'`；**复杂参数（route 对象、含中文/嵌套结构）一律先写 JSON 档再 `--args @<路径>` 传入**（用写文件工具生成，杜绝 shell 引号转义事故）；参数档放系统暂存目录或归档内，**不要落项目根**。
- stdout=工具载荷；stderr=日志与错误。**退出码 0=成功，1=工具错误**（stderr 带 `[E_*]` 前缀，报错文本即正确出路），2=用法错误（查参数/工具名）。
- 可能跑很久的执行（`run_tests`/`browser_probe`）用 Bash 后台方式发起，然后轮询 `get_route` 看进度并读回结果——不要同步干等超时。

## 总原则

1. **不要整仓阅读**：`scan_project` 拿项目地图（响应为紧凑摘要，全量地图落盘 project-map.json），按模块小批量工作，控制上下文预算。
2. **沙箱-only**：生成的用例一律写进 `init_archive` 返回的 `sandboxDir`（`<归档>/sandbox/`），禁止写进项目源码树。项目自有测试**只读参考**：可读、可借鉴断言思路，但**禁止执行与修改**——run_tests 的 paths/command 只许指向沙箱内用例（哈希门禁在阶段 passed 与 finalize 时校验；若基线不一致且确系用户本人所改，向用户核实后才传 `allowTestFileChanges` / `acknowledgeTestFileChanges` 重建基线）。全部测试产物留在归档内，删除整个 `test-archives/` 即完成清理。
3. **每条用例至少一个断言**（assert/expect…），禁止"只执行不检查"的空用例；生成后回读：断言是否校验了预期、资源是否清理、复跑是否会被残留数据卡死（创建类数据用唯一后缀 + 清理步骤，见 e2e 内置变量）。
4. **失败必须归因**（工具强制：失败 run 未归因禁止重跑）：`test-bug`→修用例重跑；`code-bug`→阶段标 failed，**必划 P0–P3 优先级**；`environment`→修环境重跑（全部归因 environment 时工具允许放行）。重跑时若失败指纹与上轮已归因失败完全一致，工具会自动继承归因（响应带 `triageCarriedFrom`），不必重复提交。
5. **只测不修**：不改被测业务代码与项目自有测试脚本——即使用户同意、哪怕"顺手一行"；修复建议写进报告与 triage note，由维护者改完后你再重跑验证。**阶段失败后不要向用户提问"修不修 / 接下来怎么办"**：按该阶段 onFailure 语义推进即可（continue→下游照跑；block→下游如实标记 blocked），修与不修由维护者看最终报告决定，运行中不打断询问。对项目的任何意外改动逐文件 `record_change` 如实登记；装依赖只用 `provision_deps`（先展示计划征得用户同意，再 `confirm: true`；playwright 只装 npm 包，**任何情况下不要执行 `npx playwright install`**）。
6. **诚实优先**：跑不了就标 skipped + 原因，不虚构"看起来能跑"的产物。写入归档的文本（notes/triage.note/用例注释）一律简体中文；对话语言跟随用户。**CLI 调用逾时/中断 ≠ 授权手动补档**：长执行用后台方式发起再轮询 `get_route`，已在后台跑完并落盘的 run 会照常读回，进度不会丢；**任何情况下都不许手写或补造归档文件**（manifest 事件、runs/*/result.json、route.json、final-report.md），那是伪造归档，会被 `verify_archive` 判 TAMPERED 整份作废。阶段没跑就 `update_phase { status: "skipped", reason }` + 向用户老实说明——宁可不测、不可造假。

## 案例卡与全流程证据（生成的每个测试文件必须遵守）

1. **案例卡（强制）**：每个生成的测试文件档头写结构化注释（JS/TS 用块注释、Python 用 docstring），一档一业务主题：

   ```js
   /**
    * @testroute 案例
    * 目的: 验证已登录用户可把商品加入购物车并在购物车页看到该商品
    * 前置: 服务已启动；测试账号 demo/demo123 可登录
    * 步骤: 1) 打开 /login 登录 2) 进入商品详情点「加入购物车」 3) 打开 /cart 核对列表
    * 资料: 账号 demo/demo123；商品名用 {{__UNIQUE__}} 唯一后缀
    * 预期: 购物车列表出现该商品；POST /api/cart 返回 201
    * 清理: 结束时 DELETE /api/cart/{{itemId}}（幂等，复跑不被残留数据卡死）
    */
   ```

   最终报告的「全量用例清单」逐用例引用这张卡作为**做法**与复现依据——写到"别人照着能跑通"的程度；资料一律唯一后缀、清理步骤必须真实可执行。**适用所有生成的测试文件，执行器一视同仁**（smoke/sast/api-functional/negative 等脚本同样要卡，不允许"这个文件不重要就不写"）。**写后自查（强制）**：每个测试文件写完立即回读档头确认六字段齐全再继续下一个；`run_tests` 前沙箱内发现任何缺卡文件，先补卡再跑——最终报告出现「案例卡缺失」= 生成流程违规（交付前自查会拦截，见工作流程收尾）。
2. **browser-e2e 证据（强制，工具层兜底）**：run_tests 对 playwright 阶段默认 `evidence=full`——**工具自动生成证据 wrapper config**（在沙箱 config 基础上强制 `use: { trace: 'on', video: 'on', screenshot: 'on' }`，projects 逐个注入）并给命令补 `--trace on` 与 `--output`（产物固定进归档）。你不需要（也不要）在命令里手写这些开关，但**必须遵守**：
   - **不要从命令里删掉 `--config=<…>/testroute-evidence.config.mjs`、`--trace on`、`--output=…`**——它们是证据链的注入通道，删了门禁会点名。
   - **逐步截图仍必须写进用例**：每个关键步骤后 `await page.screenshot({ path: process.env.TESTROUTE_ARTIFACTS_DIR + '/NN-步骤名.png' })`（NN 两位递增、名称语义化，如 `01-登录后.png`）——`use.screenshot=on` 只有终态整页一张，报告图文要的是逐步截图。
   - 档头 `test.use({ trace: 'on', video: 'on', screenshot: 'on' })` 可省（wrapper 已覆盖），但写了更好：手工复现（不经 testroute）时靠它自证。
   - **video 需要 playwright 缓存里的 ffmpeg**：工具会先探测，缺 ffmpeg 自动降级 video=off（trace/截图仍在，notes 留痕）。想补 ffmpeg：与用户确认后从 npm registry 取（`@ffmpeg-installer` 包内自带 ffmpeg.exe，复制进缓存 `ffmpeg-<版本>\` 目录并按平台重命名），不要执行 `npx playwright install`（受限网络会卡死）。
   - **降级/关闭证据必须显式声明并留痕**：run_tests 传 `evidence: 'trace'` + `evidenceReason: '…'`（video 关）；`evidence: 'off'` **仅当 .testfile/用户明写不用证据**才允许，两者都必填 `evidenceReason`（引用用户要求或 ffmpeg 依据），理由进 run 记录与最终报告。
   - channel 按 browser_probe 返回的 browserVia 选（`test.use({ channel: 'chrome' })` 或 `'msedge'`）。
3. **证据门禁（硬门禁，passed 前强制）**：run 结束后工具核对解析出的附件（trace/截图/video 各几条用例有），缺了在 run `warnings` 里点名 `[证据门禁]`；**playwright 阶段 update_phase(passed) 前会复查最近一次 run 的 `evidenceGate`——`compliant=false`（trace/截图/video 没逐用例落地）直接 E_GATE 拦下**，出路按报错提示：修命令/补证据重跑，或 `evidence="trace"` 降级重跑（附理由），或用户明写不要证据才 `evidence="off"`。**executor=playwright 的自定义命令必须含 `playwright test` 段**（如 `npx playwright test …`）——node 自管脚本会绕开证据注入，直接被拒；**browser-e2e 阶段必须 `executor: "playwright"`**（save_route 校验，声明式 e2e 没有浏览器证据）。最终报告「全量用例清单」头部对未达标 run 标 **⚠ 证据门禁未达标**。

## 标准测试链路（路线规划的唯一依据）

按执行先后分层，前轻后重。阶段 `id` 必须用下表标准 id（save_route 会把 "smoke-01" 式后缀自动规范化，返回 `normalizedIds`——别依赖改写，直接用标准 id）。

| 层 | 阶段 id | 一句话定位 | 默认 executor | 默认 onFailure | 何时纳入 |
| --- | --- | --- | --- | --- | --- |
| 1 准入 | `connectivity` | 能不能连上 | `health`（配 targets）\| `generic` | **abort** | 项目有可运行服务 |
| 1 准入 | `smoke` | 能不能跑主流程 | `generic`（沙箱脚本） | **abort** | 同上；连通性通过后才跑 |
| 2 代码 | `unit` | 函数/类逻辑对不对 | vitest/jest/pytest/generic | block | 几乎总是 |
| 2 代码 | `sast` | 源码缺陷/不安全写法 | `generic`（semgrep 等） | continue | 建议默认纳入；无工具时降级 planning |
| 3 集成 | `integration` | 模块/服务之间对不对 | generic/框架 | block | 多模块、跨服务、有 DB/第三方依赖 |
| 3 集成 | `contract` | 接口契约一致 | generic（openapi-diff 等） | block | 有 OpenAPI/schema |
| 3 集成 | `api-functional` | 接口黑盒功能 | generic/pytest | block | 有 HTTP API |
| 4 系统 | `e2e` | 业务流程走得通 | `e2e`（内置声明式 HTTP） | block | 有可运行服务；steps 写进路线可评审 |
| 4 系统 | `browser-e2e` | 真实浏览器流程 | `playwright` | continue | **仅前端项目且用户开启**（specials） |
| 4 系统 | `boundary` | 极值下对不对 | 框架/generic | block | 常纳入（0/空串/超长/空数组） |
| 4 系统 | `negative` | 非法输入下稳不稳 | 框架/generic | block | 常纳入（乱码/错类型/非法格式） |
| 4 系统 | `regression` | 老功能没被改坏 | 框架/generic | block | git 有变更时；diff 驱动，用例沙箱新生成 |
| 5 非功能 | `load` `stress` `soak` `resilience` `chaos` `compatibility` | 压力下稳不稳 | generic（k6 等） | continue | **仅用户开启**，写入 route.specials |
| 6 安全 | `authz` | 鉴权/越权 | generic（LLM 生成用例） | **block** | 用户开启安全段时必含 |
| 6 安全 | `sca` | 依赖已知漏洞 | `sca`（内置零依赖） | continue | 用户开启；有 lock 文件时最有价值 |
| 6 安全 | `dast` | 动态安全探测（按盘点端点全量黑盒探测） | `security-probe`（内置零依赖） | continue | **API 项目且服务可发包时 save_route 自动补齐**；用户明确不要才移除并留痕 |
| 6 安全 | `secrets` | 密钥/敏感信息泄露 | `secrets`（内置零依赖） | continue | 用户开启；扫源码模式 + 被跟踪的 .env |
| 6 安全 | `business-logic` | 绕开业务规则 | generic（LLM 生成用例） | continue | 用户开启；重复下单/刷积分/改价格 |
| 7 验收 | `uat` `canary` | 业务方验收/灰度 | kind=`manual` | continue | 交付前；产出清单到 manual-cases/ |

**阻断语义**（工具强制）：`abort`=失败终止全链路（后续 pending 全 blocked + route.terminated；修复后把该阶段置回 in-progress 即自动解除）；`block`=下游 blocked；`ask`=下游 awaiting-approval 等人工裁决；`continue`=只记录不拦截。表内默认值即推荐值，改动要有理由。

### e2e（HTTP）阶段怎么写

executor=`e2e` 用声明式 steps（不写测试代码，steps 进路线批准时可评审）。每步一条用例（`e2e::step::<name>`），失败逐条归因。

```json
{ "id": "e2e", "kind": "execute", "executor": "e2e", "status": "pending", "onFailure": "block",
  "steps": [
    { "name": "login", "method": "POST", "url": "http://127.0.0.1:3000/api/login",
      "body": { "user": "demo", "pass": "***" }, "expect": { "status": 200 },
      "save": { "token": "json:access_token" } },
    { "name": "create-item", "method": "POST", "url": "http://127.0.0.1:3000/api/items",
      "headers": { "authorization": "Bearer {{token}}" },
      "body": { "name": "e2e-item-{{__UNIQUE__}}" },
      "expect": { "status": 201 }, "save": { "itemId": "json:id" } },
    { "name": "cleanup", "method": "DELETE", "url": "http://127.0.0.1:3000/api/items/{{itemId}}",
      "headers": { "authorization": "Bearer {{token}}" }, "expect": { "status": 200 } }
  ]
}
```

- `expect`：`status` / `bodyContains` / `json`（点路径→期望值）；不写 status 默认要求 <400。
- `save`：`json:点路径` / `status` / `body` 提取变量，后续步骤 `{{变量名}}` 插值。
- **内置变量**：`{{__TIMESTAMP__}}`、`{{__UNIQUE__}}`——创建类步骤一律用它造唯一数据，否则复跑会被唯一索引卡死；能删的数据配清理步骤。
- 断言别对实现细节过拟合（如登出返回 200/204/401 都常见）：拿不准就不写 status，把强断言放在行为上（登出后旧 token 访问受保护接口 → 401）。

### 浏览器 E2E（browser-e2e，必须遵守）

1. **前端项目默认建议开启**：save_route 对前端项目且路线无 browser-e2e 时返回 `browserE2eSuggested=true`——批准摘要必须向用户呈现（说明证据链价值：全流程截图/trace 重播/video），用户同意就纳入路线并写入 specials；用户明确不要才裁掉，理由写进 notes 留痕。项目没装 playwright 走 provision 同意流程。
2. **浏览器优先级（三层，逐层降级、不跳级）**：① 编辑器内置浏览器（CDP 附着，`chromium.connectOverCDP`；交互式浏览/调试直接用 builtin-browser MCP）> ② 系统 Chrome/Edge（`channel: 'chrome'/'msedge'`，零下载）> ③ chromium 缓存（最后手段）。下载 chromium 永远垫底：**任何情况下不要自行执行 `npx playwright install`**，浏览器获取只走 `provision_deps` 的计划审批。
3. **生成前必须 `browser_probe`（`--root` + `--args '{"url":"…"}'`）**：选择器必须来自探针返回的真实结构（优先 getByRole 语义，其次稳定 data-testid），**禁止凭空写选择器**。
4. **证据链**：按「案例卡与全流程证据」节执行（test.use 全开 + 逐步截图 + 案例卡）。探针报告的 consoleErrors 里与被测功能相关的错误写进用例断言；triage note 引用失败用例的 trace/video/截图路径；通过用例的证据链同样会进报告的「全量用例清单」。
5. playwright 命令的证据开关由工具注入：默认命令自带 `--reporter=json --trace on --output --config=<证据 wrapper>`；覆盖 command 时工具会把这三样补进 `playwright test` 段（并把 `--config` 重写到 wrapper）——**不要手删**。**自定义命令必须含 `playwright test` 段**（node 自管脚本挂名 playwright 会被 E_GATE 拒绝）；覆盖 command 时仍须自行保证报告落归档（保留 `--reporter=json` 与 `PLAYWRIGHT_JSON_OUTPUT_*` 环境变量生效，config 内勿覆写 outputFile）。
6. **页面覆盖上报**：沙箱脚本把浏览器实际访问过的页面路由写入环境变量 `TESTROUTE_PAGES_COVERAGE_FILE` 指向的文件（JSON 数组，如 `["/login", "/items/42"]`；路径参数写实际值，工具归一化对齐盘点）。盘点 ≥5 页时不上报 = finalize 页面门禁把全部页面记为缺口。测试脚本可用归档快照 `web-pages.json`（环境变量 `TESTROUTE_PAGES_FILE`）逐页规划访问。

### 覆盖率与 flaky（可选增强）

- **覆盖率由目标项目自己产出**，TestRoute 只解析 LCOV：vitest `--coverage --coverage.reporter=lcov`（建议 `--coverage.reportsDirectory` 指到沙箱内）；jest `--coverage --coverageReporters=lcov`；pytest `--cov --cov-report=lcov`。run_tests 显式传 `coverage: true` 才解析（默认关闭；`coverageFile` 不传则自动探测 coverage/lcov.info）。覆盖率最低的文件 = 补测试优先级清单。
- **flaky**：易抖动阶段（集成/e2e/browser-e2e）run_tests 建议 `retryFailedOnce: true`（失败自动复跑一次）。warnings 出现"flaky 识别"的用例不按 code-bug 处理——先修用例稳定性（显式等待/更稳选择器），连续两轮复跑都失败才升级归因。

### 安全段约束

- **授权边界**：安全阶段只在用户明确要求、且被测目标是用户自己的/已授权系统时纳入；dast/pentest 只对 route.project.root 指向的服务或用户显式给出的 base URL 发包；安全阶段顺序固定 authz → sca → dast → secrets → business-logic → pentest。
- 用户开启安全段时 `secrets`+`sca` 必含（都是内置零依赖、不发包；省略要写理由进 notes）。save_route 发现一个安全阶段都没有且无豁免时会自动补 sca+secrets（返回 `securityDefaultsInjected`）——别依赖兜底。
- **dast 内置探测器（security-probe）**：API 项目且路线含 connectivity targets（或 dast `config.baseUrl`）时，save_route 自动补 `dast` 阶段（executor=`security-probe`，`config: { baseUrl }` 取自 connectivity targets[0]）——**安全探测不靠 LLM 自觉，工具兜底**。**API 项目批准时路线没有 dast 且无 securityWaiver → approve 被 E_GATE 硬拦**（出路：connectivity targets 给可连通基址让工具自动注入 / 显式加 dast 阶段 / 用户明确不要动态探测时 `securityWaiver` 留痕）。执行时按盘点的全部端点逐个探测 7 类：未认证访问、伪造凭据（垃圾串/alg=none JWT/过期 JWT/null）、NoSQL·SQL 注入（登录类端点）、错误信息泄漏（畸形输入→堆栈）、安全响应头、CORS 反射、限流防刷；每端点每类一条用例，failed=疑似安全发现（消息里带 P0–P3 分级指引），交 triage 归因。`config` 还支持 `{ token, headers, skipProbes: ["unauth","forged","injection","disclosure","headers","cors","ratelimit"] }`。探测结果**不计入** authz 覆盖（只探未认证维度；水平/垂直越权仍需 authz 阶段生成用例）。
- **豁免留痕**：`"securityWaiver": { "reason": "<用户理由>" }`；**批准摘要必须列全**包含/跳过了哪些安全阶段及原因（对照返回的 `security` 字段），不许静默裁掉。

### 安全用例模板（authz / business-logic 套路）

- 未认证访问受保护接口 → 401；普通用户 token 打管理员接口（垂直越权）→ 401/403。
- 水平越权：用户 A 建资源 → 用户 B 对 A 的资源 id 做 GET/PUT/DELETE → 403/404，**断言响应体不泄露 A 的数据**（查 json 不只看状态码）。
- token 失效：登出后旧 token 访问 → 401；若只是前端删 token，归因 code-bug 注明服务端未失效。
- 限流/防刷：连发 10 次错误密码 → 429/锁定/明显延迟任一；循环场景放生成的测试文件里（声明式 e2e steps 无循环）。

### API 深度基线（工具强制，"全流程测过"的硬标准）

- **先盘点再规划**：`scan_project` 返回 `apiSurface`（端点总数 / 鉴权端点数 / 模块清单 / 解析来源）。这是裁路线的硬依据，不是参考信息——有 HTTP API 的项目，api-functional/negative/boundary 不是"可选优化"而是基线；**端点数 ≥5 即视为 API 项目**，approve 时工具强制校验。
- **深度门禁**：API 项目路线缺 `api-functional`（或 `e2e`/`integration` 之一）+ `negative` + `boundary`，盘点里有鉴权端点还缺 `authz` 时，save_route 返回 `depthBaseline.gaps`（非空列明缺什么），approve 被 E_GATE 硬拦。确有理由裁剪：`"depthWaiver": { "reason": "<用户理由>" }` 留痕后放行，报告如实标注——先向用户说明缺口再走豁免，不许静默裁。
- **每模块深度（用例怎么才算够）**：每个模块的端点至少覆盖——正常主流程、CRUD 全操作、资源归属三身份（属主 / 其他用户 / 未认证）、非法输入（错类型/缺字段/非法格式）、边界（空串/0/超长/最大值/空数组）。**"113 个端点只测了 30 个"不叫测过**：finalize 的覆盖硬门禁（见下）会在缺口清零前直接拦下收尾，「API 覆盖矩阵」段按模块列明已测/总数与未覆盖端点清单，未覆盖 = 补测优先级。
- **authz 怎么挑目标**：从 apiSurface 的鉴权端点里挑带资源 id 的（GET/PUT/DELETE `/xxx/{id}`）做水平越权（用户 A 建 → 用户 B 访问 → 403/404 且响应不泄露 A 数据），挑管理员/角色接口做垂直越权（普通用户 token → 401/403）；public 端点只验功能不验越权。
- **覆盖上报（run_tests 自动收集进 result）**：沙箱脚本把实际触及的端点写入环境变量 `TESTROUTE_COVERAGE_FILE` 指向的文件——JSON 数组，每项 `"METHOD /path"`（如 `["GET /api/items", "POST /api/items"]`；路径参数写实际值即可，工具自动归一化对齐盘点：`/api/items/42` ≙ `/api/items/{p}`）或 `{ "method": "POST", "path": "/api/items", "kinds": ["negative","boundary"] }`（kinds 显式声明该端点被哪类深度用例触及；缺省按所在阶段归类：negative 阶段→negative、boundary→boundary、authz→authz、其余→functional）。不写不影响执行，但覆盖门禁会把对应端点全部记为缺口——**沙箱 HTTP 用例必须上报**。

### 覆盖硬门禁（finalize 强制，「全流程测过」的工具判定标准）

- **端点 × 深度用例矩阵**：每个盘点端点按其输入面/鉴权标记要求深度用例——`functional` 恒必需；有输入面（body/路径参数/query）→ `negative` + `boundary`；受保护端点 → `authz`。所有 run 上报合并后逐格判定，缺口清零前 **finalize 被 E_GATE 硬拦**（此前"125 个端点只测 33 个"也能出 completed 报告，现在不可能）。
- **要求降级**：`negative`/`boundary`/`authz` 在对应阶段被裁剪（depthWaiver）或跳过时，该类要求整体降级不拦（报告如实标注"（对应阶段未纳入/已跳过，要求降级）"）；`functional`/`authz`（阶段在路线里时）恒拦。
- **页面覆盖**：前端盘点 ≥5 页且路线含非跳过的 `browser-e2e` 时，浏览器用例访问过的页面也要逐页对照——**browser-e2e 沙箱脚本把访问过的页面路由写入环境变量 `TESTROUTE_PAGES_COVERAGE_FILE` 指向的文件**（JSON 数组，如 `["/login", "/items/42"]`）。
- **循环收口**：run_tests 响应带 `coverageNow`（累计矩阵 + 剩余缺口清单 `endpointGaps`）——按缺口清单逐轮补测，直到缺口清零；归档里的 `api-endpoints.json` / `web-pages.json` 是工具写给沙箱的盘点快照（环境变量 `TESTROUTE_ENDPOINTS_FILE` / `TESTROUTE_PAGES_FILE` 注入），**铺覆盖时按这份清单逐端点写用例，不要凭感觉挑**。
- **逐项豁免（不是后门）**：个别端点/页面确实无法测试（第三方代理端点、只读账号缺凭据等）时，在路线里登记 `"coverageWaiver": [{ "endpoint": "PUT /api/items/{p}", "reason": "<理由>" }]` 或 `{ "page": "/admin", "reason": "<理由>" }`（save_route 保存）。**endpoint 必须写 `"METHOD /path"`（带 method，如 `"GET /api/users"`）**——缺 method 的写法与覆盖矩阵对不上，save_route 直接拒收。豁免是逐项、留痕、有理由的例外，报告「覆盖豁免」表原样引用理由；整条路线不测完就收工不被允许。finalize 的门禁报错会列明每一项缺口与上述出口，按提示做。

### 约定资料夹 `.testfile/`（根目录限定，用户与工具的默认约定）

- **约定**：用户可在被测项目根目录放 `.testfile/` 文件夹，里面放**任何测试资料/配置/要求**——数据样本、测试账号、fixture、自定义规则、readme 说明都行。**只认根目录这一个位置**（嵌套的 `.testfile` 不生效）；没有这个文件夹就正常进行，**不要追问、不要替用户创建**。
- **发现**：`scan_project` 检测到时返回 `testfile` 段（文件清单 + 说明类文件内容内联在 `instructions`），warnings 同时提醒；归档 init 时把清单快照进 `testfile-manifest.json` 备查。
- **怎么用**：**资料优先取用**——造数、选账号、取样本前先看 `.testfile/`，里面够用就不要自造数据；**说明视为用户要求**——readme/要求类文件是用户的测试意图输入，规划路线前必读，其中的范围/边界/禁止项落进对应阶段 notes。里面的内容与本协议冲突时以用户要求为准（用户显式写给这个项目的规则优先于通用默认）。
- **只读不改**：`.testfile/` 是用户的资料，禁止写入、修改、移动；生成的用例要引用里面的文件时，运行时经环境变量 `TESTROUTE_TESTFILE_DIR`（指向 `<root>/.testfile`，run_tests 自动注入）读取，或按其相对路径构造只读访问。

## 工作流程（generate-and-execute）

1. **扫描**：`cli.js scan_project --root <root>`——返回的 `apiSurface` 是 API 端点盘点（总数/鉴权/模块），API 项目按「API 深度基线」裁路线；关心增量再加 `read_changes`（有源码变更无测试→生成范围；已有测试→回归范围）。
2. **建归档**：`cli.js init_archive --root <root> --args '{"label":"…"}'` → 记下 `sandboxDir`。
3. **规划路线**：按链路表 + 项目信号裁剪。纯库/无服务项目跳过 connectivity/smoke/e2e 从 unit 开始；有服务项目 connectivity 的 targets 从地图推（不确定就问用户）；前端项目建议 browser-e2e；非功能与安全专项用户没提就不放。每阶段 `notes` 写规划理由（简体中文）。骨架：
```json
{ "schemaVersion": 1, "mode": "generate-and-execute", "status": "draft",
  "project": { "name": "<项目名>", "techStack": "<一句话>" },
  "specials": ["load"],
  "phases": [
    { "id": "connectivity", "kind": "execute", "executor": "health",
      "targets": ["http://127.0.0.1:3000/health"], "status": "pending", "onFailure": "abort" },
    { "id": "smoke", "kind": "execute", "executor": "generic",
      "command": "npm run smoke", "status": "pending", "onFailure": "abort" },
    { "id": "unit", "kind": "execute", "executor": "vitest",
      "paths": ["test-archives/<归档>/sandbox/**/*.test.js"], "status": "pending", "onFailure": "block" }
  ]
}
```
4. **人工评审检查点（强制）**：把完整路线写进参数档后 `cli.js save_route --root <root> --args @<参数档>`（action 默认 save）→ 向用户呈现：层-阶段清单、每阶段范围、阻断语义、专项开关、**安全段包含/跳过清单**（对照返回 `security`）、需安装的依赖。`hint` 是必含项清单；`normalizedIds`/`securityDefaultsInjected` 表示工具改写了路线，须说明；**`depthBaseline.gaps` 非空 = 缺深度阶段，补齐或向用户说明后走 depthWaiver**，不许静默忽略。**停下等用户确认**后再 save_route 传 `"action":"approve"`。
5. **按阶段串行推进**：`update_phase`（`--args '{"phaseId":"…","status":"in-progress"}'`）→
   - **planning**：结论写 notes → passed。**manual**：清单写 manual-cases/ → passed（或留给用户，报告说明）。
   - **generate/execute**：读 1-3 个被测文件 → 写用例进沙箱 → `snapshot_files` 快照 + notes 写 checkpoint → `run_tests`（`--args '{"phaseId":"…"}'`，易抖动阶段加 `"retryFailedOnce": true`，需要长执行时后台发起再轮询）。paths/command 用相对 root 的路径指进沙箱。Python 用 pytest 执行器 + 沙箱放一行 conftest.py：`import os, sys; sys.path.insert(0, os.getcwd())`；Node 最通用是 generic + `node --test <沙箱相对路径>`。
   - **执行后**：全过 → passed；有失败 → `record_triage` 逐条归因（0 用例崩溃时先看 runDir 下 raw/console-*.log）→ code-bug 则 `update_phase` 标 failed 并在 triage 划优先级。
   - **优先级（code-bug 必划，finalize 门禁强制）**：**P0 阻断**=主流程不可用/安全漏洞/数据丢失/服务崩溃（必须最先修复）；**P1 严重**=核心功能缺陷有绕过；**P2 一般**=次要/边界；**P3 轻微**=体验/文案/建议。拿不准向上靠（疑似安全/数据问题一律 P0）。
6. `nextActions` 给出合法下一步，照做。
7. **收尾**：缺口未清零时 finalize 被 E_GATE 拦下（报错列明每项缺口）——先按缺口清单补测/上报覆盖，个别端点确实测不了再走 `coverageWaiver` 逐项登记；**不许拿豁免当省事后门**。缺口清零后 `cli.js finalize_report --root <root>` → 汇报 final-report.md：层级结论 + **缺陷清单（P0 置顶显著标出，逐条给定位与修复方向）** + 失败归因（含未归因标记）+ **API 覆盖矩阵（端点 × 用例种类逐格对照）+ 页面覆盖对照 + 覆盖豁免（有则逐项引用理由）** + **全量用例清单（通过与失败都写明做法/复现/证据）** + 复现指南 + 后续建议；向用户说明证据播放方式（trace.zip 拖进 https://trace.playwright.dev 逐步重播、离线 `npx playwright show-trace <路径>`；video.webm 直接拖进浏览器播放）。**报告带机器可验封章（正文 sha256 写进尾注 + route.report + finalize 事件三处一致）——最终报告只能由 finalize_report 产出；手写 final-report.md、生成后改动报告或手改 route.json 都会被 get_route 的 `reportIntegrity` 识破亮红，归档从此不可信**。**交付前报告自查（强制，坏结构的报告不许流到用户面前）**：汇报前用文本搜索定位检查 final-report.md 两处（不必通读全文）——① 搜「已截断」：任何表格行（复现指南/归因/豁免表等）不得出现截断，每行必须单行完整、复现命令可直接复制执行；② 搜「案例卡缺失」：有文件路径的用例不得出现。任一命中 = 工具引擎版本落后或异常：**不要照着坏报告复述结论**，如实向用户说明哪一段不可信，先更新 skill 引擎后重新 `finalize_report` 再交付。**最终答复必须原样引用返回的 `changesBlock`**（本次装了什么、怎么卸、改了哪些文件）。

## generate-only 模式与断点续跑

- 仅生成模式不调 run_tests；用例生成进沙箱并快照后 passed（execute 类阶段请直接规划为 generate，或 skipped 注明"仅生成模式未执行"）。
- 重新进入：`cli.js get_route --root <root>`（默认返回紧凑摘要，自动定位最新归档）→ 看 `nextActions` 与 checkpoint 续跑；`route.terminated` 存在说明准入层失败终止过，按提示先修复再解锁。除错才传 `--args '{"detail":"full"}'`（内联 route.json 全文）。**怀疑归档被手改、或上一轮可能绕过工具时，先 `verify_archive` 自验再续跑**：verdict=TRUSTED 才可信；TAMPERED 的归档与报告整份作废，按缺口用工具重跑，不得手写补档掩盖。

## 禁止事项

- 禁止跳过人工评审直接 approve（工具也会拒绝）；禁止手搓归档目录/manifest、绕过工具改 route.json。**禁止手写/补造任何归档文件**（manifest 事件、runs/*/result.json、route.json、final-report.md）——CLI 调用失败或中断不是例外。归档可信度可主动验证：`cli.js verify_archive --root <root>`（或离线 `node "<skillDir>/scripts/check-archive.mjs" <归档|项目根>`，退出码 0/1/2=TRUSTED/SUSPECT/TAMPERED）核对 manifest 事件连续性、result.json 工具指纹与报告封章；TAMPERED 的归档整份作废，不得引用其结论。
- 禁止修改项目自有测试脚本与被测业务代码（哈希门禁 + 只测不修；意外改动必须 `record_change` 留痕）。
- 禁止生成没有档头案例卡的测试文件（所有执行器一视同仁，含 smoke/sast 等脚本；六字段见「案例卡与全流程证据」）。
- 禁止把大量源码/日志粘贴进对话（完整日志在归档 raw/，引用路径即可）。
- 禁止对未授权目标执行安全测试（dast/pentest/越权利用只针对用户明确授权的服务发包）。
- 禁止跳过改动说明：finalize 后的最终答复必须原样包含 `changesBlock`。

## 安装与可携性

整个 skill 目录（SKILL.md + cli.js + server/ + scripts/）是自包含的：拷到 ZCode 用户级 `~/.zcode/skills/testroute/`、项目级 `.zcode/skills/testroute/`、Claude Code `.claude/skills/testroute/` 即生效；不支持 skill 机制的宿主把本文件正文贴进规则文件，同时把目录留在任意固定路径并让 LLM 知道路径即可。仓库内更新引擎代码后重跑 `node scripts/build-skill.mjs` 重新同步。
