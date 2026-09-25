// wizard.js —— 首次运行向导（M4）：选择内嵌/外接 → 获取 ComfyUI → 选模型 → 画师清单/许可 → 完成。
// 长任务统一走后端 job + SSE（见 job-view.js），所有失败都有明确文案，不静默。
'use strict';

import { JobProgress } from '../job-view.js';

const h = React.createElement;
const { useState, useEffect } = React;

export default function WizardPage(props) {
  const { api, post, t, state, settings, refresh, toast } = props;
  const [mode, setMode] = useState((settings && settings.comfy && settings.comfy.mode) || 'embedded');
  const [externalDir, setExternalDir] = useState((settings && settings.comfy && settings.comfy.dir) || '');
  const [kind, setKind] = useState('portable');
  const [srcPath, setSrcPath] = useState('');
  const [modelsFrom, setModelsFrom] = useState('');
  const [copyMode, setCopyMode] = useState('link');
  const [plan, setPlan] = useState(null);
  const [tier, setTier] = useState('minimal');
  const [selected, setSelected] = useState([]);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [detect, setDetect] = useState(null);

  const loadPlan = async (tierName) => {
    try {
      const p = await api('/app/setup/plan?mode=' + encodeURIComponent(mode) + '&sel=' + encodeURIComponent(tierName || tier) + (externalDir ? '&dir=' + encodeURIComponent(externalDir) : ''));
      setPlan(p);
      if (!selected.length) setSelected((p.selected || []).map((m) => m.id));
    } catch (e) { toast(e.message, 'error'); }
  };

  useEffect(() => { loadPlan(tier); }, [mode]);

  // 切走再切回向导时把**正在跑的安装任务**重新挂上（本轮修的真实缺陷：以前进度只在页面里，
  // 一离开就"不再显示安装进程"——任务其实一直在服务端跑）。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api('/app/jobs?kind=setup');
        // `running` 是一个任务对象（无则 null）；这里同时兼容"数组"写法，避免契约演进时静默失效。
        const arr = Array.isArray(r && r.running) ? r.running : (r && r.running ? [r.running] : []);
        const j = arr[0] || ((r && r.items) || []).find((x) => x.state === 'running');
        if (alive && j && j.id) setJobId(j.id);
      } catch { /* 离线时忽略 */ }
    })();
    return () => { alive = false; };
  }, [api]);
  useEffect(() => {
    if (!plan) return;
    const byTier = { minimal: ['minimal'], standard: ['minimal', 'standard'], full: ['minimal', 'standard', 'full'] }[tier] || [];
    setSelected(plan.models.filter((m) => byTier.includes(m.tier)).map((m) => m.id));
  }, [tier, plan && plan.modelsDir]);

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id)));

  async function run() {
    try {
      const body = {
        mode,
        comfySource: { kind: mode === 'external' ? 'external' : kind, path: kind === 'portable' || kind === 'skip' || kind === 'git' ? '' : srcPath },
        externalDir,
        models: selected,
        copyMode,
        modelsFrom: modelsFrom ? { dir: modelsFrom } : undefined,
      };
      const r = await post('/app/setup/run', body);
      setJobId(r.jobId);
      setResult(null);
      toast(t('toast.jobStarted'), 'ok');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function detectDir() {
    try {
      const r = await api('/app/comfy/detect?dir=' + encodeURIComponent(mode === 'external' ? externalDir : ''));
      setDetect(r);
      toast(r.ok ? t('settings.comfy.detected') : (r.error || t('settings.comfy.detectFailed')), r.ok ? 'ok' : 'error');
    } catch (e) { toast(e.message, 'error'); }
  }

  async function launch() {
    try {
      const r = await post('/app/comfy/launch');
      toast(r.online ? t('shell.online') : (r.error || t('shell.offline')), r.online ? 'ok' : 'error');
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function stopComfy() {
    try {
      const r = await post('/app/comfy/stop');
      toast(r.stopped ? t('shell.offline') : (r.error || r.note || ''), r.stopped ? 'ok' : 'warn');
      refresh();
    } catch (e) { toast(e.message, 'error'); }
  }

  const totalBytes = plan ? plan.models.filter((m) => selected.includes(m.id)).reduce((a, m) => a + (m.installed ? 0 : m.bytes), 0) : 0;

  const step = (n, title, body, cls) => h('div', { className: 'step' + (cls ? ' ' + cls : '') },
    h('div', { className: 'step-idx' }, String(n)),
    h('div', { className: 'step-body' }, h('div', { style: { fontWeight: 600 } }, title), body));

  return h('div', { className: 'page' },
    h('h1', { className: 'page-title' }, t('wizard.title')),
    h('p', { className: 'page-sub' }, t('wizard.intro')),

    h('div', { className: 'steps' },
      step(1, t('wizard.mode.title'),
        h('div', { className: 'col' },
          h('div', { className: 'row' },
            h('button', { className: 'btn' + (mode === 'embedded' ? ' primary' : ''), onClick: () => { setMode('embedded'); loadPlan(tier); } }, t('wizard.mode.embedded')),
            h('button', { className: 'btn' + (mode === 'external' ? ' primary' : ''), onClick: () => { setMode('external'); loadPlan(tier); } }, t('wizard.mode.external'))),
          h('div', { className: 'hint' }, mode === 'embedded' ? t('wizard.mode.embedded.desc') : t('wizard.mode.external.desc')),
          mode === 'external'
            ? h('div', { className: 'row' },
              h('input', { className: 'input', value: externalDir, placeholder: t('settings.comfy.dir.placeholder'), onChange: (e) => setExternalDir(e.target.value) }),
              h('button', { className: 'btn tiny', onClick: detectDir }, t('settings.comfy.detect')))
            : null,
          detect ? h('div', { className: detect.ok ? 'ok' : 'error' }, detect.ok ? t('wizard.externalOk') + '：' + detect.modelsDir : detect.error) : null),
        state.setup && state.setup.completed ? 'done' : ''),

      mode === 'embedded' ? step(2, t('wizard.step.comfyui'),
        h('div', { className: 'col' },
          h('div', { className: 'row' },
            h('select', { className: 'select option-dark narrow', value: kind, onChange: (e) => setKind(e.target.value) },
              h('option', { value: 'portable' }, t('wizard.source.portable')),
              h('option', { value: 'archive' }, t('wizard.source.archive')),
              h('option', { value: 'dir' }, t('wizard.source.dir')),
              h('option', { value: 'git' }, t('wizard.source.git')),
              h('option', { value: 'skip' }, t('wizard.source.skip')))),
          (kind === 'archive' || kind === 'dir')
            ? h('input', { className: 'input', value: srcPath, placeholder: t('wizard.source.path.placeholder'), onChange: (e) => setSrcPath(e.target.value) })
            : null,
          h('div', { className: 'row' },
            h('span', { className: 'hint' }, t('wizard.copyMode')),
            h('button', { className: 'btn tiny' + (copyMode === 'link' ? ' primary' : ''), onClick: () => setCopyMode('link') }, t('wizard.copyMode.link')),
            h('button', { className: 'btn tiny' + (copyMode === 'copy' ? ' primary' : ''), onClick: () => setCopyMode('copy') }, t('wizard.copyMode.copy'))),
          h('div', { className: 'field' },
            h('span', { className: 'label' }, t('wizard.modelsFrom')),
            h('input', { className: 'input', value: modelsFrom, placeholder: t('settings.comfy.dir.placeholder'), onChange: (e) => setModelsFrom(e.target.value) }),
            h('span', { className: 'hint' }, t('wizard.modelsFrom.hint'))))) : null,

      step(mode === 'embedded' ? 3 : 2, t('wizard.step.models'),
        h('div', { className: 'col' },
          h('div', { className: 'row' },
            ['minimal', 'standard', 'full'].map((x) => h('button', { key: x, className: 'btn tiny' + (tier === x ? ' primary' : ''), onClick: () => setTier(x) }, t('wizard.models.tier') + ': ' + x)),
            h('span', { className: 'sp' }),
            h('span', { className: 'hint' }, t('wizard.models.total') + '：' + (totalBytes / 1073741824).toFixed(2) + ' GB')),
          h('div', { className: 'hint' }, t('wizard.licenseNote')),
          plan
            ? h('div', { className: 'model-pick' }, plan.models.map((m) => h('label', { className: 'list-row', key: m.id },
              h('input', { type: 'checkbox', checked: selected.includes(m.id), onChange: () => toggle(m.id) }),
              h('span', { className: 'name' }, m.file),
              h('span', { className: 'count' }, (m.bytes / 1073741824).toFixed(2) + ' GB'),
              h('span', { className: 'count' }, m.license),
              m.installed ? h('span', { className: 'ok' }, t('common.installed')) : null)))
            : h('div', { className: 'muted' }, t('common.loading')))),

      step(mode === 'embedded' ? 4 : 3, t('wizard.step.artists'), h('div', { className: 'hint' }, t('wizard.artists.hint'))),
      step(mode === 'embedded' ? 5 : 4, t('wizard.step.llm'), h('div', { className: 'hint' }, t('wizard.llm.hint')))),

    h('div', { className: 'row', style: { marginTop: 14 } },
      h('button', { className: 'btn primary', disabled: !!jobId && !result, onClick: run }, t('wizard.run')),
      h('span', { className: 'sp' }),
      state.comfy.online
        ? h('button', { className: 'btn danger', onClick: stopComfy }, t('comfy.stop'))
        : h('button', { className: 'btn', onClick: launch }, t('comfy.start'))),

    jobId ? h(JobProgress, {
      jobId,
      onDone: (r) => {
        setResult(r || {});
        toast(t('wizard.finished'), 'ok');
        refresh();
      },
      onFail: (e) => { setResult({ error: e.message }); toast(t('wizard.failed') + '：' + e.message, 'error'); },
    }) : null,

    result ? h('div', { className: result.error ? 'error' : 'ok' },
      result.error ? result.error : t('wizard.finished')) : null,

    h('div', { className: 'card', style: { marginTop: 12 } },
      h('div', { className: 'card-title' }, t('wizard.log')),
      h('div', { className: 'hint' }, t('wizard.sideNote'))));
}
