// settings.js —— 设置页（F5）：语言、ComfyUI 内嵌/外接、局域网监听、镜像与下载阈值、
// LLM 上下文条数、离线自检。窗口行为两项按需求隐藏（本独立版是纯浏览器页面，没有托盘进程），
// 页面上明确说明原因。
'use strict';

const h = React.createElement;
const { useState, useEffect } = React;

function Field(props) {
  const { label, hint, children } = props;
  return h('div', { className: 'field' },
    label ? h('span', { className: 'label' }, label) : null,
    children,
    hint ? h('span', { className: 'hint' }, hint) : null);
}

export default function SettingsPage(props) {
  const { api, put, post, t, state, settings, refresh, toast } = props;
  const s = settings || {};
  const [comfy, setComfy] = useState(s.comfy || { mode: 'embedded', dir: '', port: 8188, autoStart: false, extraArgs: [] });
  const [listen, setListen] = useState(s.listen || { host: '127.0.0.1', port: 8788, lan: false });
  const [download, setDownload] = useState(s.download || {});
  const [llm, setLlm] = useState(s.llm || { contextMessages: 5, port: 8199, ctxSize: 8192 });
  const [apiCfg, setApiCfg] = useState((s.llm && s.llm.api) || { baseUrl: '', apiKey: '', model: '', temperature: 0.6, maxTokens: 4096, reasoning: 'off', retries: 2 });
  const [apiModels, setApiModels] = useState([]);
  const [apiTest, setApiTest] = useState('');
  const [lang, setLang] = useState(s.lang || 'zh');
  const [detect, setDetect] = useState(null);
  const [checks, setChecks] = useState(state && state.selfcheck ? state.selfcheck : null);
  const [busy, setBusy] = useState(false);
  // 镜像测速（设置页 → 下载）：默认测最小档生图权重的官方直链，各源下 100 MiB。
  const [speedUrl, setSpeedUrl] = useState('https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/diffusion_models/anima-turbo-v1.1.safetensors');
  const [speedMib, setSpeedMib] = useState(100);
  const [speed, setSpeed] = useState(null);
  const [speedBusy, setSpeedBusy] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setComfy(settings.comfy || {});
    setListen(settings.listen || {});
    setDownload(settings.download || {});
    setLlm(settings.llm || {});
    setApiCfg((settings.llm && settings.llm.api) || { baseUrl: '', apiKey: '', model: '', temperature: 0.6, maxTokens: 4096, reasoning: 'off', retries: 2 });
    setLang(settings.lang || 'zh');
  }, [settings]);

  /** 测试外接 API：先存一次配置（否则后端测的是旧值），再调 /app/llm/api/test。 */
  async function testApi() {
    setApiTest(t('common.loading'));
    try {
      await put('/app/settings', { llm: { api: { ...apiCfg, temperature: Number(apiCfg.temperature) || 0.6, maxTokens: Number(apiCfg.maxTokens) || 4096 } } });
      const r = await post('/app/llm/api/test', {});
      setApiTest(t('settings.llm.apiTestOk') + ` · ${r.ms}ms · ${r.model}`
        + (r.models && r.models.length ? ` · ${r.models.length} models` : '')
        + (r.sample ? ` · "${String(r.sample).slice(0, 30)}"` : ''));
      // 顺手把服务端模型清单灌进下拉框，省得用户手打模型名。
      if (r.models && r.models.length) setApiModels(r.models);
      if (r.modelKnown === false) toast(t('settings.llm.apiModelUnknown') + '：' + r.model, 'error');
      else toast(t('settings.llm.apiTestOk'), 'ok');
    } catch (e) {
      setApiTest(t('settings.llm.apiTestFail') + '：' + e.message);
      toast(t('settings.llm.apiTestFail') + '：' + e.message, 'error');
    }
  }

  /** 只拉模型清单（不消耗生成额度）。 */
  async function fetchApiModels() {
    setApiTest(t('common.loading'));
    try {
      const r = await post('/app/llm/api/models', {});
      const ids = (r.items || []).map((m) => m.id);
      setApiModels(ids);
      setApiTest(t('settings.llm.apiModelsOk') + ` · ${ids.length}`);
      if (ids.length && !ids.includes(apiCfg.model)) toast(t('settings.llm.apiModelUnknown') + '：' + (apiCfg.model || '(空)'), 'error');
    } catch (e) { setApiTest(t('settings.llm.apiTestFail') + '：' + e.message); toast(e.message, 'error'); }
  }

  /** 常见服务预设（社区客户端的常规做法：一键填好 baseUrl + 模型名）。 */
  function apiPreset(which) {
    if (which === 'deepseek') setApiCfg({ ...apiCfg, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });
    else if (which === 'local') setApiCfg({ ...apiCfg, baseUrl: 'http://127.0.0.1:8199/v1', model: 'local' });
    else if (which === 'openai') setApiCfg({ ...apiCfg, baseUrl: 'https://api.openai.com/v1' });
    else if (which === 'siliconflow') setApiCfg({ ...apiCfg, baseUrl: 'https://api.siliconflow.cn/v1' });
    else if (which === 'dashscope') setApiCfg({ ...apiCfg, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' });
  }

  /** 国内优选：ModelScope + aifasthub + hf-mirror + 实测可用的 GitHub 代理（全部实测过）。 */
  function presetCn() {
    setDownload({
      ...download,
      hfMirror: 'https://hf-mirror.com',
      aifasthub: 'https://aifasthub.com',
      modelscope: 'https://modelscope.cn',
      useModelScope: true,
      startDeadlineMs: 10000,
      stallDeadlineMs: 15000,
      stallKBs: 30,
      hfMirrors: '',
      nodeMirrors: '',
      jsdelivrMirrors: '',
      githubProxies: ['https://gh-proxy.com/', 'https://down.npee.cn/?{url}', 'https://ghproxy.net/', 'https://ghfast.top/'],
    });
    toast(t('settings.download.presetCn'), 'ok');
  }

  async function save() {
    setBusy(true);
    try {
      const proxies = Array.isArray(download.githubProxies)
        ? download.githubProxies
        : String(download.githubProxiesText || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      // 镜像梯队：多行文本框 → 数组（空数组 = 用后端按基地址组合出来的默认梯队）
      const lines = (v) => (typeof v === 'string' ? v.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : (Array.isArray(v) ? v : []));
      await put('/app/settings', {
        lang,
        comfy: { ...comfy, port: Number(comfy.port) || 8188 },
        listen: { ...listen, lan: !!listen.lan, port: Number(listen.port) || 8788 },
        download: {
          officialTimeoutMs: Number(download.officialTimeoutMs) || 10000,
          startDeadlineMs: Number(download.startDeadlineMs) || 10000,
          stallDeadlineMs: Number(download.stallDeadlineMs) || 15000,
          slowThresholdKBs: Number(download.slowThresholdKBs) || 200,
          slowWindowMs: Number(download.slowWindowMs) || 30000,
          stallKBs: Number(download.stallKBs) || 30,
          hfMirror: download.hfMirror || 'https://hf-mirror.com',
          aifasthub: download.aifasthub || 'https://aifasthub.com',
          modelscope: download.modelscope || 'https://modelscope.cn',
          useModelScope: download.useModelScope !== false,
          hfMirrors: lines(download.hfMirrors),
          nodeMirrors: lines(download.nodeMirrors),
          jsdelivrMirrors: lines(download.jsdelivrMirrors),
          pipIndex: download.pipIndex || '',
          githubProxies: proxies,
        },
        llm: {
          provider: llm.provider === 'api' ? 'api' : 'local',
          contextMessages: Math.max(0, Math.min(20, Number(llm.contextMessages) || 0)),
          defaultModel: llm.defaultModel || '',
          port: Number(llm.port) || 8199,
          ctxSize: Number(llm.ctxSize) || 8192,
          maxTokens: Math.max(64, Math.min(8192, Number(llm.maxTokens) || 512)),
          gpuLayers: llm.gpuLayers === undefined ? 99 : Number(llm.gpuLayers),
          characterRepair: llm.characterRepair !== false,
          sendContext: llm.sendContext === true,
          keepMessages: Math.max(2, Math.min(200, Number(llm.keepMessages) || 40)),
          api: {
            baseUrl: apiCfg.baseUrl || '',
            apiKey: apiCfg.apiKey || '',
            model: apiCfg.model || '',
            temperature: Number(apiCfg.temperature) || 0.6,
            maxTokens: Math.max(64, Math.min(393216, Number(apiCfg.maxTokens) || 4096)),
            reasoning: ['off', 'low', 'high', 'max'].includes(apiCfg.reasoning) ? apiCfg.reasoning : 'off',
            retries: Math.max(0, Math.min(5, apiCfg.retries === undefined ? 2 : Number(apiCfg.retries))),
          },
        },
      });
      toast(t('settings.saved'), 'ok');
      await refresh();
      const st = await api('/app/selfcheck');
      setChecks(st);
    } catch (e) {
      toast(t('toast.failed') + '：' + e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doDetect() {
    try {
      const r = await api('/app/comfy/detect?dir=' + encodeURIComponent(comfy.dir || ''));
      setDetect(r);
      toast(r.ok ? t('settings.comfy.detected') : t('settings.comfy.detectFailed') + '：' + (r.error || ''), r.ok ? 'ok' : 'error');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function probeMirror() {
    try {
      const r = await api('/app/download/probe?url=' + encodeURIComponent('https://huggingface.co/'));
      const lines = (r.results || []).map((x) => (x.source === 'official' ? t('download.probe.official') : t('download.probe.mirror') + ' ' + x.via)
        + '：' + (x.ok ? t('download.probe.ok') + ' ' + x.status + ' / ' + x.ms + 'ms' : t('download.probe.fail') + ' ' + (x.error || x.status)));
      toast(lines.join(' ｜ '), 'info');
    } catch (e) { toast(e.message, 'error'); }
  }

  /** 镜像测速：真的各下一段（默认 100 MiB），报告每个来源的速度 —— 用户要求的那条规则的现场验证。 */
  async function runSpeedTest() {
    setSpeedBusy(true);
    setSpeed(null);
    try {
      const r = await api('/app/download/speedtest?mib=' + (speedMib || 100) + '&url=' + encodeURIComponent(speedUrl));
      setSpeed(r);
      toast(t('settings.speed.done') + '：' + r.usable + '/' + r.total, r.usable ? 'ok' : 'error');
    } catch (e) { toast(e.message, 'error'); } finally { setSpeedBusy(false); }
  }

  const proxyText = Array.isArray(download.githubProxies) ? download.githubProxies.join('\n') : (download.githubProxiesText || '');
  const lanToken = (state && state.listen && state.listen.token) || (s.listen && s.listen.token) || '';
  const issues = (checks && checks.issues) || [];

  return h('div', { className: 'page' },
    h('h1', { className: 'page-title' }, t('settings.title')),
    h('p', { className: 'page-sub' }, t('settings.subtitle')),

    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('settings.lang')),
      h('div', { className: 'row' },
        h('button', { className: 'btn' + (lang === 'zh' ? ' primary' : ''), onClick: () => setLang('zh') }, t('settings.lang.zh')),
        h('button', { className: 'btn' + (lang === 'en' ? ' primary' : ''), onClick: () => setLang('en') }, t('settings.lang.en')),
        h('span', { className: 'hint' }, t('settings.restartHint')))),

    h('div', { className: 'settings-grid' },
      h('div', { className: 'card' },
        h('div', { className: 'card-title' }, t('settings.comfy.title')),
        h(Field, { label: t('settings.comfy.mode') },
          h('select', { className: 'select option-dark', value: comfy.mode, onChange: (e) => setComfy({ ...comfy, mode: e.target.value }) },
            h('option', { value: 'embedded' }, t('settings.comfy.mode.embedded')),
            h('option', { value: 'external' }, t('settings.comfy.mode.external')))),
        comfy.mode === 'external'
          ? h(Field, { label: t('settings.comfy.dir'), hint: t('settings.comfy.dir.hint') },
            h('input', { className: 'input', value: comfy.dir || '', placeholder: t('settings.comfy.dir.placeholder'), onChange: (e) => setComfy({ ...comfy, dir: e.target.value }) }),
            h('div', { className: 'row' }, h('button', { className: 'btn tiny', onClick: doDetect }, t('settings.comfy.detect'))))
          : h('div', { className: 'hint' }, t('settings.comfy.mode.embedded') + ' → ' + ((state && state.paths && state.paths.comfyEmbedded) || 'runtime/comfyui')),
        detect ? h('div', { className: detect.ok ? 'ok' : 'error' },
          detect.ok
            ? t('settings.comfy.layout') + '：' + detect.layout + ' · ' + detect.modelsDir
            : (detect.error || '')) : null,
        h(Field, { label: t('settings.comfy.port') },
          h('input', { className: 'input narrow', type: 'number', min: 1, max: 65535, value: comfy.port, onChange: (e) => setComfy({ ...comfy, port: e.target.value }) })),
        h('label', { className: 'check' },
          h('input', { type: 'checkbox', checked: !!comfy.autoStart, onChange: (e) => setComfy({ ...comfy, autoStart: e.target.checked }) }),
          t('settings.comfy.autoStart'))),

      h('div', { className: 'card' },
        h('div', { className: 'card-title' }, t('settings.listen.title')),
        h(Field, { label: t('settings.listen.port') },
          h('input', { className: 'input narrow', type: 'number', value: listen.port, onChange: (e) => setListen({ ...listen, port: e.target.value }) })),
        h('label', { className: 'check' },
          h('input', { type: 'checkbox', checked: !!listen.lan, onChange: (e) => setListen({ ...listen, lan: e.target.checked }) }),
          t('settings.listen.lan')),
        h('div', { className: 'hint' }, t('settings.listen.lan.hint')),
        lanToken ? h('div', { className: 'mono' }, 'token: ' + lanToken) : null),

      h('div', { className: 'card' },
        h('div', { className: 'card-title' }, t('settings.download.title')),
        h(Field, { label: t('settings.download.hfMirror') },
          h('input', { className: 'input', value: download.hfMirror || '', onChange: (e) => setDownload({ ...download, hfMirror: e.target.value }) })),
        h(Field, { label: t('settings.download.aifasthub'), hint: t('settings.download.aifasthub.hint') },
          h('input', { className: 'input', value: download.aifasthub || '', onChange: (e) => setDownload({ ...download, aifasthub: e.target.value }) })),
        h(Field, { label: t('settings.download.hfMirrors'), hint: t('settings.download.hfMirrors.hint') },
          h('textarea', {
            className: 'textarea', rows: 4,
            value: Array.isArray(download.hfMirrors) ? download.hfMirrors.join('\n') : (download.hfMirrors || ''),
            placeholder: (Array.isArray(download.hfMirrors) && download.hfMirrors.length) ? '' : t('settings.download.hfMirrors.auto'),
            onChange: (e) => setDownload({ ...download, hfMirrors: e.target.value }),
          })),
        h(Field, { label: t('settings.download.ghProxies'), hint: t('settings.download.ghProxies.hint') },
          h('textarea', {
            className: 'textarea', value: proxyText,
            onChange: (e) => setDownload({ ...download, githubProxies: e.target.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) }),
          })),
        h(Field, { label: t('settings.download.nodeMirrors'), hint: t('settings.download.nodeMirrors.hint') },
          h('textarea', {
            className: 'textarea', rows: 3,
            value: Array.isArray(download.nodeMirrors) ? download.nodeMirrors.join('\n') : (download.nodeMirrors || ''),
            placeholder: (Array.isArray(download.nodeMirrors) && download.nodeMirrors.length) ? '' : t('settings.download.hfMirrors.auto'),
            onChange: (e) => setDownload({ ...download, nodeMirrors: e.target.value }),
          })),
        h(Field, { label: t('settings.download.jsdelivrMirrors'), hint: t('settings.download.jsdelivrMirrors.hint') },
          h('textarea', {
            className: 'textarea', rows: 3,
            value: Array.isArray(download.jsdelivrMirrors) ? download.jsdelivrMirrors.join('\n') : (download.jsdelivrMirrors || ''),
            placeholder: (Array.isArray(download.jsdelivrMirrors) && download.jsdelivrMirrors.length) ? '' : t('settings.download.hfMirrors.auto'),
            onChange: (e) => setDownload({ ...download, jsdelivrMirrors: e.target.value }),
          })),
        h('div', { className: 'row' },
          h(Field, { label: t('settings.download.officialTimeout') },
            h('input', { className: 'input narrow', type: 'number', value: download.officialTimeoutMs || 10000, onChange: (e) => setDownload({ ...download, officialTimeoutMs: e.target.value }) })),
          h(Field, { label: t('settings.download.startDeadline'), hint: t('settings.download.startDeadline.hint') },
            h('input', { className: 'input narrow', type: 'number', value: download.startDeadlineMs || 10000, onChange: (e) => setDownload({ ...download, startDeadlineMs: e.target.value }) })),
          h(Field, { label: t('settings.download.stallDeadline') },
            h('input', { className: 'input narrow', type: 'number', value: download.stallDeadlineMs || 15000, onChange: (e) => setDownload({ ...download, stallDeadlineMs: e.target.value }) }))),
        h('div', { className: 'row' },
          h(Field, { label: t('settings.download.slowThreshold') },
            h('input', { className: 'input narrow', type: 'number', value: download.slowThresholdKBs || 200, onChange: (e) => setDownload({ ...download, slowThresholdKBs: e.target.value }) })),
          h(Field, { label: t('settings.download.slowWindow') },
            h('input', { className: 'input narrow', type: 'number', value: download.slowWindowMs || 30000, onChange: (e) => setDownload({ ...download, slowWindowMs: e.target.value }) })),
          h(Field, { label: t('settings.download.stall'), hint: t('settings.download.stall.hint') },
            h('input', { className: 'input narrow', type: 'number', value: download.stallKBs === undefined ? 30 : download.stallKBs, onChange: (e) => setDownload({ ...download, stallKBs: e.target.value }) }))),
        h('div', { className: 'row' },
          h(Field, { label: t('settings.download.modelscope') },
            h('input', { className: 'input', value: download.modelscope || 'https://modelscope.cn', onChange: (e) => setDownload({ ...download, modelscope: e.target.value }) })),
          h('label', { className: 'check' },
            h('input', { type: 'checkbox', checked: download.useModelScope !== false, onChange: (e) => setDownload({ ...download, useModelScope: e.target.checked }) }),
            t('settings.download.useModelScope'))),
        h('div', { className: 'row' },
          h('button', { className: 'btn tiny primary', onClick: presetCn }, t('settings.download.presetCn')),
          h('span', { className: 'hint' }, t('settings.download.presetCn.hint'))),

        // ── 镜像测速：真的各下一段（默认 100 MiB），报告每个来源的速度 ──
        h('div', { className: 'speed-box' },
          h('div', { className: 'card-title' }, t('settings.speed.title')),
          h('div', { className: 'hint' }, t('settings.speed.hint')),
          h('div', { className: 'row' },
            h('input', { className: 'input', value: speedUrl, onChange: (e) => setSpeedUrl(e.target.value) }),
            h('select', { className: 'select option-dark narrow', value: speedMib, onChange: (e) => setSpeedMib(Number(e.target.value)) },
              h('option', { value: 5 }, '5 MiB'),
              h('option', { value: 20 }, '20 MiB'),
              h('option', { value: 100 }, '100 MiB')),
            h('button', { className: 'btn tiny', disabled: speedBusy, onClick: runSpeedTest }, speedBusy ? t('common.loading') : t('settings.speed.run'))),
          speed
            ? h('table', { className: 'speed-table' },
              h('thead', null, h('tr', null,
                h('th', null, t('settings.speed.source')),
                h('th', null, t('settings.speed.firstByte')),
                h('th', null, t('settings.speed.got')),
                h('th', null, t('settings.speed.speed')),
                h('th', null, t('settings.speed.verdict')))),
              h('tbody', null, speed.items.map((it, i) => h('tr', { key: i, className: (it.ok || it.partial) ? 'ok-row' : 'bad-row' },
                h('td', null, it.via || it.source),
                h('td', null, it.firstByteMs ? it.firstByteMs + ' ms' : '-'),
                h('td', null, it.gotBytes ? (it.gotBytes / 1048576).toFixed(1) + ' MiB' : '0'),
                h('td', null, it.mbps ? it.mbps + ' MB/s' : '-'),
                h('td', null, it.ok ? t('settings.speed.pass') : (it.partial ? t('settings.speed.slow') : (it.error || t('settings.speed.fail'))))))))
            : null),
        h('div', { className: 'row' },
          h('button', { className: 'btn tiny', onClick: probeMirror }, t('settings.probe')),
          h('span', { className: 'hint' }, 'pip: ' + (download.pipIndex || '')))),

      h('div', { className: 'card' },
        h('div', { className: 'card-title' }, t('settings.llm.title')),
        h(Field, { label: t('settings.llm.provider'), hint: t('llm.provider.hint') },
          h('select', {
            className: 'select option-dark', value: llm.provider || 'local',
            onChange: (e) => setLlm({ ...llm, provider: e.target.value }),
          },
            h('option', { value: 'local' }, t('llm.provider.local')),
            h('option', { value: 'api' }, t('llm.provider.api')))),
        (llm.provider === 'api')
          ? h('div', { className: 'col' },
            h('div', { className: 'row tight' },
              h('span', { className: 'hint' }, t('settings.llm.apiPreset')),
              h('button', { className: 'btn tiny', onClick: () => apiPreset('deepseek') }, 'DeepSeek'),
              h('button', { className: 'btn tiny', onClick: () => apiPreset('local') }, t('settings.llm.apiPreset.local')),
              h('button', { className: 'btn tiny', onClick: () => apiPreset('siliconflow') }, 'SiliconFlow'),
              h('button', { className: 'btn tiny', onClick: () => apiPreset('dashscope') }, 'DashScope'),
              h('button', { className: 'btn tiny', onClick: () => apiPreset('openai') }, 'OpenAI')),
            h(Field, { label: t('settings.llm.apiBase'), hint: t('settings.llm.apiBase.hint') },
              h('input', { className: 'input', value: apiCfg.baseUrl || '', placeholder: 'https://api.deepseek.com', onChange: (e) => setApiCfg({ ...apiCfg, baseUrl: e.target.value }) })),
            h(Field, { label: t('settings.llm.apiKey'), hint: t('settings.llm.apiKey.hint') },
              h('input', { className: 'input', type: 'password', value: apiCfg.apiKey || '', onChange: (e) => setApiCfg({ ...apiCfg, apiKey: e.target.value }) })),
            h('div', { className: 'row' },
              h(Field, { label: t('settings.llm.apiModel'), hint: apiModels.length ? t('settings.llm.apiModel.hint') : undefined },
                apiModels.length
                  ? h('select', { className: 'select option-dark', value: apiCfg.model || '', onChange: (e) => setApiCfg({ ...apiCfg, model: e.target.value }) },
                    apiModels.map((m) => h('option', { key: m, value: m }, m)))
                  : h('input', { className: 'input', value: apiCfg.model || '', placeholder: 'deepseek-flash', onChange: (e) => setApiCfg({ ...apiCfg, model: e.target.value }) })),
              h(Field, { label: t('settings.llm.apiTemperature') },
                h('input', { className: 'input narrow', type: 'number', min: 0, max: 2, step: 0.1, value: apiCfg.temperature === undefined ? 0.6 : apiCfg.temperature, onChange: (e) => setApiCfg({ ...apiCfg, temperature: e.target.value }) })),
              h(Field, { label: t('settings.llm.apiMaxTokens'), hint: t('settings.llm.apiMaxTokens.hint') },
                h('input', { className: 'input narrow', type: 'number', min: 64, max: 393216, value: apiCfg.maxTokens === undefined ? 4096 : apiCfg.maxTokens, onChange: (e) => setApiCfg({ ...apiCfg, maxTokens: e.target.value }) }))),
            h('div', { className: 'row' },
              h(Field, { label: t('settings.llm.apiReasoning'), hint: t('settings.llm.apiReasoning.hint') },
                h('select', { className: 'select option-dark', value: ['off', 'low', 'high', 'max'].includes(apiCfg.reasoning) ? apiCfg.reasoning : 'off', onChange: (e) => setApiCfg({ ...apiCfg, reasoning: e.target.value }) },
                  h('option', { value: 'off' }, t('settings.llm.apiReasoning.off')),
                  h('option', { value: 'low' }, t('settings.llm.apiReasoning.low')),
                  h('option', { value: 'high' }, t('settings.llm.apiReasoning.high')),
                  h('option', { value: 'max' }, t('settings.llm.apiReasoning.max')))),
              h(Field, { label: t('settings.llm.apiRetries') },
                h('input', { className: 'input narrow', type: 'number', min: 0, max: 5, value: apiCfg.retries === undefined ? 2 : apiCfg.retries, onChange: (e) => setApiCfg({ ...apiCfg, retries: e.target.value }) }))),
            h('div', { className: 'row' },
              h('button', { className: 'btn tiny primary', onClick: testApi }, t('settings.llm.apiTest')),
              h('button', { className: 'btn tiny', onClick: fetchApiModels }, t('settings.llm.apiModels')),
              h('span', { className: 'hint' }, apiTest || '')),
            h('div', { className: 'hint' }, t('settings.llm.apiHint')))
          : null,
        h(Field, { label: t('settings.llm.contextMessages'), hint: t('settings.llm.contextHint') },
          h('input', { className: 'input narrow', type: 'number', min: 0, max: 20, value: llm.contextMessages, onChange: (e) => setLlm({ ...llm, contextMessages: e.target.value }) })),
        // 上下文策略：界面保留历史（可整段复制），是否把历史发给模型由这里决定
        h('label', { className: 'check' },
          h('input', { type: 'checkbox', checked: llm.sendContext === true, onChange: (e) => setLlm({ ...llm, sendContext: e.target.checked }) }),
          t('settings.llm.sendContext')),
        h('div', { className: 'hint' }, t('settings.llm.sendContext.hint')),
        h(Field, { label: t('settings.llm.keepMessages') },
          h('input', { className: 'input narrow', type: 'number', min: 2, max: 200, value: llm.keepMessages === undefined ? 40 : llm.keepMessages, onChange: (e) => setLlm({ ...llm, keepMessages: e.target.value }) })),
        h(Field, { label: t('settings.llm.defaultModel') },
          h('input', { className: 'input', value: llm.defaultModel || '', onChange: (e) => setLlm({ ...llm, defaultModel: e.target.value }) })),
        h('div', { className: 'row' },
          h(Field, { label: t('settings.llm.port') },
            h('input', { className: 'input narrow', type: 'number', value: llm.port, onChange: (e) => setLlm({ ...llm, port: e.target.value }) })),
          h(Field, { label: t('settings.llm.ctxSize') },
            h('input', { className: 'input narrow', type: 'number', value: llm.ctxSize, onChange: (e) => setLlm({ ...llm, ctxSize: e.target.value }) })),
          h(Field, { label: t('settings.llm.maxTokens'), hint: t('settings.llm.maxTokens.hint') },
            h('input', { className: 'input narrow', type: 'number', min: 64, max: 8192, value: llm.maxTokens === undefined ? 512 : llm.maxTokens, onChange: (e) => setLlm({ ...llm, maxTokens: e.target.value }) }))),
        h(Field, { label: t('settings.llm.promptFile') },
          h('div', { className: 'mono' }, 'assets/templates/anima-system-prompt.txt')),
        h('label', { className: 'check' },
          h('input', { type: 'checkbox', checked: llm.characterRepair !== false, onChange: (e) => setLlm({ ...llm, characterRepair: e.target.checked }) }),
          t('settings.llm.characterRepair')),
        h('div', { className: 'hint' }, t('settings.llm.characterRepair.hint'))),

      h('div', { className: 'card' },
        h('div', { className: 'card-title' }, t('settings.window.title')),
        h('div', { className: 'hint' }, t('settings.window.noTray')))),

    h('div', { className: 'row' },
      h('button', { className: 'btn primary', disabled: busy, onClick: save }, t('common.save')),
      h('span', { className: 'sp' }),
      h('button', { className: 'btn tiny', onClick: async () => { setChecks(await api('/app/selfcheck')); } }, t('shell.recheck'))),

    h('div', { className: 'card', style: { marginTop: 12 } },
      h('div', { className: 'card-title' }, t('shell.selfcheckIssues')),
      issues.length
        ? h('div', { className: 'list' }, issues.map((i, idx) => h('div', { className: 'list-row', key: idx },
          h('span', { className: i.level === 'error' ? 'error' : 'warn' }, i.level === 'error' ? '✕' : '!'),
          h('span', { className: 'name' }, i.message),
          h('span', { className: 'hint' }, i.fix))))
        : h('div', { className: 'ok' }, t('shell.selfcheckOk'))));
}
