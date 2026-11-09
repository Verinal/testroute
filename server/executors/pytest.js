import fs from 'node:fs';
import { summarizeCases, emptySummary } from '../result.js';
import { parseJunitXml } from './junitxml.js';
import { resolveDottedModulePath } from '../paths.js';

function quote(p) {
  return `"${String(p).replace(/"/g, '')}"`;
}

// pytest junit XML 没有 file 属性，classname 是点号模块路径（如 sandbox.unit.test_auth_utils.LoginPage），
// 直接当文件路径会导致案例卡提取失败。这里对照真实文件系统还原为相对路径，并把用例 id 重建成
// pytest nodeid 形式（file::Class::name），使复现命令可直接执行。
function normalizeSuites(root, suites) {
  if (!root) return suites;
  for (const s of suites) {
    for (const c of s.cases || []) {
      const hit = resolveDottedModulePath(root, c.file);
      if (!hit) continue;
      const name = String(c.name || '');
      c.file = hit.file;
      c.id = [hit.file, ...hit.classes, name].filter(Boolean).join('::');
    }
  }
  return suites;
}

export const pytest = {
  id: 'pytest',
  label: 'pytest',
  artifactName: 'pytest-junit.xml',
  // pythonBin 由调用方探测（python / py -3）
  buildCommand({ paths, outFile, command, pythonBin = 'python' }) {
    if (command && String(command).trim()) return String(command).trim();
    const p = (paths || []).map(quote).join(' ');
    // no:cacheprovider：不在 rootdir（通常是项目根）留 .pytest_cache/
    return `${pythonBin} -m pytest -q -p no:cacheprovider --junitxml=${quote(outFile)} ${p}`.replace(/\s+/g, ' ').trim();
  },
  parse({ root, outFile, proc }) {
    let xml = null;
    try {
      if (fs.existsSync(outFile)) xml = fs.readFileSync(outFile, 'utf8');
    } catch {}
    if (xml) {
      const suites = normalizeSuites(root, parseJunitXml(xml));
      const summary = summarizeCases(suites.flatMap((s) => s.cases));
      if (summary.total > 0 || proc.exitCode === 0) {
        return {
          suites,
          summary,
          parseStatus: 'junit-xml',
          artifacts: [{ kind: 'junit-xml', path: outFile }],
          warnings: summary.total === 0 ? ['JUnit XML 无 <testcase>，用例数为 0'] : [],
        };
      }
    }
    return {
      suites: [],
      summary: emptySummary(),
      parseStatus: 'exit-code-only',
      artifacts: xml ? [{ kind: 'junit-xml', path: outFile }] : [],
      warnings: ['未获得可解析的 JUnit 报告（可能未安装 pytest），已降级为 exit code 判定'],
    };
  },
};
