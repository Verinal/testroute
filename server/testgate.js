// 测试脚本只读门禁（哈希锚定）：归档创建时对项目自有测试文件做 sha256 快照，
// 阶段标 passed / finalize 前验证未被修改或删除。TestRoute 生成的用例一律进沙箱
// （test-archives/<id>/sandbox/），不在此快照范围内 —— 项目自己的测试脚本对 testroute 只读。
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fail } from './validate.js';
import { IGNORE_DIRS, looksLikeTestFile } from './detect.js';
import { readJson, writeJson, nowIso } from './paths.js';

export const TESTGATE_FILE = 'testfile-hashes.json';
const MAX_FILES = 3000;
const MAX_DEPTH = 12;

function walkTestFiles(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= MAX_FILES) return;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || e.name === 'test-archives' || (e.name.startsWith('.') && e.name !== '.github')) continue;
        visit(abs, depth + 1);
      } else if (e.isFile()) {
        const rel = path.relative(root, abs).split(path.sep).join('/');
        if (looksLikeTestFile(rel)) found.push({ rel, abs });
      }
    }
  };
  visit(root, 0);
  return found;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

export function hashTestFiles(root) {
  const files = {};
  for (const { rel, abs } of walkTestFiles(root)) {
    try {
      files[rel] = sha256File(abs);
    } catch {
      /* 不可读文件跳过（权限等），不阻塞归档 */
    }
  }
  return files;
}

export function testGatePath(archiveDir) {
  return path.join(archiveDir, TESTGATE_FILE);
}

// 归档创建时调用：快照当前项目自有测试文件基线
export function snapshotTestGate(root, archiveDir) {
  const files = hashTestFiles(root);
  writeJson(testGatePath(archiveDir), {
    schemaVersion: 1,
    capturedAt: nowIso(),
    root,
    fileCount: Object.keys(files).length,
    truncatedNote: Object.keys(files).length >= MAX_FILES ? `扫描达到上限 ${MAX_FILES} 个测试文件，基线为抽样估计` : null,
    files,
  });
  return Object.keys(files).length;
}

export function loadTestGate(archiveDir) {
  return readJson(testGatePath(archiveDir));
}

// 验证基线未被修改/删除。新增文件不算违规（可能是用户自己的工作）。
export function verifyTestGate(root, archiveDir) {
  const baseline = loadTestGate(archiveDir);
  if (!baseline) return { ok: true, enforced: false, modified: [], deleted: [], note: '无基线（旧归档），跳过验证' };
  const current = hashTestFiles(root);
  const modified = [];
  const deleted = [];
  for (const [rel, hash] of Object.entries(baseline.files)) {
    if (!(rel in current)) deleted.push(rel);
    else if (current[rel] !== hash) modified.push(rel);
  }
  return { ok: modified.length === 0 && deleted.length === 0, enforced: true, modified, deleted };
}

// 用户知情后显式确认变更（allowTestFileChanges=true）→ 重建基线，后续以此为准
export function acknowledgeTestGate(root, archiveDir) {
  const count = snapshotTestGate(root, archiveDir);
  return { acknowledged: true, baselineRebuilt: true, fileCount: count };
}

export function gateViolationError(phaseId, violation) {
  const fmt = (list) => list.slice(0, 20).join('\n  - ') + (list.length > 20 ? `\n  - …共 ${list.length} 个` : '');
  const parts = [];
  if (violation.modified.length) parts.push(`被修改:\n  - ${fmt(violation.modified)}`);
  if (violation.deleted.length) parts.push(`被删除:\n  - ${fmt(violation.deleted)}`);
  return fail(
    'E_GATE',
    `项目自有测试脚本被改动（门禁：测试脚本对 TestRoute 只读，生成的用例必须放沙箱 test-archives/<归档>/sandbox/）。` +
      `${phaseId ? `阶段 "${phaseId}" 不能标 passed。` : '不能生成最终报告。'}\n` +
      `${parts.join('\n')}\n` +
      `请还原这些文件，或确认改动来自用户本人后，带 allowTestFileChanges=true / acknowledgeTestFileChanges=true 重新调用（将记录确认事件并重建基线）。`
  );
}
