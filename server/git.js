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

// 全流程门禁用（scope=full 的 regression 纳入判定）：工作区是否存在「真实源码变更」。
// 不走 changedFiles（items 截断 50 条，截断后无法可靠判定），直接全量 porcelain 逐行核对：
// untracked（??）不计（测试产物/归档随时新增，不代表源码被改）；
// 排除 test-archives/** 与 exclude 列表（provision 台账记录的安装/改动路径——playwright 安装自己触发的假阳性）。
export function hasTrackedChanges(root, exclude = []) {
  if (!isGitRepo(root)) return false;
  const status = git(root, ['status', '--porcelain=v1']);
  if (status.status !== 0) return false;
  const excl = new Set(exclude.map((p) => String(p)));
  for (const line of String(status.stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const x = line[0];
    const y = line[1];
    if (x === '?' || y === '?') continue;
    let rest = line.slice(3);
    const rename = /^[^ ]+ -> (.*)$/.exec(rest);
    if (rename) rest = rename[1];
    const p = rest.replace(/^"|"$/g, '');
    if (excl.has(p)) continue;
    if (p === 'test-archives' || p.startsWith('test-archives/')) continue;
    return true;
  }
  return false;
}
