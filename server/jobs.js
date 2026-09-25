// 长任务（下载/安装）：统一 jobId + SSE 事件流 + 落盘日志。
//
// 契约见 docs/INTERNAL-CONTRACT.md §3：绝不允许静默失败——每个失败都要有 message。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');

const jobs = new Map();
const MAX_EVENTS = 800;
const MAX_JOBS = 40;

function newId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function create(kind, title) {
  // 只保留最近 MAX_JOBS 个已结束任务，避免内存无界增长。
  if (jobs.size > MAX_JOBS) {
    const done = [...jobs.values()].filter((j) => j.state !== 'running').sort((a, b) => a.startedAt - b.startedAt);
    for (const j of done.slice(0, jobs.size - MAX_JOBS)) jobs.delete(j.id);
  }
  const job = {
    id: newId(),
    kind,
    title: title || kind,
    state: 'running',
    events: [],
    listeners: new Set(),
    result: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    logFile: path.join(paths.jobs, kind + '-' + newId() + '.log'),
  };
  fsx.ensureDir(paths.jobs);
  // 任务体（download.js / 安装器）直接往 job 上发事件，避免到处传 jobs 模块。
  job.emit = (ev) => frame(job, { phase: ev.phase || job.phaseName || job.kind, level: ev.level || 'info', at: Date.now(), ...ev });
  // extra：可选的数值进度信息（downloaded/total/speedKBs/etaSec/waiting…）。
  // 前端不再需要从 message 里正则抠速度 —— 早期版本只把"窗口均速 0 KB/s"写进文案，
  // 一旦文案没更新（或首帧还没收到数据）界面就只能显示 0，看起来像"速度永远是 0"。
  job.emitPercent = (phaseName, percent, message, level = 'info', extra = null) => {
    frame(job, {
      phase: phaseName || job.phaseName || job.kind,
      message: message || '',
      percent: clampPct(percent),
      level,
      at: Date.now(),
      ...(extra && typeof extra === 'object' ? extra : {}),
    });
  };
  job.log = (message, level = 'info') => job.emit({ message, level });
  job.phase = (name) => phase(job, name);            // 切换阶段（job.phaseName 记录当前阶段名）
  jobs.set(job.id, job);
  log.info(`job ${job.id} 开始：${job.title}`);
  return job;
}

function frame(job, ev) {
  const data = { ...ev };
  job.events.push(data);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  for (const fn of job.listeners) {
    try { fn(data); } catch { /* 断开的监听者不该影响任务 */ }
  }
  try {
    fs.appendFileSync(job.logFile, JSON.stringify(data) + '\n', 'utf8');
  } catch { /* ignore */ }
}

function progress(job, message, percent, level = 'info') {
  frame(job, { phase: job.phaseName || job.kind, message: String(message), percent: clampPct(percent), level, at: Date.now() });
}

function phase(job, name) {
  job.phaseName = name;   // 注意：当前阶段名放 phaseName，别覆盖 job.phase 这个方法
  frame(job, { phase: name, message: '', percent: undefined, level: 'info', at: Date.now() });
}

function clampPct(p) {
  if (p === undefined || p === null || !Number.isFinite(Number(p))) return undefined;
  return Math.max(0, Math.min(100, Math.round(Number(p))));
}

function finish(job, result) {
  if (job.state !== 'running') return;
  job.state = 'done';
  job.result = result === undefined ? null : result;
  job.endedAt = Date.now();
  frame(job, { phase: 'done', ok: true, result: job.result, message: '完成', level: 'ok', percent: 100, at: Date.now() });
  log.info(`job ${job.id} 完成：${job.title}`);
  closeListeners(job);
}

function fail(job, err) {
  if (job.state !== 'running') return;
  job.state = 'failed';
  job.error = err && err.message ? err.message : String(err);
  job.endedAt = Date.now();
  frame(job, { phase: 'done', ok: false, error: job.error, message: job.error, level: 'error', at: Date.now() });
  log.error(`job ${job.id} 失败：${job.title} → ${job.error}`);
  closeListeners(job);
}

function closeListeners(job) {
  for (const fn of job.listeners) {
    try { fn(null); } catch { /* ignore */ }
  }
}

function get(id) {
  return jobs.get(id) || null;
}

/**
 * 任务清单（给外壳的"后台任务"指示器用）。
 * 关键点：任务本身活在服务端，**不随页面切换消失** —— 用户从向导切到别的页再切回来，
 * 靠这个接口就能重新挂上正在跑的下载/安装任务，而不是"进度不见了"。
 */
function list() {
  return [...jobs.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map((j) => {
      const last = j.events.length ? j.events[j.events.length - 1] : null;
      const lastPct = [...j.events].reverse().find((e) => typeof e.percent === 'number');
      const lastSpeed = [...j.events].reverse().find((e) => typeof e.speedKBs === 'number');
      return {
        id: j.id,
        kind: j.kind,
        title: j.title,
        state: j.state,
        percent: j.state === 'done' ? 100 : (lastPct ? lastPct.percent : (last && typeof last.percent === 'number' ? last.percent : 0)),
        speedKBs: lastSpeed ? lastSpeed.speedKBs : null,
        message: last && last.message ? last.message : '',
        startedAt: j.startedAt,
        endedAt: j.endedAt,
        error: j.error || null,
      };
    });
}

/** 当前正在跑的任务（可指定 kind 前缀）。 */
function running(kindPrefix) {
  return list().find((j) => j.state === 'running' && (!kindPrefix || String(j.kind).startsWith(kindPrefix))) || null;
}

/** SSE：先补发历史事件，再挂监听；客户端断开时清理。 */
function stream(id, req, res) {
  const job = jobs.get(id);
  if (!job) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '任务不存在：' + id }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (ev) => {
    if (ev === null) { // 任务终止：补一帧终态后关闭
      if (job.state === 'done') res.write('data: ' + JSON.stringify({ phase: 'done', ok: true, result: job.result }) + '\n\n');
      else if (job.state === 'failed') res.write('data: ' + JSON.stringify({ phase: 'done', ok: false, error: job.error }) + '\n\n');
      res.end();
      return;
    }
    res.write('data: ' + JSON.stringify(ev) + '\n\n');
  };
  for (const ev of job.events) send(ev);
  if (job.state !== 'running') {
    if (job.state === 'done') send({ phase: 'done', ok: true, result: job.result });
    else send({ phase: 'done', ok: false, error: job.error });
    res.end();
    return;
  }
  job.listeners.add(send);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
  const cleanup = () => {
    clearInterval(ping);
    job.listeners.delete(send);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/** 把同步/异步任务体包起来：抛错即 job.fail，绝不静默。 */
function run(kind, title, body) {
  const job = create(kind, title);
  setImmediate(async () => {
    try {
      const result = await body(job);
      finish(job, result);
    } catch (e) {
      fail(job, e);
    }
  });
  return job;
}

module.exports = { create, progress, phase, finish, fail, get, list, running, stream, run, frame };
