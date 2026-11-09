import path from 'node:path';
import fs from 'node:fs';
import { fail } from './validate.js';

export function resolveRoot(root) {
  const r = path.resolve(String(root));
  if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
    fail('E_NOT_FOUND', `项目根目录不存在或不是目录: ${r}`);
  }
  return r;
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

export function relFrom(root, p) {
  return toPosix(path.relative(root, p));
}

// pytest 的 junit XML 只有 classname（点号模块路径，相对 rootdir），没有 file 属性。
// 把点号模块路径还原为真实文件相对路径；classname 尾部可能带类名（类用例），逐级裁掉重试。
// 命中返回 { file, classes }（file 为 posix 相对路径，classes 为裁掉的类名段）；不命中返回 null。
export function resolveDottedModulePath(root, file) {
  const f = String(file || '').trim();
  if (!root || !f || path.isAbsolute(f) || f.includes('/') || f.includes('\\') || !f.includes('.')) return null;
  const parts = f.split('.');
  for (let drop = 0; drop < Math.min(2, parts.length); drop++) {
    const segs = parts.slice(0, parts.length - drop);
    if (!segs.length) break;
    const candidate = path.join(root, ...segs) + '.py';
    try {
      if (fileExists(candidate)) {
        return { file: relFrom(root, candidate), classes: parts.slice(parts.length - drop) };
      }
    } catch {
      /* 路径非法继续裁下一级 */
    }
  }
  return null;
}

export function slug(s, maxLen = 30) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

export function nowStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function nowIso(d = new Date()) {
  return d.toISOString();
}

export function archivesDir(root) {
  return path.join(root, 'test-archives');
}

export function listArchives(root) {
  const dir = archivesDir(root);
  if (!fs.existsSync(dir)) return [];
  // 按 manifest.json 的 mtime（最近活跃）降序，而非目录名——同一秒创建的归档按名字排序会颠倒
  // 真实先后（如 "e2e-fail" < "e2e-http"），导致缺省解析落到旧归档。名字仅作 tie-break。
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      let t = 0;
      try {
        t = fs.statSync(path.join(dir, e.name, 'manifest.json')).mtimeMs;
      } catch {
        t = 0; // 无 manifest 的残目录排最后
      }
      return { name: e.name, t };
    })
    .sort((a, b) => b.t - a.t || (a.name < b.name ? 1 : -1))
    .map((x) => x.name);
}

export function findLatestArchive(root) {
  const names = listArchives(root);
  if (names.length === 0) return null;
  return path.join(archivesDir(root), names[0]);
}

// 归档目录解析（不存在返回 null，由调用方决定报错还是忽略）。
export function resolveArchiveDir(root, archiveDir = '') {
  if (archiveDir) {
    const d = path.isAbsolute(archiveDir) ? archiveDir : path.join(archivesDir(root), archiveDir);
    return fs.existsSync(d) ? d : null;
  }
  return findLatestArchive(root);
}

export function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    fail('E_CORRUPT', `JSON 文件解析失败: ${p}（${e.message}）`);
  }
}

export function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return p;
}

export function fileExists(p) {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}
