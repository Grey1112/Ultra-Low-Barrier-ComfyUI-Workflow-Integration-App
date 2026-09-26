// models-upload.js —— v1.3.0：自定义模型的本地上传（需求 7）。
//
// 两条路径：
//   ① `pickLocalFile()`：调系统"打开文件"对话框，拿回一个绝对路径（用户不用手打长路径）。
//      Windows 上用 PowerShell + System.Windows.Forms；其它平台/失败时明确回报"请手动粘贴路径"，
//      **绝不静默失败**（红线）。
//   ② `importLocalFile()`：把该路径的权重**硬链接**（同卷瞬时、不额外占空间）或复制到目标目录。
//   ③ `receiveUpload()`：浏览器直传（原始字节直通，不做 multipart 解析），落盘到目标目录，
//      过程中记录进度供界面轮询；落盘先用 `.uploading` 后缀，校验通过才改名。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { paths } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');
const catalog = require('./models-catalog');

const MAX_UPLOAD_BYTES = 60 * 1024 * 1024 * 1024;   // 60 GiB：比任何单文件权重都大，同时挡住异常请求
const uploads = new Map();                          // uploadId → {received, total, startedAt, state, error, file}

function humanPickHint() {
  return '无法弹出系统文件对话框（非 Windows 或缺少 PowerShell）；请在输入框里直接粘贴文件的完整路径。';
}

/**
 * 弹出系统"打开文件"对话框 → 返回选中的绝对路径。
 * 注意：这是本程序**自己**的本地接口，返回的路径只会被本进程用于本机文件操作。
 */
function pickLocalFile() {
  if (process.platform !== 'win32') return { ok: false, hint: humanPickHint() };
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Title = "选择要添加到本程序的权重文件"',
    '$d.Filter = "权重文件 (*.safetensors;*.ckpt;*.pt;*.pth;*.gguf;*.bin;*.sft)|*.safetensors;*.ckpt;*.pt;*.pth;*.gguf;*.bin;*.sft|所有文件 (*.*)|*.*"',
    '$d.Multiselect = $false',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
  ].join('\n');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
      encoding: 'utf8', timeout: 300000, windowsHide: false,
    });
    const out = String(r.stdout || '').trim();
    if (r.status === 0 && out && fsx.isFile(out)) return { ok: true, path: out, bytes: fsx.sizeOf(out) };
    if (out) return { ok: false, error: '选择的文件不存在：' + out, path: out };
    return { ok: false, hint: humanPickHint(), detail: (r.stderr || '').trim().slice(0, 200) || undefined };
  } catch (e) {
    return { ok: false, hint: humanPickHint(), detail: e.message };
  }
}

/** 目标落位（走 models-catalog 的白名单校验，防目录穿越）。 */
function targetFor(modelsDir, dest, fileName) {
  const d = catalog.normalizeDest(dest);
  const name = catalog.normalizeFileName(fileName);
  const file = path.join(modelsDir, d, name);
  return { dest: d, name, file, rel: path.join(d, name) };
}

/**
 * 把本机某个文件导入到目标目录（硬链接优先，跨卷自动回落复制）。
 * @returns {{ok:boolean, file:string, bytes:number, linked:boolean, replaced:boolean}}
 */
function importLocalFile({ srcPath, modelsDir, dest, fileName, sha256, control }) {
  if (!srcPath || !fsx.isFile(srcPath)) throw new Error('源文件不存在：' + srcPath);
  const t = targetFor(modelsDir, dest, fileName || path.basename(srcPath));
  const bytes = fsx.sizeOf(t.file);
  fsx.ensureDir(path.dirname(t.file));
  // 覆盖前先确认：已存在且大小相同的同名文件直接算成功（幂等，避免重复复制几十 GB）
  const size = fsx.sizeOf(t.file);
  if (size >= 0 && size === fsx.sizeOf(srcPath)) {
    return { ok: true, file: t.file, bytes: size, linked: false, replaced: false, reason: '目标已存在且大小相同，跳过复制' };
  }
  fs.rmSync(t.file, { force: true });
  let linked = false;
  try { fs.linkSync(srcPath, t.file); linked = true; } catch { linked = false; }
  if (!linked) {
    // 大文件复制：分块搬运（每 8 MiB 检查一次暂停/取消），可中断、可续；
    // 中断时删掉半成品，避免"看起来装好了其实不完整"。
    copySyncInterruptible(srcPath, t.file, control);
  }
  const srcSize = fsx.sizeOf(srcPath);
  if (fsx.sizeOf(t.file) !== srcSize) {
    try { fs.rmSync(t.file, { force: true }); } catch { /* 忽略 */ }
    throw new Error('复制后大小不一致（磁盘空间不足或被中断）');
  }
  return { ok: true, file: t.file, bytes: fsx.sizeOf(t.file), linked, replaced: true, rel: t.rel, dest: t.dest, name: t.name };
}

/** 可中断的同步复制（每次 8 MiB），让暂停/取消在长复制中也能生效。 */
function copySyncInterruptible(src, dst, control) {
  const CHUNK = 8 * 1024 * 1024;
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(dst, 'w');
  const buf = Buffer.alloc(CHUNK);
  try {
    let pos = 0;
    for (;;) {
      if (control && typeof control.getState === 'function') {
        const st = control.getState();
        if (st === 'canceled' || st === 'paused') {
          throw Object.assign(new Error(st === 'canceled' ? '任务已被用户取消' : '任务已暂停'), { code: st === 'canceled' ? 'DCP_CANCELED' : 'DCP_PAUSED' });
        }
      }
      const n = fs.readSync(inFd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      fs.writeSync(outFd, buf, 0, n);
      pos += n;
    }
  } catch (e) {
    try { fs.closeSync(inFd); } catch { /* 忽略 */ }
    try { fs.closeSync(outFd); } catch { /* 忽略 */ }
    if (e && (e.code === 'DCP_CANCELED' || e.code === 'DCP_PAUSED')) {
      try { fs.rmSync(dst, { force: true }); } catch { /* 忽略 */ }
    }
    throw e;
  }
  fs.closeSync(inFd);
  fs.closeSync(outFd);
  return pos;
}

// ── 浏览器直传（原始字节）────────────────────────────────

function newUploadId() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function uploadStatus(id) {
  const u = uploads.get(String(id));
  if (!u) return null;
  return { id: u.id, state: u.state, received: u.received, total: u.total, percent: u.total ? Math.round((u.received / u.total) * 100) : 0, file: u.file, error: u.error, startedAt: u.startedAt, endedAt: u.endedAt };
}

/**
 * 接收浏览器直传的原始字节并落盘。
 * 前端约定（见 web/pages/install.js）：
 *   POST /app/models/upload?uploadId=..&name=..&dest=..&modelsDirToken=..
 *   body: 原始文件字节；content-length 用于总进度。
 * 落盘路径：<modelsDir>/<dest>/<name>；先写 `<name>.uploading`，写完校验大小再改名。
 */
function receiveUpload(req, res, query) {
  const id = String(query.get('uploadId') || newUploadId());
  const nameRaw = query.get('name') || '';
  const destRaw = query.get('dest') || 'diffusion_models';
  const modelsDir = query.get('modelsDir') || '';
  const t = targetFor(modelsDir, destRaw, nameRaw);
  const total = Number(req.headers['content-length'] || 0);
  if (total > MAX_UPLOAD_BYTES) {
    res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: `上传体积上限 ${Math.round(MAX_UPLOAD_BYTES / 1073741824)} GB（当前 ${fsx.fmtBytes(total)}）` }));
    return;
  }
  fsx.ensureDir(path.dirname(t.file));
  const tmp = t.file + '.uploading';
  fs.rmSync(tmp, { force: true });
  const rec = { id, state: 'uploading', received: 0, total, file: t.file, rel: t.rel, dest: t.dest, name: t.name, startedAt: Date.now(), endedAt: null, error: null };
  uploads.set(id, rec);
  const ws = fs.createWriteStream(tmp);
  req.on('data', (c) => { rec.received += c.length; });
  req.on('error', (e) => {
    rec.state = 'failed'; rec.error = e.message; rec.endedAt = Date.now();
    try { ws.destroy(); } catch { /* 忽略 */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  });
  ws.on('error', (e) => {
    rec.state = 'failed'; rec.error = e.message; rec.endedAt = Date.now();
    try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
  });
  ws.on('finish', () => {
    const got = fsx.sizeOf(tmp);
    if (total && got !== total) {
      rec.state = 'failed';
      rec.error = `上传不完整：收到 ${fsx.fmtBytes(got)} / 声明 ${fsx.fmtBytes(total)}（文件已删除，请重试）`;
      rec.endedAt = Date.now();
      try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
      return;
    }
    try {
      fs.rmSync(t.file, { force: true });
      fs.renameSync(tmp, t.file);
      rec.state = 'done';
      rec.received = got;
      rec.endedAt = Date.now();
      rec.bytes = got;
      log.info(`自定义模型上传完成：${t.rel}（${fsx.fmtBytes(got)}）`);
    } catch (e) {
      rec.state = 'failed';
      rec.error = '落盘失败：' + e.message;
      rec.endedAt = Date.now();
    }
  });
  req.pipe(ws);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, uploadId: id, file: t.file, rel: t.rel, dest: t.dest, name: t.name, total }));
}

function pruneUploads() {
  const cutoff = Date.now() - 6 * 3600 * 1000;
  for (const [id, u] of uploads) if (u.endedAt && u.endedAt < cutoff) uploads.delete(id);
}

module.exports = { pickLocalFile, importLocalFile, receiveUpload, uploadStatus, targetFor, MAX_UPLOAD_BYTES, uploads, pruneUploads };
