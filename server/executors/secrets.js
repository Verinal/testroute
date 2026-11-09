// Secrets 敏感信息扫描执行器（内置零依赖）：扫描项目文件中的密钥/令牌泄露模式。
// 每个命中 = 一条 failed 用例（file:line 定位 + 打码片段）；干净扫描 = 一条 passed 证据用例
// （名称带「N 个文件，0 命中」），否则报告里 0过/0败/0跳 分不清「扫了且干净」和「什么都没扫」。
// 输出/依赖目录/测试产物跳过。误报（测试夹具、占位符）交给 triage 归因 test-bug，这里只负责"宁可多报、绝不漏报密钥"。
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { runCommand } from '../run.js';
import { summarizeCases, emptySummary } from '../result.js';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.venv', 'venv', 'env', 'coverage', 'target',
  'vendor', '__pycache__', '.next', '.nuxt', '.idea', '.pytest_cache', 'site-packages',
  'test-archives', 'test-results', 'playwright-report',
]);
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.jar', '.woff', '.woff2', '.ttf', '.mp4', '.mp3', '.lock',
]);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 4000;
const MAX_CASES = 100;

// 命中模式：id 前缀 → 正则。命中值会被打码后再写入结果。
const PATTERNS = [
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'AWS Access Key' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, label: '私钥块' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, label: 'JWT 令牌' },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, label: 'Slack 令牌' },
  { id: 'generic-secret', re: /\b(api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']([^"'\s]{8,})["']/gi, label: '硬编码凭据赋值', group: 2 },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9_-]{20,}\b/g, label: '硬编码 Bearer 令牌' },
];

// 高置信的误报豁免：占位符 / 环境变量引用 / 文档示例
const FALSE_POSITIVE = /process\.env|os\.environ|import\.meta\.env|getenv|YOUR[_A-Z]|your[-_]|example|placeholder|xxx+|<[^>]+>|\$\{|\{\{|\bchangeme\b|\bdummy\b|\btest[-_]?(key|secret|token|password)\b|xxxxxxxx|0123456789|dummy/i;

function mask(secret) {
  const s = String(secret);
  if (s.length <= 8) return '*'.repeat(s.length);
  return s.slice(0, 4) + '*'.repeat(Math.min(12, s.length - 8)) + s.slice(-4);
}

function isSensitiveEnvFile(root, rel) {
  const base = path.basename(rel);
  // 范本档（.env.example/.env.sample/.env.template/.env.dist）设计上就该入库，不是泄露
  if (/^\.env\.(example|sample|template|dist)$/i.test(base)) return false;
  if (!/^\.env/i.test(base)) return false;
  try {
    const probe = spawnSync('git', ['ls-files', '--', rel], { cwd: root, encoding: 'utf8', shell: false, windowsHide: true });
    return probe.status === 0 && String(probe.stdout).trim().length > 0;
  } catch {
    return false;
  }
}

function walkFiles(root) {
  const files = [];
  const visit = (dir, depth) => {
    if (depth > 12 || files.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.github')) continue;
        visit(abs, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (SKIP_EXT.has(ext)) continue;
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_BYTES) continue;
        files.push({ abs, rel: path.relative(root, abs).split(path.sep).join('/') });
      }
    }
  };
  visit(root, 0);
  return files;
}

function finishScan(cases, note, scanned = 0) {
  const warnings = [];
  if (note) warnings.push(note);
  if (cases.length === 0) {
    warnings.push('未发现密钥泄露模式（扫描 ≠ 安全保证：仅覆盖常见模式，不能替代人工审查）');
    // 干净扫描出一条 passed 证据用例：计数从「0过/0败/0跳」变成「1过」，名称带扫描量，报告可读
    cases.push({
      id: 'secrets::clean',
      name: `密钥扫描（${scanned} 个文件，0 命中）`,
      file: '',
      status: 'passed',
      durationMs: null,
      message: `扫描 ${scanned} 个文件未发现密钥泄露模式。扫描 ≠ 安全保证：仅覆盖常见模式，不能替代人工审查`,
    });
  }
  return {
    proc: {
      exitCode: cases.some((c) => c.status === 'failed') ? 1 : 0,
      stdout: cases.map((c) => `${c.status === 'failed' ? 'FAIL' : 'PASS'} | ${c.name}: ${c.message}`).join('\n') + '\n',
      stderr: '',
      timedOut: false,
      command: '(secrets 内置扫描)',
    },
    parsed: {
      suites: cases.length ? [{ name: 'secrets', cases }] : [],
      summary: cases.length ? summarizeCases(cases) : emptySummary(),
      parseStatus: 'builtin',
      artifacts: [],
      warnings,
    },
  };
}

export const secrets = {
  id: 'secrets',
  label: '密钥/敏感信息扫描',
  artifactName: null,

  buildCommand() {
    return null; // 内置扫描，无外部命令
  },

  async run({ root }) {
    const cases = [];
    let scanned = 0;
    for (const { abs, rel } of walkFiles(root)) {
      let text;
      try {
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue; // 二进制/非 UTF-8 跳过
      }
      scanned++;
      if (/\u0000/.test(text.slice(0, 2000))) continue;

      if (isSensitiveEnvFile(root, rel)) {
        cases.push({
          id: `secrets::env-tracked::${rel}`,
          name: `${rel}: .env 被 git 跟踪`,
          file: rel,
          status: 'failed',
          durationMs: null,
          message: '.env 文件被 git 跟踪（密钥会随仓库历史泄露）。应加入 .gitignore，仅保留 .env.example',
        });
      }

      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || FALSE_POSITIVE.test(line)) continue;
        for (const p of PATTERNS) {
          p.re.lastIndex = 0;
          let m;
          while ((m = p.re.exec(line)) !== null) {
            const raw = p.group ? m[p.group] : m[0];
            if (!raw || FALSE_POSITIVE.test(raw)) continue;
            cases.push({
              id: `secrets::${p.id}::${rel}::L${i + 1}`,
              name: `${rel}:${i + 1} ${p.label}`,
              file: rel,
              status: 'failed',
              durationMs: null,
              message: `第 ${i + 1} 行疑似 ${p.label}（已打码）: ${mask(raw)} —— 请核实；若为测试夹具/占位符，triage 归因 test-bug，并建议改用环境变量或假值模式（如 ${p.id === 'aws-key' ? 'AKIAIOSFODNN7EXAMPLE' : '占位符'}）`,
            });
            if (cases.length >= MAX_CASES) {
              return finishScan(cases, `命中数达到上限 ${MAX_CASES}，已截断`, scanned);
            }
          }
        }
      }
    }
    return finishScan(cases, null, scanned);
  },

  parse({ proc }) {
    // run() 已返回结构化结果；直接命令行调用时按行数兜底
    const stdout = String(proc.stdout || '');
    const failed = (stdout.match(/^FAIL \|/gm) || []).length;
    if (failed === 0) return { suites: [], summary: emptySummary(), parseStatus: 'exit-code-only', artifacts: [], warnings: [] };
    const cases = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.startsWith('FAIL |')) continue;
      const name = line.slice(6).split(':')[0] || 'secrets 命中';
      cases.push({ id: `secrets::line::${cases.length}`, name, file: '', status: 'failed', durationMs: null, message: line.slice(6) });
    }
    return {
      suites: [{ name: 'secrets', cases }],
      summary: summarizeCases(cases),
      parseStatus: 'stdout-lines',
      artifacts: [],
      warnings: [],
    };
  },
};
