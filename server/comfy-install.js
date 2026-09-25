// 首次运行向导的安装器（Node 侧，替代插件版的 PowerShell 安装器）。
//
// 安装目标全部落在项目内（内嵌模式）：runtime/comfyui（ComfyUI 本体）、
// runtime/bin（7-Zip 精简版）、<modelsDir>（权重）、<comfyDir>/model-notes（画师清单）。
// 一切下载走 server/download.js 的 F3 策略（官方源 → 镜像，自动切换并提示）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { paths, load, save } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');
const zip = require('./util/zip');
const dl = require('./download');
const store = require('./store');
const comfy = require('./comfy');

const COMFYUI_GIT = 'https://github.com/comfyanonymous/ComfyUI';
const COMFYUI_COMMIT = 'e638023d54497dbe0579565e5de4bb7076899592';   // 与插件版安装器同一实测 commit
const ANIMA_NODE_GIT = 'https://github.com/GumGum10/comfyui-anima-3-8B.git';
const ANIMA_NODE_COMMIT = '381c13af328b958febf86c155d2f4b007cd0f55b';
const PORTABLE_ASSETS = [
  'ComfyUI_windows_portable_nvidia.7z',
  'ComfyUI_windows_portable_nvidia_cu126.7z',
  'ComfyUI_windows_portable.7z',
];
// GitHub Releases 资产名不稳定（cu126/cu128/nvidia 等变体），所以先问 API，再回落到候选名。
const RELEASE_API = 'https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest';
// 实测钉住的版本（2026-09 复核：仓库已从 comfyanonymous/ComfyUI 迁到 Comfy-Org/ComfyUI，
// 资产 URL 仍是同一个；官方 nvidia 便携包 1,925,204,508 B）。
// 字节数与 sha256 都来自 GitHub Releases API 的 `digest` 字段（本环境 api.github.com 可直连）——
// 这样即使走第三方代理下载，也能校验出"下到的到底是不是官方包"。
const PORTABLE_TAG = 'v0.37.0';
const PORTABLE_REPO = 'Comfy-Org/ComfyUI';
const PORTABLE_KNOWN = {
  'ComfyUI_windows_portable_nvidia.7z': { bytes: 1925204508, sha256: '7805f634fab51f63a238aaf0cfe2a9833bb7c86ddfc8400a60919f44460d7d65' },
  'ComfyUI_windows_portable_nvidia_cu126.7z': { bytes: 1867201814, sha256: '4f8c587c8319a3595dcdc6b8fbfc7234d2d02fa6b1a328c1ab3e819c97d95fb8' },
  'ComfyUI_windows_portable_amd.7z': { bytes: 1595844037, sha256: '563da2462a866f8fdf8ccd091a8c0e185e785394408735f8e99647593a67dd79' },
  'ComfyUI_windows_portable_intel.7z': { bytes: 1512836652, sha256: '1041af3a25ca2c7b3615db3027ca0fd40df37c1758c4e9955e762672193ac4cc' },
};
// 官方**旧版本**的镜像（hf-mirror 上的第三方转存，但文件本身经 sha256 证明就是官方 v0.3.59 的资产）。
// 只在 v0.37.0 全线失败时使用：宁可给一个哈希校验通过的旧官方包，也不要给来源不明的第三方构建。
const PORTABLE_OFFICIAL_OLD = [
  {
    name: 'ComfyUI_windows_portable_nvidia.7z',
    saveAs: 'ComfyUI_windows_portable_nvidia_v0.3.59.7z',
    url: 'https://hf-mirror.com/StabooruJeffrey/ComfyUI_v0.3.59_72212fe/resolve/main/ComfyUI_windows_portable_nvidia.7z',
    expectBytes: 2086957962,
    sha256: 'a1cf7b103c075793056a24ec33280bc8bd103f77f55bd9084bcb959456619c1a',
    note: '官方 v0.3.59 的便携包（hf-mirror 转存，sha256 与 GitHub API 一致）',
  },
];
// 第三方镜像兜底：HF / ModelScope 上的社区构建（**不是官方包**，只在官方渠道全不通时使用，
// 会明确告知用户；实测 hf-mirror 约 0.94–4.17 MB/s，ModelScope 上 licyk 的构建约 11 MB/s 但目录结构未必兼容）。
const PORTABLE_THIRD_PARTY = [
  { name: 'ComfyUI_windows_portable-marduk191-v1.0.7z', url: 'https://hf-mirror.com/marduk191/Comfyui_windows_portable_builds/resolve/main/ComfyUI_windows_portable-marduk191-v1.0.7z', thirdParty: true },
  { name: 'ComfyUI_mythria_portable.zip', url: 'https://hf-mirror.com/sofianedrz/mythria-comfyui-portable/resolve/main/ComfyUI_mythria_portable.zip', thirdParty: true },
];

// ── 模型目录 ─────────────────────────────────────────────

function catalog() {
  const list = fsx.readJson(paths.modelsJson, []);
  if (!Array.isArray(list)) throw new Error('installer/models.json 解析失败（应为数组）');
  return list;
}

function modelsDirFor(mode, externalDir) {
  const dir = mode === 'external' ? externalDir : paths.comfyEmbedded;
  const layout = comfy.detectLayout(dir);
  if (layout.ok) return layout.modelsDir;
  // 还没装本体时的预期落位（内嵌模式：便携包内层 ComfyUI\models）
  return path.join(dir, 'ComfyUI', 'models');
}

function installedState(entry, modelsDir) {
  const file = path.join(modelsDir, entry.dest, entry.file);
  const size = fsx.sizeOf(file);
  return { file, exists: size >= 0, size, ready: size === entry.bytes };
}

function tierOf(id, list) {
  const e = list.find((x) => x.id.toLowerCase() === String(id).toLowerCase() || x.file.toLowerCase() === String(id).toLowerCase());
  return e ? e.tier : null;
}

/** 解析模型选择表达式：id / 档位 / all / none，逗号分隔，取并集。 */
function resolveSelection(list, spec) {
  const parts = String(spec || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ids: [], unknown: [] };
  const ids = new Set();
  const unknown = [];
  for (const p of parts) {
    const low = p.toLowerCase();
    if (low === 'all') { list.forEach((m) => ids.add(m.id)); continue; }
    if (low === 'none') continue;
    const byTier = list.filter((m) => m.tier === low);
    if (byTier.length) { byTier.forEach((m) => ids.add(m.id)); continue; }
    const hit = list.find((m) => m.id.toLowerCase() === low || m.file.toLowerCase() === low || m.file.toLowerCase() === low + '.safetensors');
    if (hit) ids.add(hit.id);
    else unknown.push(p);
  }
  return { ids: [...ids], unknown };
}

// ── 7-Zip：随项目携带（7zr 精简版 → 解出 x64 的 7za） ─────

// 7-Zip 官方站实测只有 17–25 KB/s（1.76 MB 的 extra 包 45 s 都收不完），
// 而 GitHub 上的 ip7z/7zip Release 经 gh-proxy 有 1.8 MB/s —— 所以首选 GitHub，
// 官方站只当兜底。（版本 26.03 为当前最新实测可用版本。）
const SEVENZIP_TAGS = ['26.03', '25.01', '24.09'];

async function ensure7z(job) {
  const binDir = paths.runtimeBin;
  fsx.ensureDir(binDir);
  const have = zip.find7z([binDir]);
  // 已随项目携带的 7za.exe 优先；系统装的 7z.exe 也能用。
  const x64 = path.join(binDir, '7za.exe');
  if (fsx.isFile(x64)) return { exe: x64, source: 'bundled' };
  if (have && /7za\.exe$|7z\.exe$/i.test(have) && path.resolve(have).startsWith(path.resolve(binDir))) return { exe: have, source: 'bundled' };

  const settings = load();
  const sevenZipBase = 'https://github.com/ip7z/7zip/releases/download';
  const candidatesFor = (file) => [
    ...SEVENZIP_TAGS.map((t) => `${sevenZipBase}/${t}/${file}`),
    `https://www.7-zip.org/a/${file}`,
  ];

  const r7zr = path.join(binDir, '7zr.exe');
  if (!fsx.isFile(r7zr)) {
    job.log('获取 7-Zip 精简版（7zr.exe，约 0.6 MB）…');
    let done = false;
    let lastErr = null;
    for (const url of candidatesFor('7zr.exe')) {
      try {
        await dl.download({ url, dest: r7zr, job, phase: 'runtime', label: '7zr.exe', settings, force: true });
        done = true;
        break;
      } catch (e) { lastErr = e; job.log('7zr.exe 来源失败：' + e.message, 'warn'); }
    }
    if (!done) throw new Error('7zr.exe 获取失败（GitHub 镜像与官方站都不通）：' + (lastErr ? lastErr.message : '未知'));
  }
  // 用 7zr 解出完整版 x64 7za（便携、无安装、无注册表）
  try {
    job.log('解出 x64 版 7za.exe（用于处理大体积便携包）…');
    const extra = path.join(paths.runtimeDl, '7z-extra.7z');
    if (!fsx.isFile(extra)) {
      let lastErr = null;
      let ok = false;
      for (const url of candidatesFor(`7z${SEVENZIP_TAGS[0]}-extra.7z`).concat(SEVENZIP_TAGS.slice(1).map((t) => `https://www.7-zip.org/a/7z${t}-extra.7z`))) {
        try {
          await dl.download({ url, dest: extra, job, phase: 'runtime', label: '7z-extra.7z', settings, force: true });
          ok = true;
          break;
        } catch (e) { lastErr = e; job.log('7z-extra 来源失败：' + e.message, 'warn'); }
      }
      if (!ok) throw new Error('7z-extra.7z 获取失败：' + (lastErr ? lastErr.message : '未知'));
    }
    const staging = path.join(paths.runtimeDl, '7z-extra');
    fs.rmSync(staging, { recursive: true, force: true });
    zip.extractWith7z(r7zr, extra, staging, { onLine: (l) => job.log(l) });
    const cand = [
      path.join(staging, 'x64', '7za.exe'),
      path.join(staging, '7za.exe'),
    ].find((p) => fsx.isFile(p));
    if (cand) {
      fs.copyFileSync(cand, x64);
      const dll = path.join(path.dirname(cand), '7za.dll');
      if (fsx.isFile(dll)) fs.copyFileSync(dll, path.join(binDir, '7za.dll'));
      job.log('已使用随项目携带的 7za.exe（x64）', 'ok');
      return { exe: x64, source: 'bundled' };
    }
  } catch (e) {
    job.log('解出 x64 版 7za 失败，回落到 7zr.exe（仍可解压 7z，但大包解压更慢）：' + e.message, 'warn');
  }
  if (fsx.isFile(r7zr)) return { exe: r7zr, source: 'bundled-7zr' };
  if (have) {
    job.log('改用系统已安装的 7-Zip：' + have, 'warn');
    return { exe: have, source: 'system' };
  }
  throw new Error('没有可用的 7-Zip（随项目获取失败，系统也未安装）。请安装 7-Zip 后重试。');
}

async function fetchText(url) {
  const s = load();
  for (const c of dl.buildCandidates(url, s)) {
    try {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(15000), redirect: 'follow' });
      if (r.ok) return await r.text();
    } catch { /* 试下一个 */ }
  }
  return null;
}

/** 通过 GitHub API（走镜像）解析便携包的当前资产名；失败返回 null（回落到候选名）。
 *  同时把官方 `digest`（sha256）与 `size` 一起带出来 —— 走第三方代理也能校验是不是官方包。 */
async function resolvePortableAsset(job) {
  try {
    const txt = await fetchText(RELEASE_API);
    if (!txt) return null;
    const j = JSON.parse(txt);
    const assets = Array.isArray(j.assets) ? j.assets : [];
    const zips = assets.filter((a) => /^ComfyUI_windows_portable.*\.(7z|zip)$/.test(a.name || ''));
    if (!zips.length) return null;
    const pick = zips.find((a) => /nvidia/i.test(a.name)) || zips[0];
    const sha = (pick.digest || '').replace(/^sha256:/i, '') || undefined;
    job.log(`GitHub Releases 最新便携包资产：${pick.name}（${fsx.fmtBytes(pick.size || 0)}${sha ? '，sha256 ' + sha.slice(0, 16) + '…' : ''}）`);
    return { name: pick.name, urls: [pick.browser_download_url], size: pick.size, sha256: sha, tag: j.tag_name };
  } catch (e) {
    job.log('查询 Releases 资产名失败（将按候选名依次尝试）：' + e.message, 'warn');
    return null;
  }
}

// ── ComfyUI 本体 ─────────────────────────────────────────

async function installComfyUI(job, opts) {
  const kind = opts.comfySource?.kind || 'skip';
  const destRoot = paths.comfyEmbedded;
  if (kind === 'skip') { job.log('按请求跳过 ComfyUI 本体获取'); return { skipped: true }; }
  const settings = load();

  if (kind === 'external') { job.log('外接模式：不改动 ComfyUI 本体'); return { external: true }; }

  if (kind === 'dir') {
    const src = opts.comfySource.path;
    const layout = comfy.detectLayout(src);
    if (!layout.ok) throw new Error('指定的目录不是可用的 ComfyUI 安装：' + layout.error);
    job.log(`从本地已有 ComfyUI 导入：${src}（布局 ${layout.layout}，权重目录 ${layout.modelsDir}）`);
    const useLink = (opts.copyMode || 'link') === 'link';
    // 代码目录整体导入；权重用硬链接（同卷瞬时、跨卷自动回落为复制）。
    const srcCode = layout.codeDir;
    const dstCode = path.join(destRoot, 'ComfyUI');
    fsx.ensureDir(destRoot);
    // venv 必须一起导入（否则内嵌模式没有解释器）；硬链接模式同卷即时、不占额外空间。
    // 注意：output/temp/input/user 只在**顶层**跳过 —— 早先按名字在任意深度跳过，
    // 把 `comfy_api/input/` 也一起跳了，ComfyUI 启动即 ImportError: cannot import name 'CurvePoint'
    // （真实踩过一次，靠"从零向导 + 内嵌出图"的端到端测试才暴露）。
    const topLevelSkip = new Set(['output', 'temp', 'input', 'user']);
    const anyLevelSkip = new Set(['__pycache__', '.git']);
    const keep = (from) => {
      const rel = path.relative(srcCode, from).split(path.sep);
      if (rel.some((seg) => anyLevelSkip.has(seg))) return false;
      if (rel.length >= 1 && topLevelSkip.has(rel[0])) return false;
      return true;
    };
    const res = fsx.copyTree(srcCode, dstCode, {
      link: useLink,
      filter: keep,
      onFile: (from) => { job.log('  + ' + path.relative(srcCode, from)); },
    });
    job.log(`代码导入完成：${res.files} 个文件（硬链接 ${res.linked} 个）`, 'ok');
    // 便携包根层的 python_embeded：一并导入，否则内嵌模式跑不起来
    const pySrc = path.join(src, 'python_embeded');
    if (fsx.isDir(pySrc) && !fsx.isDir(path.join(destRoot, 'python_embeded'))) {
      job.log('导入 python_embeded（便携解释器）…');
      const r2 = fsx.copyTree(pySrc, path.join(destRoot, 'python_embeded'), { link: useLink });
      job.log(`解释器导入完成：${r2.files} 个文件（硬链接 ${r2.linked} 个）`, 'ok');
    }
    return { imported: true, files: res.files, linked: res.linked, codeDir: dstCode };
  }

  if (kind === 'git') {
    const git = which('git');
    if (!git) throw new Error('未找到 git。请改用「官方便携包」（无需 git）或指定本地归档。');
    const codeDir = path.join(destRoot, 'ComfyUI');
    fsx.ensureDir(destRoot);
    if (!fsx.isDir(path.join(codeDir, '.git'))) {
      job.log(`git clone ${COMFYUI_GIT} → ${codeDir}（经镜像加速）…`);
      runJobCmd(job, await proxyGitClone(git, COMFYUI_GIT, codeDir));
    }
    runJobCmd(job, { cmd: git, args: ['-C', codeDir, 'fetch', '--depth', '1', 'origin', COMFYUI_COMMIT] });
    runJobCmd(job, { cmd: git, args: ['-C', codeDir, 'checkout', COMFYUI_COMMIT] });
    const py = which('python') || which('py');
    if (!py) throw new Error('git 模式需要系统 Python 来创建 venv；未找到 python/py。建议改用官方便携包。');
    const venvDir = path.join(destRoot, 'venv');
    if (!fsx.isFile(path.join(venvDir, 'Scripts', 'python.exe'))) {
      job.log('创建虚拟环境 venv …');
      runJobCmd(job, { cmd: py, args: ['-m', 'venv', venvDir] });
    }
    const venvPy = path.join(venvDir, 'Scripts', 'python.exe');
    job.log('安装 ComfyUI 依赖（pip 使用镜像源）…');
    runJobCmd(job, { cmd: venvPy, args: ['-m', 'pip', 'install', '-U', 'pip', '-i', settings.download.pipIndex] });
    runJobCmd(job, { cmd: venvPy, args: ['-m', 'pip', 'install', '-r', path.join(codeDir, 'requirements.txt'), '-i', settings.download.pipIndex] });
    return { git: true, codeDir };
  }

  // portable / archive
  const sevenZip = await ensure7z(job);
  job.log(`使用 7-Zip：${sevenZip.exe}（来源：${sevenZip.source}）`);
  let archive = null;
  if (kind === 'archive') {
    archive = opts.comfySource.path;
    if (!fsx.isFile(archive)) throw new Error('指定的本地归档不存在：' + archive);
    job.log('使用本地归档：' + archive);
  } else {
    const resolved = await resolvePortableAsset(job);
    // 候选表：官方 Release（经镜像）→ 钉住版本的官方资产（带 sha256）→ 旧 latest 路径
    //        → 哈希校验通过的官方旧版镜像 → 第三方社区构建。
    const entries = [];
    const add = (name, url, extra = {}) => {
      if (entries.some((e) => e.url === url)) return;
      entries.push({ name, url, ...extra });
    };
    if (resolved) for (const u of resolved.urls) add(resolved.name, u, { expectBytes: resolved.size, sha256: resolved.sha256 });
    for (const n of PORTABLE_ASSETS) {
      const k = PORTABLE_KNOWN[n] || {};
      add(n, `https://github.com/${PORTABLE_REPO}/releases/download/${PORTABLE_TAG}/${n}`, { expectBytes: k.bytes, sha256: k.sha256 });
    }
    for (const n of PORTABLE_ASSETS) add(n, `https://github.com/comfyanonymous/ComfyUI/releases/latest/download/${n}`);
    for (const o of PORTABLE_OFFICIAL_OLD) add(o.name, o.url, { expectBytes: o.expectBytes, sha256: o.sha256, saveAs: o.saveAs, note: o.note });
    for (const t of PORTABLE_THIRD_PARTY) add(t.name, t.url, { thirdParty: true });

    let lastErr = null;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const file = path.join(paths.runtimeDl, e.saveAs || e.name);
      try {
        job.log(`获取 ComfyUI 便携包（候选 ${i + 1}/${entries.length}）：${e.name}${e.note ? '（' + e.note + '）' : ''}${e.thirdParty ? '（第三方社区构建，非官方包）' : ''}`);
        await dl.download({ url: e.url, dest: file, job, phase: 'comfyui', label: e.name, settings, expectBytes: e.expectBytes, sha256: e.sha256, force: true });
        archive = file;
        if (e.thirdParty) job.log('注意：本次使用的是第三方社区构建的便携包（不是 ComfyUI 官方包），遇到问题请改用官方包或本地归档。', 'warn');
        if (e.note) job.log('注意：' + e.note, 'warn');
        break;
      } catch (err) {
        lastErr = err;
        job.log(`候选 ${e.name} 失败：${err.message}`, 'warn');
      }
    }
    if (!archive) {
      throw new Error('ComfyUI 便携包获取失败（官方源与全部镜像都不通）。\n最后一次错误：' + (lastErr ? lastErr.message : '未知')
        + '\n可手动下载 ComfyUI 的 Windows 便携包，然后在向导里选择「本地归档」指定该 .7z 文件；'
        + '或改用「git 模式」（需要 git 与系统 Python）。');
    }
  }

  job.log('解压便携包（大包解压需要几分钟，请勿关闭窗口）…');
  job.phase('comfyui');
  fs.rmSync(destRoot, { recursive: true, force: true });
  fsx.ensureDir(destRoot);
  zip.extractWith7z(sevenZip.exe, archive, destRoot, { onLine: (l) => job.log(l) });
  zip.hoistSingleRoot(destRoot, (l) => job.log(l));
  const layout = comfy.detectLayout(destRoot);
  if (!layout.ok || !layout.python) {
    throw new Error('解压完成但未找到可用的 ComfyUI（需要 main.py 与 python_embeded\\python.exe）。'
      + (layout.error || '') + ' 可加 -KeepTemp 思路排查，或改用「本地归档」重试。');
  }
  job.log(`ComfyUI 就绪：入口 ${layout.mainPy}，解释器 ${layout.python}`, 'ok');
  return { portable: true, codeDir: layout.codeDir, modelsDir: layout.modelsDir, archive };
}

async function proxyGitClone(git, url, dest) {
  const s = load();
  // 只取"前缀式"代理（kkgithub/{repo} 这类模板式不能用于 git clone）。
  const prefixes = s.download.githubProxies.filter((p) => !/\{[a-z]+\}/.test(p));
  const cands = [url, ...prefixes.map((p) => (p.endsWith('/') ? p : p + '/') + url)];
  let lastErr = null;
  for (const c of cands) {
    const r = spawnSync(git, ['clone', '--depth', '1', c, dest], { encoding: 'utf8' });
    if (r.status === 0) return { cmd: git, args: ['--version'] };   // 已克隆完成
    lastErr = (r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(-1)[0];
  }
  throw new Error('git clone 失败（含镜像尝试）：' + (lastErr || '未知错误'));
}

function which(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, [name], { encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function runJobCmd(job, spec) {
  if (spec.cmd === 'git' && spec.args[0] === '--version') return;   // proxyGitClone 已完成克隆
  job.log('$ ' + [spec.cmd, ...spec.args].join(' '));
  const r = spawnSync(spec.cmd, spec.args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (out) out.split(/\r?\n/).slice(-15).forEach((l) => job.log('  ' + l));
  if (r.status !== 0) throw new Error(`命令失败（exit ${r.status}）：${spec.cmd} ${spec.args.join(' ')}`);
}

// ── 自定义节点 ───────────────────────────────────────────

async function installNodes(job, opts) {
  const mode = opts.mode || load().comfy.mode;
  const dir = mode === 'external' ? (opts.externalDir || load().comfy.dir) : paths.comfyEmbedded;
  const layout = comfy.detectLayout(dir);
  if (!layout.ok) { job.log('本体尚未就绪，跳过自定义节点', 'warn'); return { skipped: true }; }
  const dest = path.join(layout.codeDir, 'custom_nodes', 'comfyui-anima-3-8B');
  if (fsx.isFile(path.join(dest, '__init__.py')) || fsx.isDir(dest)) {
    job.log('自定义节点 comfyui-anima-3-8B 已存在，跳过');
  } else {
    const git = which('git');
    fsx.ensureDir(path.dirname(dest));
    if (git) {
      job.log('克隆 comfyui-anima-3-8B（MIT）…');
      try {
        runJobCmd(job, await proxyGitClone(git, ANIMA_NODE_GIT, dest));
        runJobCmd(job, { cmd: git, args: ['-C', dest, 'checkout', ANIMA_NODE_COMMIT] });
      } catch (e) {
        job.log('git 方式失败，改用 codeload ZIP：' + e.message, 'warn');
        fs.rmSync(dest, { recursive: true, force: true });
      }
    }
    if (!fsx.isDir(dest)) {
      const zipUrl = `https://codeload.github.com/GumGum10/comfyui-anima-3-8B/zip/${ANIMA_NODE_COMMIT}`;
      const zf = path.join(paths.runtimeDl, 'anima-node.zip');
      job.log('下载节点 ZIP（codeload）…');
      await dl.download({ url: zipUrl, dest: zf, job, phase: 'nodes', label: 'comfyui-anima-3-8B.zip', settings: load() });
      zip.unzipTo(zf, dest);
      zip.hoistSingleRoot(dest, (l) => job.log(l));
    }
  }
  // 节点依赖：用 ComfyUI 自己的解释器装，避免污染系统环境
  if (layout.python) {
    const req = path.join(dest, 'requirements.txt');
    if (fsx.isFile(req)) {
      job.log('安装节点依赖（pip 使用镜像源）…');
      try {
        runJobCmd(job, { cmd: layout.python, args: ['-m', 'pip', 'install', '-r', req, '-i', load().download.pipIndex] });
      } catch (e) {
        job.log('节点依赖安装失败（可稍后手动重试）：' + e.message, 'warn');
      }
    }
  }
  return { dest };
}

// ── 模型权重 ─────────────────────────────────────────────

async function installModels(job, ids, opts) {
  const list = catalog();
  const wanted = ids && ids.length ? list.filter((m) => ids.includes(m.id)) : [];
  if (!wanted.length) { job.log('未选择任何模型'); return { installed: [], skipped: [] }; }
  const mode = opts.mode || load().comfy.mode;
  const modelsDir = modelsDirFor(mode, opts.externalDir);
  job.log(`权重目标目录：${modelsDir}`);
  fsx.ensureDir(modelsDir);
  const settings = load();
  const installed = [];
  const skipped = [];
  const totalBytes = wanted.reduce((a, m) => a + m.bytes, 0);
  let doneBytes = 0;
  for (const m of wanted) {
    job.phase('models');
    const target = path.join(modelsDir, m.dest, m.file);
    const st = installedState(m, modelsDir);
    if (st.ready && !opts.force) {
      job.log(`已就绪，跳过：${m.file}（${fsx.fmtBytes(m.bytes)}）`, 'ok');
      skipped.push(m.id);
      doneBytes += m.bytes;
      continue;
    }
    job.log(`准备模型 ${m.id}（${fsx.fmtBytes(m.bytes)}，许可 ${m.license}）`);
    let done = false;

    // ① 本地已有 ComfyUI 目录里找同名文件 → 硬链接/复制（离线可用，且省一次全量下载）
    if (opts.modelsFrom?.dir) {
      const found = findModelFile(opts.modelsFrom.dir, m.file);
      if (found) {
        fsx.ensureDir(path.dirname(target));
        const useLink = (opts.copyMode || 'link') === 'link';
        fs.rmSync(target, { force: true });
        let linked = false;
        if (useLink) { try { fs.linkSync(found, target); linked = true; } catch { linked = false; } }
        if (!linked) fs.copyFileSync(found, target);
        const okSize = fsx.sizeOf(target) === m.bytes;
        job.log(`从本地导入：${m.file} ← ${found}（${linked ? '硬链接' : '复制'}${okSize ? '' : '，⚠️ 大小与目录表不一致'}）`, okSize ? 'ok' : 'warn');
        done = true;
      }
    }

    // ② 联网下载（官方源 → 模板镜像梯队 → 该组件在 models.json 里声明的已验证镜像，F3）
    if (!done) {
      const url = m.officialUrl || (Array.isArray(m.urls) && m.urls[0]);
      if (!url) { job.log(`模型 ${m.id} 没有可用下载地址（models.json 里 urls 为空）`, 'error'); continue; }
      // mirrors：每个权重单独声明的"实测可用"镜像（≥3 个来源的要求写在数据里，可审计）。
      // fastMirrors：实测很快、插到梯队最前面先试的来源。
      const mirrors = (Array.isArray(m.mirrors) ? m.mirrors : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
      const fastMirrors = (Array.isArray(m.fastMirrors) ? m.fastMirrors : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
      await dl.download({
        url, urls: mirrors, urlsFirst: fastMirrors, dest: target, job, phase: 'models', label: m.file,
        expectBytes: m.bytes, sha256: m.sha256, settings,
        // force 必须一路传到下载引擎：`download()` 自己还有一条"已存在且大小匹配就跳过"的短路，
        // 不传就会变成"点了重新下载却什么都没发生"（实测踩到：向导里的强制重下 2.5 秒就"完成"了）。
        force: !!opts.force,
      });
    }
    doneBytes += m.bytes;
    job.emitPercent('models', (doneBytes / totalBytes) * 100, `${m.file} 完成`);
    installed.push(m.id);
  }
  return { installed, skipped, modelsDir };
}

function findModelFile(root, fileName) {
  const direct = [
    path.join(root, 'models', 'diffusion_models', fileName),
    path.join(root, 'models', 'text_encoders', fileName),
    path.join(root, 'models', 'vae', fileName),
    path.join(root, fileName),
  ];
  for (const p of direct) if (fsx.isFile(p)) return p;
  // 兜底：浅层递归找同名文件（深度 ≤ 4）
  const stack = [{ d: root, depth: 0 }];
  while (stack.length) {
    const { d, depth } = stack.shift();
    if (depth > 4) continue;
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === fileName.toLowerCase()) return p;
      if (e.isDirectory() && !['venv', 'python_embeded', '.git', 'node_modules', 'output', 'temp'].includes(e.name)) stack.push({ d: p, depth: depth + 1 });
    }
  }
  return null;
}

// ── 画师清单 / 许可 ──────────────────────────────────────

function installArtists(job, opts) {
  const mode = opts?.mode || load().comfy.mode;
  const dir = mode === 'external' ? (opts?.externalDir || load().comfy.dir) : paths.comfyEmbedded;
  const targets = [path.join(dir, 'model-notes')];
  const layout = comfy.detectLayout(dir);
  if (layout.ok) targets.push(path.join(layout.codeDir, 'model-notes'));
  const files = ['Anima2B_Artist_Index_59k.txt', 'Anima2B_Artist_top200.txt', 'NOTICE.md'];
  for (const t of targets) {
    fsx.ensureDir(t);
    for (const f of files) {
      const src = path.join(paths.artists, f);
      if (!fsx.isFile(src)) continue;
      fs.copyFileSync(src, path.join(t, f));
    }
    job.log('画师清单已复制到：' + t);
  }
  comfy.resetArtistsCache();
  return { targets };
}

function installLicenses(job, opts) {
  const mode = opts?.mode || load().comfy.mode;
  const dir = mode === 'external' ? (opts?.externalDir || load().comfy.dir) : paths.comfyEmbedded;
  const dest = path.join(dir, 'LICENSES');
  fsx.ensureDir(dest);
  let n = 0;
  if (fsx.isDir(paths.licenses)) {
    for (const f of fs.readdirSync(paths.licenses)) {
      const src = path.join(paths.licenses, f);
      if (!fsx.isFile(src)) continue;
      fs.copyFileSync(src, path.join(dest, f));
      n++;
    }
  }
  const tp = path.join(paths.root, 'THIRD_PARTY.md');
  if (fsx.isFile(tp)) fs.copyFileSync(tp, path.join(dir, 'THIRD_PARTY-NOTICE.md'));
  job.log(`许可与第三方声明已复制（${n} 个文件）→ ${dest}`);
  return { dest, files: n };
}

// ── 计划与总入口 ─────────────────────────────────────────

function plan(opts = {}) {
  const mode = opts.mode === 'external' ? 'external' : 'embedded';
  const list = catalog();
  const modelsDir = modelsDirFor(mode, opts.externalDir);
  const models = list.map((m) => {
    const st = installedState(m, modelsDir);
    return { id: m.id, file: m.file, bytes: m.bytes, tier: m.tier, license: m.license, licenseName: m.licenseName, dest: m.dest, installed: st.ready, existingBytes: st.exists ? st.size : 0, note: m.note };
  });
  const sel = resolveSelection(list, opts.sel === undefined ? '' : opts.sel);
  const selected = sel.ids.length ? models.filter((m) => sel.ids.includes(m.id)) : [];
  const tiers = {
    minimal: models.filter((m) => m.tier === 'minimal').reduce((a, m) => a + m.bytes, 0),
    standard: models.filter((m) => ['minimal', 'standard'].includes(m.tier)).reduce((a, m) => a + m.bytes, 0),
    full: models.reduce((a, m) => a + m.bytes, 0),
  };
  return {
    mode,
    modelsDir,
    comfyDir: mode === 'external' ? (opts.externalDir || load().comfy.dir) : paths.comfyEmbedded,
    steps: [
      { id: 'runtime', title: '运行时与解压工具' },
      { id: 'comfyui', title: mode === 'external' ? '外接 ComfyUI 检测' : '获取 ComfyUI 本体' },
      { id: 'nodes', title: '自定义节点（comfyui-anima-3-8B）' },
      { id: 'models', title: '模型权重' },
      { id: 'artists', title: '画师清单' },
      { id: 'licenses', title: '许可与第三方声明' },
    ],
    models,
    selected,
    unknown: sel.unknown,
    totalBytes: selected.reduce((a, m) => a + m.bytes, 0),
    tiers,
    platform: process.platform,
  };
}

/** 向导主流程。opts: {mode, comfySource:{kind,path}, models:[ids], copyMode, modelsFrom:{dir}, externalDir, skip:{}} */
async function runSetup(job, opts) {
  const result = { steps: {} };
  const skip = opts.skip || {};
  job.log(`向导开始：模式=${opts.mode || 'embedded'}，ComfyUI 来源=${opts.comfySource?.kind || 'portable'}`);

  if (!skip.runtime) {
    job.phase('runtime');
    const z = await ensure7z(job);
    result.steps.runtime = { sevenZip: z.exe, source: z.source };
  } else {
    job.log('跳过运行时步骤');
  }

  if (!skip.comfyui) {
    job.phase('comfyui');
    if ((opts.mode || 'embedded') === 'external') {
      const dir = opts.externalDir;
      const layout = comfy.detectLayout(dir);
      if (!layout.ok) throw new Error('外接目录不可用：' + layout.error);
      save({ comfy: { mode: 'external', dir } });
      result.steps.comfyui = { external: true, dir, layout: layout.layout, modelsDir: layout.modelsDir };
      job.log(`外接 ComfyUI 就绪：${layout.layout} 布局，权重目录 ${layout.modelsDir}`, 'ok');
    } else {
      result.steps.comfyui = await installComfyUI(job, opts);
    }
  } else {
    job.log('跳过 ComfyUI 本体步骤');
  }

  if (!skip.nodes && (opts.mode || 'embedded') === 'embedded') {
    job.phase('nodes');
    try {
      result.steps.nodes = await installNodes(job, opts);
    } catch (e) {
      job.log('自定义节点安装失败（Anima 3.8B v2 管线会不可用，其它管线不受影响）：' + e.message, 'error');
      result.steps.nodes = { error: e.message };
    }
  }

  if (!skip.models) {
    job.phase('models');
    const ids = opts.models && opts.models.length ? opts.models : resolveSelection(catalog(), opts.sel || '').ids;
    result.steps.models = await installModels(job, ids, opts);
  } else {
    job.log('跳过模型步骤');
  }

  if (!skip.artists) {
    job.phase('artists');
    result.steps.artists = installArtists(job, opts);
  }
  if (!skip.licenses) {
    job.phase('licenses');
    result.steps.licenses = installLicenses(job, opts);
  }

  const mode = opts.mode || 'embedded';
  if (mode === 'embedded') save({ comfy: { mode: 'embedded', dir: '' } });
  store.writeSetup({
    completed: true,
    mode,
    comfySource: opts.comfySource?.kind || 'portable',
    comfyDir: mode === 'external' ? (opts.externalDir || '') : paths.comfyEmbedded,
    modelsDir: modelsDirFor(mode, opts.externalDir),
    // v1.1.0（修复 B5）：已就绪而被跳过的权重同样要记账 —— 硬链接导入本机已有 ComfyUI 时
    // 模型全部走 skipped 分支，旧写法只落 installed，于是 setup.json 的 models 为空，
    // 向导页看起来"一个都没装"。
    models: result.steps.models
      ? [...new Set([...(result.steps.models.installed || []), ...(result.steps.models.skipped || [])])]
      : [],
    artists: !skip.artists,
    licenses: !skip.licenses,
  });
  job.log('向导完成 ✅', 'ok');
  return result;
}

module.exports = {
  catalog, plan, resolveSelection, modelsDirFor, installedState, runSetup,
  ensure7z, installComfyUI, installNodes, installModels, installArtists, installLicenses, findModelFile,
  COMFYUI_GIT, COMFYUI_COMMIT,
};
