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
const { paths, load, comfyDir, BUILD_TAG } = require('./config');
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
    // v1.2.2（R1/R2）：把"这是我拉起的"落盘。内存里的 state.pid 一旦进程重启就没了，
    // 而跨进程孤儿恰恰只能在下次启动时靠这条记录识别出来。
    writeOwnerRecord({
      schema: OWNER_SCHEMA,
      buildTag: BUILD_TAG,
      pid: child.pid,
      ownerPid: process.pid,
      startedAtMs: state.startedAt,
      python: layout.python,
      mainPy: layout.mainPy,
      codeDir: path.dirname(layout.mainPy),
      port: cur.port,
      spawnCommand: state.spawnCommand,
    });
    // 子进程自己退出（用户手动关掉、崩溃）时立刻清掉归属记录，
    // 免得下次启动把一条废 pid 当孤儿去比对（也顺手把 state.pid 置空，让 status.running 说实话）。
    child.on('exit', () => {
      removeOwnerRecord(child.pid);
      if (state.pid === child.pid) state.pid = null;
    });
    child.unref();
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

/**
 * 终止**进程树**（只传进程号；调用方必须先确认真的是本程序拉起的那个 ComfyUI）。
 * win32：taskkill /T /F（实测 /T 能连 detached 子进程一起收）。
 * 非 win32：等价物 = 先给进程组 SIGTERM（detached 的子进程自成一个进程组），仍在就一步升到 SIGKILL ——
 *          退出路径不会再有第二次机会，所以不能只发一次信号就走。
 */
function taskkill(pid) {
  if (process.platform !== 'win32') {
    const sig = (s) => {
      try { process.kill(-pid, s); return true; } catch { try { process.kill(pid, s); return true; } catch { return false; } }
    };
    sig('SIGTERM');
    if (pidAlive(pid)) sig('SIGKILL');
    return !pidAlive(pid);
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
function cmdlineOf(pid, timeoutMs = 8000) {
  if (process.platform !== 'win32' || !pid) return '';
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}" -ErrorAction SilentlyContinue).CommandLine`],
      { encoding: 'utf8', timeout: timeoutMs });
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

// ── 进程归属：只清"本程序拉起的"那一个 ComfyUI ────────────
//
// 为什么必须落盘（第十一轮实测结论）：孤儿的真实成因**不是** detached 脱离进程树
// （实测 detached 子进程照样被 taskkill /T 杀掉），而是"父链被单进程杀掉之后断掉"——
// 启动器被强杀（scripts/start.ps1 的 $proc.Kill() 是不带 /T 的单进程杀）时，中间那层 node 死掉，
// 而 ComfyUI 作为 detached 子进程活着，父链断裂 → /T 永远够不着 → 跨进程孤儿，
// 下次启动时 launch() 又"探测到端口有回应就返回 online:true"把它认领了。
// 内存里的 state.pid 对这类孤儿永远是空的，所以唯一能识别它的就是**落盘的归属记录**：
//   data/run/comfy-owner-<pid>.json（data/ 已被 .gitignore 忽略，绝不入库、不带机器路径进仓库）
//
// 红线：**绝不**按"谁在监听 comfy.port"清理 —— 那正是用户自己启动的实例（旧 stop() 会误杀它）。
// 判定谓词见 docs/ROUND11-REQUIREMENTS.md §7.2：五条全过才动手，任一不过只记日志。

const OWNER_SCHEMA = 1;

function ownerDir() { return path.join(paths.data, 'run'); }

function ownerFileOf(pid) { return path.join(ownerDir(), `comfy-owner-${pid}.json`); }

function writeOwnerRecord(rec) {
  try {
    fsx.writeJsonAtomic(ownerFileOf(rec.pid), rec);
    return true;
  } catch (e) {
    log.warn('写入 ComfyUI 归属记录失败（不影响启动，只影响下次的孤儿清理）：' + e.message);
    return false;
  }
}

function removeOwnerRecord(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { fs.unlinkSync(ownerFileOf(n)); return true; } catch { return false; }
}

/** 列出 data/run 下的全部归属记录（含解析失败的；后者一律不参与终止判定）。 */
function listOwnerRecords() {
  let names = [];
  try { names = fs.readdirSync(ownerDir()); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!/^comfy-owner-\d+\.json$/i.test(name)) continue;
    const file = path.join(ownerDir(), name);
    let rec = null;
    let error = null;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { rec = null; error = '记录不是 JSON 对象'; }
    } catch (e) { error = e.message; }
    out.push({ file, rec, error });
  }
  return out;
}

/** 进程是否存活（EPERM = 存在但没有权限，也算存活）。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function normPathText(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/**
 * 五条谓词全过才认"这条记录指向的确实是本程序拉起的 ComfyUI"：
 *   ① 记录存在、可解析、schema 已知、pid 是正整数；② 进程存活；③ 命令行非空且确实是 ComfyUI main.py，
 *   并且反推出的入口目录 == 记录 codeDir（或命令行含记录 mainPy）；④ pid ≠ 本进程；⑤ 事后删记录（调用方做）。
 * 任何一条不满足 → 只记日志、绝不动手：宁可漏清，也绝不误杀。
 */
function verifyOwnership(rec, opts = {}) {
  if (!rec || typeof rec !== 'object') return { ok: false, reason: '记录缺失或不可解析' };
  if (rec.schema !== OWNER_SCHEMA) return { ok: false, reason: '记录 schema 未知：' + String(rec.schema) };
  const pid = Number(rec.pid);
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: '记录里的 pid 非法：' + String(rec.pid) };
  if (pid === process.pid) return { ok: false, pid, reason: '记录指向本进程自身' };
  if (!pidAlive(pid)) return { ok: false, dead: true, pid, reason: '进程已不存在' };
  const cmd = cmdlineOf(pid, opts.cmdlineTimeoutMs);
  if (!cmd) return { ok: false, pid, reason: '读不到命令行，无法确认它是 ComfyUI main.py' };
  if (!/main\.py/i.test(cmd)) return { ok: false, pid, reason: '命令行里没有 main.py（不是 ComfyUI 入口）' };
  const cmdDir = codeDirFromCmdline(cmd);
  const wantDir = normPathText(rec.codeDir);
  const wantMain = normPathText(rec.mainPy);
  const dirMatch = !!wantDir && !!cmdDir && normPathText(cmdDir) === wantDir;
  const mainMatch = !!wantMain && normPathText(cmd).includes(wantMain);
  if (!dirMatch && !mainMatch) {
    return { ok: false, pid, reason: '命令行与记录的入口对不上（可能是 pid 已被复用）' };
  }
  return { ok: true, pid, reason: dirMatch ? '命令行入口目录与记录一致' : '命令行含记录的 main.py' };
}

/**
 * 启动时清掉上一次留下的、**确实属于本程序**的 ComfyUI 孤儿（R2）。
 * 候选只来自 data/run 下本程序自己写的归属记录 —— 用户自己启动的实例没有任何记录，永远不在候选里。
 */
function cleanupOrphans() {
  const records = listOwnerRecords();
  const result = { dir: ownerDir(), scanned: records.length, killed: [], removed: [], skipped: [] };
  for (const { file, rec, error } of records) {
    const name = path.basename(file);
    if (error) {
      result.skipped.push({ file: name, reason: '记录不可解析：' + error });
      log.warn(`归属记录 ${name} 不可解析，已跳过（不动任何进程）：${error}`);
      continue;
    }
    const v = verifyOwnership(rec);
    if (!v.ok) {
      // 进程已经不在：记录肯定是废的，删掉即可（删记录 ≠ 杀进程，不会误伤）。
      if (v.dead) { removeOwnerRecord(rec.pid); result.removed.push(rec.pid); }
      result.skipped.push({ file: name, pid: rec.pid, reason: v.reason });
      log.warn(`归属记录 ${name} 未清理（不动手）：${v.reason}`);
      continue;
    }
    const killed = taskkill(v.pid);
    removeOwnerRecord(v.pid);
    result.killed.push({ pid: v.pid, taskkillOk: killed, why: v.reason });
    log.info(`清理上一次遗留的 ComfyUI 孤儿：pid=${v.pid}（${v.reason}）→ ${killed ? '已终止进程树' : '终止命令未成功'}`);
  }
  if (result.killed.length) {
    log.info(`启动清理完成：终止了 ${result.killed.length} 个上一次由本程序拉起、却残留至今的 ComfyUI 进程。`);
  }
  return result;
}

/**
 * 本程序自己拉起的 ComfyUI 进程号清单。
 * 两个来源：① 内存 state.pid —— 本次运行**亲自 spawn** 出来的，direct 证据，无需再验；
 *           ② data/run 下的归属记录 —— 跨进程/跨重启的孤儿只有它能识别，必须过五条谓词。
 */
function ownedTargets(opts = {}) {
  const out = [];
  const seen = new Set();
  const add = (pid, source, why) => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0 || n === process.pid || seen.has(n)) return;
    seen.add(n);
    out.push({ pid: n, source, why });
  };
  if (state.pid) add(state.pid, 'memory', '本次运行由本程序拉起');
  for (const { file, rec, error } of listOwnerRecords()) {
    if (error) continue;
    const v = verifyOwnership(rec, opts);
    if (v.ok) add(v.pid, path.basename(file), v.reason);
  }
  return out;
}

/**
 * 同步兜底清理（给 process 的 'exit' 事件用）。
 * 为什么必须**整个同步**：Windows 上 taskkill /F 就是 TerminateProcess，实测不给 node 任何执行机会
 * （SIGTERM/SIGINT/SIGBREAK/exit 处理器一个都不跑），能被执行的只有"此刻正在跑的同步代码"，
 * 所以这里一行 async/await 都不能有，只用 spawnSync。
 * 覆盖：正常退出、process.exit()、以及 SIGINT/SIGTERM 处理器里触发的退出 —— 这些路径都能跑完。
 * taskkill /F 直接打死本进程时这段代码同样不会被执行：那种情况由"托盘先礼后兵"（scripts/tray.ps1
 * 先 POST /app/quit）与"下次启动清理孤儿"（cleanupOrphans）兜住。
 */
function killOwnedSync(why = 'process-exit') {
  const out = { why, killed: [], skipped: [] };
  const targets = ownedTargets({ cmdlineTimeoutMs: 2500 });
  for (const t of targets) {
    if (!pidAlive(t.pid)) {
      removeOwnerRecord(t.pid);
      out.skipped.push({ pid: t.pid, reason: '进程已不存在' });
      continue;
    }
    const ok = taskkill(t.pid);
    removeOwnerRecord(t.pid);
    out.killed.push({ pid: t.pid, taskkillOk: ok, source: t.source });
  }
  if (state.pid) state.pid = null;
  try {
    if (out.killed.length) {
      log.info(`退出同步兜底（${why}）：已终止本程序拉起的 ComfyUI `
        + out.killed.map((k) => `pid=${k.pid}${k.taskkillOk ? '' : '(终止命令未成功)'}`).join('、'));
    }
  } catch { /* 退出阶段日志失败不抛 */ }
  return out;
}

/**
 * 一键停止（异步，给面板「停止 ComfyUI」与退出收尾用）：**只停本程序拉起的**，不再按端口兜底。
 * 与旧实现的差别（这是第十一轮的红线）：
 *   · 旧 `stop()` 在内存没有 pid 时会退到 `pidListeningOn(port)` —— 那会杀掉**用户自己启动的** ComfyUI；
 *   · 旧 `stop()` 先 probe 端口，离线就 early-return —— 而我们自己拉起的实例可能已经离线但进程还在
 *     （退出时必须照样停掉，见 R1），所以这里**不以端口在线与否为条件**。
 * 非本程序拉起的实例：不动手，明确回报"已跳过"。
 */
async function stopOwned(why = 'manual') {
  const cur = current();
  const targets = ownedTargets();
  if (!targets.length) {
    const online = await probe(cur.port, 1000);
    return {
      online, stopped: false, owner: online ? 'foreign' : 'none',
      note: online
        ? `127.0.0.1:${cur.port} 上的 ComfyUI 不是本程序拉起的（没有任何归属记录），已跳过；要停它请手动结束该进程。`
        : '本程序当前没有拉起的 ComfyUI 实例。',
    };
  }
  const detail = [];
  for (const t of targets) {
    if (!pidAlive(t.pid)) {
      removeOwnerRecord(t.pid);
      detail.push({ pid: t.pid, taskkillOk: false, note: '进程已不存在' });
      continue;
    }
    const ok = taskkill(t.pid);
    removeOwnerRecord(t.pid);
    detail.push({ pid: t.pid, taskkillOk: ok, source: t.source });
  }
  if (state.pid) state.pid = null;
  const stillAlive = detail.filter((d) => pidAlive(d.pid)).map((d) => d.pid);
  const online = await probe(cur.port, 800);
  log.info(`已停止本程序拉起的 ComfyUI（${why}）：`
    + detail.map((d) => `pid=${d.pid}${d.taskkillOk ? '' : '(终止命令未成功)'}`).join('、')
    + (online ? `；端口 ${cur.port} 仍有 ComfyUI 在监听（可能是另一个实例，未动它）` : ''));
  return {
    online, stopped: stillAlive.length === 0, owner: 'app',
    pids: detail.map((d) => d.pid), stillAlive, detail,
    note: stillAlive.length ? `进程 ${stillAlive.join('、')} 仍在运行（可能权限不足），请手动结束。` : undefined,
  };
}

/** 兼容旧名字：POST /app/comfy/stop 与退出收尾都走同一个安全口径。 */
async function stop() { return stopOwned('面板「停止 ComfyUI」'); }

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
  // v1.2.2：进程归属（只清本程序拉起的实例）+ 退出的同步兜底 + 启动孤儿清理
  stopOwned, killOwnedSync, cleanupOrphans, verifyOwnership, listOwnerRecords, ownerDir, taskkill,
  state,
};
