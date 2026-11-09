// 归档并发写保护：advisory 锁（归档目录下 .lock 文件）。
// 场景：多个编辑器各拉起一个 MCP server 进程，同时写同一个归档。进程无共享内存，只能靠文件锁。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fail } from './validate.js';

const STALE_MS = 30 * 60 * 1000; // 锁超过 30 分钟视为残留（run_tests 自身超时默认 5 分钟，长 run 也远小于此）
const DEAD_PID_GRACE_MS = 5000; // 持锁进程已死：留缓冲防误判（刚创建就检查 / pid 复用窗口）
const WAIT_MS = 2000; // 短暂等待吸收毫秒级并发；对方在跑长任务时等待无意义，快速报错更诚实

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function withArchiveLock(archiveDir, fn) {
  const lockPath = path.join(archiveDir, '.lock');
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    let info = null;
    try {
      const fd = fs.openSync(lockPath, 'wx'); // 独占创建：并发抢锁只有一个成功
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') fail('E_INTERNAL', `归档锁创建失败: ${e.message}`);
      try {
        info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {}
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // 锁刚好被释放，重试抢锁
      }
      const stale =
        age > STALE_MS ||
        (age > DEAD_PID_GRACE_MS && info?.pid && info.pid !== process.pid && !pidAlive(info.pid));
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {}
        continue;
      }
      if (Date.now() >= deadline) {
        fail(
          'E_BUSY',
          `归档正被其他进程使用（${info?.pid ? `pid=${info.pid}` : '未知持锁方'}，已持有 ${Math.round(age / 1000)}s）。` +
            `多编辑器场景请等对方操作完成；若确认无并发使用，删除归档目录下的 .lock 文件后重试。`
        );
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {}
  }
}
