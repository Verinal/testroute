import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 引擎身份（版本锚）：package.json 版本 + build-skill.mjs 同步时生成的 buildinfo.js（构建时间戳）。
// 多宿主拷贝漂移的验尸依据——每份 result.json、init 事件与最终报告头都带这一行，
// 归档因此能回答「这场 run 是哪份拷贝、什么版本跑的」（真实事故：三个宿主三份拷贝，全部自称 0.2.0，
// 出事后只能靠 git log 和文件大小反推运行时引擎）。
function readPkgVersion() {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const v = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    return typeof v === 'string' && v ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

let build = 'dev';
try {
  ({ ENGINE_BUILD: build } = await import('./buildinfo.js'));
} catch {
  /* 仓库内开发运行：无 buildinfo.js（build-skill.mjs 组装可携包时才生成） */
}

export const ENGINE_VERSION = readPkgVersion();
export const ENGINE_BUILD = build;
export function engineIdentity() {
  return { name: 'testroute', version: ENGINE_VERSION, build: ENGINE_BUILD };
}
export function engineLabel() {
  return `testroute v${ENGINE_VERSION} build ${ENGINE_BUILD}`;
}
