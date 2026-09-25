// 通用文件/编码工具：原子 JSON 写、路径工具、体积格式化。
//
// 可迁移性红线：本文件（以及整个 server/）不得出现任何绝对机器路径——
// 一切位置都从 __dirname 向上推导，或来自用户在设置里填写的可配置项。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** 原子写 JSON：先写临时文件再 rename；产物不带 BOM（ConvertFrom-Json/JSON.parse 都怕 BOM）。 */
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  const text = JSON.stringify(value, null, 2) + '\n';
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  // Windows 上 rename 覆盖目标需要先删除（同卷 rename 是原子的）。
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeTextAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch { return -1; }
}

function sha256File(file, onProgress) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const rs = fs.createReadStream(file, { highWaterMark: 1 << 22 });
    let done = 0;
    rs.on('data', (c) => {
      hash.update(c);
      done += c.length;
      if (onProgress) onProgress(done);
    });
    rs.on('error', reject);
    rs.on('end', () => resolve(hash.digest('hex')));
  });
}

/** 只允许把子路径拼到根目录内（防目录穿越）。 */
function safeJoin(root, rel) {
  const target = path.resolve(root, String(rel || '').replace(/^[/\\]+/, ''));
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error('path escapes root: ' + rel);
  }
  return target;
}

function fmtBytes(n) {
  if (n === undefined || n === null || n < 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(i >= 3 ? 2 : 1)) + ' ' + units[i];
}

/** 目录树复制；link=true 时优先硬链接（同卷瞬时、跨卷自动回落为复制）。 */
function copyTree(src, dest, opts = {}) {
  const { link = false, filter = null, onFile = null } = opts;
  let files = 0;
  let linked = 0;
  const walk = (from, to) => {
    const st = fs.statSync(from);
    if (st.isDirectory()) {
      ensureDir(to);
      for (const name of fs.readdirSync(from)) walk(path.join(from, name), path.join(to, name));
      return;
    }
    if (!st.isFile()) return;
    if (filter && !filter(from, st)) return;
    ensureDir(path.dirname(to));
    fs.rmSync(to, { force: true });
    let didLink = false;
    if (link) {
      try { fs.linkSync(from, to); didLink = true; } catch { didLink = false; }
    }
    if (!didLink) fs.copyFileSync(from, to);
    else linked++;
    files++;
    if (onFile) onFile(from, to, didLink);
  };
  walk(src, dest);
  return { files, linked };
}

module.exports = {
  writeJsonAtomic,
  writeTextAtomic,
  readJson,
  ensureDir,
  exists,
  isFile,
  isDir,
  sizeOf,
  sha256File,
  safeJoin,
  fmtBytes,
  copyTree,
};
