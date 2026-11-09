// 约定资料夹 `.testfile/`（仅项目根目录生效）：用户往里放任何测试资料/配置/要求，
// TestRoute 检测到就取用，没有就当不存在（兼容，不追问不报错）。只读不改——
// 生成的用例仍进沙箱，读这里的文件一律经 TESTROUTE_TESTFILE_DIR 环境变量。
import path from 'node:path';
import fs from 'node:fs';
import { toPosix } from './paths.js';

export const TESTFILE_DIR = '.testfile';

const MAX_LIST = 200;           // 文件清单上限（防超大资料夹撑爆地图）
const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // 清单统计口径，超过不截断只标记
const INSTRUCTION_MAX_FILES = 4; // 说明类文件最多内联几份
const INSTRUCTION_MAX_BYTES = 4 * 1024;  // 单份说明类文件内联上限

// 说明类文件：顶层（含一级子目录）的 md/txt —— 用户的「要求」通常写在这里，内联进地图让规划时必见
const INSTRUCTION_RE = /(^|\/)(readme|instruction|instructions|requirement|requirements|notes?|说明|要求|约定)\.(md|txt|markdown)$/i;

function statSize(abs) {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

// 递归列 `.testfile/` 全部文件（相对 posix 路径 + 字节数）
export function listTestfiles(root) {
  const base = path.join(root, TESTFILE_DIR);
  let st;
  try {
    st = fs.statSync(base);
  } catch {
    return null;
  }
  if (!st.isDirectory()) return null;

  const files = [];
  let truncated = false;
  const visit = (dir, rel) => {
    if (files.length >= MAX_LIST) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX_LIST) {
        truncated = true;
        return;
      }
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(dir, e.name);
      if (e.isDirectory()) visit(childAbs, childRel);
      else if (e.isFile()) files.push({ path: childRel, size: statSize(childAbs) });
    }
  };
  visit(base, '');
  const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
  return {
    present: true,
    dir: TESTFILE_DIR,
    files,
    totalFiles: files.length,
    totalBytes,
    truncated,
  };
}

// 内联说明类文件内容（截断标注），让「要求」直接出现在扫描结果里
export function inlineInstructions(root, listing) {
  if (!listing) return undefined;
  const picked = listing.files
    .filter((f) => INSTRUCTION_RE.test(f.path) && f.size <= INSTRUCTION_MAX_BYTES)
    .slice(0, INSTRUCTION_MAX_FILES);
  const out = [];
  for (const f of picked) {
    let content = '';
    try {
      content = fs.readFileSync(path.join(root, TESTFILE_DIR, ...f.path.split('/')), 'utf8');
    } catch {
      continue;
    }
    if (content.length > INSTRUCTION_MAX_BYTES) content = content.slice(0, INSTRUCTION_MAX_BYTES) + `…(截断，全文读 ${TESTFILE_DIR}/${f.path})`;
    out.push({ path: f.path, content: content.trim() });
  }
  return out.length ? out : undefined;
}

// 汇总入口：无文件夹 → null；有 → { present, dir, files, totalFiles, totalBytes, truncated, instructions? }
export function inspectTestfile(root) {
  const listing = listTestfiles(root);
  if (!listing) return null;
  const instructions = inlineInstructions(root, listing);
  return instructions ? { ...listing, instructions } : listing;
}

// 归档留痕：把当时用到的资料夹快照（路径+大小清单）写进归档，保证报告可对账
export function testfileManifest(root) {
  const listing = listTestfiles(root);
  if (!listing) return null;
  return { capturedAt: new Date().toISOString(), dir: TESTFILE_DIR, ...listing };
}

// 沙箱脚本读取资料的安全提示路径：绝对路径给环境变量用
export function testfileAbsDir(root) {
  return path.join(root, TESTFILE_DIR);
}

export function testfileRelPath(root, abs) {
  return toPosix(path.relative(root, abs));
}
