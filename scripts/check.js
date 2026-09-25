// scripts/check.js —— 项目自检（`npm run check` / `node scripts/check.js`）。
//
// 覆盖：① 全部后端与前端脚本的语法；② JSON 配置可解析；③ 中英词典键集一致且无空值；
//      ④ .ps1 必须是 UTF-8 with BOM + CRLF（Windows PowerShell 5.1 中文脚本红线）；
//      ⑤ 交付物零真实机器路径（脱敏自查）。
// 任何一项失败都以非零码退出，便于接 CI 或发布前手动跑。
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
const problems = [];

function ok(msg) { pass++; console.log('  ✓ ' + msg); }
function bad(msg) { fail++; problems.push(msg); console.log('  ✗ ' + msg); }

function listFiles(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

console.log('comfy-panel-standalone 自检（' + ROOT + '）\n');

// ① 语法
console.log('[1] 语法检查');
const serverJs = listFiles(path.join(ROOT, 'server'), (p) => p.endsWith('.js'));
const webJs = [
  path.join(ROOT, 'web', 'panel.js'),
  path.join(ROOT, 'web', 'panel-host.js'),
];
for (const f of serverJs.concat(webJs)) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad('语法错误：' + path.relative(ROOT, f) + ' → ' + String(e.stderr || e.message).split('\n')[0]);
  }
}
if (!fail) ok(serverJs.length + ' 个后端脚本 + 面板两半语法通过');

const esmFiles = listFiles(path.join(ROOT, 'web'), (p) => p.endsWith('.js') && !p.endsWith('panel.js') && !p.endsWith('panel-host.js'));
for (const f of esmFiles) {
  try {
    // ESM 不能用 node --check，改走 stdin + --input-type=module
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f, 'utf8'), stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    bad('ESM 语法错误：' + path.relative(ROOT, f) + ' → ' + String(e.stderr || e.message).split('\n')[0]);
  }
}
if (!problems.some((p) => p.startsWith('ESM'))) ok(esmFiles.length + ' 个前端 ES 模块语法通过');

// ② JSON
console.log('\n[2] JSON 可解析');
const jsonFiles = [
  path.join(ROOT, 'package.json'),
  path.join(ROOT, 'installer', 'models.json'),
  path.join(ROOT, 'installer', 'llm-models.json'),
  path.join(ROOT, 'web', 'i18n', 'zh.json'),
  path.join(ROOT, 'web', 'i18n', 'en.json'),
];
for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    ok(path.relative(ROOT, f));
  } catch (e) {
    bad('JSON 解析失败：' + path.relative(ROOT, f) + ' → ' + e.message);
  }
}

// ③ 词典
console.log('\n[3] 中英词典');
try {
  const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'i18n', 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'i18n', 'en.json'), 'utf8'));
  const diff = (a, b) => Object.keys(a).filter((k) => !(k in b));
  const uiMissing = diff(zh.ui, en.ui).concat(diff(en.ui, zh.ui));
  const panelMissing = diff(zh.panel, en.panel).concat(diff(en.panel, zh.panel));
  if (uiMissing.length || panelMissing.length) bad('词典键集不一致：ui ' + uiMissing.length + ' / panel ' + panelMissing.length);
  else ok('ui ' + Object.keys(zh.ui).length + ' 键、panel ' + Object.keys(zh.panel).length + ' 键，zh/en 完全一致');
  const empty = [...Object.entries(en.ui), ...Object.entries(en.panel)].filter(([, v]) => !String(v).trim());
  if (empty.length) bad('英文词典有空值：' + empty.length + ' 条');
  else ok('英文词典无空值');
  const han = /[\u3400-\u4dbf\u4e00-\u9fff]/;
  const hanInEn = Object.entries(en.panel).filter(([k, v]) => k !== v && han.test(String(v)));
  if (hanInEn.length) bad('英文词典值里仍有汉字：' + hanInEn.length + ' 条（示例：' + hanInEn[0][0].slice(0, 24) + '）');
  else ok('英文词典值里没有汉字残留');
  const badRules = (en.panelPhrases || []).filter((r) => han.test(String(r.replace)));
  if (badRules.length) bad('英文短语规则的替换串含汉字：' + badRules.length + ' 条');
  else ok('英文短语规则替换串无汉字（' + (en.panelPhrases || []).length + ' 条）');
} catch (e) {
  bad('词典检查失败：' + e.message);
}

// ④ .ps1 编码红线
console.log('\n[4] PowerShell 脚本编码（必须 UTF-8 with BOM + CRLF）');
const ps1 = listFiles(path.join(ROOT, 'scripts'), (p) => p.endsWith('.ps1'));
for (const f of ps1) {
  const b = fs.readFileSync(f);
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const crlf = /\r\n/.test(b.toString('utf8'));
  if (bom && crlf) ok(path.basename(f) + '：BOM + CRLF');
  else bad(path.basename(f) + '：BOM=' + bom + ' CRLF=' + crlf);
}

// ④b .cmd / .bat 编码红线（本机踩过：LF-only + UTF-8 中文 → cmd.exe 在 CP936 下解析崩掉，双击启动 exit 9009）
//    规则：CRLF + **纯 ASCII**。中文提示一律交给 .ps1（UTF-8 with BOM）去打印。
console.log('\n[4b] 批处理脚本编码（必须 CRLF + 纯 ASCII，避免 cmd.exe 代码页问题）');
const cmds = [path.join(ROOT, 'start.cmd')]
  .concat(listFiles(path.join(ROOT, 'scripts'), (p) => /\.(cmd|bat)$/i.test(p)))
  .filter((f) => fs.existsSync(f));
for (const f of cmds) {
  const b = fs.readFileSync(f);
  const text = b.toString('latin1');
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const bareLf = (text.match(/(?<!\r)\n/g) || []).length;
  const nonAscii = [...b].filter((x) => x > 127).length;
  if (crlfCount > 0 && bareLf === 0 && nonAscii === 0 && !(b[0] === 0xef && b[1] === 0xbb)) {
    ok(path.basename(f) + '：CRLF + 纯 ASCII（' + crlfCount + ' 行）');
  } else {
    bad(path.basename(f) + '：CRLF=' + crlfCount + ' 裸LF=' + bareLf + ' 非ASCII字节=' + nonAscii
      + '（cmd.exe 按 OEM 代码页读文件，非 ASCII/裸 LF 会导致双击启动失败）');
  }
}

// ⑤ 脱敏
console.log('\n[5] 交付物脱敏（零真实机器路径/用户名）');
const scanDirs = ['server', 'web', 'scripts', 'docs', 'assets', 'installer'];
const scanFiles = ['README.md', 'FEATURES.md', 'MIGRATION.md', 'THIRD_PARTY.md', 'AI-DECLARATION.md', 'package.json', '.gitignore', 'start.cmd'];
const skipExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2', '.gguf', '.safetensors']);
const patterns = [
  // 注意：这些是**正则字面量**，`\\` 才是"一个字面反斜杠"；写成 `\\\\` 会要求两个反斜杠，
  // 结果整条脱敏自查永远命中不了（第一轮就是这样漏掉了本项目所在盘的路径，靠 build-core 才发现）。
  { re: /[A-Za-z]:\\Users\\/, name: 'Windows 用户目录绝对路径' },
  { re: /[A-Za-z]:\\(Game|AI|ComfyUI|Models|Project)\\/i, name: '本机盘符路径' },
  { re: /AppData\\Roaming/, name: 'AppData 路径' },
  { re: /\bwziru\b/, name: '真实用户名' },
];
const hits = [];
const targets = [];
// 这两个脚本**自带**脱敏扫描模式（模式串里含 AppData、盘符等字面量），
// 它们不是交付物里的机器路径，扫描时排除（脚本自身逻辑仍会扫描整个核心版）。
const scanDefinitionFiles = new Set(['build-core.ps1', 'check.js']);
for (const d of scanDirs) targets.push(...listFiles(path.join(ROOT, d), (p) => !skipExt.has(path.extname(p).toLowerCase()) && !scanDefinitionFiles.has(path.basename(p))));
for (const f of scanFiles) if (fs.existsSync(path.join(ROOT, f))) targets.push(path.join(ROOT, f));
for (const f of targets) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const p of patterns) {
    if (p.re.test(text)) hits.push(path.relative(ROOT, f) + ' → ' + p.name);
  }
}
if (hits.length) {
  bad('脱敏自查命中 ' + hits.length + ' 处：');
  hits.slice(0, 10).forEach((h) => console.log('      ' + h));
} else {
  ok('扫描 ' + targets.length + ' 个文本文件：零命中');
}

console.log('\n结果：pass=' + pass + ' fail=' + fail);
if (fail) {
  console.log('\n未通过项：');
  problems.forEach((p) => console.log('  · ' + p));
}
process.exit(fail ? 1 : 0);
