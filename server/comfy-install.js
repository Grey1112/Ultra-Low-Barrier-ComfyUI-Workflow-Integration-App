// 首次运行向导的安装器（Node 侧，替代插件版的 PowerShell 安装器）。
//
// 安装目标全部落在项目内（内嵌模式）：runtime/comfyui（ComfyUI 本体）、
// runtime/bin（7-Zip 精简版）、<modelsDir>（权重）、<comfyDir>/model-notes（画师清单）。
// 一切下载走 server/download.js 的 F3 策略（官方源 → 镜像，自动切换并提示）。
//
// v1.3.0（第十二轮）—— 修的是用户报的"恶性 bug"（安装阶段）：
//   ① **可续装**：每个组件/模型装完就把状态写进 data/install/state.json，并且判定一律以
//      **磁盘真值**为准（install-state.js）。再次点「开始安装」只装缺的，绝不重下已装好的东西。
//      旧实现没有任何逐组件记录，`installComfyUI` 又无条件 `fs.rmSync(destRoot)` + 全量解压，
//      于是每次点安装都要重下 1.79 GB 的便携包 —— 而且那个 destRoot 正是内嵌模式的权重目录，
//      重装会把用户已经下好的模型一起删掉（本机实测就是这么丢的）。
//   ② **不卡死**：所有来源都失败/都太慢时**跳过该组件并继续后面的**，
//      慢源由 download.js 的墙钟上限掐掉（实测踩过 50 KB/s 磨一整天）。
//   ③ **组件与模型分离**：runSetup 分两段跑，模型段由 install-queue.js 统一排队与播报。
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

/** 延迟取用：install-state / install-queue 会 require 本模块，顶层互相 require 会成环。 */
function stateMod() { return require('./install-state'); }
function queueMod() { return require('./install-queue'); }

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

/** 归档签名校验（v1.3.0）：防止把"几百 KB 的校验页/HTML 错误页"当成下载成功的归档。 */
function archiveKind(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8);
    const n = fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    if (n < 4) return 'unknown';
    if (buf[0] === 0x37 && buf[1] === 0x7a && buf[2] === 0xbc && buf[3] === 0xaf) return '7z';
    if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'zip';
    if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'rar';
  } catch { /* 读不到就当未知 */ }
  return 'unknown';
}

/** 校验归档并返回类型；不是归档就删掉它（下次会重新下）并抛错。 */
function requireArchive(file, label) {
  const kind = archiveKind(file);
  if (kind === 'unknown') {
    const size = fsx.sizeOf(file);
    try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
    throw new Error(`${label} 不是有效的压缩包（大小 ${fsx.fmtBytes(size)}，多半是下到了错误页/被截断）——已删除，将在下一个来源重试`);
  }
  return kind;
}

/**
 * 校验"可执行文件"（7zr.exe / 7za.exe 这类）。
 * ⚠️ 别拿 requireArchive 去校验它们：那会把一个好好的 7zr.exe 当成"坏压缩包"删掉，
 * 于是每次安装都要重下一遍（自检时真实踩到过这个反噬）。
 * 判据：Windows PE 头 `MZ` + 体积下界（7zr.exe 约 580 KB，取 256 KB 作护栏）。
 */
function requireBinary(file, label, minBytes = 262144) {
  let head = Buffer.alloc(2);
  try {
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
  } catch { /* 读不到按不合格处理 */ }
  const size = fsx.sizeOf(file);
  const isMz = head[0] === 0x4d && head[1] === 0x5a;
  const isElf = head[0] === 0x7f && head[1] === 0x45;
  if (size < minBytes || !(isMz || isElf)) {
    try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
    throw new Error(`${label} 不像有效的可执行文件（大小 ${fsx.fmtBytes(size)}，头部 ${head.toString('hex')}）——已删除，将在下一个来源重试`);
  }
  return true;
}

/**
 * 保证有一个可用的 7-Zip。
 * v1.3.0 的加固点：
 *   · 7z-extra.7z 落盘后先做**归档签名校验**（本机实测踩过：down.npee.cn 返回一个 1.4 MB 的
 *     非归档响应，旧实现当成"下载完成"，接着 7zr 报 `Is not archive`，最后降级到 7zr 去解
 *     1.79 GB 的大包 —— 又慢又难查）；
 *   · 不再静默接受坏缓存：校验不过就删掉并换下一个来源；
 *   · opts.control / maxWallMs 一路传给下载引擎（暂停、取消、墙钟上限都生效）。
 */
async function ensure7z(job, opts = {}) {
  const state = stateMod();
  const binDir = paths.runtimeBin;
  fsx.ensureDir(binDir);
  const have = zip.find7z([binDir]);
  // 已随项目携带的 7za.exe 优先；系统装的 7z.exe 也能用。
  const x64 = path.join(binDir, '7za.exe');
  if (fsx.isFile(x64)) return { exe: x64, source: 'bundled' };
  if (have && /7za\.exe$|7z\.exe$/i.test(have) && path.resolve(have).startsWith(path.resolve(binDir))) return { exe: have, source: 'bundled' };
  // v1.3.0：把 7zr 也算作"已就绪"（它同样是一个可用的 7-Zip；旧实现每次都要重下一次 7zr.exe）
  const r7zrExisting = path.join(binDir, '7zr.exe');
  if (fsx.isFile(r7zrExisting)) {
    state.markComponent('runtime', { exe: r7zrExisting, source: 'bundled-7zr' });
    return { exe: r7zrExisting, source: 'bundled-7zr' };
  }
  // v1.3.0：用户已经指定了**本地归档**且它是 zip 时，内置 JS 解压器就够了 ——
  // 不该为了解一个本地 zip 再去下载 7-Zip（那是一次与出图无关的联网等待）。
  if (opts.archiveIsZipOnly) return { exe: null, source: 'builtin-zip' };

  const settings = load();
  const sevenZipBase = 'https://github.com/ip7z/7zip/releases/download';
  const candidatesFor = (file) => [
    ...SEVENZIP_TAGS.map((t) => `${sevenZipBase}/${t}/${file}`),
    `https://www.7-zip.org/a/${file}`,
  ];

  const r7zr = path.join(binDir, '7zr.exe');
  const dlOpts = {
    job, phase: 'runtime', settings, force: true,
    control: opts.control, maxWallMs: opts.maxWallMs, skipHosts: opts.skipHosts,
  };
  if (!fsx.isFile(r7zr)) {
    job.log('获取 7-Zip 精简版（7zr.exe，约 0.6 MB）…');
    let done = false;
    let lastErr = null;
    for (const url of candidatesFor('7zr.exe')) {
      try {
        await dl.download({ ...dlOpts, url, dest: r7zr, label: '7zr.exe' });
        requireBinary(r7zr, '7zr.exe');
        done = true;
        break;
      } catch (e) {
        if (e && (e.code === dl.PAUSED || e.code === dl.CANCELED)) throw e;
        lastErr = e; job.log('7zr.exe 来源失败：' + e.message, 'warn');
      }
    }
    if (!done) {
      throw new Error('7zr.exe 获取失败（GitHub 镜像与官方站都不通）：' + (lastErr ? lastErr.message : '未知')
        + '\n可手动把 7za.exe / 7zr.exe 放进 runtime\\bin\\（或先安装 7-Zip），再重试；'
        + '若你的 ComfyUI 是 ZIP 包，向导里选「本地归档」时不需要 7-Zip。');
    }
  }
  // 用 7zr 解出完整版 x64 7za（便携、无安装、无注册表）
  try {
    job.log('解出 x64 版 7za.exe（用于处理大体积便携包）…');
    const extra = path.join(paths.runtimeDl, '7z-extra.7z');
    if (fsx.isFile(extra)) {
      // 上一次可能留下一个坏缓存：先校验，不合格就删掉重下（旧实现会一直拿着它报 Is not archive）
      try { requireArchive(extra, '7z-extra.7z'); }
      catch (e) { job.log('清掉损坏的 7z-extra.7z 缓存：' + e.message, 'warn'); }
    }
    if (!fsx.isFile(extra)) {
      let lastErr = null;
      let ok = false;
      const urls = candidatesFor(`7z${SEVENZIP_TAGS[0]}-extra.7z`)
        .concat(SEVENZIP_TAGS.slice(1).map((t) => `https://www.7-zip.org/a/7z${t}-extra.7z`));
      for (const url of urls) {
        try {
          await dl.download({ ...dlOpts, url, dest: extra, label: '7z-extra.7z' });
          requireArchive(extra, '7z-extra.7z');
          ok = true;
          break;
        } catch (e) {
          if (e && (e.code === dl.PAUSED || e.code === dl.CANCELED)) throw e;
          lastErr = e; job.log('7z-extra 来源失败：' + e.message, 'warn');
        }
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
      state.markComponent('runtime', { exe: x64, source: 'bundled' });
      return { exe: x64, source: 'bundled' };
    }
  } catch (e) {
    if (e && (e.code === dl.PAUSED || e.code === dl.CANCELED)) throw e;
    job.log('解出 x64 版 7za 失败，回落到 7zr.exe（仍可解压 7z，但大包解压更慢）：' + e.message, 'warn');
  }
  if (fsx.isFile(r7zr)) {
    job.log('⚠️ 当前使用 7zr 精简版解压：解大体积便携包会明显更慢（这是上一次 7za 获取失败的后果）', 'warn');
    state.markComponent('runtime', { exe: r7zr, source: 'bundled-7zr' });
    return { exe: r7zr, source: 'bundled-7zr' };
  }
  if (have) {
    job.log('改用系统已安装的 7-Zip：' + have, 'warn');
    state.markComponent('runtime', { exe: have, source: 'system' });
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
  const state = stateMod();

  if (kind === 'external') { job.log('外接模式：不改动 ComfyUI 本体'); return { external: true }; }

  // ── v1.3.0（需求 1 / 3）：已装好就**什么都不做** ─────────────────────────────
  // 这是用户报的恶性 bug 的正解：旧实现无条件 `fs.rmSync(destRoot)` + 全量解压，
  // 于是"每次点开始安装都重新安装 ComfyUI"；更糟的是 destRoot 就是内嵌模式的权重目录，
  // 重装会连用户已下好的模型一起删掉。现在只在「明确要求重装」或「确实没装/是半成品」时才动它。
  const existing = comfy.detectLayout(destRoot);
  const forceComfy = !!(opts.force && (opts.force === true || opts.force.comfyui));
  if (existing.ok && existing.python && !forceComfy) {
    job.log(`ComfyUI 本体已安装，跳过获取与解压（${existing.layout} 布局，入口 ${existing.mainPy}）`, 'ok');
    state.markComponent('comfyui', { dir: destRoot, codeDir: existing.codeDir, layout: existing.layout, kind: 'existing' });
    return { ok: true, skipped: true, codeDir: existing.codeDir, modelsDir: existing.modelsDir };
  }
  if (!existing.ok && fsx.isDir(destRoot) && fsx.isDir(path.join(destRoot, 'ComfyUI'))) {
    // 半成品（本机实测形态：runtime\comfyui\ComfyUI 下只有一个 output\ 空壳）：
    // 明确说明并清掉，避免"看起来装了其实跑不起来"。
    job.log('检测到上一次安装留下的半成品目录（不完整），将清理后重新获取：' + (existing.error || ''), 'warn');
  }

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
  // v1.3.0（需求 2）：这里拆成**下载**与**解压**两段，供队列做成两个可分别调用的阶段 ——
  // 这样"下载 ComfyUI 的同时先把模型也下起来"才有可能（见 install-queue 的双通道调度）。
  const archive = await downloadPortableArchive(job, opts);
  return await installFromArchive(job, archive, opts);
}

/**
 * 只负责把便携包**下载**到 runtime/_dl（不碰 runtime/comfyui，不解压）。
 * @returns {Promise<string>} 归档文件路径
 */
async function downloadPortableArchive(job, opts = {}) {
  const kind = opts.comfySource?.kind || 'portable';
  const settings = load();
  if (kind === 'archive') {
    const a = opts.comfySource.path;
    if (!fsx.isFile(a)) throw new Error('指定的本地归档不存在：' + a);
    requireArchive(a, '指定的本地归档');
    job.log('使用本地归档：' + a);
    return a;
  }
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

  // 候选表按"主机是否已试过"重排 —— 「自动换源」时跳过上一轮已经失败的主机。
  const skipHosts = new Set((opts.skipHosts || []).map((h) => String(h).toLowerCase()));
  const ordered = entries.filter((e) => { try { return !skipHosts.has(new URL(e.url).host.toLowerCase()); } catch { return true; } });
  const finalEntries = ordered.length ? ordered : entries;
  if (ordered.length < entries.length) {
    job.log(`按「自动换源」跳过 ${entries.length - ordered.length} 个已失败的来源（剩余 ${finalEntries.length} 个）`, 'warn');
  }

  let archive = null;
  let lastErr = null;
  for (let i = 0; i < finalEntries.length; i++) {
    const e = finalEntries[i];
    const file = path.join(paths.runtimeDl, e.saveAs || e.name);
    try {
      job.log(`获取 ComfyUI 便携包（候选 ${i + 1}/${finalEntries.length}）：${e.name}${e.note ? '（' + e.note + '）' : ''}${e.thirdParty ? '（第三方社区构建，非官方包）' : ''}`);
      await dl.download({
        url: e.url, dest: file, job, phase: 'comfyui', label: e.name, settings,
        expectBytes: e.expectBytes, sha256: e.sha256, force: true,
        control: opts.control, maxWallMs: opts.maxWallMs, skipHosts: opts.skipHosts,
        // ⚠️ onProgress 必须一路传下来：队列靠它拿到 downloaded/total/speedKBs/etaSec。
        // 这里漏过一次 —— 现象就是「ComfyUI 本体那一行没有下载速度」（其余任务都有），
        // 因为其他下载路径都传了，唯独这条 1.79 GB 的主下载没传。
        onProgress: opts.onProgress,
        // 大包不做"下载后逐字节 sha256"（1.79 GB 要几十秒白等）；完整性由
        // download.js 的"改名前的字节校验" + 归档签名校验 + 解压结果判定三道兜住。
        noSha: true,
      });
      requireArchive(file, e.name);
      archive = file;
      if (e.thirdParty) job.log('注意：本次使用的是第三方社区构建的便携包（不是 ComfyUI 官方包），遇到问题请改用官方包或本地归档。', 'warn');
      if (e.note) job.log('注意：' + e.note, 'warn');
      break;
    } catch (err) {
      if (err && (err.code === dl.PAUSED || err.code === dl.CANCELED)) throw err;
      lastErr = err;
      job.log(`候选 ${e.name} 失败：${err.message}`, 'warn');
    }
  }
  if (!archive) {
    throw new Error('ComfyUI 便携包获取失败（官方源与全部镜像都不通）。\n最后一次错误：' + (lastErr ? lastErr.message : '未知')
      + '\n可手动下载 ComfyUI 的 Windows 便携包，然后在「安装中心」选择「本地归档」指定该 .7z 文件；'
      + '或改用「外接已有目录」/「git 模式」（需要 git 与系统 Python）。');
  }
  return archive;
}

/**
 * 只负责把**已经下好的**归档解压安装到 runtime/comfyui（不联网）。
 * 阶段可单独调用，因此队列能先下 ComfyUI、同时并行下模型、下载完再调这一步入库。
 */
async function installFromArchive(job, archive, opts = {}) {
  const destRoot = paths.comfyEmbedded;
  const state = stateMod();
  if (!archive || !fsx.isFile(archive)) throw new Error('归档不存在（请先完成 ComfyUI 下载）：' + archive);
  const localArchiveKind = archiveKind(archive);

  // ── 解压：**先备份已有 models\，解压成功后合并回来**（红线：重装不删权重）──────────
  job.log('解压便携包（大包解压需要几分钟，请勿关闭窗口）…');
  job.phase('comfyui');
  const modelsBackup = path.join(paths.runtimeDl, '_comfyui-models-bak');
  let movedModels = false;
  // 两个可能的权重落位：便携包内层 ComfyUI\models 与 destRoot\models
  const innerModels = path.join(destRoot, 'ComfyUI', 'models');
  const outerModels = path.join(destRoot, 'models');
  try {
    fs.rmSync(modelsBackup, { recursive: true, force: true });
    for (const [src, tag] of [[innerModels, 'inner'], [outerModels, 'outer']]) {
      if (fsx.isDir(src)) {
        const dst = path.join(modelsBackup, tag);
        fsx.ensureDir(path.dirname(dst));
        fs.renameSync(src, dst);
        movedModels = true;
        job.log(`已临时保管已有权重目录（重装后原样合并回来）：${src}`, 'warn');
      }
    }
  } catch (e) {
    job.log('备份已有权重目录失败（改为原地保留，不做全量删除）：' + e.message, 'warn');
  }

  const restoreModels = () => {
    if (!movedModels) return;
    try {
      const pairs = [[path.join(modelsBackup, 'inner'), innerModels], [path.join(modelsBackup, 'outer'), outerModels]];
      for (const [bak, dst] of pairs) {
        if (!fsx.isDir(bak)) continue;
        fsx.copyTree(bak, dst, { link: false });
        fs.rmSync(bak, { recursive: true, force: true });
      }
    } catch (e) {
      job.log('⚠️ 权重目录合并失败，备份仍保留在：' + modelsBackup + '（原因：' + e.message + '）', 'error');
      return;
    }
    movedModels = false;
  };

  // 解压需要 7-Zip；本地归档是 ZIP 时内置解压器就够（不去联网下 7-Zip）
  const sevenZip = await ensure7z(job, { ...opts, archiveIsZipOnly: localArchiveKind === 'zip' });
  if (sevenZip.exe) job.log(`使用 7-Zip：${sevenZip.exe}（来源：${sevenZip.source}）`);
  else job.log('本次不需要 7-Zip（归档是 ZIP，走内置解压器）');

  try {
    // 半成品目录只清"代码与解释器"，权重已经在上面挪走了
    fs.rmSync(destRoot, { recursive: true, force: true });
    fsx.ensureDir(destRoot);
    if (localArchiveKind === 'zip') {
      job.log('归档类型：ZIP（走内置解压器）');
      zip.unzipTo(archive, destRoot, (n) => { if (n && n.length < 80) job.log('  + ' + n); });
    } else {
      zip.extractWith7z(sevenZip.exe, archive, destRoot, { onLine: (l) => job.log(l) });
    }
    zip.hoistSingleRoot(destRoot, (l) => job.log(l));
    const layout = comfy.detectLayout(destRoot);
    if (!layout.ok || !layout.python) {
      throw new Error('解压完成但未找到可用的 ComfyUI（需要 main.py 与 python_embeded\\python.exe）。'
        + (layout.error || '') + ' 可改用「本地归档」或「外接已有目录」重试。');
    }
    restoreModels();
    job.log(`ComfyUI 就绪：入口 ${layout.mainPy}，解释器 ${layout.python}`, 'ok');
    state.markComponent('comfyui', { dir: destRoot, codeDir: layout.codeDir, layout: layout.layout, kind });
    return { ok: true, portable: true, codeDir: layout.codeDir, modelsDir: layout.modelsDir, archive };
  } catch (e) {
    // 解压失败也要把权重放回去（否则一次失败就把用户的模型弄丢了）
    restoreModels();
    throw e;
  }
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

/**
 * 下载并安装**一个**模型（向导与安装中心队列共用这一份实现）。
 * 语义要点（v1.3.0）：
 *   · 已就绪（大小精确匹配）就跳过 —— 不重复下载（需求 1）；
 *   · `control`（暂停/取消）`maxWallMs`（墙钟上限）`skipHosts`（自动换源）一路传到下载引擎；
 *   · 失败**只抛给调用方**，由调用方决定"跳过并继续"（需求 2）。
 */
async function installOneModel(job, entry, opts = {}) {
  const modelsDir = opts.modelsDir || modelsDirFor(opts.mode || load().comfy.mode, opts.externalDir);
  const target = path.join(modelsDir, entry.dest, entry.file);
  const st = { file: target, size: fsx.sizeOf(target) };
  st.exists = st.size >= 0;
  st.ready = st.exists && (entry.bytes ? st.size === entry.bytes : st.size > 0);
  const force = !!(opts.force && (opts.force === true || (opts.forceModels && opts.forceModels[entry.id]) || opts.forceAllModels));
  if (st.ready && !force) {
    job.log(`已就绪，跳过：${entry.file}（${fsx.fmtBytes(entry.bytes)}）`, 'ok');
    return { id: entry.id, skipped: true, file: target };
  }
  fsx.ensureDir(path.dirname(target));
  job.log(`准备模型 ${entry.id}（${fsx.fmtBytes(entry.bytes)}，${entry.custom ? '自定义模型' : '许可 ' + entry.license}）`);

  // ① 本地已有 ComfyUI 目录里找同名文件 → 硬链接/复制（离线可用，且省一次全量下载）
  if (opts.modelsFrom?.dir) {
    const found = findModelFile(opts.modelsFrom.dir, entry.file);
    if (found) {
      const useLink = (opts.copyMode || 'link') === 'link';
      fs.rmSync(target, { force: true });
      let linked = false;
      if (useLink) { try { fs.linkSync(found, target); linked = true; } catch { linked = false; } }
      if (!linked) fs.copyFileSync(found, target);
      const okSize = fsx.sizeOf(target) === entry.bytes;
      job.log(`从本地导入：${entry.file} ← ${found}（${linked ? '硬链接' : '复制'}${okSize ? '' : '，⚠️ 大小与目录表不一致'}）`, okSize ? 'ok' : 'warn');
      if (!entry.custom) stateMod().markModel(entry.id, { file: entry.file, bytes: entry.bytes, sha256: '-' });
      return { id: entry.id, imported: true, file: target };
    }
  }

  // ② 联网下载（官方源 → 模板镜像梯队 → 该组件在 models.json 里声明的已验证镜像）
  const url = entry.officialUrl || entry.sourceUrl || (Array.isArray(entry.urls) && entry.urls[0]);
  if (!url) throw new Error(`模型「${entry.file}」没有可用下载地址（自定义模型请在编辑里填来源直链，或用本地上传）`);
  const mirrors = (Array.isArray(entry.mirrors) ? entry.mirrors : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
  const fastMirrors = (Array.isArray(entry.fastMirrors) ? entry.fastMirrors : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
  const r = await dl.download({
    url, urls: mirrors, urlsFirst: fastMirrors, dest: target, job, phase: 'models', label: entry.file,
    expectBytes: entry.bytes, sha256: entry.sha256, settings: opts.settings || load(),
    // force 必须一路传到下载引擎：`download()` 自己还有一条"已存在且大小匹配就跳过"的短路，
    // 不传就会变成"点了重新下载却什么都没发生"（实测踩到：向导里的强制重下 2.5 秒就"完成"了）。
    force,
    control: opts.control, maxWallMs: opts.maxWallMs, skipHosts: opts.skipHosts, onProgress: opts.onProgress,
  });
  if (!entry.custom) stateMod().markModel(entry.id, { file: entry.file, bytes: r.bytes, sha256: entry.sha256 ? 'ok' : '-' });
  return { id: entry.id, file: target, bytes: r.bytes, source: r.source, via: r.via };
}

/**
 * 批量安装模型（向导路径）。**逐个 try/catch**：任何一个模型全部来源都失败时，
 * 只记录并**继续下一个**（需求 2：不允许在某一步卡死整条流程）。
 */
async function installModels(job, ids, opts) {
  const list = catalog();
  const wanted = ids && ids.length ? list.filter((m) => ids.includes(m.id)) : [];
  if (!wanted.length) { job.log('未选择任何模型'); return { installed: [], skipped: [], failed: [], modelsDir: null }; }
  const mode = opts.mode || load().comfy.mode;
  const modelsDir = modelsDirFor(mode, opts.externalDir);
  job.log(`权重目标目录：${modelsDir}`);
  fsx.ensureDir(modelsDir);
  const installed = [];
  const skipped = [];
  const failed = [];
  const totalBytes = wanted.reduce((a, m) => a + m.bytes, 0);
  let doneBytes = 0;
  for (const m of wanted) {
    job.phase('models');
    if (opts.control && opts.control.getState && opts.control.getState() !== 'running') throw Object.assign(new Error('已暂停/取消'), { code: opts.control.getState() === 'canceled' ? dl.CANCELED : dl.PAUSED });
    try {
      const r = await installOneModel(job, m, { ...opts, modelsDir });
      if (r.skipped) skipped.push(m.id); else installed.push(m.id);
    } catch (e) {
      if (e && (e.code === dl.PAUSED || e.code === dl.CANCELED)) throw e;
      failed.push({ id: m.id, file: m.file, error: e.message });
      job.log(`模型 ${m.id} 安装失败，**自动跳过并继续下一个**：${e.message}`, 'error');
    }
    doneBytes += m.bytes;
    job.emitPercent('models', (doneBytes / totalBytes) * 100, `${m.file} 完成`);
  }
  if (failed.length) job.log(`本轮有 ${failed.length} 个模型未能安装（已跳过，不影响其它组件）：` + failed.map((f) => f.id).join('、'), 'warn');
  return { installed, skipped, failed, modelsDir };
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

/** 向导主流程。opts: {mode, comfySource:{kind,path}, models:[ids], copyMode, modelsFrom:{dir}, externalDir, skip:{}, force:{runtime,comfyui,nodes,models}} */
async function runSetup(job, opts) {
  const result = { steps: {}, skippedComponents: [] };
  const skip = opts.skip || {};
  const force = opts.force || {};
  const state = stateMod();
  job.log(`向导开始：模式=${opts.mode || 'embedded'}，ComfyUI 来源=${opts.comfySource?.kind || 'portable'}`);
  job.log('v1.3.0：安装是**可续的** —— 已就绪的组件与模型会直接跳过，只装缺的那些。');

  if (!skip.runtime) {
    job.phase('runtime');
    const st = state.verifyComponent('runtime');
    if (st.ok && !(force === true || force.runtime)) {
      job.log(`运行时已就绪，跳过：${st.detail.exe}`, 'ok');
      result.steps.runtime = { skipped: true, sevenZip: st.detail.exe, source: 'existing' };
    } else {
      const z = await ensure7z(job, opts);
      result.steps.runtime = { sevenZip: z.exe, source: z.source };
      state.markComponent('runtime', { exe: z.exe, source: z.source });
    }
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
    const st = state.verifyComponent('nodes', { mode: opts.mode, externalDir: opts.externalDir });
    if (st.ok && !(force === true || force.nodes)) {
      job.log('自定义节点已就绪，跳过', 'ok');
      result.steps.nodes = { skipped: true, dest: st.detail.dir };
    } else {
      try {
        result.steps.nodes = await installNodes(job, opts);
      } catch (e) {
        // 节点失败**不阻断**：Anima 3.8B v2 管线不可用，其它管线照常（需求 2）
        job.log('自定义节点安装失败（Anima 3.8B v2 管线会不可用，其它管线不受影响）：' + e.message, 'error');
        result.steps.nodes = { error: e.message };
        result.skippedComponents.push({ id: 'nodes', error: e.message });
      }
    }
  }

  if (!skip.models) {
    job.phase('models');
    const ids = opts.models && opts.models.length ? opts.models : resolveSelection(catalog(), opts.sel || '').ids;
    // 组件与模型是**两段独立流程**：模型段逐个下载、逐个失败跳过，绝不影响上面的组件安装（需求 3）
    result.steps.models = await installModels(job, ids, opts);
  } else {
    job.log('跳过模型步骤');
  }

  if (!skip.artists) {
    job.phase('artists');
    const st = state.verifyComponent('artists', { mode: opts.mode });
    if (st.ok && !(force === true || force.artists)) {
      job.log('画师清单已就绪，跳过', 'ok');
      result.steps.artists = { skipped: true, files: st.detail.files };
    } else {
      result.steps.artists = installArtists(job, opts);
      state.markComponent('artists', result.steps.artists);
    }
  }
  if (!skip.licenses) {
    job.phase('licenses');
    const st = state.verifyComponent('licenses', { mode: opts.mode });
    if (st.ok && !(force === true || force.licenses)) {
      job.log('许可与第三方声明已就绪，跳过', 'ok');
      result.steps.licenses = { skipped: true, files: st.detail.files };
    } else {
      result.steps.licenses = installLicenses(job, opts);
      state.markComponent('licenses', result.steps.licenses);
    }
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
    // v1.3.0：失败被跳过的模型也如实记账，界面才能解释"为什么这个没装上"
    failedModels: result.steps.models ? (result.steps.models.failed || []) : [],
    artists: !skip.artists,
    licenses: !skip.licenses,
    // v1.3.0：逐组件状态（安装中心与向导都读它）
    componentsAt: new Date().toISOString(),
  });
  const kinds = ['runtime', 'comfyui', 'nodes', 'artists', 'licenses'];
  const skippedComp = kinds.filter((k) => !result.steps[k] || result.steps[k].skipped);
  result.report = {
    skippedComponents: skippedComp,
    skippedModels: result.steps.models ? (result.steps.models.skipped || []) : [],
    failedModels: result.steps.models ? (result.steps.models.failed || []) : [],
  };
  if (result.report.failedModels.length) {
    job.log(`向导完成（部分模型被跳过：${result.report.failedModels.map((f) => f.id).join('、')}）`, 'warn');
  } else {
    job.log('向导完成 ✅', 'ok');
  }
  return result;
}

/**
 * 安装**单个组件**（安装中心队列用）。
 * 与 runSetup 的关系：runSetup 是"向导一次性把缺的补上"，installComponent 是"某个组件单独重装/安装"；
 * 两者都走同一批底层函数，因此行为一致、可续装、可取消。
 */
async function installComponent(job, refId, opts = {}) {
  const state = stateMod();
  const mode = opts.mode || load().comfy.mode;
  const force = opts.force === true;
  const check = () => {
    if (opts.control && typeof opts.control.getState === 'function') {
      const st = opts.control.getState();
      if (st === 'canceled') throw Object.assign(new Error('任务已被用户取消'), { code: dl.CANCELED });
      if (st === 'paused') throw Object.assign(new Error('任务已暂停'), { code: dl.PAUSED });
    }
  };
  check();
  const before = state.verifyComponent(refId, { mode, externalDir: opts.externalDir });
  if (before.ok && !force) {
    job.log(`组件「${refId}」已就绪，无需重装（如需强制重装请在安装中心勾选「重新安装」）`, 'ok');
    return { refId, skipped: true, detail: before.detail };
  }
  switch (refId) {
    case 'runtime': {
      // 运行时是"解压一切的前提"：装不上后面也动不了，所以照实抛错（队列记 failed 并继续下一个）。
      // 但系统/项目里已有可用 7-Zip 时会直接复用 —— 不会联网、不会失败。
      const z = await ensure7z(job, opts);
      return { refId, detail: { exe: z.exe, source: z.source } };
    }
    case 'nodes': {
      // v1.3.0（需求修正）：Anima 3.8B 已并入通用管线，这个自定义节点**不再是必需品**。
      // 界面上不单独显示；装不上（离线、git 不可用…）只记一条 warn，**绝不拖垮整组前置组件**。
      try {
        const r = await installNodes(job, { mode, externalDir: opts.externalDir, control: opts.control });
        return { refId, detail: r };
      } catch (e) {
        if (e && (e.code === dl.PAUSED || e.code === dl.CANCELED)) throw e;
        job.log('自定义节点未安装（Anima 已走通用管线，不影响出图）：' + e.message, 'warn');
        return { refId, skipped: true, softFail: true, detail: { error: e.message } };
      }
    }
    case 'artists': {
      try {
        const r = installArtists(job, { mode, externalDir: opts.externalDir });
        return { refId, detail: r };
      } catch (e) {
        job.log('画师清单复制失败（不影响出图，可在画师页重试）：' + e.message, 'warn');
        return { refId, skipped: true, softFail: true, detail: { error: e.message } };
      }
    }
    case 'licenses': {
      try {
        const r = installLicenses(job, { mode, externalDir: opts.externalDir });
        return { refId, detail: r };
      } catch (e) {
        job.log('许可声明复制失败（不影响出图）：' + e.message, 'warn');
        return { refId, skipped: true, softFail: true, detail: { error: e.message } };
      }
    }
    case 'comfyui': {
      const source = opts.comfySource || { kind: 'portable' };
      const r = await installComfyUI(job, {
        mode,
        comfySource: source,
        copyMode: opts.copyMode || 'link',
        externalDir: opts.externalDir,
        force: true,                 // 走到这里就是要装的（已就绪的情况上面已经拦住）
        control: opts.control,
        maxWallMs: opts.maxWallMs,
        skipHosts: opts.skipHosts,
      });
      return { refId, detail: r };
    }
    default:
      throw new Error('未知组件：' + refId);
  }
}

/**
 * v1.3.0（需求 1）：把「前置组件」整组当成**一个任务**跑完。
 *
 * 为什么要有它：用户明确要求"安装列表只显示一个任务，完全不显示 7-Zip / 画师清单 /
 * 许可与第三方声明 / 自定义节点这些具体内容"。界面上一条任务，后端内部仍然逐个装，
 * 只是把进度**聚合**成一条上报（`report` 回调给队列，队列再写进任务的 percent/message）。
 *
 * 语义：
 *   · runtime 失败 = 整组失败（它是解压前提）；
 *   · 其余成员失败只记 warn、**不阻断**（Anima 已走通用管线，画师/许可只是附带件）；
 *   · 已就绪的成员直接跳过（可续装）。
 */
async function installPrereqGroup(job, opts = {}) {
  const state = stateMod();
  const members = ['runtime', 'nodes', 'artists', 'licenses'];
  const report = typeof opts.report === 'function' ? opts.report : () => {};
  const done = [];
  const failed = [];
  const total = members.length;
  for (let i = 0; i < members.length; i++) {
    const id = members[i];
    report({ index: i, total, label: id, percent: Math.round((i / total) * 100) });
    if (opts.control && typeof opts.control.getState === 'function') {
      const st = opts.control.getState();
      if (st === 'canceled') throw Object.assign(new Error('任务已被用户取消'), { code: dl.CANCELED });
      if (st === 'paused') throw Object.assign(new Error('任务已暂停'), { code: dl.PAUSED });
    }
    try {
      const r = await installComponent(job, id, opts);
      if (r && r.softFail) failed.push({ id, error: r.detail && r.detail.error });
      else done.push(id);
    } catch (e) {
      if (e && (e.code === dl.PAUSED || e.code === dl.CANCELED)) throw e;
      if (id === 'runtime') throw e;          // 解压前提：它失败就整组失败
      failed.push({ id, error: e.message });
      job.log(`前置组件「${id}」未完成（不影响出图）：${e.message}`, 'warn');
    }
    report({ index: i + 1, total, label: id, percent: Math.round(((i + 1) / total) * 100) });
  }
  const stillMissing = members.filter((id) => !state.verifyComponent(id).ok);
  job.log(`前置组件处理完成：就绪 ${total - stillMissing.length}/${total}`
    + (failed.length ? `，未完成 ${failed.map((f) => f.id).join('、')}（不影响出图）` : ''), 'ok');
  return { group: 'prereq', done, failed, missing: stillMissing };
}

module.exports = {
  catalog, plan, resolveSelection, modelsDirFor, installedState, runSetup,
  ensure7z, installComfyUI, downloadPortableArchive, installFromArchive,
  installNodes, installModels, installOneModel, installArtists, installLicenses, findModelFile,
  installComponent, installPrereqGroup, archiveKind, requireArchive, requireBinary,
  COMFYUI_GIT, COMFYUI_COMMIT,
};
