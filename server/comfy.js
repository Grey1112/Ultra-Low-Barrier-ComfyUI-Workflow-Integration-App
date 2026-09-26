// ComfyUI 侧：安装探测、进程管理、HTTP 反代、WebSocket 裸 TCP 中继、画师清单只读。
//
// 与插件版宿主半的关系：反代与 WS 中继的逻辑**原样继承**（含"不改写则不放过 origin 围栏"
// 的实测结论），只是把插件宿主的 connection.requestRejection 鉴权换成了本地回环 + 可选 LAN 令牌。
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { paths, load, comfyDir } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');

const state = { pid: null, startedAt: null, lastError: null, spawnCommand: null, codeDir: null };

// ── 探测 ─────────────────────────────────────────────────

/** 探测一个目录是"venv/git 布局"还是"官方 Windows 便携包布局"。 */
function detectLayout(dir) {
  if (!dir) return { ok: false, dir, layout: 'unknown', error: '未指定 ComfyUI 目录' };
  if (!fsx.isDir(dir)) return { ok: false, dir, layout: 'unknown', error: '目录不存在：' + dir };
  const mainCandidates = [path.join(dir, 'main.py'), path.join(dir, 'ComfyUI', 'main.py')];
  const mainPy = mainCandidates.find((p) => fsx.isFile(p)) || null;
  const codeDirOf = mainPy ? path.dirname(mainPy) : dir;
  const pyCandidates = [
    path.join(dir, 'venv', 'Scripts', 'python.exe'),
    path.join(dir, 'venv', 'bin', 'python'),
    path.join(dir, 'python_embeded', 'python.exe'),
    path.join(dir, 'python.exe'),
    // 便携包把代码放在内层 ComfyUI\ 时，解释器可能跟代码同级（导入型安装）
    path.join(codeDirOf, 'venv', 'Scripts', 'python.exe'),
    path.join(codeDirOf, 'venv', 'bin', 'python'),
    path.join(codeDirOf, 'python_embeded', 'python.exe'),
    path.join(codeDirOf, 'python.exe'),
  ];
  const python = pyCandidates.find((p) => fsx.isFile(p)) || null;
  if (!mainPy) {
    return {
      ok: false, dir, layout: 'unknown', mainPy: null, python,
      candidates: mainCandidates,
      error: '未找到 ComfyUI 入口 main.py，已探测：' + mainCandidates.join('、'),
    };
  }
  const codeDir = path.dirname(mainPy);
  const innerModels = path.join(codeDir, 'models');
  const rootModels = path.join(dir, 'models');
  const modelsDir = fsx.isDir(innerModels) ? innerModels : (fsx.isDir(rootModels) ? rootModels : innerModels);
  const layout = codeDir === path.resolve(dir) ? 'venv' : 'portable';
  return { ok: true, dir, codeDir, modelsDir, mainPy, python, layout, candidates: mainCandidates };
}

/** 设置当前生效的 ComfyUI 目录与布局。 */
function current() {
  const s = load();
  return { settings: s, dir: comfyDir(s), port: s.comfy.port, mode: s.comfy.mode };
}

function baseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

async function probe(port, timeoutMs = 1500) {
  try {
    const r = await fetch(baseUrl(port) + '/system_stats', { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch {
    return false;
  }
}

async function status() {
  const cur = current();
  const online = await probe(cur.port);
  const layout = detectLayout(cur.dir);
  return {
    online,
    running: !!state.pid,
    pid: state.pid,
    mode: cur.mode,
    dir: cur.dir,
    port: cur.port,
    layout: layout.ok ? layout.layout : 'unknown',
    modelsDir: layout.modelsDir || null,
    mainPy: layout.mainPy || null,
    python: layout.python || null,
    startedAt: state.startedAt,
    lastError: state.lastError,
    candidates: layout.candidates || [],
  };
}

// ── 进程管理 ─────────────────────────────────────────────

/** 一键启动：已在跑则直接返回；否则探测入口/解释器后 detached 拉起。 */
async function launch() {
  const cur = current();
  if (await probe(cur.port, 1200)) return { online: true, launched: false, port: cur.port };
  const layout = detectLayout(cur.dir);
  if (!layout.ok) {
    state.lastError = layout.error;
    return { online: false, launched: false, error: layout.error + '（可在「设置 → ComfyUI」里指定正确目录）' };
  }
  if (!layout.python) {
    const err = '未找到可用的 Python 解释器（已探测 venv\\Scripts\\python.exe / python_embeded\\python.exe / python.exe）。'
      + '内嵌模式请用「首次运行向导」安装官方便携包（自带 python_embeded）。';
    state.lastError = err;
    return { online: false, launched: false, error: err };
  }
  const args = [layout.mainPy, '--listen', '127.0.0.1', '--port', String(cur.port), '--disable-metadata', ...(cur.settings.comfy.extraArgs || [])];
  try {
    fsx.ensureDir(paths.logs);
    const out = fs.openSync(paths.comfyLog, 'a');
    const child = spawn(layout.python, args, {
      cwd: path.dirname(layout.mainPy),   // 入口脚本所在目录（便携包=内层 ComfyUI\）
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(out);
    state.pid = child.pid;
    state.startedAt = Date.now();
    state.lastError = null;
    state.spawnCommand = [layout.python, ...args].join(' ');
    state.codeDir = path.dirname(layout.mainPy);   // 记住入口目录：输出目录就挂在它下面（见 outputDirInfo）
    log.info(`已拉起 ComfyUI：pid=${child.pid} cwd=${path.dirname(layout.mainPy)} port=${cur.port}`);
  } catch (e) {
    state.lastError = e.message;
    log.error('启动 ComfyUI 失败：' + e.message);
    return { online: false, launched: false, error: '启动 ComfyUI 失败：' + e.message };
  }
  // 等待就绪（最多 180 秒；面板/向导也会轮询 /system_stats）。
  // 实测：冷启动 + 与另一个 ComfyUI 实例抢显存时 90 秒不够（Python 侧导入很重），所以放宽到 180 秒。
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    if (await probe(cur.port, 1500)) return { online: true, launched: true, port: cur.port, pid: state.pid, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return {
    online: false, launched: true, pid: state.pid, port: cur.port,
    error: 'ComfyUI 进程已启动但 180 秒内没有就绪（/system_stats 不可达）。请看日志：' + paths.comfyLog,
  };
}

function taskkill(pid) {
  if (process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
    return true;
  }
  const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
  return r.status === 0;
}

/** 找到监听指定端口的进程号（不是我们拉起的 ComfyUI 也能停）。 */
function pidListeningOn(port) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`],
    { encoding: 'utf8' });
  const pid = Number.parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

/**
 * 读取某个进程的命令行（仅 Windows；用 PowerShell CIM，实测 ~150 ms）。
 * 为什么要它：面板/「图片文件夹」必须指向**实际在跑的那个 ComfyUI** 的输出目录 ——
 * 用户经常是自己在别处（例如另一块盘上的自建 ComfyUI）起 ComfyUI，而本程序按内嵌布局去找
 * `<项目>/runtime/comfyui/ComfyUI/output`，于是生成的照片"根本不出现在图片文件夹里"。
 */
function cmdlineOf(pid) {
  if (process.platform !== 'win32' || !pid) return '';
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue).CommandLine`],
      { encoding: 'utf8', timeout: 8000 });
    return String(r.stdout || '').trim();
  } catch { return ''; }
}

/** 从命令行里取出 ComfyUI 入口 main.py 所在目录（venv 与便携两种布局都能认）。 */
function codeDirFromCmdline(cmd) {
  const s = String(cmd || '');
  const m = s.match(/"([^"]*main\.py)"|(\S+main\.py)/i);
  const p = m ? (m[1] || m[2]) : '';
  if (!p) return null;
  try { return path.dirname(path.resolve(p)); } catch { return null; }
}

let codeDirCache = { at: 0, port: 0, dir: null };

/** 监听该端口的可能是**别人**起的 ComfyUI，用它的命令行反推代码目录（缓存 60 s）。 */
function codeDirOfRunning(port) {
  const now = Date.now();
  if (codeDirCache.port === port && now - codeDirCache.at < 60000) return codeDirCache.dir;
  const pid = pidListeningOn(port);
  const dir = pid ? codeDirFromCmdline(cmdlineOf(pid)) : null;
  codeDirCache = { at: now, port, dir };
  return dir;
}

/**
 * 输出目录情报：本程序拉起的实例优先（我们确知它的入口目录），其次问"端口上那个进程"。
 * 返回 { dir, source }；拿不到就是 null，让调用方回落到按设置推导的候选目录。
 */
function outputDirInfo(port) {
  const cur = port === undefined ? current() : { port: Number(port) || current().port };
  const tried = [];
  if (state.codeDir) tried.push({ dir: state.codeDir, source: 'launched-by-app' });
  const running = codeDirOfRunning(cur.port);
  if (running) tried.push({ dir: running, source: 'running-process' });
  for (const t of tried) {
    for (const c of [path.join(t.dir, 'output'), path.join(t.dir, 'ComfyUI', 'output')]) {
      if (fsx.isDir(c)) return { dir: c, source: t.source, codeDir: t.dir };
    }
  }
  // 有代码目录但 output 还没建出来（ComfyUI 首次启动前）：也认，免得又指回内嵌空目录
  if (tried.length) {
    const t = tried[0];
    return { dir: path.join(t.dir, 'output'), source: t.source + '(expected)', codeDir: t.dir };
  }
  return null;
}

/** 一键停止：优先停我们拉起的进程；否则停监听该端口的进程（同机回环）。 */
async function stop() {
  const cur = current();
  const online = await probe(cur.port, 1200);
  if (!online) { state.pid = null; return { online: false, stopped: false, note: 'ComfyUI 当前未在运行' }; }
  const pid = state.pid || pidListeningOn(cur.port);
  if (!pid) {
    return { online: true, stopped: false, error: `ComfyUI 在 ${cur.port} 端口运行，但不是本程序拉起的，也未能取得它的进程号；请手动结束该进程。` };
  }
  const killed = taskkill(pid);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (!(await probe(cur.port, 1000))) {
      state.pid = null;
      log.info(`已停止 ComfyUI：pid=${pid}`);
      return { online: false, stopped: true, pid };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { online: true, stopped: false, pid, error: `结束进程 ${pid} 后 15 秒内端口仍在监听（killed=${killed}）` };
}

function logTail(lines = 300) {
  try {
    const text = fs.readFileSync(paths.comfyLog, 'utf8');
    const arr = text.split(/\r?\n/);
    return { path: paths.comfyLog, lines: arr.slice(-Math.max(1, Math.min(5000, lines))) };
  } catch {
    return { path: paths.comfyLog, lines: [] };
  }
}

// ── 画师清单（只读，懒加载缓存；成功才缓存，失败不缓存） ────
let artistsAll = null;
let artistsTop = null;

function artistDirs() {
  const cur = current();
  return [paths.artists, path.join(cur.dir, 'model-notes'), path.join(cur.dir, 'ComfyUI', 'model-notes')].filter(Boolean);
}

function readArtistFile(name) {
  for (const dir of artistDirs()) {
    const file = path.join(dir, name);
    try {
      const lines = fs.readFileSync(file, 'utf8')
        .split('\n').map((l) => l.trim()).filter((l) => l.startsWith('@'));
      if (lines.length > 0) return { lines, file };
    } catch { /* 换下一个候选目录 */ }
  }
  return null;
}

function readArtists() {
  if (artistsAll === null) {
    const a = readArtistFile('Anima2B_Artist_Index_59k.txt');
    if (a) artistsAll = a;
  }
  if (artistsTop === null) {
    const t = readArtistFile('Anima2B_Artist_top200.txt');
    if (t) artistsTop = t;
  }
  if (!artistsAll) {
    const tried = artistDirs().map((d) => path.join(d, 'Anima2B_Artist_Index_59k.txt'));
    const e = new Error('画师清单不可读，已探测：' + tried.join('、'));
    e.status = 500;
    throw e;
  }
  if (!artistsTop) {
    const tried = artistDirs().map((d) => path.join(d, 'Anima2B_Artist_top200.txt'));
    const e = new Error('画师清单不可读，已探测：' + tried.join('、'));
    e.status = 500;
    throw e;
  }
  return { all: artistsAll.lines, top: artistsTop.lines, files: { all: artistsAll.file, top: artistsTop.file } };
}

/** 清单刷新（向导复制完清单后调用；对应插件版"清单变更要重启"的改进）。 */
function resetArtistsCache() {
  artistsAll = null;
  artistsTop = null;
}

// ── HTTP 反代 ────────────────────────────────────────────
// 只转发 content-type，绝不把浏览器 cookie / 其它头带给 ComfyUI（继承插件版隐私边界）。
// 请求体一律以原始字节直通（multipart 上传与二进制都不会被 UTF-8 解码破坏）。

function proxy(req, res, port) {
  const target = `/comfy-panel/api`;
  const idx = req.url.indexOf(target);
  const rest = idx === 0 ? req.url.slice(target.length) : req.url;
  const upstreamPath = (rest && rest.startsWith('/')) ? rest : '/' + (rest || '');
  const options = {
    host: '127.0.0.1',
    port,
    method: req.method,
    path: upstreamPath,
    headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
  };
  const up = http.request(options, (upRes) => {
    const headers = {};
    if (upRes.headers['content-type']) headers['content-type'] = upRes.headers['content-type'];
    if (upRes.headers['content-length']) headers['content-length'] = upRes.headers['content-length'];
    headers['cache-control'] = 'no-store';
    res.writeHead(upRes.statusCode || 502, headers);
    upRes.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `ComfyUI 不可达（127.0.0.1:${port}），请先点「启动 ComfyUI」` }));
    } else {
      res.end();
    }
  });
  req.pipe(up);
}

// ── WebSocket 裸 TCP 中继 ────────────────────────────────
// ComfyUI 0.37 默认注册 create_origin_only_middleware：比对 Host 与 Origin 的 netloc，
// 不一致直接 403。面板来源是本服务端口 ≠ 8188，所以握手必须由服务端改写后转发。
// 只保留 6 个协议必需头，Cookie 不透传。

function relaySocket(req, socket, head, port) {
  const upstream = net.connect({ host: '127.0.0.1', port });
  let failed = false;
  const fail = (why) => {
    if (failed) return;
    failed = true;
    log.warn(`ws relay 失败（127.0.0.1:${port}）：${why}`);
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', (e) => fail(e?.message ?? String(e)));
  upstream.on('close', () => { if (!failed) socket.destroy(); });
  socket.on('error', () => { failed = true; upstream.destroy(); });
  socket.on('close', () => { failed = true; upstream.destroy(); });
  upstream.on('connect', () => {
    if (failed) return;
    let search = '';
    try { search = new URL(req.url ?? '/', 'http://x').search; } catch { /* ignore */ }
    const allow = ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'sec-websocket-protocol'];
    const lines = [`GET /ws${search} HTTP/1.1`, `Host: 127.0.0.1:${port}`, `Origin: http://127.0.0.1:${port}`];
    for (const k of allow) {
      const v = req.headers[k];
      if (v === undefined) continue;
      lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
}

module.exports = {
  detectLayout, current, probe, status, launch, stop, logTail,
  readArtists, resetArtistsCache, artistDirs,
  proxy, relaySocket,
  // v1.2.0：输出目录定位（图片文件夹 / 本机作品 / 删除都以此为准）
  outputDirInfo, codeDirOfRunning, cmdlineOf, codeDirFromCmdline, pidListeningOn,
  state,
};
