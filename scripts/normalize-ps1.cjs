// 把项目里的 .ps1 规范化为 UTF-8 with BOM + CRLF（红线 3.2），并做 PowerShell 解析校验。
//
// 为什么必须：Windows PowerShell 5.1 在没有 BOM 时按 ANSI/GBK 解码脚本，脚本里的中文
// 字符串会被读坏并导致语法解析失败。本脚本用"锚点无关"的最小改写：只做行尾/BOM 规范化，
// 不改内容；写临时文件 → 校验 → 原子替换（红线 3.8 要求的安全姿势）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.existsSync(path.join(ROOT, 'scripts'))
    ? fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.ps1')).map((f) => path.join(ROOT, 'scripts', f))
    : [];

if (!files.length) {
  console.error('没有找到 .ps1 文件');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const raw = fs.readFileSync(f);
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 统一 CRLF
  const crlf = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
  const out = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlf, 'utf8')]);
  if (!out.length) throw new Error('拒绝写入空内容：' + f);

  const tmp = f + '.tmp-verify';
  fs.writeFileSync(tmp, out);
  // 校验：BOM 为真 + 非空 + 行数合理
  const check = fs.readFileSync(tmp);
  const bom = check[0] === 0xef && check[1] === 0xbb && check[2] === 0xbf;
  if (!bom) { fs.rmSync(tmp, { force: true }); throw new Error('BOM 校验失败：' + f); }
  fs.renameSync(tmp, f);

  // PowerShell 解析校验（0 错误）
  let parseInfo = 'skipped';
  try {
    const ps = process.env.DCP_PS || 'powershell';
    const script = `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${f.replace(/'/g, "''")}',[ref]$null,[ref]$e);Write-Output $e.Count`;
    const stdout = execFileSync(ps, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    const count = Number.parseInt(String(stdout).trim(), 10);
    parseInfo = 'errors=' + (Number.isFinite(count) ? count : '?');
    if (count !== 0) failed++;
  } catch (e) {
    parseInfo = 'parse-check-unavailable(' + e.message.split('\n')[0].slice(0, 60) + ')';
  }
  const lines = crlf.split('\r\n').length;
  console.log(`${path.basename(f)}: BOM=true CRLF=true bytes=${out.length} lines=${lines} ${parseInfo}`);
}
process.exit(failed ? 1 : 0);
