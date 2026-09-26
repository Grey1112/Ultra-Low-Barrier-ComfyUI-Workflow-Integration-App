// job-view.js —— 长任务（下载 / 安装）的统一前端视图。
//
// 后端契约：POST 类接口返回 { jobId }，事件流是
//   GET /app/jobs/{jobId}/events  (text/event-stream)
//   帧： {"phase","message","percent","level"} … 末帧 {"phase":"done","ok":bool,"result","error"}

import { t } from './i18n.js';

/** 订阅任务事件流。返回取消订阅函数。 */
export function runJob(jobId, handlers = {}) {
  const es = new EventSource('/app/jobs/' + encodeURIComponent(jobId) + '/events');
  let closed = false;
  const close = () => { if (!closed) { closed = true; es.close(); } };
  es.onmessage = (ev) => {
    let data = null;
    try { data = JSON.parse(ev.data); } catch { return; }
    if (data && data.phase === 'done') {
      close();
      if (data.ok) handlers.onDone && handlers.onDone(data.result, data);
      else handlers.onFail && handlers.onFail(new Error(data.error || 'job failed'), data);
      return;
    }
    handlers.onEvent && handlers.onEvent(data);
  };
  es.onerror = () => {
    // 事件流断开：可能是正常结束（服务端关闭）也可能是网络问题——用轮询兜底一次。
    close();
    fetch('/app/jobs/' + encodeURIComponent(jobId))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('job not found'))))
      .then((j) => {
        if (j.state === 'done') handlers.onDone && handlers.onDone(j.result, { phase: 'done', ok: true, result: j.result });
        else if (j.state === 'failed') handlers.onFail && handlers.onFail(new Error(j.error || 'job failed'), { phase: 'done', ok: false, error: j.error });
        else handlers.onFail && handlers.onFail(new Error(t('toast.failed')));
      })
      .catch((e) => handlers.onFail && handlers.onFail(e));
  };
  return close;
}

/** React 组件：进度条 + 实时速度/剩余时间 + 日志。pages 直接 import 使用。 */
export function JobProgress(props) {
  const { jobId, onDone, onFail, compact } = props;
  const [percent, setPercent] = React.useState(0);
  const [phase, setPhase] = React.useState('');
  const [lines, setLines] = React.useState([]);
  const [error, setError] = React.useState('');
  // 数值进度：后端在帧里直接给 downloaded/total/speedKBs/etaSec —— 不再从日志文案里正则抠速度。
  const [nums, setNums] = React.useState(null);

  React.useEffect(() => {
    if (!jobId) return undefined;
    setPercent(0); setPhase(''); setLines([]); setError(''); setNums(null);
    const stop = runJob(jobId, {
      onEvent(e) {
        if (typeof e.percent === 'number') setPercent(e.percent);
        if (e.phase) setPhase(e.phase);
        if (e.message) setLines((prev) => prev.concat((e.level ? '[' + e.level + '] ' : '') + e.message).slice(-300));
        if (typeof e.downloaded === 'number' && typeof e.total === 'number') {
          setNums({
            downloaded: e.downloaded, total: e.total,
            speedKBs: typeof e.speedKBs === 'number' ? e.speedKBs : null,
            etaSec: typeof e.etaSec === 'number' ? e.etaSec : null,
            waiting: !!e.waiting, candidate: e.candidate || '',
          });
        }
      },
      onDone(result) { setPercent(100); onDone && onDone(result); },
      onFail(err) { setError(err.message); onFail && onFail(err); },
    });
    return stop;
  }, [jobId]);

  if (!jobId) return null;
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  const gb = (n) => (n / 1073741824).toFixed(2) + ' GB';
  const sizeOf = (n) => (n >= 1073741824 ? gb(n) : mb(n));
  const speedText = !nums ? '' : (nums.waiting ? '等待数据…'
    : (nums.speedKBs === null ? '' : (nums.speedKBs >= 1024 ? (nums.speedKBs / 1024).toFixed(2) + ' MB/s' : Math.round(nums.speedKBs) + ' KB/s')));
  const etaText = (nums && nums.etaSec !== null && nums.etaSec !== undefined)
    ? (nums.etaSec >= 60 ? Math.floor(nums.etaSec / 60) + ' 分 ' + (nums.etaSec % 60) + ' 秒' : nums.etaSec + ' 秒') : '';

  return React.createElement('div', { className: 'job' + (compact ? ' job-compact' : '') },
    React.createElement('div', { className: 'row' },
      React.createElement('span', { className: 'muted' }, phase || t('common.progress')),
      React.createElement('span', { className: 'sp' }),
      React.createElement('span', { className: 'muted' }, Math.round(percent) + '%')),
    React.createElement('div', { className: 'job-bar' }, React.createElement('i', { style: { width: Math.max(2, percent) + '%' } })),
    nums ? React.createElement('div', { className: 'row tight job-nums' },
      React.createElement('span', { className: 'muted' }, t('job.downloaded') + ' ' + sizeOf(nums.downloaded) + ' / ' + sizeOf(nums.total)),
      speedText ? React.createElement('span', { className: 'badge' }, '↓ ' + speedText) : null,
      etaText ? React.createElement('span', { className: 'muted' }, t('job.eta') + ' ' + etaText) : null,
      nums.candidate ? React.createElement('span', { className: 'muted' }, t('job.source') + ' ' + nums.candidate) : null) : null,
    lines.length ? React.createElement('div', { className: 'job-log' }, lines.join('\n')) : null,
    error ? React.createElement('div', { className: 'error' }, error) : null);
}

/** 打开一个 job 并在弹窗里显示进度；完成后 onDone。 */
export function openJobModal(jobId, title, onDone, onFail) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = ReactDOM.createRoot(host);
  const close = () => { root.unmount(); host.remove(); };
  root.render(React.createElement('div', { className: 'modal-mask' },
    React.createElement('div', { className: 'modal' },
      React.createElement('div', { className: 'modal-title' }, title || t('common.progress')),
      React.createElement(JobProgress, {
        jobId,
        onDone: (r) => { onDone && onDone(r); setTimeout(close, 1200); },
        onFail: (e) => { onFail && onFail(e); },
      }),
      React.createElement('div', { className: 'modal-foot' },
        React.createElement('button', { className: 'btn', onClick: close }, t('common.close'))))));
}

/**
 * v1.3.0：下载队列的轻量进度条（读**服务端**队列快照，因此切页/关窗口都不丢）。
 * 用法：web/pages/install.js 与向导页的行内进度都用它。
 */
export function QueueProgress(props) {
  const { api, taskId, label } = props;
  const [task, setTask] = React.useState(null);
  React.useEffect(() => {
    if (!taskId) return undefined;
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/app/install/queue');
        if (!r.ok) return;
        const j = await r.json();
        const hit = (j.items || []).find((x) => x.id === taskId);
        if (alive) setTask(hit || null);
      } catch { /* 离线时静默 */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, [taskId]);
  if (!task) return null;
  const pct = Math.max(0, Math.min(100, task.percent || 0));
  const speed = typeof task.speedKBs === 'number' && task.speedKBs > 0
    ? (task.speedKBs >= 1024 ? (task.speedKBs / 1024).toFixed(2) + ' MB/s' : Math.round(task.speedKBs) + ' KB/s')
    : (task.waiting ? t('queue.waiting') : '');
  return React.createElement('div', { className: 'job job-compact' },
    React.createElement('div', { className: 'row' },
      React.createElement('span', { className: 'muted' }, label || task.title),
      React.createElement('span', { className: 'sp' }),
      React.createElement('span', { className: 'muted' }, pct + '%')),
    React.createElement('div', { className: 'job-bar' }, React.createElement('i', { style: { width: Math.max(2, pct) + '%' } })),
    React.createElement('div', { className: 'row tight job-nums' },
      speed ? React.createElement('span', { className: 'badge' }, '↓ ' + speed) : null,
      task.candidate ? React.createElement('span', { className: 'muted' }, t('job.source') + ' ' + task.candidate) : null,
      task.error ? React.createElement('span', { className: 'error' }, task.error) : null));
}

/**
 * 后台任务指示器：显示**服务端**正在跑的任务（下载/安装），点一下打开进度弹窗。
 * 为什么放在外壳：任务活在服务端、进度靠 SSE，页面切走不该让用户"看不见进度了"。
 * v1.3.0：把**持久化下载队列**也数进来（队列任务与 job 是同一批工作的两种视图）。
 */
export function BackgroundJobs(props) {
  const { api, t: tt } = props;
  const tFn = typeof tt === 'function' ? tt : t;
  const [jobs, setJobs] = React.useState([]);
  const [queued, setQueued] = React.useState(0);

  React.useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch('/app/jobs');
        if (!r.ok) return;
        const j = await r.json();
        if (alive) setJobs((j.items || []).filter((x) => x.state === 'running'));
      } catch { /* 离线时静默 */ }
      try {
        const r2 = await fetch('/app/install/queue');
        if (!r2.ok) return;
        const q = await r2.json();
        const c = q.counts || {};
        if (alive) setQueued((c.running || 0) + (c.queued || 0));
      } catch { /* 离线时静默 */ }
    };
    poll();
    const iv = setInterval(poll, 2000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  if (!jobs.length && !queued) return null;
  if (!jobs.length) {
    return React.createElement('button', {
      className: 'badge good job-chip',
      title: tFn('install.queue.title'),
      onClick: () => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('dcp-go-tab', { detail: 'install' })); },
    }, '📦 ' + tFn('install.queue.title') + ' · ' + queued);
  }
  const j = jobs[0];
  return React.createElement('button', {
    className: 'badge good job-chip',
    title: tFn('job.openHint'),
    onClick: () => openJobModal(j.id, j.title),
  }, '⏳ ' + (j.title || j.kind) + ' · ' + Math.round(j.percent || 0) + '%'
    + (typeof j.speedKBs === 'number' && j.speedKBs > 0 ? ' · ' + (j.speedKBs >= 1024 ? (j.speedKBs / 1024).toFixed(1) + ' MB/s' : Math.round(j.speedKBs) + ' KB/s') : '')
    + (jobs.length > 1 || queued ? ' (+' + (jobs.length - 1 + queued) + ')' : ''));
}
