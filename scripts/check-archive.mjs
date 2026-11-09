#!/usr/bin/env node
// 归档自验 CLI——独立于 MCP 工具链（宿主 MCP 逾时/离线时也能取证）。
// 用法: node scripts/check-archive.mjs <归档目录 | 项目根> [--json] [--allow-legacy]
//   传项目根时自动取 test-archives/ 下最新归档。
//   --allow-legacy   全部 run 都缺工具签名（env/command）时按旧版工具宽容（降为备注）
//   --json           输出机器可读 JSON（字段见 server/integrity.js）
// 退出码: 0=TRUSTED 1=SUSPECT 2=TAMPERED 3=用法/IO 错误
// 判定语义：TRUSTED 未发现伪造痕迹；SUSPECT 有疑点（引用结论前先复核）；TAMPERED 存在硬伤，整份作废。
import path from 'node:path';
import fs from 'node:fs';
import { verifyArchiveIntegrity } from '../server/integrity.js';
import { MANIFEST_FILE, listArchives } from '../server/archive.js';
import { archivesDir } from '../server/paths.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const allowLegacy = argv.includes('--allow-legacy');
const targets = argv.filter((a) => !a.startsWith('--'));

function die(message) {
  if (asJson) console.log(JSON.stringify({ error: message }));
  else console.error(`用法: node scripts/check-archive.mjs <归档目录 | 项目根> [--json] [--allow-legacy]\n${message}`);
  process.exit(3);
}

if (targets.length !== 1) die('请提供恰好一个目标路径');
let target = path.resolve(targets[0]);
if (!fs.existsSync(path.join(target, MANIFEST_FILE))) {
  const root = target;
  if (!fs.existsSync(archivesDir(root))) die(`既不是归档目录（无 manifest.json），也没有 test-archives/: ${root}`);
  const latest = listArchives(root)[0];
  if (!latest) die(`test-archives/ 下没有归档: ${archivesDir(root)}`);
  target = path.join(archivesDir(root), latest);
  if (!asJson) console.error(`(未直接命中归档，取最新归档: ${latest})`);
}

let report;
try {
  report = verifyArchiveIntegrity(target, { allowLegacy });
} catch (err) {
  die(`自验失败: ${err?.stack || err}`);
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { verdict, fails, warns, infos, stats } = report;
  console.log(`归档自验: ${target}`);
  console.log(`判定: ${verdict}（硬伤 ${fails.length} / 疑点 ${warns.length}）`);
  console.log('');
  const dump = (title, list) => {
    if (list.length === 0) return;
    console.log(`【${title}】`);
    for (const f of list) console.log(`  [${f.area}]${f.subject ? ` ${f.subject}:` : ''} ${f.message}`);
    console.log('');
  };
  dump('硬伤（fail）——任一即整份作废', fails);
  dump('疑点（warn）——引用结论前先复核', warns);
  dump('备注（info）', infos);
  console.log(`统计: 事件 ${stats.events} 条 | run 目录 ${stats.runs} 个 / result ${stats.results ?? stats.stamped + stats.legacy} 份（完整工具签名 ${stats.stamped} / 无签名 ${stats.legacy}）| 阶段 ${stats.phases} 个 | 最终报告: ${stats.hasReport ? '有' : '无'}`);
  if (verdict === 'TRUSTED') console.log('TRUSTED：归档自洽，未发现伪造痕迹。');
  if (verdict === 'SUSPECT') console.log('SUSPECT：归档有疑点，未构成硬伤；先复核再引用结论。');
  if (verdict === 'TAMPERED') console.log('TAMPERED：归档存在硬伤，整份作废——不得引用其结论；按缺口用工具重跑或重建。');
}

process.exit(report.verdict === 'TRUSTED' ? 0 : report.verdict === 'SUSPECT' ? 1 : 2);
