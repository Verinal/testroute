import { spawn } from 'node:child_process';

// 有界捕获：保留头部 + 尾部，防止超长日志撑爆内存/上下文
class StreamCap {
  constructor(cap = 512 * 1024) {
    this.cap = cap;
    this.head = '';
    this.tail = '';
    this.total = 0;
    this.truncated = false;
  }
  push(s) {
    this.total += s.length;
    if (this.head.length < this.cap * 0.7) {
      const take = s.slice(0, this.cap * 0.7 - this.head.length);
      this.head += take;
      s = s.slice(take.length);
    }
    if (s.length > 0) {
      const tailCap = this.cap * 0.3;
      this.tail = (this.tail + s).slice(-tailCap);
      if (this.total > this.cap) this.truncated = true;
    }
  }
  text() {
    if (!this.truncated) return this.head + this.tail;
    return this.head + `\n…[输出过长已折叠，共 ${this.total} 字符，省略中间部分]…\n` + this.tail;
  }
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      if (child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
        });
      }
    } else {
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, 3000);
      if (typeof t.unref === 'function') t.unref();
    }
  } catch {
    /* 尽力而为 */
  }
}

export function runCommand({ cwd, command, timeoutMs = 300000, env }) {
  return new Promise((resolve) => {
    const useShell = process.platform === 'win32';
    let child;
    try {
      child = spawn(command, {
        cwd,
        shell: useShell,
        windowsHide: true,
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          CI: '1',
          PYTHONUNBUFFERED: '1',
          PYTHONDONTWRITEBYTECODE: '1', // 不在项目源码树里写 __pycache__（沙箱用例 import 项目模块时）
          ...env,
        },
      });
    } catch (e) {
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: `spawn 失败: ${e?.message || e}`,
        timedOut: false,
        spawnError: String(e?.message || e),
      });
      return;
    }

    const outCap = new StreamCap();
    const errCap = new StreamCap();
    let timedOut = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => outCap.push(d));
    child.stderr?.on('data', (d) => errCap.push(d));

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        stdout: outCap.text(),
        stderr: (errCap.text() + `\n${e?.message || e}`).trim(),
        timedOut,
        spawnError: String(e?.message || e),
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code === null ? (timedOut ? -1 : 1) : code,
        stdout: outCap.text(),
        stderr: errCap.text(),
        timedOut,
      });
    });
  });
}
