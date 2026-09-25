// works.js —— 本机生成作品索引（给「画师」页用：某位画师在本机有哪些作品）。
//
// 数据来源：ComfyUI 的 output 目录（内嵌模式 = <comfyDir>/ComfyUI/output，外部模式 = <comfyDir>/output）。
// 画师 tag 的推导口径与面板完全一致（见 web/panel.js 的 artistFromName）：
//   落盘文件名形如 `<画师>_<序号>_<批次>_.png`（保存前缀由面板的 savePrefix 决定），
//   例如 `soranana (sorabananasan)_20_00001_.png` → `@soranana (sorabananasan)`；
//   `noartist_...` 视为没有画师（不进入画师维度）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths, load, comfyDir } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');

const IMG_RE = /\.(png|webp|jpe?g)$/i;
const MAX_FILES = 4000;          // 扫描上限：防止超大 output 目录把请求拖死
const MAX_DEPTH = 2;

/** output 目录候选（按顺序取第一个存在的）。 */
function outputCandidates() {
  const root = comfyDir();
  return [
    root && path.join(root, 'ComfyUI', 'output'),
    root && path.join(root, 'output'),
    path.join(paths.root, 'output'),
  ].filter(Boolean);
}

function outputDir() {
  for (const d of outputCandidates()) if (fsx.isDir(d)) return d;
  return outputCandidates()[0] || path.join(paths.root, 'output');
}

/** 文件名 → 画师 tag（与面板同一套规则）；没有画师返回 null。 */
function artistFromName(name) {
  const m = String(name || '').match(/([^/\\]+)_(\d+)_\d+_\.(?:png|webp|jpe?g)$/i);
  if (!m) return null;
  const part = m[1];
  if (/^noartist$/i.test(part)) return null;
  return '@' + part.replace(/_/g, ' ');
}

/** 递归收集图片（按修改时间倒序，最多 MAX_FILES 个）。
 *  注意：sub 必须相对**根目录**算 —— 递归时不能把 dir 换成当前子目录（第一版就是这里写错，
 *  结果子目录里的图都被当成根目录下的同名文件，直读路由必然 404）。 */
function scanImages(root, dir = root, depth = 0, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return out;
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < MAX_DEPTH) scanImages(root, p, depth + 1, out);
    } else if (IMG_RE.test(e.name)) {
      let st = null;
      try { st = fs.statSync(p); } catch { continue; }
      out.push({ file: p, name: e.name, sub: path.relative(root, path.dirname(p)).replace(/\\/g, '/'), mtime: st.mtimeMs, bytes: st.size });
    }
  }
  return out;
}

let cache = { at: 0, dir: '', items: [] };

/** 列出本机作品（可按画师过滤 / 按关键词搜索）。返回 { dir, items, total, artists }。 */
function list(opts = {}) {
  const dir = outputDir();
  const now = Date.now();
  if (cache.dir !== dir || now - cache.at > 15000) {
    const raw = scanImages(dir).sort((a, b) => b.mtime - a.mtime);
    cache = {
      at: now, dir,
      items: raw.map((it) => ({ ...it, artist: artistFromName(it.name), url: viewUrl(it) })),
    };
    log.info(`本机作品索引：${cache.items.length} 张（${dir}）`);
  }
  const artist = String(opts.artist || '').trim();
  const q = String(opts.q || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(300, Number(opts.limit) || 60));
  let items = cache.items;
  if (artist) {
    const key = artist.replace(/^@/, '').replace(/_/g, ' ').toLowerCase();
    items = items.filter((i) => i.artist && i.artist.replace(/^@/, '').toLowerCase() === key);
  } else if (q) {
    items = items.filter((i) => (i.artist || '').toLowerCase().includes(q) || i.name.toLowerCase().includes(q));
  }
  // 画师 → 作品数（供页面列出"本机有作品的画师"）
  const counts = new Map();
  for (const i of cache.items) if (i.artist) counts.set(i.artist, (counts.get(i.artist) || 0) + 1);
  const artists = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .filter((a) => (!q || a.tag.toLowerCase().includes(q)))
    .sort((a, b) => b.count - a.count);
  return {
    dir, installed: fsx.isDir(dir), scanned: cache.items.length,
    total: items.length, items: items.slice(0, limit), artists: artists.slice(0, 200),
    withWorks: artists.length,
  };
}

/** 缩略图/原图 URL：优先走「直读磁盘」路由（ComfyUI 不在线也能看）。 */
function viewUrl(it) {
  return '/app/output/file?name=' + encodeURIComponent(it.name) + (it.sub ? '&sub=' + encodeURIComponent(it.sub) : '');
}

/** 安全解析：只允许 output 目录内的相对路径。 */
function resolveInOutput(rel, sub) {
  const dir = outputDir();
  const parts = [String(sub || '').replace(/^[/\\]+/, ''), String(rel || '')].filter(Boolean);
  const target = path.resolve(dir, ...parts);
  const base = path.resolve(dir);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  if (!IMG_RE.test(target)) return null;
  return fsx.isFile(target) ? target : null;
}

/** 打开本机文件夹（资源管理器 / 文件管理器）。 */
function openFolder(which) {
  const map = { output: outputDir(), logs: paths.logs, models: paths.llmModels, data: paths.data };
  const dir = map[which] || map.output;
  if (!fsx.isDir(dir)) fsx.ensureDir(dir);
  const { spawn } = require('node:child_process');
  try {
    if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
    log.info(`已打开文件夹（${which || 'output'}）：${dir}`);
    return { ok: true, which: which || 'output', dir };
  } catch (e) {
    return { ok: false, which: which || 'output', dir, error: e.message };
  }
}

module.exports = { outputDir, list, viewUrl, artistFromName, resolveInOutput, openFolder, scanImages };
