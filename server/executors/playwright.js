// Playwright 外部命令适配器：浏览器 E2E（browser-e2e 阶段）。
// Playwright 是被测项目的 devDependency，npx 运行 —— TestRoute 自身保持零依赖。
// 报告走内置 json reporter，输出文件位置通过 PLAYWRIGHT_JSON_OUTPUT_* 环境变量指定（execute() 注入）；
// --trace on 命令行强制全量 trace（覆盖项目 config 的 retain-on-failure 类设置），trace.zip 是可拖进
// trace.playwright.dev 逐步重播的证据文件；--output 把用例产物（trace/视频/截图/error-context）固定进归档，
// 避免 playwright 在项目根生成 test-results/。
// 证据链是硬约定（evidence=full 默认）：video/自动截图没有 CLI 开关，只能由 config 的 use 开启——
// evidencePlan() 生成证据 wrapper config（在沙箱 config 基础上强制 use.trace/video/screenshot）并给命令补
// --trace on/--output/--config；跑完后 verifyEvidenceGate() 按解析出的附件核对证据是否真的落地。
// 关闭/降级证据只能 run_tests { evidence, evidenceReason } 显式声明（.testfile/用户明写才允许，理由留痕）。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parsePlaywrightJson } from './pwjson.js';
import { emptySummary } from '../result.js';
import { nodeProjectDirs } from '../detect.js';

const posix = (p) => String(p).split(path.sep).join('/');
const CONFIG_NAMES = ['playwright.config.mjs', 'playwright.config.mts', 'playwright.config.js', 'playwright.config.cjs', 'playwright.config.ts', 'playwright.config.cts'];
const TS_CONFIG_RE = /\.(mts|cts|ts)$/i;
const WRAPPER_NAME = 'testroute-evidence.config.mjs';

// 沙箱 spec 的包解析桥接：沙箱在 test-archives/ 下，monorepo 布局（根目录无 node_modules，
// playwright 装在 frontend/ 等一层子项目）时，从沙箱向上解析不到包 → spec 的
// import { test } from 'playwright/test' 直接失败、0 用例。在沙箱 node_modules 放 junction
// 指向真实安装位置（工具自有领地内操作，不写项目树；已存在则跳过，跨平台：POSIX 上退化为普通符号链接）。
function linkSandboxPlaywright(sandboxDir, root, notes) {
  if (!sandboxDir || !root) return;
  const byName = new Map();
  for (const dir of nodeProjectDirs(root)) {
    for (const name of ['playwright', '@playwright/test']) {
      if (byName.has(name)) continue;
      const src = path.join(dir, 'node_modules', ...name.split('/'));
      try {
        if (fs.statSync(src).isDirectory()) byName.set(name, src);
      } catch { /* 未安装 → 下一个候选 */ }
    }
  }
  for (const [name, src] of byName) {
    const dest = path.join(sandboxDir, 'node_modules', ...name.split('/'));
    try {
      fs.lstatSync(dest);
      continue; // 已有（上一轮 run 建过 / 用户自建）→ 不动
    } catch { /* 不存在 → 建 */ }
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(src, dest, 'junction');
    } catch (e) {
      notes?.push(`沙箱包解析桥接失败（${name} → ${src}）：${String(e?.message || e).slice(0, 120)}`);
    }
  }
}
// 「playwright test」命令形态：npx playwright test / playwright test / node …/playwright/cli.js test /
// node …/@playwright/test/cli.js test 都算（.cmd shim 不在 PATH 时走 cli.js 是正当路径）。
// node 自管脚本（fake-pw.mjs 之类）不算——那是绕开证据注入的挂名。
export const PLAYWRIGHT_TEST_RE =
  /\bplaywright(?:\.cmd)?\s+test\b|\bplaywright[\/\\](?:cli\.js|test[\/\\]cli\.js)\s+test\b/;

function firstExistingConfig(dir) {
  for (const name of CONFIG_NAMES) {
    const p = path.join(dir, name);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 不存在 → 下一个 */
    }
  }
  return null;
}

// 从命令里抠出 cd 目标目录（playwright 的 cwd 可能不是项目根：如 "cd frontend && npx playwright test"）
function cdDirsFromCommand(command, root) {
  const out = [];
  const re = /(?:^|[&;|(])\s*cd\s+("[^"]+"|'[^']+'|[^\s&;|]+)/g;
  let m;
  while ((m = re.exec(String(command || '')))) {
    const raw = m[1].replace(/^["']|["']$/g, '');
    out.push(path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(root, raw));
  }
  return out;
}

// 从 --config=<path> / --config <path> 抠出配置路径；start/end 圈住值本身（含引号）便于原位回写
function configRefFromCommand(command) {
  const s = String(command || '');
  let m = /--config=(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))/.exec(s);
  if (m) {
    const raw = m[1] || m[2] || m[3];
    const quoted = m[1] != null || m[2] != null;
    const start = m.index + '--config='.length;
    return { raw, start, end: start + raw.length + (quoted ? 2 : 0) };
  }
  m = /--config\s+(?:"([^"]+)"|'([^']+)'|([^\s&;|]+))/.exec(s);
  if (m) {
    const raw = m[1] || m[2] || m[3];
    const quoted = m[1] != null || m[2] != null;
    return { raw, start: m.index + m[0].length - raw.length - (quoted ? 2 : 0), end: m.index + m[0].length };
  }
  return null;
}

// playwright 缓存里的 ffmpeg（video 录制依赖，二进制不随 npm 包分发）。
// 缺失时强制 video:'on' 会让每条用例直接报错——所以先探测，缺了就自动降级 video=off（trace/截图仍在）。
function ffmpegAvailable({ root, command, baseDir }) {
  // monorepo 布局：playwright-core 在 frontend/ 等一层子项目里，从根向上走永远够不到 —— 子项目目录也进候选
  const candidates = [root, ...nodeProjectDirs(root), ...cdDirsFromCommand(command, root), ...(baseDir ? [baseDir] : [])];
  let revision = null;
  outer: for (const start of candidates) {
    let dir = path.resolve(start);
    for (let i = 0; i < 5 && dir; i++, dir = path.dirname(dir)) {
      const bj = path.join(dir, 'node_modules', 'playwright-core', 'browsers.json');
      try {
        if (!fs.statSync(bj).isFile()) continue;
        const data = JSON.parse(fs.readFileSync(bj, 'utf8'));
        const ff = (data.browsers || []).find((b) => b && b.name === 'ffmpeg');
        if (ff?.revision != null) {
          revision = String(ff.revision);
          break outer;
        }
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  if (!revision) return { available: false, reason: '未找到 playwright-core/browsers.json，无法确认 ffmpeg 版本' };
  let cacheDir;
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) cacheDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  else if (process.platform === 'win32') cacheDir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  else if (process.platform === 'darwin') cacheDir = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  else cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright');
  const binNames = process.platform === 'win32' ? ['ffmpeg-win64.exe'] : process.platform === 'darwin' ? ['ffmpeg-mac'] : ['ffmpeg-linux'];
  for (const bin of binNames) {
    const p = path.join(cacheDir, `ffmpeg-${revision}`, bin);
    try {
      if (fs.statSync(p).isFile()) return { available: true, path: p };
    } catch {
      /* 不存在 → 下一个 */
    }
  }
  return {
    available: false,
    reason: `playwright 缓存缺 ffmpeg（${posix(path.join(cacheDir, `ffmpeg-${revision}`))}）——受限网络不要 playwright install，按 SKILL 用 @ffmpeg-installer 补或降级 evidence=trace`,
  };
}

// 证据 wrapper config：强制 video/自动截图的唯一手段（它们没有 CLI 开关）。
// 只在工具自有领地（沙箱）落文件，绝不写入项目树；与 base config 同目录，保证 testDir 等
// 相对路径的解析基准不变。base=null 时给最小 config（testDir 指沙箱）。
function writeEvidenceWrapper({ sandboxDir, baseConfig, videoEnabled }) {
  const targetDir = baseConfig ? path.dirname(baseConfig) : sandboxDir;
  const wrapperPath = path.join(targetDir, WRAPPER_NAME);
  const ev = videoEnabled ? "{ trace: 'on', video: 'on', screenshot: 'on' }" : "{ trace: 'on', screenshot: 'on' }";
  let body;
  if (baseConfig) {
    body = [
      `// TestRoute 证据 wrapper（自动生成，每次 run 覆盖）：在 ${path.basename(baseConfig)} 基础上强制开启证据开关。`,
      `// use 里 trace/video/screenshot 以本文件为准；base config 的其余设置全部保留。删除本文件不影响项目。`,
      `import base from './${path.basename(baseConfig)}';`,
      `const EVIDENCE = ${ev};`,
      `const baseObj = base && typeof base === 'object' ? base : {};`,
      `const merged = { ...baseObj, use: { ...(baseObj.use || {}), ...EVIDENCE } };`,
      `if (Array.isArray(baseObj.projects)) merged.projects = baseObj.projects.map((p) => ({ ...p, use: { ...(p.use || {}), ...EVIDENCE } }));`,
      `export default merged;`,
      '',
    ].join('\n');
  } else {
    body = [
      `// TestRoute 证据 wrapper（自动生成，每次 run 覆盖）：项目/沙箱没有 playwright config 时的最小证据配置。`,
      `export default {`,
      `  testDir: '${posix(sandboxDir)}',`,
      `  use: ${ev},`,
      `};`,
      '',
    ].join('\n');
  }
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(wrapperPath, body, 'utf8');
    return wrapperPath;
  } catch {
    return null; // 目录只读等异常 → 调用方降级为仅 --trace on 兜底
  }
}

// 把 flag 插进命令中 playwright test 所在段（紧跟子命令之后，而不是整条命令尾部——
// 自定义命令常是 "cd frontend && npx playwright test … && post.mjs" 形态，插尾部会落错命令）。
function insertFlagAfterTest(command, flag) {
  const m = PLAYWRIGHT_TEST_RE.exec(command);
  return command.slice(0, m.index + m[0].length) + flag + command.slice(m.index + m[0].length);
}

// 自定义 command/config 时 json reporter 可能输出到任意路径（如 config 里覆写了 reporter.outputFile）——
// 在归档目录与项目根找回本次运行新生成的 playwright JSON 报告。
// 只认 mtime 不早于本次执行开始、内容形如 playwright 报告（stats + suites）的文件；
// 不跟踪符号链接（沙箱里可能有指到 node_modules 的 junction），目录深度与扫描量设上限。
function findReportCandidates({ root, outDir, startedAt }) {
  const earliest = startedAt ? new Date(startedAt).getTime() - 5000 : 0;
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'test-results', 'playwright-report', 'artifacts', 'coverage', 'dist', 'build',
  ]);
  const NAME_RE = /(report|results?)\.json$/i;
  const found = [];
  const seen = new Set();
  let budget = 800; // 扫描条目上限，防超大归档拖慢执行器
  const visit = (dir, depth) => {
    if (depth > 4 || budget <= 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget <= 0) return;
      budget--;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const key = abs.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (e.isDirectory()) {
        if (!e.isSymbolicLink()) visit(abs, depth + 1);
        continue;
      }
      if (!e.isFile() || !NAME_RE.test(e.name)) continue;
      if (earliest) {
        try {
          if (fs.statSync(abs).mtimeMs < earliest) continue;
        } catch {
          continue;
        }
      }
      found.push(abs);
    }
  };
  const roots = [];
  if (outDir) roots.push(path.resolve(outDir, '..', '..')); // <archive>/runs/<run>/raw → 归档根
  roots.push(root);
  for (const r of roots) {
    const key = path.resolve(r).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      visit(r, 0);
    }
  }
  // 新的在前：本次运行的报告 mtime 最大
  return found
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map((x) => x.p);
}

export const playwright = {
  id: 'playwright',
  label: '浏览器 E2E（Playwright）',
  artifactName: 'playwright-report.json',

  // 证据编排（execute() 在 buildCommand 之前调用）：决定 wrapper、补丁命令、探测 ffmpeg。
  // evidence: 'full'（trace+video+screenshot，默认）| 'trace'（video 关，ffmpeg 缺失场景）| 'off'（.testfile 明写才允许）。
  evidencePlan({ root, outDir, command = '', evidence = 'full' }) {
    const notes = [];
    const plan = { level: evidence, wrapperPath: null, videoEnabled: false, notes };
    if (evidence === 'off') {
      notes.push('证据链已被显式关闭（evidence=off，理由见 run 记录 evidenceReason）——本 run 不产生 trace/video/截图产物。');
      plan.command = command;
      return plan;
    }
    // outDir = <归档>/runs/<run>/raw → 往上三层才是归档根（sandbox 与 runs 平级）
    const archiveRoot = outDir ? path.resolve(outDir, '..', '..', '..') : null;
    const sandboxDir = archiveRoot ? path.join(archiveRoot, 'sandbox') : null;
    linkSandboxPlaywright(sandboxDir, root, notes);

    const isDefault = !command.trim();
    const isPwTest = PLAYWRIGHT_TEST_RE.test(command);
    if (!isDefault && !isPwTest) {
      // 非 playwright test 命令（自管脚本）不注入——证据由脚本自行落 TESTROUTE_ARTIFACTS_DIR
      plan.command = command;
      return plan;
    }

    // base config：命令里的 --config 优先，其次沙箱 config；项目树的 config 只发现不写入
    let baseConfig = null;
    let baseInsideSandbox = false;
    const cfgRef = configRefFromCommand(command);
    const resolveRaw = (raw) => {
      // 命令里的路径常是正斜杠形态（shell 兼容写法），统一 normalize 成本机分隔符再比对
      if (path.isAbsolute(raw)) return fs.existsSync(raw) ? path.normalize(raw) : null;
      for (const dir of [...cdDirsFromCommand(command, root), root]) {
        const p = path.resolve(dir, raw);
        if (fs.existsSync(p)) return p;
      }
      return null;
    };
    if (cfgRef) {
      const resolved = resolveRaw(cfgRef.raw);
      if (resolved) {
        baseConfig = resolved;
        baseInsideSandbox = !!(sandboxDir && resolved.toLowerCase().startsWith(sandboxDir.toLowerCase() + path.sep));
      } else {
        notes.push(`命令里的 --config=${cfgRef.raw} 不存在，按无 base config 处理。`);
      }
    } else if (sandboxDir) {
      baseConfig = firstExistingConfig(sandboxDir);
      baseInsideSandbox = !!baseConfig;
    }
    if (!baseConfig) {
      const cwdDir = cdDirsFromCommand(command, root)[0] || root;
      const cwdCfg = command.trim() ? firstExistingConfig(cwdDir) : null;
      const rootCfg = firstExistingConfig(root);
      baseConfig = cwdCfg || rootCfg || null; // 只用于提示；项目树 config 不注入（见下）
    }

    const canInject = sandboxDir && (!baseConfig || (baseInsideSandbox && !TS_CONFIG_RE.test(baseConfig)));
    if (baseConfig && !baseInsideSandbox) {
      notes.push(
        `检测到项目自有 playwright config（${posix(path.relative(root, baseConfig) || baseConfig)}）——工具不写入项目树，video/自动截图无法注入；` +
          `trace 已由 --trace on 兜底。要全量证据请在沙箱自建 playwright.config.mjs（SKILL 证据规范）。`
      );
    } else if (baseConfig && TS_CONFIG_RE.test(baseConfig)) {
      notes.push(`沙箱 playwright config 是 TypeScript（${path.basename(baseConfig)}），node 无法静态 import 做证据注入——trace 由 --trace on 兜底，video/截图请在 config 里开 use。`);
    }
    if (canInject) {
      if (evidence === 'full') {
        const ff = ffmpegAvailable({ root, command, baseDir: baseConfig ? path.dirname(baseConfig) : sandboxDir });
        plan.videoEnabled = ff.available;
        if (!ff.available) notes.push(`video 证据自动降级关闭：${ff.reason}`);
      } else if (evidence === 'trace') {
        plan.videoEnabled = false;
        notes.push('evidence=trace：video 关闭（理由见 evidenceReason），trace + 截图照常强制。');
      }
      plan.wrapperPath = writeEvidenceWrapper({ sandboxDir, baseConfig, videoEnabled: plan.videoEnabled });
      if (!plan.wrapperPath) notes.push('证据 wrapper config 写入失败（目录只读？）——回退为仅 --trace on 兜底。');
    }

    if (isDefault) {
      plan.command = '';
      return plan; // 默认命令由 buildCommand 组装（含 --config=wrapper）
    }
    let patched = command;
    if (plan.wrapperPath) {
      const ref = configRefFromCommand(patched);
      if (ref) {
        patched = patched.slice(0, ref.start) + posix(plan.wrapperPath) + patched.slice(ref.end);
      } else {
        patched = insertFlagAfterTest(patched, ` --config="${posix(plan.wrapperPath)}"`);
      }
    }
    if (!/(^|\s)--trace(\s|=)/.test(patched)) patched = insertFlagAfterTest(patched, ' --trace on');
    if (!/(^|\s)--output(\s|=)/.test(patched) && outDir) {
      patched = insertFlagAfterTest(patched, ` --output="${posix(path.join(outDir, 'artifacts'))}"`);
    }
    plan.command = patched;
    return plan;
  },

  buildCommand({ paths, outFile, command, evidence = 'full', plan = null }) {
    if (command) return command; // 自定义命令已在 evidencePlan() 补丁（--config 指向证据 wrapper + --trace on + --output）
    const p = (paths || []).length ? ' ' + paths.join(' ') : '';
    const off = evidence === 'off';
    const out = !off && outFile ? ` --output="${path.dirname(outFile).split(path.sep).join('/')}/artifacts"` : '';
    const trace = off ? '' : ' --trace on';
    const cfg = !off && plan?.wrapperPath ? ` --config="${posix(plan.wrapperPath)}"` : '';
    return `npx --no-install playwright test${p} --reporter=json${trace}${out}${cfg}`;
  },

  parse({ root, outFile, proc, startedAt, outDir }) {
    let text = outFile && fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
    let warnings = [];
    if (!text) {
      // 自定义 command 时 json 可能直接打到 stdout
      const out = String(proc.stdout || '').trim();
      if (out.startsWith('{')) {
        text = out;
        warnings.push('报告取自 stdout（建议用默认执行方式，报告写入 runs/<phase>/raw/）');
      }
    }
    if (!text) {
      // 覆盖 command/config 时报告常被写到别处——找回本次运行的报告照常解析，不丢用例级结果，
      // 否则只能按 exit code 判定，报告里 0过/0败/0跳 会被误读成"没跑测试"
      const shown = (p) => {
        const rel = path.relative(root, p).split(path.sep).join('/');
        return rel && !rel.startsWith('..') ? rel : p;
      };
      for (const cand of findReportCandidates({ root, outDir, startedAt })) {
        let t = null;
        try {
          t = fs.readFileSync(cand, 'utf8');
        } catch {
          continue;
        }
        if (!/^\s*\{/.test(t)) continue;
        let probe;
        try {
          probe = JSON.parse(t);
        } catch {
          continue;
        }
        // 必须形如 playwright JSON 报告（stats + suites），避免误吃归档里其他执行器的 result.json
        if (!probe || typeof probe !== 'object' || !probe.stats || !Array.isArray(probe.suites)) continue;
        const parsed = parsePlaywrightJson(t, root);
        if (parsed.parseStatus === 'parsed' && parsed.summary.total > 0) {
          return {
            ...parsed,
            artifacts: [...parsed.artifacts, { kind: 'json', path: cand }],
            warnings: [
              ...parsed.warnings,
              `JSON 报告不在预期位置（${outFile}），已从 ${shown(cand)} 找回并解析。自定义 command 时请保留 --reporter=json 并设 PLAYWRIGHT_JSON_OUTPUT_DIR/NAME（config 内勿覆写 outputFile），让报告落进 runs/<phase>/raw/。`,
            ],
          };
        }
      }
    }
    if (!text) {
      return {
        suites: [],
        summary: emptySummary(),
        parseStatus: 'exit-code-only',
        artifacts: [],
        warnings: [
          `未找到 Playwright JSON 报告（${outFile}，含归档目录/项目根回退扫描）。若覆盖了 command，请保留 --reporter=json 并设置 PLAYWRIGHT_JSON_OUTPUT_NAME，或直接让阶段用默认命令。`,
          ...(proc.exitCode === 0 ? [] : ['exitCode 非 0 但无报告可解析']),
        ],
      };
    }
    const parsed = parsePlaywrightJson(text, root);
    return {
      ...parsed,
      artifacts: [
        ...(outFile && fs.existsSync(outFile) ? [{ kind: 'json', path: outFile }] : []),
        ...parsed.artifacts,
      ],
      warnings: [...warnings, ...parsed.warnings],
    };
  },
};

// 证据规范 lint（软约束，只警告不拦）：证据开关由工具的 evidencePlan 强制注入（trace 命令行兜底、
// video/自动截图由 wrapper config 注入），但用例档头的 test.use 仍是手工复现时的自证写法，
// page.screenshot 逐步截图只能由用例自身提供——缺失时通过 lint 提醒补齐。
const SPEC_FILE_RE = /\.(mjs|cjs|js|jsx|ts|tsx|mts|cts)$/i;

export function lintSpecs({ root, paths = [] } = {}) {
  const warnings = [];
  const files = (paths || [])
    .map((p) => path.resolve(root, p))
    .filter((f) => {
      if (!SPEC_FILE_RE.test(f)) return false;
      try {
        return fs.statSync(f).isFile();
      } catch {
        return false;
      }
    })
    .slice(0, 20);
  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (!/test\.use\s*\(/.test(text)) {
      warnings.push(
        `[证据规范] ${rel}: 档头缺少 test.use({ trace: 'on', video: 'on', screenshot: 'on' })——工具已注入证据 config，但手工复现（不经 testroute）时靠用例自证；逐步截图见下条`
      );
    }
    if (!/screenshot\s*\(/.test(text)) {
      warnings.push(
        `[证据规范] ${rel}: 未包含 page.screenshot() 逐步截图——每个关键步骤后调用 page.screenshot({ path: process.env.TESTROUTE_ARTIFACTS_DIR + '/NN-步骤名.png' })，NN 递增、名称语义化`
      );
    }
  }
  return warnings;
}

// 证据门禁核对（run 结束后）：按解析出的用例附件核对 trace/截图/video 是否真的落地，缺了就在
// run warnings 里点名——「全量用例清单」逐用例证据行 + 本门禁是证据链硬约定的最后防线。
// 只警告不改 pass/fail：证据缺失是工具/环境问题，不该把被测系统的结论染红，但必须无处可藏。
export function verifyEvidenceGate({ suites = [], level = 'full', videoEnabled = true } = {}) {
  const cases = (suites || []).flatMap((s) => s.cases || []).filter((c) => c.status !== 'skipped');
  const total = cases.length;
  const count = (kind) => cases.filter((c) => (c.attachments || []).some((a) => a.kind === kind)).length;
  const expectVideo = level === 'full' && videoEnabled;
  const warnings = [];
  const expectations = [
    { kind: 'trace', label: 'trace.zip', required: true, hint: '--trace on 与 --output 应由工具注入命令；被自定义命令覆盖时请恢复' },
    {
      kind: 'screenshot',
      label: '截图',
      required: true,
      hint: '自动截图由证据 wrapper 的 use.screenshot=on 提供；逐步截图须用例内 page.screenshot（落 TESTROUTE_ARTIFACTS_DIR）',
    },
    {
      kind: 'video',
      label: 'video.webm',
      required: expectVideo,
      hint: 'use.video=on 由证据 wrapper 注入；ffmpeg 缺失时工具会自动降级并留 notes，复查 evidencePlan notes',
    },
  ];
  const missing = [];
  for (const e of expectations) {
    if (!e.required) continue;
    const present = count(e.kind);
    if (present < total) {
      missing.push({ kind: e.kind, present, total, hint: e.hint });
      warnings.push(`[证据门禁] ${e.label}仅 ${present}/${total} 条用例有——${e.hint}`);
    }
  }
  return {
    level,
    videoEnabled: expectVideo,
    total,
    trace: { present: count('trace'), required: true },
    screenshot: { present: count('screenshot'), required: true },
    video: { present: count('video'), required: expectVideo },
    compliant: total > 0 && missing.length === 0,
    warnings,
  };
}
