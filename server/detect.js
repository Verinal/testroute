// 项目地图扫描：给 LLM 规划路线用的压缩摘要（不回传源码内容，控制上下文预算）。
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { toPosix } from './paths.js';
import { scanApiSurface } from './apimap.js';
import { inspectTestfile } from './testfile.js';

export const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', 'env',
  '__pycache__', '.idea', '.vscode', 'coverage', 'target', 'vendor',
  '.next', '.nuxt', '.pytest_cache', '.mypy_cache', 'site-packages', '.tox',
]);

export const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.go', '.java', '.kt', '.cs', '.rb', '.php',
]);

export function looksLikeTestFile(relPath) {
  const segs = relPath.split('/');
  const base = segs[segs.length - 1];
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  if (/^(test|spec)_[^/]*\.py$|[^/]*_(test|spec)\.py$|^conftest\.py$/i.test(base)) return true;
  if (/_(test|spec)\.go$|_test\.rs$/i.test(base)) return true;
  if (/(Test|Tests|IT)\.(java|kt)$/i.test(base)) return true;
  // 位于 tests / test / __tests__ / spec(s) 目录中的任何文件
  for (let i = 0; i < segs.length - 1; i++) {
    if (/^(tests?|__tests__|specs?)$/i.test(segs[i])) return true;
  }
  return false;
}

function tryCmd(cmd, args) {
  try {
    const r = spawnSync(`${cmd} ${args.join(' ')}`, {
      timeout: 6000,
      shell: process.platform === 'win32',
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status === 0) {
      return { available: true, version: String(r.stdout || '').split(/\r?\n/)[0].slice(0, 60) };
    }
    return { available: false };
  } catch {
    return { available: false };
  }
}

function walk(root, cb, { maxFiles = 8000, maxDepth = 12 } = {}) {
  let count = 0;
  const visit = (dir, depth) => {
    if (depth > maxDepth || count >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= maxFiles) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name.startsWith('.') && e.name !== '.github') continue;
        visit(abs, depth + 1);
      } else if (e.isFile()) {
        count++;
        cb(toPosix(path.relative(root, abs)), abs);
      }
    }
  };
  visit(root, 0);
  return count;
}

// 供 apimap 等模块复用：列出项目内全部文件（相对 posix 路径）
export function listProjectFiles(root, { maxFiles = 8000 } = {}) {
  const files = [];
  walk(root, (rel) => files.push(rel), { maxFiles });
  return files;
}

function readPkgJson(root) {
  const p = path.join(root, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readTextIfExists(p) {
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

function detectTestFrameworks(root, pkg) {
  const found = new Set();
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const fw of ['vitest', 'jest', 'mocha', '@playwright/test', 'cypress', '@vue/test-utils']) {
    if (deps[fw]) found.add(fw.replace(/^@/, '').replace('/', ':'));
  }
  const pyText =
    readTextIfExists(path.join(root, 'requirements.txt')) +
    readTextIfExists(path.join(root, 'pyproject.toml')) +
    readTextIfExists(path.join(root, 'setup.py'));
  if (/pytest/i.test(pyText)) found.add('pytest');
  if (fs.existsSync(path.join(root, 'go.mod'))) found.add('go-test');
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) found.add('cargo-test');
  return [...found];
}

function detectPackageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(root, 'package-lock.json'))) return 'npm';
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return 'bun';
  return null;
}

// 前端信号：决定是否建议开启 browser-e2e（写 specials）。dep/构建器/框架文件/组件扩展名任一命中即算。
// pkg/files 缺省时自行探测（browserE2eSuggested 等调用方手上没有现成扫描结果）。
export function detectFrontend(root, pkg, files) {
  const signals = [];
  pkg = pkg === undefined ? readPkgJson(root) : pkg;
  if (!Array.isArray(files)) {
    files = [];
    walk(root, (rel) => files.push(rel));
  }
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  for (const key of ['react', 'vue', 'svelte', '@angular/core', 'next', 'nuxt', 'preact', 'solid-js']) {
    if (deps[key]) signals.push(`dep:${key}`);
  }
  for (const key of ['vite', 'webpack', '@vue/cli-service', '@angular-devkit/build-angular', 'rollup', 'esbuild']) {
    if (deps[key]) signals.push(`bundler:${key}`);
  }
  for (const f of ['index.html', 'vite.config.js', 'vite.config.ts', 'webpack.config.js', 'next.config.js', 'nuxt.config.ts', 'angular.json']) {
    if (files.includes(f)) signals.push(`file:${f}`);
  }
  // 子目录里的页面入口也算前端信号（如 public/index.html 静态页）
  const htmlIndex = files.find((f) => /^(public|src|app|pages|static|www)\/index\.html$/i.test(f));
  if (htmlIndex) signals.push(`file:${htmlIndex}`);
  const uiFiles = files.filter((f) => /\.(tsx|jsx|vue|svelte)$/i.test(f)).slice(0, 5);
  if (uiFiles.length) signals.push(`files:${uiFiles.join(', ')}`);
  return { detected: signals.length > 0, signals: signals.slice(0, 12) };
}

// Node 项目定位：根目录本身，其次一层子目录里的 package.json / node_modules（monorepo /
// 前端子项目布局，如 FastAPI 后端在根、frontend/ 持有 package.json）。只下一层，不做全树扫描。
export function nodeProjectDirs(root) {
  const dirs = [];
  if (fs.existsSync(path.join(root, 'package.json')) || fs.existsSync(path.join(root, 'node_modules'))) dirs.push(root);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return dirs; // 根都读不了 → 只有根候选
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const child = path.join(root, e.name);
    if (fs.existsSync(path.join(child, 'package.json')) || fs.existsSync(path.join(child, 'node_modules'))) dirs.push(child);
  }
  return dirs;
}

// 从项目 node_modules 读 playwright 系包版本（复现指南与依赖台账用；读不到返回 null）。
// 依次看根与一层子项目目录（monorepo 布局 playwright 常装在 frontend/ 等子目录）。
export function playwrightVersionFromNodeModules(root) {
  for (const dir of nodeProjectDirs(root)) {
    for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
      try {
        const pkgPath = path.join(dir, 'node_modules', ...name.split('/'), 'package.json');
        const v = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
        if (v) return String(v);
      } catch {}
    }
  }
  return null;
}

// browser-e2e 可行性：项目声明了 playwright 或本机 npx 可跑；尽量带上版本号
function detectPlaywright(root, pkg) {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  if (deps['playwright'] || deps['@playwright/test'] || deps['playwright-core']) {
    const version = playwrightVersionFromNodeModules(root);
    return { available: true, via: 'package.json', ...(version ? { version } : {}) };
  }
  const probe = tryCmd('npx', ['--no-install', 'playwright', '--version']);
  const version = probe.available ? probe.version || null : playwrightVersionFromNodeModules(root);
  return { available: probe.available, via: probe.available ? 'npx' : null, ...(version ? { version } : {}) };
}

export function scanProject(root) {
  const pkg = readPkgJson(root);
  const files = [];
  const total = walk(root, (rel) => files.push(rel));

  const extHist = {};
  const testFiles = [];
  const sourceFiles = [];
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase();
    if (ext) extHist[ext] = (extHist[ext] || 0) + 1;
    if (looksLikeTestFile(rel)) testFiles.push(rel);
    else if (SOURCE_EXTS.has(ext)) sourceFiles.push(rel);
  }

  // 测试分布：按顶层目录聚组
  const byDir = {};
  for (const rel of testFiles) {
    const top = rel.includes('/') ? rel.split('/')[0] : '.';
    byDir[top] = byDir[top] || { dir: top, count: 0, samples: [] };
    byDir[top].count++;
    if (byDir[top].samples.length < 5) byDir[top].samples.push(rel);
  }

  // 源码分布
  const srcByDir = {};
  for (const rel of sourceFiles) {
    const top = rel.includes('/') ? rel.split('/')[0] : '.';
    srcByDir[top] = (srcByDir[top] || 0) + 1;
  }

  const manifests = {
    packageJson: !!pkg,
    pyproject: fs.existsSync(path.join(root, 'pyproject.toml')),
    requirementsTxt: fs.existsSync(path.join(root, 'requirements.txt')),
    goMod: fs.existsSync(path.join(root, 'go.mod')),
    cargoToml: fs.existsSync(path.join(root, 'Cargo.toml')),
    pomXml: fs.existsSync(path.join(root, 'pom.xml')),
    gradle: fs.existsSync(path.join(root, 'build.gradle')) || fs.existsSync(path.join(root, 'build.gradle.kts')),
    csproj: files.filter((f) => f.endsWith('.csproj')).slice(0, 5),
    dockerCompose: fs.existsSync(path.join(root, 'docker-compose.yml')) || fs.existsSync(path.join(root, 'docker-compose.yaml')),
    ci: ['.github/workflows', '.gitlab-ci.yml', '.circleci'].some((p) => fs.existsSync(path.join(root, p))),
  };

  const scripts = {};
  if (pkg?.scripts) {
    for (const [k, v] of Object.entries(pkg.scripts)) {
      if (/test|e2e|smoke|check/i.test(k)) scripts[k] = v;
    }
  }

  let runtime = null;
  if (manifests.packageJson) runtime = 'node';
  else if (manifests.pyproject || manifests.requirementsTxt) runtime = 'python';
  else if (manifests.goMod) runtime = 'go';
  else if (manifests.cargoToml) runtime = 'rust';
  else if (manifests.pomXml || manifests.gradle) runtime = 'java';
  else if (manifests.csproj.length) runtime = 'dotnet';

  const readiness = {
    node: tryCmd('node', ['--version']),
    npm: tryCmd('npm', ['--version']),
    python: tryCmd('python', ['--version']),
    py: tryCmd('py', ['--version']),
    git: tryCmd('git', ['--version']),
    docker: tryCmd('docker', ['--version']),
  };

  const frontend = detectFrontend(root, pkg, files);
  const playwrightReady = detectPlaywright(root, pkg);
  readiness.playwright = playwrightReady;

  // API 端点面盘点：静态解析路由定义（FastAPI/Flask/Express/Fastify/OpenAPI），
  // 作为路线深度门禁与报告「盘点 vs 实测」覆盖对照的基准
  let apiSurface = { schemaVersion: 1, total: 0, protectedCount: 0, publicCount: 0, modules: [], endpoints: [], sources: [], scannedFiles: 0 };
  try {
    apiSurface = scanApiSurface(root, files);
  } catch {
    /* 盘点失败不阻塞扫描，按无 API 处理 */
  }

  // 前端页面面盘点：页面/路由清单（Next 约定、pages/views 目录、静态 html、路由表绝对路径），
  // 作为 browser-e2e 页面覆盖门禁与报告「页面覆盖对照」的基准
  let webSurface = { schemaVersion: 1, total: 0, pages: [], sources: [] };
  if (frontend.detected) {
    try {
      webSurface = scanWebSurface(root, files);
    } catch {
      /* 盘点失败不阻塞扫描 */
    }
  }

  // 约定资料夹 .testfile/（仅根目录生效）：有就取用，没有就不提
  let testfile = null;
  try {
    testfile = inspectTestfile(root);
  } catch {
    /* 检测失败不阻塞扫描 */
  }

  const warnings = [];
  if (apiSurface.total > 0 && testFiles.length === 0) {
    warnings.push(`盘点到 ${apiSurface.total} 个 API 端点（${apiSurface.modules.length} 个模块）但项目无测试文件：全流程路线必须覆盖功能主流程 + negative + boundary（受保护端点还须 authz），由 save_route 深度门禁强制`);
  }
  if (testfile) {
    warnings.push(`检测到约定资料夹 .testfile/（${testfile.totalFiles} 个文件${testfile.truncated ? '，清单截断' : ''}）：其中数据/配置生成用例时优先取用（只读，勿改），说明类文件（readme/要求等）视为用户的测试要求，规划路线前必读`);
  }
  if (total >= 8000) warnings.push(`文件数达到扫描上限（${total}+），分布统计为抽样估计`);
  if (runtime === 'node' && !fs.existsSync(path.join(root, 'node_modules'))) {
    warnings.push('未发现 node_modules，执行测试前可能需要安装依赖');
  }
  if (runtime === 'python' && !readiness.python.available && !readiness.py.available) {
    warnings.push('未检测到可用的 python 解释器');
  }
  if (frontend.detected && !playwrightReady.available) {
    warnings.push('检测到前端项目但 playwright 不可用：browser-e2e 前用 testroute_provision_deps 安装 playwright（浏览器按「编辑器内置 CDP > 系统 Chrome/Edge > chromium 缓存 > 下载（最后）」优先级获取，不要自行 npx playwright install）');
  }

  const sortedExt = Object.entries(extHist)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ext, n]) => ({ ext, count: n }));

  const entryHints = [];
  if (pkg?.main) entryHints.push(pkg.main);
  for (const cand of ['src/index.ts', 'src/index.js', 'src/main.ts', 'src/main.py', 'index.js', 'main.py', 'app.py']) {
    if (fs.existsSync(path.join(root, cand))) entryHints.push(cand);
  }

  return {
    schemaVersion: 1,
    root,
    name: pkg?.name || path.basename(root),
    runtime,
    techStack: {
      runtime,
      packageManager: detectPackageManager(root),
      testFrameworks: detectTestFrameworks(root, pkg),
      buildTool: manifests.gradle ? 'gradle' : manifests.pomXml ? 'maven' : manifests.cargoToml ? 'cargo' : null,
    },
    manifests,
    npmTestScripts: scripts,
    entryHints,
    frontend,
    apiSurface,
    webSurface,
    testfile,
    languageHistogram: sortedExt,
    fileStats: { walked: total, sourceFiles: sourceFiles.length, testFiles: testFiles.length },
    existingTests: {
      total: testFiles.length,
      byDir: Object.values(byDir)
        .sort((a, b) => b.count - a.count)
        .slice(0, 40),
    },
    sourceLayout: Object.entries(srcByDir)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([dir, count]) => ({ dir, sourceFileCount: count })),
    readiness,
    warnings,
    scannedAt: new Date().toISOString(),
  };
}

// ---------- 前端页面面盘点（webSurface）----------
// browser-e2e 页面覆盖门禁的基准：「前端有哪些页面/路由」与「实测访问过哪些」对照。
// 宁缺勿错：只认高置信来源（Next.js 页面约定、pages/views 目录约定、静态 html、路由文件里的绝对路径声明），
// 解析不了就少报——误报页面会变成永远测不到的假覆盖缺口。
export const WEBSURFACE_MAX_PAGES = 500;

function collapsePageSeg(seg) {
  if (/^\[\.{0,3}[^\]]*\]$/.test(seg)) return '{p}'; // Next.js [id] / [...slug]
  if (/^[:*][\w.-]*$/.test(seg)) return '{p}'; // React/Vue :id / *path
  if (/^\{.+\}$/.test(seg)) return '{p}';
  return seg;
}

// 页面路径归一化（导出给豁免匹配用）：去 query/hash、参数段折叠为 {p}，与盘点/上报同一口径
export function normalizePagePath(rawPath) {
  let p = String(rawPath || '').split(/[?#]/)[0].trim();
  if (!p || !p.startsWith('/')) return null; // 相对路径段无法独立定位 → 不要（宁缺勿错）
  const parts = p.split('/').map(collapsePageSeg).filter((s) => s !== '');
  return '/' + parts.join('/');
}

const APP_PAGE_RE = /(^|\/)app\/(.+)\/page\.[cm]?[jt]sx?$/i;
const PAGES_DIR_RE = /(?:^|\/)(pages|views)\/(.+)\.(tsx|jsx|vue|svelte)$/i;
const HTML_RE = /^(?:(public|static|www)\/)?[^/]*\.html$/i;
const ROUTER_FILE_RE = /(^|\/)(router|routes|app|App|main|Root|Layout)\.[cm]?[jt]sx?$/i;
const ROUTER_INDICATOR_RE = /createBrowserRouter|createWebHistory|createWebHashHistory|<Routes[\s>]|<Route[\s]|new VueRouter|new Router\(|routes\s*:\s*\[/;
const ROUTE_PATH_RE = /\bpath\s*[:=]\s*["'`]([^"'`\n]+)["'`]/g;

export function scanWebSurface(root, relFiles) {
  const pages = new Map();
  let read = 0;
  // pages/views 目录约定先暂存（defer）：目录里的 modal/子组件会被目录约定误判成页面，
  // 等路由表解析完按「是否被路由 import 引用」过滤后再落榜（路由表 ≥3 页时才过滤）。
  const pagesDirEntries = [];
  const addPage = (rawPath, file, source, defer = false) => {
    const norm = normalizePagePath(rawPath);
    if (!norm || norm === '/*') return;
    if (pages.size >= WEBSURFACE_MAX_PAGES) return;
    if (defer) {
      if (pages.size + pagesDirEntries.length < WEBSURFACE_MAX_PAGES) pagesDirEntries.push({ path: norm, file, source });
      return;
    }
    if (!pages.has(norm)) pages.set(norm, { path: norm, file, source });
  };

  for (const rel of relFiles) {
    // 1) Next.js app 路由约定：app/**/page.tsx（段里排除 api 与圆括号分组）
    const appM = APP_PAGE_RE.exec(rel);
    if (appM) {
      const segs = appM[2]
        .split('/')
        .filter((s) => s && s !== 'api' && !/^\(.*\)$/.test(s));
      addPage('/' + segs.join('/'), rel, 'next-app-router');
      continue;
    }
    // 2) pages/views 目录约定（Next pages 路由 / Nuxt / 手写路由的页面目录，目录深度 ≤ 3）
    const pagesM = PAGES_DIR_RE.exec(rel);
    if (pagesM) {
      const before = rel.slice(0, pagesM.index).split('/').filter(Boolean);
      if (before.length <= 3) {
        const rest = pagesM[2].split('/');
        if (rest.some((s) => s === 'api' || /^_(app|document|layout|error|loader)$/.test(s))) continue;
        const base = rest[rest.length - 1].replace(/\.(tsx|jsx|vue|svelte)$/i, '');
        const segs = [...rest.slice(0, -1), ...(base === 'index' ? [] : [base])];
        addPage('/' + segs.join('/'), rel, `${pagesM[1]}-dir`, true);
      }
      continue;
    }
    // 3) 静态 html 页（根目录 / public|static|www 下）；index.html → /
    const htmlM = HTML_RE.exec(rel);
    if (htmlM) {
      const inPublicDir = /^(public|static|www)$/i.test(htmlM[1] || '');
      const base = (inPublicDir ? rel.replace(/^(public|static|www)\//i, '') : rel).replace(/\.html$/i, '');
      addPage(base === 'index' ? '/' : '/' + base, rel, 'static-html');
      continue;
    }
  }

  // 4) 路由文件解析（React/Vue 路由表里的路径声明）：只读候选文件名/router 目录，读前先查线索。
  // 嵌套路由的相对子段（react-router: 父 path="/" 内的 path="home"）挂到最近一个已声明的绝对
  // 父路径下组合——SPA 手写路由里这是常态，只认绝对路径会把真实页面漏光。
  let lastAbs = null;
  for (const rel of relFiles) {
    if (read >= 60 || pages.size >= WEBSURFACE_MAX_PAGES) break;
    if (!/\.[cm]?[jt]sx?$/i.test(rel) && !/\.vue$/i.test(rel)) continue;
    if (!/(^|\/)(router|routes)(\/|\.)/i.test(rel) && !ROUTER_FILE_RE.test(rel)) continue;
    try {
      const abs = path.join(root, rel);
      const st = fs.statSync(abs);
      if (st.size > 256 * 1024) continue;
      const content = fs.readFileSync(abs, 'utf8');
      read++;
      if (!ROUTER_INDICATOR_RE.test(content)) continue;
      for (const m of content.matchAll(ROUTE_PATH_RE)) {
        const raw = m[1];
        if (raw.startsWith('/')) {
          addPage(raw, rel, 'router-config');
          const norm = normalizePagePath(raw);
          if (norm) lastAbs = norm;
        } else if (lastAbs) {
          addPage(lastAbs.replace(/\/+$/, '') + '/' + raw, rel, 'router-config');
        }
      }
    } catch {
      /* 读不了就跳过 */
    }
  }

  // 5) pages/views 目录条目落榜：路由表已给出 ≥3 个页面时，目录约定整体让位——手写 SPA 的
  // components/pages/ 目录里文件名≠路由（HomePage 的真实路由是 /home），按文件名派生的路径
  // 只会造出假页面（真实案例：16 个组件/弹窗被当成页面，全靠豁免表遮盖）。
  // 路由表缺失或解析不动（<3 页）时目录约定全量保留（Next pages / Nuxt 的文件即路由）。
  const routerPageCount = [...pages.values()].filter((e) => e.source === 'router-config').length;
  if (routerPageCount < 3) {
    for (const entry of pagesDirEntries) {
      if (!pages.has(entry.path)) pages.set(entry.path, entry);
    }
  }

  const list = [...pages.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    schemaVersion: 1,
    total: list.length,
    pages: list,
    sources: [...new Set(list.map((e) => e.source))],
    scannedAt: new Date().toISOString(),
  };
}

// webSurface 数据源：优先归档里的 project-map.json（scan_project 在归档存在时写入），
// 缺失时对项目根现场扫描兜底。页面覆盖门禁与最终报告对照段用它；读不到返回 null。
export function loadWebSurface(root, archiveDir) {
  try {
    const mapPath = path.join(archiveDir, 'project-map.json');
    if (fs.existsSync(mapPath)) {
      const map = readJsonMap(mapPath);
      if (map?.webSurface && Array.isArray(map.webSurface.pages)) {
        return map.webSurface.total > 0 ? map.webSurface : null; // 已扫描确认无页面 → null
      }
    }
  } catch {
    /* 地图缺失/损坏 → 现场扫描 */
  }
  try {
    const relFiles = listProjectFiles(root);
    const surface = scanWebSurface(root, relFiles);
    return surface.total > 0 ? surface : null;
  } catch {
    return null;
  }
}

function readJsonMap(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
