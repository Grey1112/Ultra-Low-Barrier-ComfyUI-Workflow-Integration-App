// install-queue.js —— v1.3.0（第十二轮）：持久化下载队列（安装中心的心脏）。
//
// 用户要求（逐条对应实现）：
//   · 模型与 ComfyUI 等组件分开安装，互不触发（本队列用 kind='model' / 'component' 两类任务区分）；
//   · 每个任务都能**暂停 / 取消（同时删本地文件）/ 自动换源（重新测速选最快）**；
//   · 进度**即便退出窗口也保留** → 任务状态与进度落盘到 data/install/tasks.json，
//     连后端重启都还在（重启后正在跑的任务自动变 paused，用户点「继续」即从断点续传）；
//   · 某个组件的**全部来源都无效时不再卡死** → 任务失败即跳过，后面排队的继续跑；
//   · 下载某个模型时若前置缺失 → 明确提醒并**自动加入下载队列**。
//
// 为什么单独一个模块：下载编排（排队/暂停/取消/重排/落盘）与"下载一个文件"（download.js）
// 是两件事，混在一起会让 download.js 越来越难改；而且队列需要活在**页面之外**。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths, load } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');
const dl = require('./download');
const jobs = require('./jobs');
const catalog = require('./models-catalog');
const installState = require('./install-state');

const PERSIST_THROTTLE_MS = 3000;     // 进度落盘节流（每帧都写盘会白白刷硬盘）
const MAX_TASKS = 200;                // 队列上限（防止无限堆积）

/** 内存态；持久化时只写 PERSIST_FIELDS 里的字段。 */
const tasks = new Map();
const active = Object.create(null);        // key → task（在飞任务；不可重复入队）
const runtime = { pumpTimer: null, lastPersist: 0, bootstrapped: false };

let seq = 1;

const PERSIST_FIELDS = [
  'id', 'key', 'kind', 'lane', 'refId', 'title', 'file', 'dest', 'destExisted', 'url', 'urls', 'urlsFirst', 'bytes', 'sha256',
  'state', 'phase', 'attempts', 'triedHosts', 'downloaded', 'total', 'speedKBs', 'etaSec', 'candidate',
  'error', 'note', 'message', 'archivePath', 'addedAt', 'startedAt', 'endedAt', 'percent', 'waiting', 'sinceProgressSec',
];

function nowIso() { return new Date().toISOString(); }

function persist(force) {
  const t = Date.now();
  if (!force && t - runtime.lastPersist < PERSIST_THROTTLE_MS) return;
  runtime.lastPersist = t;
  const items = [...tasks.values()].map((x) => {
    const o = {};
    for (const k of PERSIST_FIELDS) o[k] = x[k];
    return o;
  });
  try {
    fsx.ensureDir(paths.installDir);
    fsx.writeJsonAtomic(paths.installQueueFile, { schema: 1, updatedAt: nowIso(), items });
  } catch (e) {
    log.warn('下载队列落盘失败（不影响本次下载）：' + e.message);
  }
}

function loadFromDisk() {
  const v = fsx.readJson(paths.installQueueFile, null);
  if (!v || !Array.isArray(v.items)) return;
  for (const raw of v.items) {
    if (!raw || !raw.id) continue;
    const t = { ...raw };
    // v1.3.0（需求 1）：老队列里逐组件任务（runtime/nodes/artists/licenses）统一并成「前置组件」一条；
    // 否则升级后会看到一堆早就该隐藏的组件行。
    if (t.kind === 'component' && t.refId !== 'prereq' && t.refId !== 'comfyui') {
      t.refId = 'prereq';
      t.key = makeKey('component', 'prereq', '');
      t.title = '前置组件';
      t.file = '前置组件';
      t.lane = 'prereq';
    }
    // 通道迁移：老数据里 comfyui 与前置组件同属 prereq 通道 → comfyui 独立成通道
    if (t.kind === 'component' && t.refId === 'comfyui') t.lane = 'comfyui';
    if (t.kind === 'component' && t.refId === 'prereq') t.lane = 'prereq';
    if (t.kind === 'component' && !t.lane) t.lane = 'prereq';
    if (t.kind === 'model' && !t.lane) t.lane = 'model';
    if (t.state === 'running') {
      // 后端重启：上一次"正在跑"的任务已经不可能还在跑 —— 转为暂停并保留进度，
      // 让用户自己决定何时继续（这就是"退出窗口/重启后进度还在"）。
      t.state = 'paused';
      t.note = '后端重启，已中断（进度已保留，点「继续」从断点续传）';
      t.speedKBs = null;
    }
    // 队列里的任务不会在重启后继续跑完，状态收敛成可操作的三态
    if (t.state === 'queued') { t.state = 'paused'; t.note = t.note || '重启后未开始（点「继续」开始）'; }
    tasks.set(t.id, t);
  }
  log.info(`下载队列已恢复：${tasks.size} 个任务（来自 ${paths.installQueueFile}）`);
}

function makeKey(kind, refId, file) {
  return kind + ':' + refId + ':' + (file || '');
}

function findTask(key) {
  for (const t of tasks.values()) {
    if (t.key === key && !['done', 'canceled'].includes(t.state)) return t;
  }
  return null;
}

function get(id) { return tasks.get(String(id)) || null; }

function newId() {
  return 't' + (seq++).toString(36) + Date.now().toString(36).slice(-4);
}

/** 队列快照（接口与前端都直接吃它）。 */
function list(filter = {}) {
  let items = [...tasks.values()];
  if (filter.state) items = items.filter((t) => t.state === filter.state);
  if (filter.kind) items = items.filter((t) => t.kind === filter.kind);
  items.sort((a, b) => {
    const pa = a.order || 0; const pb = b.order || 0;
    if (pa !== pb) return pa - pb;
    return (a.addedAt || '').localeCompare(b.addedAt || '');
  });
  const counts = { total: items.length, queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0, skipped: 0 };
  for (const t of items) if (counts[t.state] !== undefined) counts[t.state]++;
  const running = items.find((t) => t.state === 'running') || null;
  // 界面按「两组」显示组件进度，因此随快照一起下发聚合结果
  let groups = [];
  try { groups = installState.GROUPS.map((g) => groupProgress(g.id)).filter(Boolean); } catch { /* 忽略 */ }
  // 需求 3：**总下载速度** + 每个任务的速度。总速度 = 所有正在跑的任务之和
  //（两条通道并行时，这个数字就是"叠加带宽"的直观体现）。
  const runningItems = items.filter((t) => t.state === 'running');
  const totalSpeedKBs = runningItems.reduce((a, t) => a + (typeof t.speedKBs === 'number' ? t.speedKBs : 0), 0);
  return {
    items,
    counts,
    running,
    runningCount: counts.running,
    groups,
    totalSpeedKBs: Math.round(totalSpeedKBs),
    runningSpeeds: runningItems.map((t) => ({ id: t.id, title: t.title, speedKBs: typeof t.speedKBs === 'number' ? Math.round(t.speedKBs) : null, percent: t.percent || 0, lane: laneOf(t) })),
  };
}

function orderMax() {
  let m = 0;
  for (const t of tasks.values()) m = Math.max(m, t.order || 0);
  return m;
}

function push(task) {
  task.order = task.order || (orderMax() + 1);
  tasks.set(task.id, task);
  if (tasks.size > MAX_TASKS) {
    // 只淘汰最老的"已终结"任务
    const done = [...tasks.values()].filter((x) => ['done', 'canceled', 'failed', 'skipped'].includes(x.state))
      .sort((a, b) => String(a.endedAt || a.addedAt).localeCompare(String(b.endedAt || b.addedAt)));
    for (const x of done) {
      if (tasks.size <= MAX_TASKS) break;
      tasks.delete(x.id);
    }
  }
  persist(true);
  return task;
}

/** 组装一个"模型任务"（前置合法性由调用方保证）。 */
function modelTask(entry) {
  const list0 = catalog.list({});
  const m = list0.items.find((x) => x.id === entry.id);
  if (!m) throw new Error('模型不存在：' + entry.id);
  const src = m.custom ? installState.getCustom(m.id) : null;
  const url = src?.sourceUrl || null;
  const base = src
    ? { url: url || '', urls: url ? [] : [] }
    : (() => {
      const c = catalog.byId(m.id) || {};
      const mirrors = (Array.isArray(c.mirrors) ? c.mirrors : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
      const fast = (Array.isArray(c.fastMirrors) ? c.fastMirrors : []).map((x) => (typeof x === 'string' ? x : x && x.url)).filter(Boolean);
      return { url: c.officialUrl || (Array.isArray(c.urls) && c.urls[0]) || '', urls: mirrors, urlsFirst: fast };
    })();
  if (!base.url) throw new Error(`模型「${m.name}」没有可用下载地址（自定义模型请填来源直链，或用本地上传）`);
  return {
    id: newId(),
    key: makeKey('model', m.id, m.file),
    kind: 'model',
    lane: 'model',                 // 需求 2：模型走独立通道，可与 ComfyUI 同时下载
    refId: m.id,
    title: m.name,
    file: m.file,
    dest: path.join(list0.modelsDir, m.dest, m.file),
    url: base.url,
    urls: base.urls || [],
    urlsFirst: base.urlsFirst || [],
    bytes: m.bytes || 0,
    sha256: m.sha256 || '',
    state: 'queued',
    attempts: 0,
    triedHosts: [],
    downloaded: 0,
    total: m.bytes || 0,
    percent: 0,
    addedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    error: null,
    note: m.custom ? '自定义模型' : '',
  };
}

/**
 * 组装一个"组件任务"。
 * v1.3.0（需求 1）：组件对用户只有**两条** ——「前置组件」（整组一个任务）与「ComfyUI 本体」。
 * 因此这里只认这两个 refId；两者都跑在 `prereq` 通道（与模型通道并行）。
 */
const COMPONENT_TASK_DEFS = {
  // ⚠️ ComfyUI 走**独立通道** `comfyui`：它是最关键、最大（1.79 GB）、也最容易被饿死的下载。
  // 早期版本把它和「前置组件」放在同一条 lane（上限 1），于是前置组件一开跑，
  // ComfyUI 就只能在队列里干等 —— 用户报的"模型下载挤占 ComfyUI 下载位置"就发生在这里。
  prereq: { title: '前置组件', dest: null, lane: 'prereq' },
  comfyui: { title: 'ComfyUI 本体', dest: path.join(paths.runtimeDl, 'ComfyUI_windows_portable_nvidia.7z'), lane: 'comfyui' },
};

function componentTask(refId) {
  const d = COMPONENT_TASK_DEFS[refId];
  if (!d) throw new Error('未知组件任务：' + refId + '（界面只有 prereq / comfyui 两条）');
  return {
    id: newId(),
    key: makeKey('component', refId, ''),
    kind: 'component',
    lane: d.lane,
    refId,
    title: d.title,
    file: d.title,
    dest: d.dest,
    url: '',
    urls: [],
    urlsFirst: [],
    bytes: 0,
    sha256: '',
    state: 'queued',
    phase: '',                 // v1.3.0：两阶段任务用（comfyui: 'download' → 'install'）
    attempts: 0,
    triedHosts: [],
    downloaded: 0,
    total: 0,
    percent: 0,
    addedAt: nowIso(),
    startedAt: null,
    endedAt: null,
    error: null,
    note: refId === 'prereq' ? '出图要用到的附带件（程序自动挑选）' : '下载完成后自动解压安装',
  };
}

// ── 入队 ────────────────────────────────────────────────

/**
 * 入队一个模型；autoPrereq=true（默认取设置）时**自动把缺失的前置一起排队**。
 * @returns {{task:object, addedPrereqs:Array, existed:boolean}}
 */
function enqueueModel(id, opts = {}) {
  const s = load();
  const autoPre = opts.autoPrereq === undefined ? s.download.autoPrereq !== false : !!opts.autoPrereq;
  const lib = catalog.list({});
  const m = lib.items.find((x) => String(x.id).toLowerCase() === String(id).toLowerCase());
  if (!m) throw new Error('模型不存在：' + id);
  const addedPrereqs = [];
  if (autoPre) {
    const seenCycle = new Set([m.id]);
    const reported = new Set();                  // 同一个前置只报一次（依赖链会反复引用 runtime/comfyui）
    const report = (kind, id, title, taskId) => {
      const k = kind + ':' + id;
      if (reported.has(k)) return;
      reported.add(k);
      addedPrereqs.push({ kind, id, title, taskId });
    };
    const walk = (entry) => {
      for (const ref of catalog.prerequisiteRefs(entry)) {
        if (ref.kind === 'component') {
          // 组件对用户只有两类（需求 1）：任何一个组件缺失 → 入队「前置组件」整组一条任务；
          // comfyui 单独一条。组内细节不再出现在队列里。
          const group = ref.refId === 'comfyui' ? 'comfyui' : 'prereq';
          const comp = installState.verifyComponent(group === 'comfyui' ? 'comfyui' : ref.refId);
          if (!comp.ok) {
            const tk = enqueueComponent(group, { silent: true });
            if (tk) report('component', group, tk.title, tk.id);
          }
        } else {
          const dep = lib.items.find((x) => x.id === ref.refId);
          if (!dep || dep.installed) continue;
          if (seenCycle.has(dep.id)) continue;      // 防环（数据写错时不至于死循环）
          seenCycle.add(dep.id);
          const wasNew = !findTask(makeKey('model', dep.id, dep.file));
          const tk = enqueueModel(dep.id, { autoPrereq: true, silent: true });
          if (tk.task && wasNew) report('model', dep.id, dep.name, tk.task.id);
          walk(dep);
        }
      }
    };
    walk(m);
  }
  const key = makeKey('model', m.id, m.file);
  const existing = findTask(key);
  if (existing) {
    persist(true);
    schedule();
    return { task: existing, addedPrereqs, existed: true };
  }
  const task = push(modelTask(m));
  if (!opts.silent) log.info(`下载队列：入队模型 ${m.name}（${task.id}）${addedPrereqs.length ? `，自动加入 ${addedPrereqs.length} 个前置` : ''}`);
  schedule();
  return { task, addedPrereqs, existed: false };
}

function enqueueComponent(refId, opts = {}) {
  const key = makeKey('component', refId, '');
  const existing = findTask(key);
  if (existing) return existing;
  const task = push(componentTask(refId));
  if (!opts.silent) log.info(`下载队列：入队组件 ${refId}（${task.id}）`);
  schedule();
  return task;
}

/**
 * v1.3.0（需求修正）：按**用户看到的那两组**入队。
 * `group='prereq'` → 展开成 runtime / nodes / artists / licenses；
 * `group='comfyui'` → ComfyUI 本体。
 * 界面上只有一条，但队列里仍是逐组件任务 —— 这样暂停/取消/自动换源/排障都还能精确到具体组件。
 */
function enqueueComponentGroup(group, opts = {}) {
  const g = installState.GROUPS.find((x) => x.id === group);
  if (!g) throw new Error('未知组件组：' + group + '（可用：' + installState.GROUPS.map((x) => x.id).join(' / ') + '）');
  const out = [];
  for (const id of g.members) {
    const t = enqueueComponent(id, { silent: true, ...opts });
    if (t) out.push(t);
  }
  if (!opts.silent) log.info(`下载队列：入队组件组「${g.title}」（${out.length} 个子任务）`);
  return { group: g.id, title: g.title, task: out[0] || null, taskIds: out.map((t) => t.id) };
}

/**
 * 把「某一组」的进度汇总成**一条**（界面按组显示，不暴露组内细节）。
 * v1.3.0（需求 1）：每组现在就是**一个任务**（'prereq' / 'comfyui'），所以这里几乎是直读；
 * 返回 null 表示这一组当前没有任何任务 —— 此时由组件真值状态（ok/pending）决定界面显示。
 */
function groupProgress(group) {
  const g = installState.GROUPS.find((x) => x.id === group);
  if (!g) return null;
  const t = [...tasks.values()]
    .filter((x) => x.kind === 'component' && x.refId === group)
    .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)))[0];
  if (!t) return null;
  return {
    group: g.id,
    title: g.title,
    taskId: t.id,
    total: 1,
    done: t.state === 'done' ? 1 : 0,
    active: ['queued', 'running', 'paused'].includes(t.state) ? 1 : 0,
    state: t.state,
    percent: t.percent || 0,
    phase: t.phase || '',
    message: t.message || t.note || '',
    speedKBs: t.speedKBs,
    candidate: t.candidate,
    downloaded: t.downloaded,
    bytes: t.total,
    error: t.state === 'failed' ? t.error : null,
    running: t.state === 'running' ? {
      id: t.id, title: t.title, percent: t.percent || 0,
      speedKBs: t.speedKBs, candidate: t.candidate,
      downloaded: t.downloaded, bytes: t.total, phase: t.phase || '',
    } : null,
  };
}

function enqueueModelIds(ids, opts = {}) {
  const out = { tasks: [], addedPrereqs: [], existed: [], errors: [] };
  const seen = new Set();
  for (const id of ids || []) {
    try {
      const r = enqueueModel(id, opts);
      out.tasks.push(r.task);
      if (r.existed) out.existed.push(id);
      // 去重：同一个前置可能被多个模型的依赖链引用（例如 runtime/comfyui 几乎每个模型都要），
      // 只报一次，否则界面会写成"已自动加入 12 个前置"这种吓人的数字（实际只有 6 个）。
      for (const p of r.addedPrereqs) {
        const k = p.kind + ':' + p.id;
        if (seen.has(k)) continue;
        seen.add(k);
        out.addedPrereqs.push(p);
      }
    } catch (e) {
      out.errors.push({ id, error: e.message });
    }
  }
  return out;
}

// ── 调度与执行（三条并行通道）────────────────────────────
//
// v1.3.0：队列分成三条**互不阻塞**的通道，各管各的并发上限（数组顺序 = 调度优先级）：
//   ① `comfyui`：ComfyUI 本体（先下它！它是关键路径上最大的一块）；
//   ② `prereq` ：前置组件整组（解压工具 / 画师清单 / 许可 …，默认 2）；
//   ③ `model`  ：模型权重（默认 2 路并发；用户要求"下 ComfyUI 时同时下模型以提高速度"）。
// 三条通道并行，所以"前置组件 / 模型下载挤占 ComfyUI"在结构上不再可能。

const LANES = [
  { id: 'comfyui', key: 'comfyuiConcurrency', dflt: 1 },
  { id: 'prereq', key: 'prereqConcurrency', dflt: 2 },
  { id: 'model', key: 'modelConcurrency', dflt: 2 },
];

/** 任务的通道名（老数据没有 lane 字段时按 kind/refId 推断）。 */
function laneOf(task) {
  if (task.lane) return task.lane;
  if (task.kind === 'model') return 'model';
  if (task.refId === 'comfyui') return 'comfyui';
  return 'prereq';
}

function runningCount(lane) {
  let n = 0;
  for (const t of tasks.values()) if (t.state === 'running' && (!lane || laneOf(t) === lane)) n++;
  return n;
}

function laneLimits() {
  const s = load();
  const d = s.download || {};
  // 兼容旧键：老设置里只有 queueConcurrency 时，用它兜底各通道上限
  const legacy = Number.isFinite(Number(d.queueConcurrency)) ? Number(d.queueConcurrency) : 1;
  const clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : dflt;
  };
  const out = {};
  for (const l of LANES) out[l.id] = clamp(d[l.key], 1, 8, Math.max(l.dflt, Math.min(legacy, l.dflt)));
  return out;
}

function schedule() {
  if (runtime.pumpTimer) return;
  runtime.pumpTimer = setTimeout(() => { runtime.pumpTimer = null; pump(); }, 50);
}

/** 稍后再跑一轮调度（阶段交接用：给刚松开的通道一点时间让别的任务先上）。 */
function scheduleSoon(ms) {
  setTimeout(() => { pump(); }, Math.max(100, Number(ms) || 2000));
}

function pump() {
  const limits = laneLimits();
  // 通道顺序即优先级：先让 comfyui 占坑，再前置组件，最后模型（避免模型把带宽先吃光）
  for (const lane of LANES.map((l) => l.id)) {
    for (;;) {
      if (runningCount(lane) >= limits[lane]) break;
      const next = [...tasks.values()]
        .filter((t) => t.state === 'queued' && laneOf(t) === lane)
        .sort((a, b) => (a.order || 0) - (b.order || 0))[0];
      if (!next) break;
      // v2.0.3：ComfyUI 的**解压安装阶段**需要独占权重目录（把 runtime\comfyui\ComfyUI\models
      // 挪走备份再清盘）—— 此刻若模型通道还在往同一棵树里写 .part 文件，目录被占用，
      // renameSync 必失败（用户实测："权重目录未能安全备份，已中止本次解压安装"）。
      // 所以：解压阶段等模型下载跑完再开始；**下载阶段照旧并行**（并行下载是明确需求）。
      // 模型任务结束（done/failed/paused/canceled）→ finish() 会 schedule() → 这里自动放行。
      if (lane === 'comfyui' && next.phase === 'install' && runningCount('model') > 0) {
        const waitMsg = '等待模型下载完成（解压安装需独占权重目录，避免文件占用）…';
        if (next.message !== waitMsg) { next.message = waitMsg; next.note = waitMsg; persist(false); }
        break;
      }
      run(next);
      // v1.3.2 守卫：run() 没能启动它（同 key 的旧实例还在收尾，active 占坑）时状态仍是 queued，
      // 必须跳出本轮 —— 否则这个同步循环会永远抓着同一条任务空转，把整个后端的事件循环卡死
      //（实测：运行中「自动换源」后端立即假死，HTTP 全部无响应，就是这里的死循环）。
      if (next.state === 'queued') break;
    }
  }
}

function setState(task, state, patch = {}) {
  task.state = state;
  Object.assign(task, patch);
  persist(state !== 'running');
  return task;
}

function pct(downloaded, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
}

/** 真正跑一个任务（异步，不 await —— 队列自己管并发）。opts 会一路透传给安装器。 */
function run(task, opts = {}) {
  if (active[task.key]) return;
  active[task.key] = task;
  // v1.3.1：记录"动手之前 dest 是否已存在"。模型任务的 dest 就是**已安装模型的正式路径**，
  // 取消/失败清理只允许删除本任务自己创建的文件（取消一个"重装"绝不许删掉用户原来的模型）。
  if (task.dest && task.destExisted === undefined) task.destExisted = fsx.isFile(task.dest);
  setState(task, 'running', { startedAt: task.startedAt || nowIso(), error: null, speedKBs: null, downloaded: task.downloaded || 0, percent: task.percent || 0 });
  const s = load();
  const isComponent = task.kind === 'component';
  // 墙钟上限：测试环境用 DCP_MAXTASK_MS 覆盖（验收脚本要能几秒内复现"全部来源都慢"的场景）
  const envOverride = Number.parseInt(process.env.DCP_MAXTASK_MS || '', 10);
  const maxWallMs = Number.isFinite(envOverride) && envOverride > 0
    ? envOverride
    : Math.round((isComponent ? s.download.maxTaskHoursComponent : s.download.maxTaskHoursModel) * 3600 * 1000);
  const job = jobs.create(task.kind + ':' + task.refId, task.title);

  // 用户意图由**独立标志**承载，而不是看任务状态：
  // 暂停时任务状态会立刻变成 pending（界面马上要能点「继续」），若把它当作中断信号，
  // 下载线程每 1 s 采一次就会立刻抛错 —— 两条路径会互相干扰。分开就干净了。
  // v1.3.2：新增 retasked —— 「自动换源」对**运行中**的任务同样有效：
  // 引擎在下一次 1 s 采样时中止当前来源（断点保留），finish() 把任务重新入队，
  // pump 立刻让它带新 skipHosts 续传（comfyui 通道优先级最高，不会回队列干等）。
  const ctl = { paused: false, canceled: false, released: false, retasked: false };
  task._ctl = ctl;                        // 暴露给 pause/cancel/retask（函数字段不落盘，无副作用）
  const control = { getState: () => (ctl.canceled ? 'canceled' : (ctl.paused ? 'paused' : (ctl.retasked ? 'retask' : 'running'))) };
  // 本轮要跳过的来源 = retask 显式记下的"已失败来源"（skipHosts）。
  // v1.3.2：**不再**把 triedHosts 一并算进来 —— 那里面混着"上次成功用过的好源"，
  // 换源时把它拉黑会出现"唯一好源被跳过 → 任务失败"。
  const skipHosts = [...new Set([...(task.skipHosts || [])])];
  // 同一任务被"释放"（阶段切换）时不要清进度：comfyui 的 download→install 要接着算
  if (task.phase !== 'install') {
    task.downloaded = 0;
    task.percent = 0;
    task.speedKBs = null;
    task.etaSec = null;
    task.waiting = false;
  }
  task.message = '';

  const finish = (ok, err) => {
    if (ctl.released) {                     // 阶段交接：不算结束，马上把下一阶段排上
      delete active[task.key];
      delete task._ctl;
      setState(task, 'queued', { startedAt: null });
      persist(true);
      scheduleSoon(opts.releaseDelayMs || 2000);
      return;
    }
    delete active[task.key];
    delete task._ctl;
    if (ctl.retasked && !ctl.canceled && !ctl.paused) {  // v1.3.2：自动换源 —— 重新入队，pump 立刻续传（不算结束）；用户随后又取消/暂停时以用户为准
      ctl.retasked = false;
      setState(task, 'queued', { error: null, note: '已自动换源：跳过已试来源，从断点续传…' });
      try { jobs.finish(job, { taskId: task.id, note: 'retask' }); } catch { /* 忽略 */ }
      persist(true);
      schedule();
      return;
    }
    if (ctl.canceled) {
      // v1.3.2 守卫：若用户在引擎收尾期间已经把任务移回队列（canceled 后点了「继续」），尊重用户操作
      if (task.state !== 'queued') setState(task, 'canceled', { endedAt: nowIso(), speedKBs: null, error: null });
      job.log('任务已取消：本地文件与断点已删除', 'warn');
    } else if (ctl.paused) {
      // v1.3.2 守卫：若用户在引擎收尾期间已经点了「继续」（state 已是 queued），不要把暂停盖回去
      if (task.state === 'running') setState(task, 'paused', { speedKBs: null, note: '已暂停（断点已保留，可随时继续）' });
      job.log('任务已暂停：断点已保留，点「继续」即可续传', 'warn');
    } else if (ok) {
      setState(task, 'done', { endedAt: nowIso(), percent: 100, speedKBs: null, error: null, message: '' });
      // 组件安装成功：把"已就绪"写进状态表（下次「开始安装」就会跳过它 —— 修的就是那个恶性 bug）
      if (isComponent) {
        try { installState.markComponent(task.refId, task.resultDetail || {}); } catch { /* 忽略 */ }
      }
    } else {
      setState(task, 'failed', { endedAt: nowIso(), speedKBs: null, error: (err && err.message) || String(err || '未知错误') });
      // 失败时把"看起来在下载"的残片收掉，避免用户以为装了一半（.part 保留以便续传）。
      // v1.3.1：只清**本任务自己创建**的文件 —— dest 在动手前就存在（用户已装好的模型）时绝不动它。
      if (task.dest && task.destExisted === false && fsx.isFile(task.dest) && task.bytes) {
        const sz = fsx.sizeOf(task.dest);
        if (sz !== task.bytes) { try { fs.rmSync(task.dest, { force: true }); } catch { /* 忽略 */ } }
      }
    }
    try {
      if (task.state === 'done') jobs.finish(job, { taskId: task.id });
      else if (task.state === 'failed') jobs.fail(job, new Error(task.error || '任务失败'));
      else jobs.finish(job, { taskId: task.id, note: task.state });
    } catch { /* 忽略 */ }
    persist(true);
    schedule();
  };

  const body = async () => {
    const installer = require('./comfy-install');
    if (isComponent) {
      const patch = (p) => {
        if (p.downloaded !== undefined) task.downloaded = p.downloaded || task.downloaded;
        if (p.total) task.total = p.total;
        task.speedKBs = p.speedKBs === undefined ? task.speedKBs : p.speedKBs;
        task.etaSec = p.etaSec === undefined ? task.etaSec : p.etaSec;
        if (p.candidate) task.candidate = p.candidate;
        if (p.waiting !== undefined) task.waiting = !!p.waiting;
        if (p.message) task.message = p.message;
        // ⚠️ 百分比**自己按 downloaded/total 算**，不能照抄下载引擎给的那个字段：
        // 引擎用的是"目录里写死的期望字节数"作分母，而实际下载的候选可能换个版本/大小，
        // 于是在"已下 457 MB / 1.79 GB"时它仍报 0%（实测：1.79 GB 的包下到 457 MB 还是 0%）。
        if (task.total > 0 && task.downloaded > 0) {
          task.downloadPercent = Math.max(0, Math.min(100, Math.round((task.downloaded / task.total) * 100)));
        } else if (p.percent !== undefined && p.percent !== null) {
          task.downloadPercent = Math.max(0, Math.min(100, Math.round(Number(p.percent) || 0)));
        }
        task.downloadPercent = task.downloadPercent || 0;
        task.percent = Math.round(task.downloadPercent * 0.9);   // 最后 10% 留给解压
        persist(false);
      };
      const onProgress = (p) => patch(p);

      if (task.refId === 'prereq') {
        // 需求 1：**整组一个任务** —— 界面上只有「前置组件」这一条，组内细节完全不暴露
        task.phase = 'prereq';
        const r = await installer.installPrereqGroup(job, {
          control, maxWallMs, skipHosts,
          report: (info) => patch({ percent: info.percent, message: info.index + '/' + info.total }),
        });
        task.resultDetail = { group: 'prereq', missing: r.missing, failed: r.failed };
        task.percent = 100;
        task.message = '';
        return r;
      }

      // comfyui：**两阶段**（先只下载，再解压安装）
      // 需求 2：下载阶段结束就把通道让出来（`ctl.released`），让模型下载先跑起来；
      // 之后由 scheduleSoon() 自动接手解压。这样"下载 ComfyUI 的同时模型也在下"，总吞吐量叠加；
      // 若模型先下完，界面按"等待 ComfyUI"显示在 99%。
      if (task.phase === 'install') {
        const archive = task.archivePath || task.dest;
        patch({ percent: 90, message: '解压安装中（大包需要几分钟）…', speedKBs: null });
        const r = await installer.installFromArchive(job, archive, {
          ...opts, control, maxWallMs, skipHosts,
          mode: load().comfy.mode,
        });
        task.resultDetail = r || {};
        task.percent = 100;
        task.message = '';
        return r;
      }
      // download 阶段
      task.phase = 'download';
      const archive = await installer.downloadPortableArchive(job, {
        ...opts, control, maxWallMs, skipHosts,
        comfySource: task.comfySource || { kind: 'portable' },
        onProgress,
      });
      task.archivePath = archive;
      task.dest = archive;
      task.destExisted = false;              // 归档是本任务自己下的产物（取消时允许删）
      task.downloaded = fsx.sizeOf(archive);
      task.total = task.downloaded;
      task.downloadPercent = 100;
      task.percent = 90;                       // 下载完 = 整条任务 90%，解压占最后 10%
      task.speedKBs = null;
      task.message = '下载完成，正在解压安装…';
      task.phase = 'install';                  // 下一阶段
      ctl.released = true;                     // 交还通道 → finish() 会把它重新排队
      persist(true);
      return { refId: 'comfyui', phase: 'download', archive };
    }
    const lib = catalog.list({});
    const entry = lib.items.find((x) => x.id === task.refId);
    const settings = load();
    const res = await dl.download({
      url: task.url,
      urls: task.urls,
      urlsFirst: task.urlsFirst,
      dest: task.dest,
      job,
      phase: 'models',
      label: task.file,
      expectBytes: task.bytes || undefined,
      sha256: task.sha256 || undefined,
      settings,
      force: true,                         // 队列的任务就是"明确要下"，不做"已存在就跳过"的隐式短路
      control,
      skipHosts,
      maxWallMs,
      onProgress: (p) => {
        task.downloaded = p.downloaded || task.downloaded;
        task.total = p.total || task.total || task.bytes || 0;
        task.speedKBs = p.speedKBs;
        task.etaSec = p.etaSec;
        task.candidate = p.candidate;
        task.waiting = !!p.waiting;
        task.sinceProgressSec = p.sinceProgressSec;
        task.percent = pct(task.downloaded, task.total);
        persist(false);
      },
    });
    task.triedHosts = res.triedHosts || task.triedHosts || [];
    if (entry && !entry.custom) installState.markModel(entry.id, { file: entry.file, bytes: res.bytes, sha256: task.sha256 ? 'ok' : '-' });
    return res;
  };

  Promise.resolve()
    .then(body)
    .then(() => finish(true, null))
    .catch((e) => {
      // v1.3.2：自动换源 —— 引擎带出这一轮**真正失败过**的来源（不含当前源），并入 skipHosts；
      // finish() 把任务重新入队，pump 立刻续传（新 run() 的 skipHosts 就只拉黑这些失败源）。
      if (e && e.code === dl.RETASK) {
        if (Array.isArray(e.failedHosts) && e.failedHosts.length) {
          task.skipHosts = [...new Set([...(task.skipHosts || []), ...e.failedHosts])];
        }
        return finish(false, null);
      }
      if (e && e.code === dl.PAUSED) { ctl.paused = true; return finish(false, null); }
      if (e && e.code === dl.CANCELED) { ctl.canceled = true; return finish(false, null); }
      return finish(false, e);
    });
}

// ── 用户控制 ─────────────────────────────────────────────

function pause(id) {
  const t = get(id);
  if (!t) throw new Error('任务不存在：' + id);
  if (t.state === 'running') {
    if (t._ctl) t._ctl.paused = true;
    return setState(t, 'paused', { speedKBs: null, note: '已暂停（断点已保留，可随时继续）' });
  }
  if (t.state === 'queued') return setState(t, 'paused', { note: '已暂停（尚未开始）' });
  return t;
}

function resume(id) {
  const t = get(id);
  if (!t) throw new Error('任务不存在：' + id);
  if (['done', 'running'].includes(t.state)) return t;
  // 用户点「继续」= 重新尝试：清掉上一轮累积的"跳过这些来源"，否则会一直跳过同一批源；
  // 归档文件可能已被取消时删掉，也一并清掉让下载阶段重新获取。
  const patch = { error: null, note: '', skipHosts: [] };
  if (t.kind === 'component' && t.refId === 'comfyui') {
    if (t.archivePath && !fsx.isFile(t.archivePath)) { t.archivePath = ''; t.phase = 'download'; }
    else if (!t.archivePath) t.phase = 'download';
  }
  setState(t, 'queued', patch);
  schedule();
  return t;
}

/** 取消：删掉本地文件与断点（用户明确要求"取消（同时删除本地文件）"）。 */
function cancel(id, opts = {}) {
  const t = get(id);
  if (!t) throw new Error('任务不存在：' + id);
  const wipe = opts.deleteFile !== false;
  if (t._ctl) t._ctl.canceled = true;      // 让在飞的下载线程立刻抛 DCP_CANCELED
  const removed = [];
  const rmFile = (p) => { try { if (p && fsx.isFile(p)) { fs.rmSync(p, { force: true }); removed.push(p); } } catch { /* 忽略 */ } };
  if (wipe) {
    // v1.3.1（数据丢失修复）：**模型任务的 dest 就是已安装模型的正式路径**。旧实现无条件删除 ——
    // "重新下载一个已安装的模型，中途取消"会把用户原来的模型一并删掉。
    // 规则：dest 只在"动手前不存在"（即本任务自己下的）时才删；`.part` 断点与归档缓存照删；
    // 从未跑过的任务（queued 直接收消）视为"文件不是本任务创建的"，同样只清断点。
    const keepModelDest = t.kind === 'model' && t.destExisted !== false;
    if (t.dest && !keepModelDest) rmFile(t.dest);
    if (t.dest) rmFile(t.dest + '.part');
    if (t.archivePath && t.archivePath !== t.dest) { rmFile(t.archivePath); rmFile(t.archivePath + '.part'); }
  }
  if (t.kind === 'component') {
    // 组件：只清下载缓存 + 标记需要重下；**绝不删已装好的组件目录**（红线：不误删用户数 GB 数据）
    try { installState.markComponentStale(t.refId, '用户取消下载'); } catch { /* 忽略 */ }
    // 归档被删掉了，阶段也要回到"下载"，否则下次会拿一个不存在的归档去解压
    t.archivePath = '';
    t.phase = 'download';
  }
  setState(t, 'canceled', { endedAt: nowIso(), speedKBs: null, note: wipe ? '已取消，本地文件已删除' : '已取消（保留本地文件）' });
  log.info(`下载队列：取消任务 ${t.id}（${t.title}）${removed.length ? '，已删除 ' + removed.length + ' 个文件' : ''}`);
  schedule();
  return { task: t, removed };
}

/** 自动换源：忘掉最快源记忆 + 跳过已失败主机 + 重新排队（并真测一遍剩余来源）。
 *  v1.3.2：对**运行中**的任务同样有效 —— 置 retasked 让引擎在 ≤1 s 内中止当前来源
 *  （断点保留），finish() 重新入队后 pump 立刻续传。旧实现只改状态不动引擎：
 *  运行中点换源会让任务卡在"排队"（active 占坑，run() 早退），引擎还在后台用旧来源跑。 */
function retask(id) {
  const t = get(id);
  if (!t) throw new Error('任务不存在：' + id);
  const n = dl.forgetPreferred('');
  const prev = Array.isArray(t.triedHosts) ? t.triedHosts : [];
  if (t.state === 'running' && t._ctl) t._ctl.retasked = true;
  // 清掉 .part 的"跨来源续传"顾虑：不同镜像的分块可能不一致，重新测速后从断点续传仍带 Range，
  // 因此这里**保留** .part（省流量），但把已试来源记下来，下一轮直接跳过它们。
  t.skipHosts = [...new Set(prev)];
  t.note = `已自动换源：跳过 ${t.skipHosts.length} 个失败来源，重新测速（清空 ${n} 条最快源记忆）`;
  setState(t, 'queued', { error: null });
  schedule();
  log.info(`下载队列：任务 ${t.id} 自动换源（跳过 ${t.skipHosts.length} 个来源）`);
  return t;
}

function retry(id) { return resume(id); }

function move(id, dir) {
  const t = get(id);
  if (!t) throw new Error('任务不存在：' + id);
  const items = list().items.filter((x) => ['queued', 'paused'].includes(x.state));
  const i = items.findIndex((x) => x.id === t.id);
  if (i < 0) return t;
  const j = dir === 'up' ? Math.max(0, i - 1) : Math.min(items.length - 1, i + 1);
  if (i === j) return t;
  const a = items[i]; const b = items[j];
  const oa = a.order || 0; const ob = b.order || 0;
  a.order = ob; b.order = oa;
  persist(true);
  return t;
}

function clearFinished() {
  let n = 0;
  for (const [id, t] of [...tasks.entries()]) {
    if (['done', 'canceled', 'failed', 'skipped'].includes(t.state)) { tasks.delete(id); n++; }
  }
  persist(true);
  return n;
}

/** 关联到某个模型的"当前任务"（安装中心的模型行直接用）。 */
function taskFor(refId, kind = 'model') {
  let best = null;
  for (const t of tasks.values()) {
    if (t.kind !== kind || t.refId !== refId) continue;
    if (['done', 'canceled'].includes(t.state)) { if (!best) best = t; continue; }
    return t;
  }
  return best;
}

function bootstrap() {
  if (runtime.bootstrapped) return;
  runtime.bootstrapped = true;
  try { loadFromDisk(); } catch (e) { log.warn('读取下载队列失败（按空队列启动）：' + e.message); }
  persist(true);
}

module.exports = {
  bootstrap, list, get, taskFor,
  enqueueModel, enqueueModelIds, enqueueComponent, enqueueComponentGroup, groupProgress,
  pause, resume, cancel, retask, retry, move, clearFinished,
  schedule, pump, modelTask, componentTask,
  _internal: { tasks, persist, runningCount },
};
