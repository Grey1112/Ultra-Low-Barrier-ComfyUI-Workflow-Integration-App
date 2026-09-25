// 解压工具：① 纯 JS 的 ZIP 读取（无外部依赖）；② .7z 走随项目携带的 7-Zip 精简版。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');
const { ensureDir } = require('./fsx');

// ── ZIP ───────────────────────────────────────────────────
// 只实现"解压"需要的部分：读中央目录 → 逐个条目 inflateRaw → 落盘。
// 支持 store(0) 与 deflate(8) 两种压缩方式（GitHub codeload 的 zip 就是这两种）。

function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function zipCentralDirectory(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏 @' + off);
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, localOff, flags });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 解压 ZIP 到 destDir。返回 { files, bytes }。 */
function unzipTo(zipPath, destDir, onFile) {
  const buf = fs.readFileSync(zipPath);
  const entries = zipCentralDirectory(buf);
  let files = 0;
  let bytes = 0;
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    // 防目录穿越
    const rel = e.name.replace(/\\/g, '/');
    const target = path.resolve(destDir, rel);
    if (!target.startsWith(path.resolve(destDir) + path.sep)) continue;
    const lo = e.localOff;
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('ZIP 本地头损坏：' + e.name);
    const nameLen = buf.readUInt16LE(lo + 26);
    const extraLen = buf.readUInt16LE(lo + 28);
    const dataStart = lo + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + e.compSize);
    let out;
    if (e.method === 0) out = data;
    else if (e.method === 8) out = zlib.inflateRawSync(data);
    else throw new Error('不支持的压缩方式 ' + e.method + '：' + e.name);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, out);
    files++;
    bytes += out.length;
    if (onFile) onFile(e.name, out.length);
  }
  return { files, bytes };
}

// ── 7-Zip ─────────────────────────────────────────────────

/** 在候选路径里找可用的 7-Zip 可执行文件（优先随项目携带的精简版）。 */
function find7z(binDirs = []) {
  const names = ['7za.exe', '7zr.exe', '7z.exe', '7za', '7z'];
  const dirs = [...binDirs, path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip')];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = path.join(d, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
    }
  }
  // PATH 兜底
  const which = process.platform === 'win32' ? 'where' : 'which';
  for (const n of names) {
    const r = spawnSync(which, [n], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

/** 用 7-Zip 解压任意归档到 destDir（同步；调用方负责放进 job 里播报进度）。 */
function extractWith7z(exe, archive, destDir, { onLine } = {}) {
  ensureDir(destDir);
  const args = ['x', archive, '-y', '-o' + destDir, '-bso0', '-bsp0', '-bb1'];
  const r = spawnSync(exe, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = (r.stdout || '') + (r.stderr || '');
  if (onLine && out.trim()) out.trim().split(/\r?\n/).slice(-20).forEach(onLine);
  if (r.status !== 0) {
    throw new Error('7-Zip 解压失败（exit ' + r.status + '）：' + out.trim().split(/\r?\n/).slice(-3).join(' | '));
  }
  return { ok: true };
}

/** 解压后若只有单一顶层目录，把它的内容上提到 destDir（GitHub 归档的常见形态）。 */
function hoistSingleRoot(destDir, onLine) {
  const items = fs.readdirSync(destDir).filter((n) => n !== '.' && n !== '..');
  if (items.length !== 1) return false;
  const only = path.join(destDir, items[0]);
  let st;
  try { st = fs.statSync(only); } catch { return false; }
  if (!st.isDirectory()) return false;
  const inner = fs.readdirSync(only);
  for (const name of inner) {
    const from = path.join(only, name);
    const to = path.join(destDir, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }
  fs.rmSync(only, { recursive: true, force: true });
  if (onLine) onLine('已上提内层单一根目录：' + items[0]);
  return true;
}

module.exports = { unzipTo, find7z, extractWith7z, hoistSingleRoot };
