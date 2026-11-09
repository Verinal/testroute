// 依赖安装台账（provision ledger）：TestRoute 为被测项目安装的任何依赖（如 playwright/chromium）
// 都在这里记账 —— 装之前快照项目状态（判断"项目原本就有"），装之后记录差量。
// 不做自动卸载：最终报告开头输出条件化的卸载说明块，卸载权留给用户。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fail } from './validate.js';
import { readJson, writeJson, nowIso, archivesDir } from './paths.js';
import { playwrightVersionFromNodeModules, nodeProjectDirs } from './detect.js';
import { runCommand } from './run.js';

export const PROVISION_FILE = 'provision.json';
export const PROVISION_SCHEMA_VERSION = 1;

const PLAYWRIGHT_PKGS = ['playwright', 'playwright-core', '@playwright/test'];

// ---------- 状态探测 ----------

export function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  // 无锁文件但有 package.json：按 npm 处理（新项目 / 未提交锁文件的项目同样要能装依赖）
  if (fs.existsSync(path.join(root, 'package.json'))) return 'npm';
  // 根目录不是 Node 项目时看一层子项目（monorepo：后端在根、frontend/ 持有 package.json）
  for (const dir of nodeProjectDirs(root)) {
    if (dir !== root && fs.existsSync(path.join(dir, 'package.json'))) return 'npm';
  }
  return null;
}

// 安装落点：根目录是 Node 项目就用根；否则用第一个带 package.json 的一层子目录（monorepo 布局）。
export function nodeProjectDir(root) {
  for (const dir of nodeProjectDirs(root)) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
  }
  return null;
}

export function browsersDir() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return path.resolve(process.env.PLAYWRIGHT_BROWSERS_PATH);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

function browsersPresent() {
  const dir = browsersDir();
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return false;
  }
  // 只有真正装完的 chromium 才算数：浏览器目录里要有 playwright 的 INSTALLATION_COMPLETE 标记。
  // （实测出现过下载中断残留的空目录，按「非点目录就算有」会误判快取可用。）
  for (const name of names) {
    if (!/^chromium/i.test(name)) continue;
    try {
      if (fs.existsSync(path.join(dir, name, 'INSTALLATION_COMPLETE'))) return true;
    } catch { /* 忽略不可读目录 */ }
  }
  return false;
}

// 系统浏览器探测（优先级第二层）：系统 Chrome/Edge，playwright channel 启动，零下载。
function detectSystemBrowser() {
  const candidates = [];
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const lf = process.env['LocalAppData'] || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      ['chrome', path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['chrome', path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['chrome', path.join(lf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['msedge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      ['msedge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    );
  } else {
    candidates.push(
      ['chrome', '/usr/bin/google-chrome'],
      ['chrome', '/usr/bin/google-chrome-stable'],
      ['chrome', '/usr/bin/chromium'],
      ['msedge', '/usr/bin/microsoft-edge'],
    );
  }
  for (const [channel, p] of candidates) {
    try {
      if (fs.existsSync(p)) return { channel, path: p };
    } catch { /* 忽略不可读路径 */ }
  }
  return null;
}

// 编辑器内置浏览器探测（优先级第一层）：宿主编辑器（Vulcan/VSCode/Cursor/Windsurf…）的内置浏览器
// 通过 CDP 附着使用（chromium.connectOverCDP），零下载、不新开浏览器进程。
// 端点发现与 builtin-browser MCP 同源：环境变量 BROWSER_MCP_CDP_URL / BROWSER_MCP_USER_DATA_DIR，
// 以及已知宿主 user-data-dir 下的 DevToolsActivePort 文件。这里只读文件不探活（探活在 browser_probe 里做，
// 端点失效时探针会按优先级自动降级到下一层）。
export function detectEditorBrowser() {
  const envUrl = process.env.BROWSER_MCP_CDP_URL;
  if (envUrl && envUrl.trim()) return { endpoint: envUrl.trim(), source: '环境变量 BROWSER_MCP_CDP_URL' };
  const dirs = [];
  if (process.env.BROWSER_MCP_USER_DATA_DIR) dirs.push(process.env.BROWSER_MCP_USER_DATA_DIR);
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  for (const host of ['Vulcan', 'Cursor', 'Code', 'Code - OSS', 'Windsurf']) {
    dirs.push(path.join(appData, host));
  }
  for (const dir of dirs) {
    const file = path.join(dir, 'DevToolsActivePort');
    try {
      if (!fs.existsSync(file)) continue;
      const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) {
        return { endpoint: `http://127.0.0.1:${port}`, source: file };
      }
    } catch { /* 读不到就跳过 */ }
  }
  return null;
}

function pkgHasPlaywright(root) {
  const found = new Set();
  for (const dir of nodeProjectDirs(root)) {
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) continue;
    let pkg = null;
    try {
      pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
    for (const name of PLAYWRIGHT_PKGS) if (deps[name]) found.add(name);
  }
  return [...found];
}

function nodeModulesHasPlaywright(root) {
  const found = new Set();
  for (const dir of nodeProjectDirs(root)) {
    for (const name of PLAYWRIGHT_PKGS) {
      if (fs.existsSync(path.join(dir, 'node_modules', ...name.split('/')))) found.add(name);
    }
  }
  return [...found];
}

// playwright 就绪 = node_modules 可解析包 + 本机有可用浏览器。
// 浏览器优先级（与 builtin-browser MCP 一致，逐层降级、不跳级）：
// ① 编辑器内置浏览器（CDP 附着）> ② 系统 Chrome/Edge（channel，零下载）> ③ chromium 缓存（最后手段）
// > ④ 下载（永远垫底，本模块绝不主动建议）。
export function checkPlaywrightReady(root) {
  const inModules = nodeModulesHasPlaywright(root);
  const editor = detectEditorBrowser();
  const system = detectSystemBrowser();
  const cache = browsersPresent();
  const browserSource = editor ? 'editor-internal' : system ? 'system-channel' : cache ? 'chromium-cache' : 'none';
  const browserUsable = browserSource !== 'none';
  return {
    ready: inModules.length > 0 && browserUsable,
    packagesInNodeModules: inModules,
    declaredInPackageJson: pkgHasPlaywright(root),
    editorBrowser: editor,
    browsersPresent: cache,
    systemBrowser: system,
    browserSource,
    browsersDir: browsersDir(),
    missing: [
      ...(inModules.length === 0 ? ['playwright npm 包（node_modules 中不可解析）'] : []),
      ...(!browserUsable
        ? ['浏览器（编辑器内置 CDP / 系统 Chrome/Edge / chromium 缓存三层都未找到；获取只走 provision_deps 计划审批，不要自行 npx playwright install）']
        : []),
    ],
  };
}

function gitPorcelain(root) {
  try {
    const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
    if (probe.status !== 0 || String(probe.stdout).trim() !== 'true') return { isRepo: false, lines: [] };
    const status = spawnSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
    if (status.status !== 0) return { isRepo: true, lines: [] };
    return { isRepo: true, lines: String(status.stdout).split(/\r?\n/).filter(Boolean) };
  } catch {
    return { isRepo: false, lines: [] };
  }
}

// finalize 用：对比台账快照与当前 git 工作区，找出本次运行期间出现的工作区变化（诚实列示，不自动还原）。
// test-archives/ 下的产物（沙箱/归档自身）不算 —— 它们本来就该留在归档里。
export function detectWorkspaceChanges(root, ledger) {
  const now = gitPorcelain(root);
  if (!now.isRepo) return { isRepo: false, changes: [] };
  const before = new Map();
  for (const line of ledger?.preState?.gitStatus || []) {
    before.set(line.slice(3), line.slice(0, 2));
  }
  const archivesPrefix = archivesDir(root).split(path.sep).join('/') + '/';
  const changes = [];
  for (const line of now.lines) {
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    const rename = /^[^ ]+ -> (.*)$/.exec(p);
    if (rename) p = rename[1];
    p = p.replace(/^"|"$/g, '');
    const posix = p.split(path.sep).join('/');
    if (posix.startsWith(archivesPrefix)) continue;
    const beforeStatus = before.get(posix);
    if (beforeStatus === x + y || beforeStatus === y + x) continue; // 运行前就已存在的未提交改动
    changes.push({ path: posix, status: x === '?' || y === '?' ? '新增（未跟踪）' : x + y });
  }
  return { isRepo: true, changes };
}

function capturePreState(root) {
  return {
    capturedAt: nowIso(),
    packageJsonExists: fs.existsSync(path.join(root, 'package.json')),
    packageManager: detectPackageManager(root),
    declaredPlaywright: pkgHasPlaywright(root),
    nodeModulesPlaywright: nodeModulesHasPlaywright(root),
    browsersPresent: browsersPresent(),
    browsersDir: browsersDir(),
    gitStatus: gitPorcelain(root).lines,
  };
}

// ---------- 台账读写 ----------

export function provisionPath(archiveDir) {
  return path.join(archiveDir, PROVISION_FILE);
}

export function loadProvision(archiveDir) {
  return readJson(provisionPath(archiveDir));
}

function saveProvision(archiveDir, ledger) {
  ledger.updatedAt = nowIso();
  writeJson(provisionPath(archiveDir), ledger);
  return ledger;
}

export function ensureProvision(root, archiveDir) {
  let ledger = loadProvision(archiveDir);
  if (!ledger) {
    ledger = {
      schemaVersion: PROVISION_SCHEMA_VERSION,
      createdAt: nowIso(),
      preState: capturePreState(root),
      installs: [],
      modifications: [],
    };
    saveProvision(archiveDir, ledger);
  }
  return ledger;
}

export function recordModification(root, archiveDir, changes) {
  const ledger = ensureProvision(root, archiveDir);
  for (const c of changes) {
    ledger.modifications.push({
      path: String(c.path).split(path.sep).join('/'),
      kind: c.kind,
      at: nowIso(),
      note: c.note || '',
    });
  }
  saveProvision(archiveDir, ledger);
  return ledger.modifications.length;
}

// ---------- 安装 ----------

export function buildInstallPlan(root, packages) {
  const manager = detectPackageManager(root);
  if (!manager) {
    return { ok: false, reason: '未发现 package.json / 锁文件（根目录与一层子目录都没有），不是 Node.js 项目，无法安装 npm 包' };
  }
  const projectDir = nodeProjectDir(root) || root;
  const npmPkgs = [...packages];
  const wantsBrowser = npmPkgs.includes('playwright');
  const readiness = checkPlaywrightReady(root);
  const commands = [];
  if (manager === 'npm') commands.push(`npm install -D ${npmPkgs.join(' ')}`);
  else if (manager === 'yarn') commands.push(`yarn add -D ${npmPkgs.join(' ')}`);
  else if (manager === 'pnpm') commands.push(`pnpm add -D ${npmPkgs.join(' ')}`);
  else if (manager === 'bun') commands.push(`bun add -d ${npmPkgs.join(' ')}`);
  // 浏览器获取优先级：① 编辑器内置浏览器（CDP 附着，零下载）> ② 系统 Chrome/Edge（channel，零下载）
  // > ③ chromium 缓存（最后手段）> ④ 下载（永远垫底，仅前三层全无才进计划，且须用户 confirm）。
  let browsersInstall = false;
  if (wantsBrowser && readiness.browserSource === 'none') {
    commands.push('npx playwright install chromium');
    browsersInstall = true;
  }
  const browserNote = !wantsBrowser
    ? ''
    : readiness.browserSource === 'editor-internal'
      ? `浏览器优先附着编辑器内置浏览器（CDP: ${readiness.editorBrowser.endpoint}，来自 ${readiness.editorBrowser.source}）；探针/脚本用 chromium.connectOverCDP，接不上自动降级系统浏览器`
      : readiness.browserSource === 'system-channel'
        ? `浏览器复用系统 ${readiness.systemBrowser.channel === 'chrome' ? 'Chrome' : 'Edge'}（channel: ${readiness.systemBrowser.channel}，零下载）；相关配置/用例需以 channel 启动浏览器`
        : readiness.browserSource === 'chromium-cache'
          ? '浏览器复用本机已有 chromium 缓存（零下载，最后手段）'
          : '本机编辑器内置 CDP、系统 Chrome/Edge、chromium 缓存三层均不可用，下载 chromium 属永远的最后手段（受限网络下常失败）；仅此情形才进安装计划，且须用户 confirm';
  return {
    ok: true,
    manager,
    commands,
    packages: npmPkgs,
    browsersInstall,
    // 安装落点：monorepo 布局时是一层子目录（如 frontend/），单包项目是根目录本身
    cwd: projectDir,
    // 阻止 playwright 包 postinstall 自动下载浏览器（下载只允许上面那条显式命令、且仅最后手段时出现）。
    env: { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    notes: [
      'playwright 以 devDependency 写入项目 package.json（供生成的浏览器用例在项目内解析、可进项目 CI 复跑）',
      `安装执行目录：${projectDir}` + (path.resolve(projectDir) !== path.resolve(root) ? '（monorepo 子项目，package.json 在子目录）' : ''),
      'npm 安装带 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1，浏览器获取按「编辑器内置（CDP）> 系统 Chrome/Edge > chromium 缓存 > 下载（永远最后）」优先级，不随包下载',
      ...(browserNote ? [browserNote] : []),
    ],
  };
}

// 卸载说明块：顺序关键 —— 必须先 npx playwright uninstall（此时 playwright 还可解析），再卸 npm 包
export function buildUninstallBlock(root, ledger) {
  if (!ledger || !ledger.installs || ledger.installs.length === 0) {
    const pre = ledger?.preState;
    if (pre?.declaredPlaywright?.length || pre?.nodeModulesPlaywright?.length) {
      return '本次测试**未安装任何依赖**（playwright 为项目原有，勿按任何卸载说明删除）。';
    }
    return '本次测试未安装任何依赖。';
  }
  const allPkgs = new Set();
  let browsersInstalled = false;
  for (const inst of ledger.installs) {
    for (const p of inst.packages || []) allPkgs.add(p);
    if (inst.browsersInstall) browsersInstalled = true;
  }
  const manager = ledger.installs.at(-1).manager || detectPackageManager(root) || 'npm';
  const uninstallCmd =
    manager === 'yarn'
      ? `yarn remove ${[...allPkgs].join(' ')}`
      : manager === 'pnpm'
        ? `pnpm remove ${[...allPkgs].join(' ')}`
        : manager === 'bun'
          ? `bun remove ${[...allPkgs].join(' ')}`
          : `npm uninstall ${[...allPkgs].join(' ')}`;
  const lines = ['本次测试为项目安装了以下依赖（保留在项目中以便复跑与 CI 使用；如不再需要，按顺序执行）：', '', '```bash'];
  if (browsersInstalled) {
    lines.push('npx playwright uninstall   # 先删除浏览器二进制（此时 playwright 仍可解析）');
  }
  lines.push(`${uninstallCmd.padEnd(26)} # 再移除 devDependency（更新 package.json）`);
  lines.push('```');
  if (browsersInstalled) {
    lines.push('');
    lines.push(
      `> 注意：浏览器二进制在用户级共享缓存（\`${browsersDir()}\`），删除会影响本机其他使用 playwright 的项目。`
    );
  }
  return lines.join('\n');
}

// ---------- 主流程 ----------

export async function provisionDeps(root, archiveDir, { packages = ['playwright'], confirm = false, purpose = '' } = {}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    fail('E_INVALID_ARGS', 'packages 必须是非空 string 数组（如 ["playwright"]）');
  }
  const ledger = ensureProvision(root, archiveDir);
  const readiness = checkPlaywrightReady(root);
  const wantsBrowser = packages.includes('playwright');
  const pwVersion = playwrightVersionFromNodeModules(root);

  if (wantsBrowser && readiness.ready) {
    const sourceLabel =
      readiness.browserSource === 'editor-internal'
        ? `编辑器内置浏览器，CDP 附着（${readiness.editorBrowser.endpoint}）`
        : readiness.browserSource === 'system-channel'
          ? '系统 Chrome/Edge，channel 启动'
          : 'chromium 缓存（最后手段）';
    return {
      status: 'ready',
      via: 'pre-existing',
      readiness,
      ...(pwVersion ? { playwrightVersion: pwVersion } : {}),
      message:
        `playwright 包与浏览器均已就绪（浏览器来源：${sourceLabel}），无需安装。`,
    };
  }

  const plan = buildInstallPlan(root, packages);
  if (!plan.ok) fail('E_GATE', plan.reason);

  if (!confirm) {
    return {
      status: 'consent-required',
      readiness,
      plan,
      message:
        `需要用户同意后才能向项目安装依赖（写入 package.json；浏览器按「编辑器内置（CDP）> 系统 Chrome/Edge > chromium 缓存 > 下载」优先级获取，默认不下载）。` +
        `请向用户展示 plan（将执行的命令与影响），用户同意后带 confirm=true 重新调用。`,
    };
  }

  const results = [];
  let ok = true;
  for (const command of plan.commands) {
    const t0 = Date.now();
    const proc = await runCommand({ cwd: plan.cwd || root, command, timeoutMs: 600000, env: plan.env });
    const success = proc.exitCode === 0;
    ok = ok && success;
    results.push({
      command,
      exitCode: proc.exitCode,
      durationMs: Date.now() - t0,
      ok: success,
      stderrTail: String(proc.stderr || '').trim().slice(-800),
    });
    if (!success) break; // 失败即停，后续命令依赖前者成功
  }

  const entry = {
    id: `prov-${String(ledger.installs.length + 1).padStart(2, '0')}`,
    at: nowIso(),
    packages: plan.packages,
    manager: plan.manager,
    browsersInstall: plan.browsersInstall,
    ...(pwVersion ? { playwrightVersion: pwVersion } : {}),
    purpose: purpose || '',
    ok,
    results,
  };
  ledger.installs.push(entry);
  saveProvision(archiveDir, ledger);

  const after = checkPlaywrightReady(root);
  return {
    status: ok ? 'installed' : 'install-failed',
    entryId: entry.id,
    results,
    readinessAfter: after,
    uninstallBlock: buildUninstallBlock(root, ledger),
    message: ok
      ? '安装完成，已记入台账 provision.json（最终报告会输出卸载说明）。'
      : '安装失败，失败命令与 stderr 尾部已记入台账（triage 建议 environment）。',
  };
}
