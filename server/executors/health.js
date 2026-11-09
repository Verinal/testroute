// 连通性/健康检查执行器：对 targets（http(s) URL）逐个 GET 探测，一个目标一条用例。
import { summarizeCases } from '../result.js';

async function probe(url, timeoutMs) {
  const started = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, redirect: 'follow' });
    return {
      ok: res.status < 400,
      ms: Date.now() - started,
      message: `HTTP ${res.status}`,
    };
  } catch (e) {
    const code = e?.cause?.code || e?.name || 'error';
    return {
      ok: false,
      ms: Date.now() - started,
      message: code === 'AbortError' || e?.name === 'AbortError' ? `超时（>${timeoutMs}ms）` : String(code),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const health = {
  id: 'health',
  label: '连通性/健康检查',
  artifactName: null,

  // 内置执行器：不依赖外部命令，Node 原生 fetch 直接探测
  async run({ targets, timeoutMs = 30000 }) {
    const list = (targets || []).map((t) => String(t).trim()).filter(Boolean);
    if (list.length === 0) {
      const cases = [
        {
          id: 'health::no-targets',
          name: 'targets 未配置',
          file: '',
          status: 'failed',
          durationMs: null,
          message: 'executor="health" 需要在阶段里配置 targets（http(s) URL 数组）',
        },
      ];
      return {
        proc: { exitCode: 1, stdout: '', stderr: 'health: 未配置 targets', timedOut: false, command: '(health)' },
        parsed: {
          suites: [{ name: 'connectivity', cases }],
          summary: summarizeCases(cases),
          parseStatus: 'builtin',
          artifacts: [],
          warnings: [],
        },
      };
    }

    const perTarget = Math.min(10000, Math.max(3000, Math.floor(timeoutMs / Math.max(1, list.length))));
    const results = await Promise.all(list.map((t) => probe(t, perTarget)));
    const cases = results.map((r, i) => ({
      id: `health::${i + 1}`,
      name: list[i],
      file: '',
      status: r.ok ? 'passed' : 'failed',
      durationMs: r.ms,
      message: r.message,
    }));
    const stdout = cases.map((c) => `${c.status === 'passed' ? 'ok' : 'not ok'} - ${c.name}: ${c.message}`).join('\n');
    return {
      proc: {
        exitCode: cases.some((c) => c.status === 'failed') ? 1 : 0,
        stdout: stdout + '\n',
        stderr: '',
        timedOut: false,
        command: `health probe: ${list.join(', ')}`,
      },
      parsed: {
        suites: [{ name: 'connectivity', cases }],
        summary: summarizeCases(cases),
        parseStatus: 'builtin',
        artifacts: [],
        warnings: [],
      },
    };
  },

  parse({ proc }) {
    return {
      suites: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, durationMs: 0 },
      parseStatus: 'exit-code-only',
      artifacts: [],
      warnings: ['health 执行器应通过 run() 返回结果，此分支不应被触发'],
    };
  },
};
