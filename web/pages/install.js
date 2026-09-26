// install.js —— v1.3.0「安装中心」：组件安装 / 模型库 / 下载队列 / 自定义模型。
//
// 本页面把用户报的几条需求集中呈现出来：
//   · 组件与模型**分开**：组件一行一个安装按钮，模型一行一个安装按钮；
//   · 每个任务都能**暂停 / 继续 / 取消（删本地文件）/ 自动换源**；
//   · 进度**关窗口也在**：队列状态存在服务端（data/install/tasks.json），本页只是 2 s 轮询它；
//   · 某个模型全部来源都失败时**自动跳过**（队列里显示"失败"，其余任务继续跑）；
//   · 下载模型缺前置时**自动入队**并在此提示；
//   · **自定义模型**：本地上传 / 从本机路径导入（硬链接）/ 只登记直链，并指定配套编码器与 VAE。
'use strict';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

const STATE_LABEL = {
  queued: 'queue.state.queued',
  running: 'queue.state.running',
  paused: 'queue.state.paused',
  done: 'queue.state.done',
  failed: 'queue.state.failed',
  canceled: 'queue.state.canceled',
  skipped: 'queue.state.skipped',
};

const STATE_CLASS = {
  queued: 'muted', running: 'good', paused: 'warn', done: 'good', failed: 'error', canceled: 'muted', skipped: 'warn',
};

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return (v / 1073741824).toFixed(2) + ' GB';
  if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB';
  if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
  return v + ' B';
}

function fmtSpeed(kbs) {
  if (typeof kbs !== 'number' || !Number.isFinite(kbs) || kbs <= 0) return '';
  return kbs >= 1024 ? (kbs / 1024).toFixed(2) + ' MB/s' : Math.round(kbs) + ' KB/s';
}

function fmtEta(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '';
  if (sec >= 3600) return Math.floor(sec / 3600) + ' h ' + Math.floor((sec % 3600) / 60) + ' min';
  if (sec >= 60) return Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s';
  return sec + ' s';
}

/** 一行进度条（组件与模型共用）。 */
function ProgressBar(props) {
  const pct = Math.max(0, Math.min(100, Number(props.percent) || 0));
  const indeterminate = props.indeterminate === true;
  return h('div', { className: 'queue-bar' + (indeterminate ? ' indeterminate' : '') },
    h('i', { style: { width: indeterminate ? '100%' : Math.max(1, pct) + '%' } }));
}

export default function InstallPage(props) {
  const { api, post, t, state, settings, refresh, toast } = props;
  const [lib, setLib] = useState(null);
  const [queue, setQueue] = useState({ items: [], counts: {} });
  const [custom, setCustom] = useState({ items: [], routeRules: {}, destDirs: ['diffusion_models', 'text_encoders', 'vae'], modelsDir: '' });
  const [busy, setBusy] = useState('');
  const [forceComponents, setForceComponents] = useState(false);
  // 自定义模型表单
  const [form, setForm] = useState({ source: 'upload', name: '', file: '', dest: 'diffusion_models', route: 'animaPlain', encoder: '', vae: '', srcPath: '', url: '', note: '' });
  const [uploadPct, setUploadPct] = useState(null);
  const fileRef = useRef(null);
  const aliveRef = useRef(true);

  const loadLibrary = useCallback(async () => {
    try {
      const r = await api('/app/models/library');
      if (aliveRef.current) setLib(r);
    } catch (e) { /* 离线时静默，下面有状态提示 */ }
  }, [api]);

  const loadCustom = useCallback(async () => {
    try {
      const r = await api('/app/models/custom');
      if (!aliveRef.current) return;
      setCustom(r || { items: [], routeRules: {}, destDirs: [] });
      // 默认编码器/VAE 跟着管线走（用户仍可改）
      const rule = (r && r.routeRules && r.routeRules[form.route]) || null;
      if (rule) setForm((f) => ({ ...f, encoder: f.encoder || rule.encoder, vae: f.vae || rule.vae }));
    } catch (e) { /* 忽略 */ }
    // form.route 是刻意的依赖：切管线时要重新套默认编码器/VAE（其余表单值用函数式更新保留）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, form.route]);

  const loadQueue = useCallback(async () => {
    try {
      const r = await api('/app/install/queue');
      if (aliveRef.current) setQueue(r || { items: [], counts: {} });
    } catch (e) { /* 忽略 */ }
  }, [api]);

  useEffect(() => {
    aliveRef.current = true;
    loadLibrary();
    loadCustom();
    loadQueue();
    const iv = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      loadQueue();
      loadLibrary();
    }, 2000);
    return () => { aliveRef.current = false; clearInterval(iv); };
  }, [loadLibrary, loadCustom, loadQueue]);

  async function act(action, taskId) {
    setBusy(taskId + ':' + action);
    try {
      await post('/app/install/queue/' + encodeURIComponent(taskId) + '/' + action, {});
      await loadQueue();
    } catch (e) {
      toast(t('toast.failed') + '：' + e.message, 'error');
    } finally { setBusy(''); }
  }

  // v1.3.0（需求修正）：组件只按**两组**操作（前置组件 / ComfyUI 本体），不再逐个组件选
  async function installComponentGroup(group) {
    setBusy('group:' + group);
    try {
      await post('/app/components/enqueue', { groups: [group] });
      toast(t('install.jobStarted'), 'ok');
      await loadQueue();
      await loadLibrary();
    } catch (e) { toast(t('install.enqueue.failed') + '：' + e.message, 'error'); } finally { setBusy(''); }
  }

  async function installAllMissing() {
    try {
      // 缺哪一组就装哪一组（组内具体组件由后端展开，界面不暴露）
      const missingGroups = (lib && lib.groups ? lib.groups : []).filter((g) => !g.ok).map((g) => g.id);
      if (missingGroups.length) await post('/app/components/enqueue', { groups: missingGroups });
      // 一次性提交所有缺失模型；服务端会**自动补前置**并按依赖顺序插到前面
      const ids = (lib && lib.items ? lib.items : []).filter((m) => !m.installed).map((m) => m.id);
      if (ids.length) {
        const r = await post('/app/models/enqueue', { ids, autoPrereq: true });
        const pre = (r.addedPrereqs || []).length;
        toast(t('install.prereq.queued', { n: (r.tasks || []).length, p: pre }), 'ok');
      } else {
        toast(t('install.jobStarted'), 'ok');
      }
      await loadQueue();
      await loadLibrary();
    } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); }
  }

  async function installModel(id) {
    setBusy('model:' + id);
    try {
      const r = await post('/app/models/enqueue', { ids: [id], autoPrereq: true });
      const pre = (r.addedPrereqs || []).map((p) => p.title);
      if (pre.length) toast(t('install.prereq.autoAdded', { list: pre.join('、') }), 'warn');
      else toast(t('install.jobStarted'), 'ok');
      await loadQueue();
      await loadLibrary();
    } catch (e) { toast(t('install.enqueue.failed') + '：' + e.message, 'error'); } finally { setBusy(''); }
  }

  // ── 自定义模型：浏览器直传（XHR，为了拿到上传进度）────────────
  function uploadFile(file) {
    if (!file) return;
    const name = form.file || file.name;
    const modelsDir = (custom && custom.modelsDir) || (lib && lib.modelsDir) || '';
    const uploadId = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const qs = new URLSearchParams({ uploadId, name, dest: form.dest, modelsDir });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/app/models/upload?' + qs.toString(), true);
    // 请求体是**原始文件字节**（服务端按字节直通落盘，不做 multipart 解析），因此不需要 FormData。
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => { setUploadPct(null); toast(t('custom.uploadedPending'), 'error'); };
    xhr.onload = async () => {
      setUploadPct(null);
      if (xhr.status < 200 || xhr.status >= 300) {
        let msg = 'HTTP ' + xhr.status;
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* 忽略 */ }
        toast(t('toast.failed') + '：' + msg, 'error');
        return;
      }
      try {
        const r = await post('/app/models/register-upload', {
          name, dest: form.dest, modelName: form.name, route: form.route,
          encoder: form.encoder, vae: form.vae, note: form.note,
        });
        toast(t('custom.uploaded') + '：' + (r.item ? r.item.name : name), 'ok');
        setForm((f) => ({ ...f, name: '', file: '', srcPath: '', url: '' }));
        await loadCustom();
        await loadLibrary();
      } catch (e) {
        toast(t('custom.uploadedPending') + '：' + e.message, 'error');
      }
    };
    xhr.send(file);
  }

  async function pickLocal() {
    try {
      const r = await post('/app/models/pick-file', {});
      if (r && r.ok && r.path) {
        setForm((f) => ({ ...f, srcPath: r.path, file: f.file || r.path.split(/[\\/]/).pop() }));
        toast(t('custom.field.pick') + '：' + r.path, 'ok');
      } else {
        toast(t('custom.pickFailed') + '：' + ((r && (r.hint || r.error)) || ''), 'warn');
      }
    } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); }
  }

  async function addFromPath() {
    if (!form.srcPath.trim()) { toast(t('custom.needFile'), 'warn'); return; }
    if (!form.name.trim()) { toast(t('custom.needName'), 'warn'); return; }
    setBusy('custom:path');
    try {
      const r = await post('/app/models/import-local', {
        srcPath: form.srcPath.trim(), name: form.file || undefined, dest: form.dest,
        route: form.route, encoder: form.encoder, vae: form.vae, modelName: form.name.trim(),
      });
      toast(t('custom.added') + (r.linked ? '（硬链接）' : '（复制）'), 'ok');
      setForm((f) => ({ ...f, name: '', file: '', srcPath: '' }));
      await loadCustom();
      await loadLibrary();
    } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); } finally { setBusy(''); }
  }

  async function addRegisterOnly() {
    if (!form.name.trim()) { toast(t('custom.needName'), 'warn'); return; }
    if (!form.file.trim()) { toast(t('custom.needFile'), 'warn'); return; }
    try {
      const r = await post('/app/models/custom', {
        name: form.name.trim(), file: form.file.trim(), dest: form.dest, route: form.route,
        encoder: form.encoder, vae: form.vae, sourceUrl: form.url.trim() || undefined, note: form.note,
      });
      toast(t('custom.added') + (r.exists ? '' : '（文件尚未就位）'), r.exists ? 'ok' : 'warn');
      setForm((f) => ({ ...f, name: '', file: '', url: '' }));
      await loadCustom();
      await loadLibrary();
    } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); }
  }

  async function renameCustom(item) {
    const next = window.prompt(t('custom.renaming'), item.name);
    if (next === null) return;
    try {
      await api('/app/models/custom/' + encodeURIComponent(item.id), { method: 'PATCH', body: { name: String(next).trim() } });
      toast(t('toast.saved'), 'ok');
      await loadCustom();
      await loadLibrary();
    } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); }
  }

  async function removeCustom(item, deleteFile) {
    try {
      await api('/app/models/custom/' + encodeURIComponent(item.id) + (deleteFile ? '?deleteFile=1' : ''), { method: 'DELETE' });
      toast(t('custom.removed'), 'ok');
      await loadCustom();
      await loadLibrary();
    } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); }
  }

  const counts = queue.counts || {};
  const rules = (custom && custom.routeRules) || {};
  // 需求 3：当前**总下载速度**（后端把两条通道的在跑任务速度求和；界面直接显示数字）
  const totalSpeed = typeof queue.totalSpeedKBs === 'number' && queue.totalSpeedKBs > 0 ? queue.totalSpeedKBs : null;
  // 需求 2：模型下完但 ComfyUI 还没装好时，界面显示"等待 ComfyUI"，并把它按 99% 展示
  const comfyGroup = (lib && lib.groups ? lib.groups : []).find((g) => g.id === 'comfyui') || null;
  const comfyReady = !!(comfyGroup && comfyGroup.ok);
  const modelTaskFor = (id) => {
    const m = (lib && lib.items ? lib.items : []).find((x) => x.id === id);
    return (m && m.task) || null;
  };
  /** 模型的**展示态**：等 ComfyUI 时压到 99%，状态显示"等待 ComfyUI"。 */
  const viewOf = (tk) => {
    if (!tk) return null;
    const waiting = tk.state === 'done' && !comfyReady;
    if (!waiting) return { state: tk.state, percent: tk.percent || 0, waiting: false, error: tk.error };
    return { state: 'paused', percent: 99, waiting: true, error: null };
  };

  // ── ① 组件：只显示「前置组件」与「ComfyUI 本体」两行 ──────────────
  // 需求 1：界面只有这两条任务，**完全不显示** 7-Zip / 画师清单 / 许可与第三方声明 / 自定义节点。
  // 后端分别是"整组一个任务"与"下载→解压两阶段一个任务"，所以这里的进度就是任务的进度。
  const componentsBlock = (() => {
    const groups = (lib && lib.groups) || [];
    const rows = groups.length
      ? groups.map((g) => {
        const prog = (queue.groups || []).find((x) => x.group === g.id) || null;
        const active = prog && ['queued', 'running', 'paused'].includes(prog.state);
        const buttons = [
          h('span', { className: 'install-name', key: 'n' }, g.title),
          h('span', { className: 'badge ' + (g.ok ? 'good' : ''), key: 'b' }, g.ok ? t('install.status.installed') : t('install.status.missing')),
          h('span', { className: 'sp', key: 's' }),
        ];
        if (active) {
          const pct = prog.percent || 0;
          const spd = fmtSpeed(prog.speedKBs);
          const phaseText = prog.phase === 'install' ? t('queue.phase.install') : (prog.phase === 'download' ? t('queue.phase.download') : '');
          // ComfyUI 是 1.79 GB 的大包：整包 1% 就是 18 MB，所以进度数字要带小数，
          // 并且始终把"已下 / 总量"和速度一起显示出来（否则看起来像停在 0%）。
          const pctText = pct >= 10 ? String(pct) : (Math.round(pct * 10) / 10).toFixed(1);
          const bytesText = (prog.downloaded && prog.bytes)
            ? ' ' + fmtBytes(prog.downloaded) + ' / ' + fmtBytes(prog.bytes) : '';
          buttons.push(h('span', { className: 'muted', key: 'p' },
            t(STATE_LABEL[prog.state] || 'queue.state.queued') + ' ' + pctText + '%'
            + bytesText
            + (phaseText ? ' · ' + phaseText : '')
            + (spd ? ' · ' + spd : '')));
        }
        buttons.push(h('button', {
          className: 'btn tiny' + (g.ok ? '' : ' primary'),
          key: 'a',
          disabled: busy === 'group:' + g.id || (active && prog.state === 'running'),
          onClick: () => installComponentGroup(g.id),
        }, g.ok ? t('install.reinstall') : t('install.install')));
        return h('div', { className: 'install-item', key: g.id },
          h('div', { className: 'install-row', 'data-group': g.id }, buttons),
          h('div', { className: 'install-what' }, g.what),
          active ? h(ProgressBar, {
            percent: prog.percent,
            indeterminate: prog.state === 'queued' || (prog.phase === 'install'),
          }) : null,
          active && prog.message ? h('div', { className: 'hint' }, prog.message) : null,
          prog && prog.error ? h('div', { className: 'error' }, prog.error) : null);
      })
      : [h('div', { className: 'muted', key: 'load' }, t('common.loading'))];
    return h('div', { className: 'card' },
      h('div', { className: 'row' },
        h('div', { className: 'card-title' }, t('install.components.title')),
        h('span', { className: 'sp' }),
        h('label', { className: 'hint' },
          h('input', { type: 'checkbox', checked: forceComponents, onChange: (e) => setForceComponents(e.target.checked) }),
          ' ' + t('install.forceReinstall')),
        h('button', { className: 'btn tiny', onClick: loadLibrary }, t('install.refresh')),
        h('button', { className: 'btn tiny primary', onClick: installAllMissing }, t('install.fixAll'))),
      h('div', { className: 'hint' }, t('install.components.hint')),
      forceComponents ? h('div', { className: 'hint warn' }, t('install.forceReinstall.hint')) : null,
      h('div', { className: 'install-list' }, rows));
  })();

  // ── ② 下载队列 ─────────────────────────────────────────────
  const queueBlock = (() => {
    const rows = queue.items.map((task) => {
      const isRunning = task.state === 'running';
      const isPaused = task.state === 'paused';
      const isQueued = task.state === 'queued';
      const hasFail = task.state === 'failed';
      const speed = fmtSpeed(task.speedKBs);
      const eta = fmtEta(task.etaSec);
      const controls = [];
      if (isRunning || isQueued) {
        controls.push(h('button', { className: 'btn tiny', key: 'pause', disabled: busy === task.id + ':pause', onClick: () => act('pause', task.id) }, t('queue.pause')));
      }
      if (isPaused || (hasFail && task.dest)) {
        controls.push(h('button', { className: 'btn tiny primary', key: 'resume', disabled: busy === task.id + ':resume', onClick: () => act('resume', task.id) }, t('queue.resume')));
      }
      controls.push(h('button', {
        className: 'btn tiny', key: 'retask', title: t('queue.retask.hint'),
        disabled: busy === task.id + ':retask' || ['done', 'canceled'].includes(task.state),
        onClick: () => act('retask', task.id),
      }, t('queue.retask')));
      controls.push(h('button', {
        className: 'btn tiny danger', key: 'cancel',
        disabled: busy === task.id + ':cancel' || ['done', 'canceled', 'failed'].includes(task.state),
        onClick: () => act('cancel', task.id),
      }, t('queue.cancel')));
      if (isQueued || isPaused) {
        controls.push(h('button', { className: 'btn tiny', key: 'up', onClick: () => act('move-up', task.id) }, '↑ ' + t('queue.up')));
        controls.push(h('button', { className: 'btn tiny', key: 'down', onClick: () => act('move-down', task.id) }, '↓ ' + t('queue.down')));
      }
      const meta = [];
      if (task.total) meta.push(h('span', { className: 'muted', key: 'bytes' }, t('job.downloaded') + ' ' + fmtBytes(task.downloaded) + ' / ' + fmtBytes(task.total)));
      if (speed) meta.push(h('span', { className: 'badge', key: 'spd' }, '↓ ' + speed));
      if (task.waiting && isRunning) meta.push(h('span', { className: 'muted', key: 'wait' }, t('queue.waiting')));
      if (eta) meta.push(h('span', { className: 'muted', key: 'eta' }, t('job.eta') + ' ' + eta));
      if (task.candidate) meta.push(h('span', { className: 'muted', key: 'src' }, t('queue.source') + ' ' + task.candidate));
      if (task.error) meta.push(h('span', { className: 'error', key: 'err' }, task.error));
      return h('div', { className: 'queue-row', key: task.id, 'data-task': task.id, 'data-state': task.state },
        h('div', { className: 'queue-head' },
          h('span', { className: 'queue-title' }, task.title),
          h('span', { className: 'badge ' + (STATE_CLASS[task.state] || '') }, t(STATE_LABEL[task.state] || 'queue.state.queued')),
          task.note ? h('span', { className: 'hint' }, task.note) : null,
          h('span', { className: 'sp' }),
          h('span', { className: 'muted' }, Math.round(task.percent || 0) + '%')),
        h(ProgressBar, { percent: task.percent, indeterminate: isRunning && task.waiting }),
        h('div', { className: 'row tight queue-meta' }, meta),
        h('div', { className: 'row tight' }, controls));
    });
    return h('div', { className: 'card' },
      h('div', { className: 'row' },
        h('div', { className: 'card-title' }, t('install.queue.title')),
        h('span', { className: 'badge' }, t('queue.counts', {
          total: counts.total || 0, queued: counts.queued || 0, running: counts.running || 0,
          paused: counts.paused || 0, done: counts.done || 0, failed: counts.failed || 0, canceled: counts.canceled || 0,
        })),
        // 需求 3：**当前总下载速度**（两条通道并行时它就是叠加后的总吞吐）
        totalSpeed ? h('span', { className: 'badge good', 'data-dcp-total-speed': String(Math.round(totalSpeed)) },
          '↓ ' + fmtSpeed(totalSpeed) + ' · ' + t('queue.totalSpeed')) : null,
        h('span', { className: 'sp' }),
        h('button', { className: 'btn tiny', onClick: async () => { await post('/app/install/queue/clear', {}); loadQueue(); } }, t('install.queue.clearFinished'))),
      h('div', { className: 'hint' }, t('install.queue.hint')),
      queue.items.length ? null : h('div', { className: 'muted' }, t('install.queue.empty')),
      h('div', { className: 'queue-list' }, rows));
  })();

  // ── ③ 模型库 ───────────────────────────────────────────────
  const modelsBlock = (() => {
    const head = h('div', { className: 'model-row model-head', key: 'head' },
      h('span', { className: 'model-name' }, t('common.name')),
      h('span', { className: 'model-size' }, t('queue.size')),
      h('span', { className: 'model-dest' }, t('install.models.title')),
      h('span', { className: 'model-req' }, t('install.prereq.need')),
      h('span', { className: 'model-actions' }, t('common.actions')));
    const rows = (lib && lib.items ? lib.items : []).map((m) => {
      const tk = modelTaskFor(m.id);
      const v = viewOf(tk);
      const active = v && ['queued', 'running', 'paused'].includes(v.state);
      const reqCell = (m.missing && m.missing.length)
        ? h('span', { className: 'badge warn' }, t('install.prereq.need') + '：'
          + [...(m.missingGroups || []), ...(m.missingModels || [])].join('、'))
        : h('span', { className: 'badge good' }, t('install.prereq.none'));
      const actions = [];
      actions.push(h('span', { className: 'badge ' + (m.installed ? 'good' : ''), key: 'st' }, m.installed ? t('install.status.installed') : t('install.status.missing')));
      if (active) {
        actions.push(h('span', { className: 'muted', key: 'p' },
          v.waiting ? t('queue.waitingComfy') + ' 99%' : (t(STATE_LABEL[v.state] || '') + ' ' + v.percent + '%')));
      }
      actions.push(h('button', {
        className: 'btn tiny' + (m.installed ? '' : ' primary'), key: 'a',
        disabled: busy === 'model:' + m.id || (active && v.state !== 'paused'),
        onClick: () => installModel(m.id),
      }, m.installed ? t('install.reinstall') : t('install.install')));
      const nameCell = h('span', { className: 'model-name', title: m.path || '' },
        m.name,
        m.custom ? h('span', { className: 'badge' }, t('custom.title')) : null);
      return h('div', { className: 'model-row' + (m.custom ? ' is-custom' : ''), key: m.id, 'data-model': m.id },
        nameCell,
        h('span', { className: 'model-size' }, m.installedBytes ? fmtBytes(m.installedBytes) : fmtBytes(m.bytes)),
        h('span', { className: 'model-dest' }, m.dest),
        h('span', { className: 'model-req' }, reqCell),
        h('span', { className: 'model-actions' }, actions),
        h('span', { className: 'model-speed' },
          v && v.state === 'running' ? fmtSpeed(tk.speedKBs) : (v && v.waiting ? t('queue.waitingComfy') : '')),
        active ? h(ProgressBar, { percent: v.percent, indeterminate: v.state === 'running' && !!tk.waiting }) : null,
        tk && tk.error ? h('div', { className: 'error' }, tk.error) : null);
    });
    return h('div', { className: 'card' },
      h('div', { className: 'row' },
        h('div', { className: 'card-title' }, t('install.models.title')),
        h('span', { className: 'badge' }, lib ? (lib.totals.installed + ' / ' + lib.totals.count) : '…'),
        lib ? h('span', { className: 'hint' }, t('install.keeping') + ' · ' + fmtBytes(lib.totals.pendingBytes)) : null,
        h('span', { className: 'sp' }),
        h('button', { className: 'btn tiny', onClick: () => { loadLibrary(); loadQueue(); } }, t('common.refresh'))),
      h('div', { className: 'hint' }, t('install.models.hint')),
      h('div', { className: 'model-table' }, [head].concat(rows)));
  })();

  // ── ④ 自定义模型 ───────────────────────────────────────────
  const customFormFields = [];
  customFormFields.push(h('div', { className: 'field', key: 'src' },
    h('span', { className: 'label' }, t('custom.field.source')),
    h('select', { className: 'select narrow', value: form.source, onChange: (e) => setForm({ ...form, source: e.target.value }) },
      h('option', { value: 'upload' }, t('custom.source.upload')),
      h('option', { value: 'path' }, t('custom.source.path')),
      h('option', { value: 'url' }, t('custom.source.url')))));
  customFormFields.push(h('div', { className: 'field', key: 'name' },
    h('span', { className: 'label' }, t('custom.field.name')),
    h('input', { className: 'input', value: form.name, placeholder: t('custom.field.name.ph'), onChange: (e) => setForm({ ...form, name: e.target.value }) })));
  customFormFields.push(h('div', { className: 'field', key: 'file' },
    h('span', { className: 'label' }, t('custom.field.file')),
    h('input', { className: 'input', value: form.file, placeholder: 'my-model.safetensors', onChange: (e) => setForm({ ...form, file: e.target.value }) })));
  customFormFields.push(h('div', { className: 'field', key: 'dest' },
    h('span', { className: 'label' }, t('custom.field.dest')),
    h('select', { className: 'select narrow', value: form.dest, onChange: (e) => setForm({ ...form, dest: e.target.value }) },
      ((custom && custom.destDirs) || []).map((d2) => h('option', { key: d2, value: d2 }, d2)))));
  customFormFields.push(h('div', { className: 'field', key: 'route' },
    h('span', { className: 'label' }, t('custom.field.route')),
    h('select', {
      className: 'select narrow', value: form.route,
      onChange: (e) => {
        const r = rules[e.target.value] || null;
        setForm((f) => ({ ...f, route: e.target.value, encoder: r ? r.encoder : f.encoder, vae: r ? r.vae : f.vae }));
      },
    }, Object.keys(rules).map((k) => h('option', { key: k, value: k }, rules[k].label + '（' + rules[k].latentChannels + ' 通道 / ' + rules[k].encoderDim + ' 维）')))));
  customFormFields.push(h('div', { className: 'field', key: 'enc' },
    h('span', { className: 'label' }, t('custom.field.encoder')),
    h('input', { className: 'input', value: form.encoder, onChange: (e) => setForm({ ...form, encoder: e.target.value }) })));
  customFormFields.push(h('div', { className: 'field', key: 'vae' },
    h('span', { className: 'label' }, t('custom.field.vae')),
    h('input', { className: 'input', value: form.vae, onChange: (e) => setForm({ ...form, vae: e.target.value }) })));
  if (form.source === 'url') {
    customFormFields.push(h('div', { className: 'field wide', key: 'url' },
      h('span', { className: 'label' }, t('custom.field.url')),
      h('input', { className: 'input', value: form.url, placeholder: t('custom.field.url.ph'), onChange: (e) => setForm({ ...form, url: e.target.value }) })));
  }
  if (form.source === 'path') {
    customFormFields.push(h('div', { className: 'field wide', key: 'path' },
      h('span', { className: 'label' }, t('custom.field.path')),
      h('div', { className: 'row tight' },
        h('input', { className: 'input', value: form.srcPath, placeholder: t('custom.field.path.ph'), onChange: (e) => setForm({ ...form, srcPath: e.target.value }) }),
        h('button', { className: 'btn tiny', onClick: pickLocal }, t('custom.field.pick'))),
      h('span', { className: 'hint' }, t('custom.pickHint'))));
  }
  customFormFields.push(h('div', { className: 'field wide', key: 'note' },
    h('span', { className: 'label' }, t('custom.field.note')),
    h('input', { className: 'input', value: form.note, onChange: (e) => setForm({ ...form, note: e.target.value }) })));

  const customActions = [];
  if (form.source === 'upload') {
    customActions.push(h('button', {
      className: 'btn primary', key: 'up',
      disabled: uploadPct !== null,
      onClick: () => { if (fileRef.current) fileRef.current.click(); },
    }, uploadPct !== null ? t('custom.uploading') + ' ' + uploadPct + '%' : t('custom.field.upload')));
  }
  if (form.source === 'path') customActions.push(h('button', { className: 'btn primary', key: 'p', disabled: busy === 'custom:path', onClick: addFromPath }, t('custom.add')));
  if (form.source === 'url') customActions.push(h('button', { className: 'btn primary', key: 'u', onClick: addRegisterOnly }, t('custom.add')));
  customActions.push(h('input', {
    key: 'file',
    ref: fileRef, type: 'file', style: { display: 'none' },
    accept: '.safetensors,.ckpt,.pt,.pth,.gguf,.bin,.sft',
    onChange: (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadFile(f); e.target.value = ''; },
  }));
  customFormFields.push(h('div', { className: 'row', key: 'act' }, customActions));

  const customRows = (custom.items || []).map((c) => h('div', { className: 'custom-row', key: c.id },
    h('span', { className: 'custom-name' }, c.name),
    h('span', { className: 'muted' }, c.file + ' → ' + c.dest),
    h('span', { className: 'badge' }, c.route),
    h('span', { className: 'badge ' + (c.installed ? 'good' : 'warn') }, c.installed ? t('install.status.installed') : t('custom.fileMissing')),
    h('span', { className: 'sp' }),
    h('button', { className: 'btn tiny', onClick: () => renameCustom(c) }, t('custom.renaming')),
    h('button', { className: 'btn tiny', onClick: () => installModel(c.id) }, t('install.install')),
    h('button', { className: 'btn tiny', onClick: () => removeCustom(c, false) }, t('custom.remove')),
    h('button', { className: 'btn tiny danger', onClick: () => removeCustom(c, true) }, t('custom.removeFile'))));

  const customBlock = h('div', { className: 'card' },
    h('div', { className: 'card-title' }, t('custom.title')),
    h('div', { className: 'hint' }, t('custom.hint')),
    h('div', { className: 'custom-form' }, customFormFields),
    h('div', { className: 'custom-list' },
      (custom.items || []).length ? null : h('div', { className: 'muted' }, t('custom.list.empty')),
      customRows));

  const footerBlock = h('div', { className: 'card' },
    h('div', { className: 'card-title' }, t('install.faq.title')),
    h('ul', { className: 'install-faq' },
      h('li', null, t('install.faq.prereq')),
      h('li', null, t('install.faq.comfyui')),
      h('li', null, t('install.faq.llm'))),
    h('div', { className: 'hint' }, t('install.queue.note')));

  // ── 首次启动引导（需求 4）─────────────────────────────────
  // 向导页已移除：没有 ComfyUI 时直接在本页顶部给出**可点的引导**。
  // v1.3.0（需求修正）：一键只装「组件 + **默认模型**」—— 即后端给出的 `defaultModelIds`
  // （anima-turbo-v1.1.safetensors + 它自己声明的前置：qwen_3_06b_base 编码器 + qwen_image_vae）。
  // 其余 9 个权重留给用户自己在模型库里按需点。
  const needSetup = !(props.state && props.state.setup && props.state.setup.completed);
  const defaultModelIds = (lib && lib.defaultModelIds && lib.defaultModelIds.length)
    ? lib.defaultModelIds
    : ['anima-turbo-v1.1'];
  const defaultModelNames = defaultModelIds
    .map((id) => {
      const m = (lib && lib.items ? lib.items : []).find((x) => x.id === id);
      return m ? m.name : id;
    })
    .filter(Boolean);
  const firstRunBanner = needSetup
    ? h('div', { className: 'install-banner', 'data-dcp-first-run': '1' },
      h('div', { className: 'install-banner-title' }, t('install.firstRun.title')),
      h('div', { className: 'install-banner-body' }, t('install.firstRun.body')),
      h('div', { className: 'hint' }, t('install.firstRun.models', { list: defaultModelNames.join('、') })),
      h('div', { className: 'row tight' },
        h('button', {
          className: 'btn primary',
          disabled: busy === 'firstrun',
          'data-dcp-firstrun-go': '1',
          onClick: async () => {
            setBusy('firstrun');
            try {
              await post('/app/components/enqueue', { groups: ['prereq', 'comfyui'] });
              // autoPrereq 会把它自己的前置（编码器 / VAE）一起排上，不依赖前端硬编码
              await post('/app/models/enqueue', { ids: defaultModelIds, autoPrereq: true });
              toast(t('install.jobStarted'), 'ok');
              await loadQueue();
              await loadLibrary();
            } catch (e) { toast(t('toast.failed') + '：' + e.message, 'error'); } finally { setBusy(''); }
          },
        }, t('install.firstRun.oneClick')),
        h('button', {
          className: 'btn',
          onClick: () => installAllMissing(),
        }, t('install.fixAll')),
        h('span', { className: 'hint' }, t('install.firstRun.hint'))))
    : null;

  return h('div', { className: 'page' },
    h('h1', { className: 'page-title' }, t('install.title')),
    h('p', { className: 'page-sub' }, t('install.intro')),
    firstRunBanner,
    componentsBlock,
    queueBlock,
    modelsBlock,
    customBlock,
    footerBlock);
}
