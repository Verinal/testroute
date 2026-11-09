#!/usr/bin/env node
// TestRoute 可攜 CLI 入口——与 server/index.js（MCP stdio）共用同一套工具层，
// 让宿主不经 MCP 注册、直接用 Bash 调用 13 个测试领域工具。
// 用法:
//   node cli.js <tool> [--root <项目根>] [--args '<json>' | --args @<args.json>] [--list]
//   <tool> 可写短名（scan_project）或全名（testroute_scan_project）。
//   复杂参数（route 对象、含中文/嵌套结构）建议写进 JSON 档用 --args @file 传入，
//   避免 Windows shell 引号转义问题；参数档放系统暂存目录或归档内，不要落项目根。
// stdout: 工具载荷原文（与 MCP 返回的 text 完全一致）；日志/错误走 stderr。
// 退出码: 0=成功  1=工具错误（[E_*] 前缀，报错文本即正确出路）  2=用法错误
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_DEFS, callTool } from './server/tools.js';

const USAGE = `TestRoute CLI（零依赖，Node >=18）
用法:
  node cli.js <tool> [--root <项目根>] [--args '<json>' | --args @<args.json>] [--list]
示例:
  node cli.js scan_project --root "D:/my-project"
  node cli.js get_route --root "D:/my-project"
  node cli.js save_route --root "D:/my-project" --args @route-args.json
  node cli.js --list
退出码: 0=成功 1=工具错误([E_*]) 2=用法错误`;

function die(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgv(argv) {
  const opts = { tool: null, root: null, args: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list' || a === '-l') opts.list = true;
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--args') opts.args = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!opts.tool && !a.startsWith('--')) opts.tool = a;
    else die(`未知参数: ${a}\n${USAGE}`);
  }
  return opts;
}

function readArgsJson(spec) {
  if (spec == null) return {};
  let text;
  if (spec.startsWith('@')) {
    const file = path.resolve(spec.slice(1));
    if (!fs.existsSync(file)) die(`--args 指向的文件不存在: ${file}`);
    text = fs.readFileSync(file, 'utf8');
  } else {
    text = spec;
  }
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      die('--args 必须是 JSON 对象');
    }
    return parsed;
  } catch (e) {
    die(`--args 不是合法 JSON: ${e.message}`);
  }
}

async function main() {
  const opts = parseArgv(process.argv.slice(2));

  if (opts.list) {
    for (const t of TOOL_DEFS) {
      const firstLine = String(t.description || '').split('\n')[0];
      process.stdout.write(`${t.name.replace(/^testroute_/, '')}\t${firstLine}\n`);
    }
    return;
  }

  if (opts.help || !opts.tool) die(`${USAGE}\n（--list 查看全部工具）`);

  // 短名/全名都接受；参数合并顺序：args 文件/内联 → --root 显式覆盖
  const name = opts.tool.startsWith('testroute_') ? opts.tool : `testroute_${opts.tool}`;
  if (!TOOL_DEFS.some((t) => t.name === name)) {
    die(`未知工具: ${opts.tool}\n可用工具:\n${TOOL_DEFS.map((t) => `  ${t.name.replace(/^testroute_/, '')}`).join('\n')}`);
  }

  const args = readArgsJson(opts.args);
  if (opts.root != null) args.root = opts.root;

  try {
    const res = await callTool(name, args);
    const text = res?.content?.[0]?.text;
    process.stdout.write(typeof text === 'string' ? text : JSON.stringify(res, null, 2));
    process.stdout.write('\n');
  } catch (e) {
    process.stderr.write(`[${e?.code || 'E_INTERNAL'}] ${e?.message || String(e)}\n`);
    process.exit(1);
  }
}

const selfDir = path.dirname(fileURLToPath(import.meta.url));
if (!fs.existsSync(path.join(selfDir, 'server', 'tools.js'))) {
  die(`可攜包不完整：缺 ${path.join(selfDir, 'server', 'tools.js')}\n请重新构建（仓库内 node scripts/build-skill.mjs）或复制完整目录。`);
}

main();
