// SCA 依赖漏洞扫描执行器：npm audit --json / pip-audit --format json。
// 用例模型：发现漏洞的包 = 一条 failed 用例（逐包定位）；干净清单 = 一条 passed 证据用例，
// 名称带「N 依赖/套件，0 漏洞」——否则报告里 0过/0败/0跳 分不清「扫了且干净」和「什么都没扫」。
// manifest 从项目根递归发现（排除产物目录，深度≤8）——前后端分离结构（frontend/package.json、
// backend/requirements.txt）同样能扫。npm≥7 无 lockfile 时 audit 必败，记警告跳过而不发必败命令。
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from '../run.js';
import { summarizeCases, emptySummary } from '../result.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', 'env', 'coverage', 'target',
  'vendor', '__pycache__', '.next', '.nuxt', '.idea', '.pytest_cache', 'site-packages',
  'test-archives', 'test-results', 'playwright-report',
]);
const MAX_MANIFESTS = 8;
const MAX_DEPTH = 8;

function viaText(via) {
  if (!Array.isArray(via)) return '';
  return via
    .map((v) => (typeof v === 'string' ? v : v?.title || v?.name || ''))
    .filter(Boolean)
    .join('; ')
    .slice(0, 300);
}

function relPosix(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

// pip-audit 的 JSON 有两种形状：{dependencies:[...]}（实际输出）与裸数组（旧解析假设），统一取依赖列表
function pipDepList(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.dependencies)) return data.dependencies;
  return null;
}

function npmDepTotal(data) {
  const t = data?.metadata?.dependencies?.total;
  return typeof t === 'number' && t > 0 ? t : null;
}

// 干净清单的通过证据用例：让「扫了且干净」在过/败计数里可见（名称携带扫描量）
function cleanManifestCase(kind, file, depCount) {
  const unit = kind === 'npm' ? '依赖' : '套件';
  const scope = typeof depCount === 'number' && depCount > 0 ? `${depCount} ${unit}，0 漏洞` : '0 漏洞';
  return {
    id: `sca::clean::${file || kind}`,
    name: `${kind}:${file || 'audit'}（${scope}）`,
    file: '',
    status: 'passed',
    durationMs: null,
    message: `${file || '依赖清单'} 审计完成，未发现已知漏洞`,
  };
}

function findManifests(root) {
  const list = [];
  let truncated = false;
  const push = (m) => {
    if (list.length >= MAX_MANIFESTS) {
      truncated = true;
      return;
    }
    list.push(m);
  };
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (files.has('package.json')) {
      push({
        kind: 'npm',
        dir,
        file: relPosix(root, path.join(dir, 'package.json')),
        hasLock: files.has('package-lock.json') || files.has('npm-shrinkwrap.json'),
      });
    }
    if (files.has('requirements.txt')) {
      push({ kind: 'pip', dir, file: relPosix(root, path.join(dir, 'requirements.txt')) });
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
      visit(path.join(dir, e.name), depth + 1);
    }
  };
  visit(root, 0);
  return { list, truncated };
}

export const sca = {
  id: 'sca',
  label: '依赖漏洞扫描 (SCA)',
  artifactName: null,

  async run({ root, timeoutMs = 300000 }) {
    const { list, truncated } = findManifests(root);
    const warnings = [];
    if (truncated) warnings.push(`依赖清单数量达到上限 ${MAX_MANIFESTS}，超出部分未扫描`);
    const scannable = [];
    for (const m of list) {
      if (m.kind === 'npm' && !m.hasLock) {
        warnings.push(`跳过 ${m.file}：无 package-lock.json / npm-shrinkwrap.json，npm audit 无法判定已安装版本`);
      } else {
        scannable.push(m);
      }
    }
    if (!scannable.length) {
      const cases = [
        {
          id: 'sca::no-manifest',
          name: '依赖清单缺失',
          file: '',
          status: 'failed',
          durationMs: null,
          message: truncated
            ? `依赖清单数量达到上限 ${MAX_MANIFESTS}，无法执行依赖扫描（triage 建议归因 environment 并 skipped）`
            : '项目根及子目录（深度≤8，已排除 node_modules 等产物目录）未发现可扫描的依赖清单（package.json 需配 lockfile；requirements.txt），无法执行依赖扫描（triage 建议归因 environment 并 skipped）',
        },
      ];
      return {
        proc: { exitCode: 1, stdout: '', stderr: 'sca: 未发现可扫描的依赖清单', timedOut: false, command: '(sca)' },
        parsed: {
          suites: [{ name: 'sca', cases }],
          summary: summarizeCases(cases),
          parseStatus: 'synthetic',
          artifacts: [],
          warnings,
        },
      };
    }

    const suites = [];
    const cases = [];
    const stdouts = [];
    const stderrs = [];
    const cmds = [];
    let exitCode = 0;
    let timedOut = false;
    let spawnError = null;
    let anyJson = false;

    for (const m of scannable) {
      const command = m.kind === 'npm' ? 'npm audit --json' : `pip-audit -r "${m.file}" --format json`;
      const cwd = m.kind === 'npm' ? m.dir : root;
      cmds.push(m.kind === 'npm' ? `${command} @ ${relPosix(root, m.dir) || '.'}` : command);
      const proc = await runCommand({ cwd, command, timeoutMs });
      const parsed = this.parse({ proc, manifest: m });
      const src = parsed.suites?.[0];
      if (src) {
        if (parsed.parseStatus === 'json') anyJson = true;
        const relDir = relPosix(root, m.dir);
        const prefix = relDir ? `[${relDir}] ` : '';
        const subCases = src.cases.map((c) => ({ ...c, file: m.file, message: `${prefix}${c.message}` }));
        suites.push({ name: `${src.name} @ ${m.file}`, cases: subCases });
        cases.push(...subCases);
      }
      warnings.push(...(parsed.warnings || []));
      stdouts.push(`----- ${m.file}（exit=${proc.exitCode}${proc.timedOut ? '，超时' : ''}）-----\n${proc.stdout || ''}`);
      if (proc.stderr) stderrs.push(`----- ${m.file} -----\n${proc.stderr}`);
      if (proc.timedOut) timedOut = true;
      if (proc.spawnError) {
        if (!spawnError) spawnError = proc.spawnError;
        // spawn 失败（扫描器不可用）必须 failed：空输出解析出 0 用例，exitCode 留 0 会被判成 passed-empty→passed
        exitCode = 1;
        if (!src) {
          cases.push({
            id: `sca::spawn-error::${m.file}`,
            name: `sca:${m.file}（扫描器不可用）`,
            file: m.file,
            status: 'failed',
            durationMs: null,
            message: `扫描器无法启动: ${proc.spawnError}`,
          });
        }
      }
      if (proc.exitCode !== 0 && proc.exitCode !== -1) exitCode = 1;
    }

    return {
      proc: {
        exitCode: timedOut ? -1 : exitCode,
        stdout: stdouts.join('\n'),
        stderr: stderrs.join('\n'),
        timedOut,
        ...(spawnError ? { spawnError } : {}),
        command: cmds.join(' ; '),
      },
      parsed: {
        suites,
        summary: cases.length ? summarizeCases(cases) : emptySummary(),
        parseStatus: anyJson ? 'json' : 'exit-code-only',
        artifacts: [],
        warnings,
      },
    };
  },

  parse({ proc, manifest }) {
    const text = proc.stdout || '';
    const file = manifest?.file || '';
    // 扫描器 stdout 可能被进度条字符污染（pip-audit 的 spinner 走 stdout），整段 parse 会失败——
    // 依次尝试原文与从首个 '[' / '{' 起的子串，命中即用；全失败才降级为 exit code 判定
    const attempts = [text];
    for (const i of [text.indexOf('['), text.indexOf('{')].filter((i) => i >= 0).sort((a, b) => a - b)) {
      if (i > 0 && !attempts.includes(text.slice(i))) attempts.push(text.slice(i));
    }
    for (const cand of attempts) {
      let data;
      try {
        data = JSON.parse(cand);
      } catch {
        continue;
      }
      if (data && typeof data === 'object' && data.vulnerabilities) {
        // npm audit --json：vulnerabilities 只含有漏洞的包
        const cases = Object.entries(data.vulnerabilities).map(([name, v]) => ({
          id: `sca::npm::${name}`,
          name: `npm:${name}`,
          file: '',
          status: 'failed',
          durationMs: null,
          message: `[${v?.severity || 'unknown'}] ${viaText(v?.via) || '存在已知漏洞'}`,
        }));
        if (!cases.length) cases.push(cleanManifestCase('npm', file, npmDepTotal(data)));
        return {
          suites: [{ name: 'npm-audit', cases }],
          summary: summarizeCases(cases),
          parseStatus: 'json',
          artifacts: [],
          warnings: [],
        };
      }
      const pipDeps = pipDepList(data);
      if (pipDeps) {
        // pip-audit --format json 实际输出 {dependencies:[...]} 对象（旧实现只认裸数组，导致整体解析
        // 失败被降级为 exit-code-only）；两种形状统一按 vulns 字段过滤，只给有漏洞的包建 failed 用例
        const cases = pipDeps
          .filter((dep) => Array.isArray(dep?.vulns) && dep.vulns.length > 0)
          .map((dep) => {
            const ids = (dep.vulns || []).map((v) => v?.id || '').filter(Boolean).join(', ');
            const fixes = (dep.fixes || [])
              .map((f) => `${f.name || ''} ${f.version || ''}`.trim())
              .filter(Boolean)
              .join(', ');
            return {
              id: `sca::pip::${dep.name}`,
              name: `pip:${dep.name}@${dep.version || ''}`,
              file: '',
              status: 'failed',
              durationMs: null,
              message: [ids || '存在已知漏洞', fixes ? `修复版本: ${fixes}` : ''].filter(Boolean).join('；'),
            };
          });
        if (!cases.length) cases.push(cleanManifestCase('pip', file, pipDeps.length));
        return {
          suites: [{ name: 'pip-audit', cases }],
          summary: summarizeCases(cases),
          parseStatus: 'json',
          artifacts: [],
          warnings: [],
        };
      }
    }
    // 降级警告写实际原因，不猜「可能未安装」误导 triage：stdout 空 → 附 stderr 摘要（扫描器不可用）；
    // 有输出但解析不了 → 附输出开头（一眼看出格式不符还是被截断）
    const trimmed = text.trim();
    const detail = trimmed
      ? `（输出开头: ${trimmed.slice(0, 80).replace(/\s+/g, ' ')}）`
      : `（stdout 为空，stderr 摘要: ${String(proc.stderr || '').trim().slice(0, 120) || '无'}）`;
    return {
      suites: [],
      summary: emptySummary(),
      parseStatus: 'exit-code-only',
      artifacts: [],
      warnings: [
        `扫描器输出无法解析为已知 JSON 格式（npm audit 对象 / pip-audit {dependencies:[...]}），按 exit code 判定；请结合 raw/ 日志核查${detail}`,
      ],
    };
  },
};
