// git 变更识别（增量友好）：基于 git status --porcelain，含未跟踪文件。
import { spawnSync } from 'node:child_process';
import { SOURCE_EXTS, looksLikeTestFile } from './detect.js';

function git(root, args) {
  const r = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return r;
}

export function isGitRepo(root) {
  const r = git(root, ['rev-parse', '--is-inside-work-tree']);
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

// 测试运行时的代码版本锚点：结果要能回答"这次全绿对应哪版代码"。
export function gitState(root) {
  if (!isGitRepo(root)) return null;
  const headRes = git(root, ['rev-parse', 'HEAD']);
  if (headRes.status !== 0) return null;
  const branchRes = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(root, ['status', '--porcelain=v1']);
  return {
    head: String(headRes.stdout).trim(),
    branch: String(branchRes.stdout || '').trim() || null,
    dirty: status.status === 0 ? String(status.stdout).trim().length > 0 : null,
  };
}

export function changedFiles(root) {
  if (!isGitRepo(root)) {
    return { isRepo: false, branch: null, items: [], summary: { note: '不是 git 仓库，无法做增量分析' } };
  }
  const branchRes = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(root, ['status', '--porcelain=v1']);
  if (status.status !== 0) {
    return { isRepo: true, branch: null, items: [], summary: { note: `git status 失败: ${status.stderr}` } };
  }

  const items = [];
  for (const line of String(status.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    let oldPath = null;
    const rename = /^[^ ]+ -> (.*)$/.exec(rest);
    if (rename) {
      oldPath = rest.slice(0, rename.index).trim();
      rest = rename[1];
    }
    items.push({ x, y, path: rest.replace(/^"|"$/g, ''), oldPath });
  }

  const summary = { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0, source: 0, tests: 0 };
  for (const it of items) {
    it.isTest = looksLikeTestFile(it.path);
    it.isSource = SOURCE_EXTS.has(
      it.path.includes('.') ? '.' + it.path.split('.').pop().toLowerCase() : ''
    );
    if (it.x === '?' || it.y === '?') summary.untracked++;
    else if (it.x === 'A' || it.y === 'A') summary.added++;
    else if (it.x === 'D' || it.y === 'D') summary.deleted++;
    else if (it.x === 'R' || it.y === 'R') summary.renamed++;
    else summary.modified++;
    if (it.isTest) summary.tests++;
    else if (it.isSource) summary.source++;
  }

  return {
    isRepo: true,
    branch: String(branchRes.stdout || '').trim() || null,
    // 宿主上下文预算：脏工作区可能上百条，内联只留前 50 条，全量由 git status 可随时再取
    items: items.slice(0, 50),
    truncated: items.length > 50,
    total: items.length,
    summary,
  };
}
