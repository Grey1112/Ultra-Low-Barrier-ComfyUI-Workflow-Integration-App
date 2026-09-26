// app-shell.js —— 独立版外壳：导航、状态、i18n、长任务、面板落位与页面桥。
//
// 与插件版的关系：面板半（panel.js）原样复用，只是从「插件宿主的 shell.overlay 槽位」改成
// 本外壳页面里的一个标签页；外壳自己提供设置 / 首次运行向导 / 本地 LLM / 画师管理四个页面。

import { t as tGlobal, loadLang, getLang, installTranslator, retranslateAll } from './i18n.js';
import { openJobModal, BackgroundJobs } from './job-view.js';

// 排障/验收用的只读调试钩子（不影响运行路径）。
window.__DCP_I18N__ = { retranslateAll, getLang };

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

// ── 基础工具 ─────────────────────────────────────────────

async function api(path, opts) {
  const o = Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {});
  // v1.1.0（修复 B8）：在封装层做一次归一化 —— 项目里对 api() 存在两种调用约定：
  // post()/put() 会自己 JSON.stringify，另有一批调用点直接传 `{ body: {…} }` 裸对象；
  // fetch 对普通对象只会 String() 成 "[object Object]"，后端 readJsonBody 一律 400
  //（现象是"按钮点了没反应"）。这里只序列化纯对象，FormData / Blob / ArrayBuffer /
  // 已序列化字符串原样透传（panel.js 的图片上传走 FormData，不受影响）。
  if (o.body && typeof o.body === 'object'
    && !(o.body instanceof FormData) && !(o.body instanceof Blob)
    && !(o.body instanceof ArrayBuffer) && !ArrayBuffer.isView(o.body)) {
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(path, o);
  const text = await r.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  if (!r.ok) {
    const msg = (data && (data.error || data.message)) || ('HTTP ' + r.status);
    throw new Error(msg);
  }
  return data;
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body || {}) });
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body || {}) });

/** React 受控输入需要走原生 setter + input 事件，否则 React 的 state 不会更新。 */
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function fmtBytes(n) {
  if (n === undefined || n === null || n < 0) return '?';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(i >= 3 ? 2 : 1)) + ' ' + u[i];
}

// ── 页面桥（供 panel 与其它页面互相喂数据） ───────────────

function installBridge(shell) {
  window.__DCP_BRIDGE__ = {
    /**
     * 把提示词写进生图面板的正/负向输入框。
     * 首选面板自己暴露的 `window.__DCP_PANEL_API__`（真正走 setState）；
     * 它不存在时才退回 DOM 赋值（只对显示有效，作为极端兜底）。
     */
    fillPrompts({ positive, negative } = {}) {
      const panelApi = window.__DCP_PANEL_API__;
      if (panelApi && typeof panelApi.setPrompts === 'function') {
        const filled = panelApi.setPrompts({ positive, negative });
        shell.go('workbench');
        shell.toast(tGlobal('llm.filled') + '（' + filled + '）', filled ? 'ok' : 'warn');
        return { ok: filled > 0, filled, via: 'panel-api' };
      }
      const areas = document.querySelectorAll('.panel-slot textarea');
      if (!areas.length) { shell.toast(tGlobal('toast.needSetup'), 'warn'); return { ok: false, reason: 'panel-not-mounted' }; }
      let filled = 0;
      if (typeof positive === 'string' && areas[0]) { setNativeValue(areas[0], positive); filled++; }
      if (typeof negative === 'string' && areas[1]) { setNativeValue(areas[1], negative); filled++; }
      shell.go('workbench');
      shell.toast(tGlobal('llm.filled') + '（' + filled + '）', filled ? 'ok' : 'warn');
      return { ok: filled > 0, filled, via: 'dom-fallback' };
    },
    /** 读取面板当前的正/负向提示词（验收与排障用）。 */
    readPrompts() {
      const api = window.__DCP_PANEL_API__;
      if (api && typeof api.getPrompts === 'function') return api.getPrompts();
      const areas = document.querySelectorAll('.panel-slot textarea');
      return { positive: areas[0] ? areas[0].value : '', negative: areas[1] ? areas[1].value : '' };
    },
    /** 触发面板的生成按钮（找不到就返回 false，由调用方提示）。 */
    generate() {
      const api = window.__DCP_PANEL_API__;
      if (api && typeof api.generate === 'function' && api.generate()) return { ok: true, via: 'panel-api' };
      const btns = [...document.querySelectorAll('.panel-slot button')];
      const b = btns.find((x) => /生成\s*\d*\s*张/.test(x.textContent || '') && !x.disabled);
      if (!b) return { ok: false, reason: 'generate-button-unavailable' };
      b.click();
      return { ok: true, via: 'dom' };
    },
    go: (tab) => shell.go(tab),
  };
}

// ── 外壳 ─────────────────────────────────────────────────

const TABS = [
  { id: 'workbench', key: 'nav.workbench', icon: '🎛' },
  { id: 'artists', key: 'nav.artists', icon: '🎨' },
  { id: 'settings', key: 'nav.settings', icon: '⚙' },
  { id: 'wizard', key: 'nav.wizard', icon: '🚀' },
];

function App() {
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState('workbench');
  const [state, setState] = useState(null);
  const [settings, setSettings] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [lang, setLang] = useState('zh');
  const [renderKey, setRenderKey] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState([]);
  const [bootError, setBootError] = useState('');
  const panelSlotRef = useRef(null);
  const panelTranslatorRef = useRef(null);
  const pageCache = useRef({});

  const toast = useCallback((msg, level) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((cur) => cur.concat({ id, msg: String(msg), level: level || 'info' }));
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), level === 'error' ? 12000 : 6000);
  }, []);

  const t = useCallback((key, params) => tGlobal(key, params), [renderKey, lang]);

  const refresh = useCallback(async () => {
    try {
      const st = await api('/app/state');
      setState(st);
      // v1.2.0：顺手重拉设置。设置页保存后会调用 refresh()，而页面挂在 props.settings 上的那份
      // 是装载时的快照 —— 它过期后回传的旧值（尤其是空的 API Key）会覆盖用户在别处刚改好的配置。
      // 后端已把空 Key 当"不改"（双重保险），这里再把快照刷新掉，避免其它字段也被旧值回写。
      try { setSettings(await api('/app/settings')); } catch { /* 设置拉取失败不影响状态刷新 */ }
      return st;
    } catch (e) {
      setBootError(e.message);
      return null;
    }
  }, []);

  // 首次装载：i18n → 设置 → 状态 → 画师数据（含 localStorage 一次性导入）→ 安装桥
  useEffect(() => {
    (async () => {
      try {
        const st = await api('/app/state');
        setState(st);
        const se = await api('/app/settings');
        setSettings(se);
        await loadLang(se.lang || st.lang || 'zh');
        setLang(getLang());
        const arts = await api('/app/artists/lists');
        window.__DCP_ARTISTS__ = { favs: arts.favs || [], blacklist: arts.blacklist || [], groups: arts.groups || [] };
        // 一次性迁移：插件版把收藏存在浏览器 localStorage（key dcp-artist-favs）。
        try {
          const raw = localStorage.getItem('dcp-artist-favs');
          if (raw) {
            const items = JSON.parse(raw);
            if (Array.isArray(items) && items.length) {
              const r = await post('/app/artists/import', { items });
              window.__DCP_ARTISTS__ = { favs: r.favs || [], blacklist: r.blacklist || [], groups: r.groups || [] };
              if (r.imported) toast(tGlobal('artists.imported') + ' ' + r.imported, 'ok');
            }
          }
        } catch { /* 浏览器里没有旧收藏是正常情况 */ }
        window.__DCP_SAVE_ARTISTS__ = async (next) => {
          try {
            await put('/app/artists/favs', { items: next.favs || [] });
            await put('/app/artists/blacklist', { items: next.blacklist || [] });
            window.dispatchEvent(new CustomEvent('dcp-artists-changed'));
          } catch (e) {
            toast(tGlobal('toast.failed') + '：' + e.message, 'error');
          }
        };
        // v1.2.0：画师页改完分组/收藏后，用这个把共享数据（含分组）刷回来 —— 面板的分组下拉
        // 与"分组随机"池子都读 window.__DCP_ARTISTS__，刷新后广播 dcp-artists-changed 让面板同步。
        window.__DCP_REFRESH_ARTISTS__ = async () => {
          try {
            const a = await api('/app/artists/lists');
            window.__DCP_ARTISTS__ = { favs: a.favs || [], blacklist: a.blacklist || [], groups: a.groups || [] };
            window.dispatchEvent(new CustomEvent('dcp-artists-changed'));
            return window.__DCP_ARTISTS__;
          } catch { return null; }
        };
        setReady(true);
      } catch (e) {
        setBootError(e.message);
      }
    })();
  }, []);

  const go = useCallback((next) => setTab(next), []);

  useEffect(() => { installBridge({ toast, go }); }, [toast, go]);

  // 面板里「→ 去「画师」页管理」按钮：面板不直接管路由，用事件通知外壳切页。
  useEffect(() => {
    const onGo = (e) => { const id = e && e.detail; if (id) setTab(String(id)); };
    window.addEventListener('dcp-go-tab', onGo);
    return () => window.removeEventListener('dcp-go-tab', onGo);
  }, []);

  // 语言切换：重载词典 + 外壳重渲染（t() 依赖 lang）。
  // 生图面板**不重挂载**（否则用户已填的提示词会丢）：由 DOM 翻译层先还原原文、再按新词典翻一遍。
  const changeLang = useCallback(async (next) => {
    try {
      await loadLang(next);
      await put('/app/settings', { lang: next });
      setLang(next);
      const se = await api('/app/settings');
      setSettings(se);
      setTimeout(() => retranslateAll(), 0);
      setTimeout(() => retranslateAll(), 250);
      toast(tGlobal('toast.langChanged'), 'ok');
    } catch (e) {
      toast(tGlobal('toast.failed') + '：' + e.message, 'error');
    }
  }, [toast]);

  // DOM 翻译器：装在**整个内容区**上，面板与内嵌页面（LLM/画师）都被覆盖。
  useEffect(() => {
    if (!ready) return undefined;
    const slot = panelSlotRef.current;
    if (!slot) return undefined;
    const install = () => {
      if (panelTranslatorRef.current) { try { panelTranslatorRef.current(); } catch { /* ignore */ } }
      panelTranslatorRef.current = installTranslator(slot);
    };
    install();
    const timer = setTimeout(install, 400);
    return () => { clearTimeout(timer); if (panelTranslatorRef.current) { try { panelTranslatorRef.current(); } catch { /* ignore */ } panelTranslatorRef.current = null; } };
  }, [ready, tab, renderKey, lang, state && state.comfy && state.comfy.online]);

  // 状态轮询：ComfyUI 在线状态 / LLM 服务器
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [ready, refresh]);

  const loadLogs = useCallback(async () => {
    try {
      const r = await api('/app/logs?tail=300');
      setLogs(r.lines || []);
    } catch (e) { toast(e.message, 'error'); }
  }, [toast]);

  // 页面模块按需加载（失败时报错，不静默）。
  // 注意：这个 effect 必须在任何 return 之前 —— hook 数量不能随条件变化（React #310）。
  useEffect(() => {
    const map = {
      workbench: () => import('./pages/workbench.js'),
      artists: () => import('./pages/artists.js'),
      settings: () => import('./pages/settings.js'),
      wizard: () => import('./pages/wizard.js'),
    };
    if (!map[tab] || pageCache.current[tab]) return;
    map[tab]().then((m) => { pageCache.current[tab] = { component: m.default }; setRenderKey((k) => k + 1); })
      .catch((e) => toast(tGlobal('shell.pageLoadFailed') + e.message, 'error'));
  }, [tab, toast]);

  if (bootError) {
    return h('div', { className: 'page' },
      h('h1', { className: 'page-title' }, tGlobal('shell.title')),
      h('div', { className: 'error' }, tGlobal('shell.backendDown') + bootError),
      h('div', { className: 'hint' }, tGlobal('shell.backendDownHint')));
  }
  if (!ready || !state) {
    return h('div', { className: 'page' }, h('div', { className: 'muted' }, tGlobal('shell.loading')));
  }

  const issues = (state.selfcheck && state.selfcheck.issues) || [];
  const errors = issues.filter((i) => i.level === 'error');
  const setupDone = !!(state.setup && state.setup.completed);

  // v1.1.0（修复 B6）：顶栏 LLM 徽标与对话页同口径 —— 按推理来源判定就绪度，
  // 并显示实际来源（外接 API 显示模型名，而不是永远读本地运行时）。
  const llmState = state.llm || {};
  const llmIsApi = llmState.provider === 'api';
  const llmReady = llmIsApi
    ? !!(llmState.api && llmState.api.ok && llmState.api.hasKey)
    : !!(llmState.runtime && llmState.runtime.ok);
  const llmSource = llmIsApi ? ((llmState.api && llmState.api.model) || 'API') : 'LLM';
  const llmBadgeTitle = llmIsApi
    ? (llmReady ? t('llm.provider.apiReady') : t('llm.provider.apiNeedKey'))
    : (llmReady ? t('llm.runtime.ready') : t('llm.error.notReady'));

  const pageProps = { api, post, put, t, state, settings, refresh, toast, openJobModal, fmtBytes };

  const renderPage = () => {
    const map = {
      workbench: () => import('./pages/workbench.js'),
      artists: () => import('./pages/artists.js'),
      settings: () => import('./pages/settings.js'),
      wizard: () => import('./pages/wizard.js'),
    };
    if (!map[tab]) return null;
    const Cached = pageCache.current[tab];
    if (Cached) return h(Cached.component, { ...pageProps, key: tab + '-' + renderKey });
    return h('div', { className: 'page' }, h('div', { className: 'muted' }, t('common.loading')));
  };

  // 页面模块按需加载由上面的 effect 负责（见 hook 顺序说明）。

  return h('div', { className: 'app', key: 'app-' + renderKey },
    h('div', { className: 'sidebar' },
      h('div', { className: 'brand' }, '🎨 ' + t('shell.title'),
        h('span', { className: 'brand-sub' }, state.buildTag + ' · ' + (state.comfy.mode === 'external' ? t('shell.mode.external') : t('shell.mode.embedded')))),
      h('div', { className: 'nav' },
        TABS.map((t2) => h('button', {
          key: t2.id,
          className: 'nav-item' + (tab === t2.id ? ' active' : ''),
          onClick: () => go(t2.id),
        }, t2.icon + ' ' + t(t2.key))))),
    h('div', { className: 'main' },
      h('div', { className: 'topbar' },
        h('span', { className: 'badge' + (state.comfy.online ? ' good' : '') },
          h('span', { className: 'dot' + (state.comfy.online ? ' on' : ' off') }),
          'ComfyUI ' + (state.comfy.online ? t('shell.online') : t('shell.offline')) + ' · :' + state.comfy.port),
        h('span', { className: 'badge' + (llmReady ? ' good' : ' warn'), title: llmBadgeTitle },
          llmSource + ' ' + (llmReady ? t('shell.llmReady') : t('shell.llmAbsent'))),
        !llmIsApi && state.llm.model ? h('span', { className: 'badge' }, state.llm.model) : null,
        // 后台任务指示器：下载/安装跑在服务端，切页面也看得见（点开即进度弹窗）
        h(BackgroundJobs, { api, t }),
        h('span', { className: 'sp' }),
        h('button', { className: 'btn tiny', onClick: () => { loadLogs(); setLogOpen((v) => !v); } }, logOpen ? t('shell.hideLogs') : t('shell.showLogs')),
        h('button', { className: 'btn tiny', onClick: async () => { const st = await refresh(); toast(st && st.selfcheck.ok ? t('shell.selfcheckOk') : t('shell.selfcheckIssues'), st && st.selfcheck.ok ? 'ok' : 'warn'); } }, t('shell.recheck')),
        h('span', { className: 'badge' }, t('shell.language')),
        h('button', { className: 'btn tiny' + (lang === 'zh' ? ' primary' : ''), onClick: () => changeLang('zh') }, '中文'),
        h('button', { className: 'btn tiny' + (lang === 'en' ? ' primary' : '') , onClick: () => changeLang('en') }, 'EN')),
      h('div', { className: 'content', ref: panelSlotRef },
        h('div', { className: 'page', style: { paddingBottom: 0, flex: 'none' } },
          !setupDone ? h('div', { className: 'wizard-banner' },
            h('span', null, t('toast.needSetup')),
            h('span', { className: 'sp' }),
            h('button', { className: 'btn primary tiny', onClick: () => go('wizard') }, t('nav.wizard'))) : null,
          errors.length ? h('div', { className: 'error' },
            errors.map((i) => i.message + ' → ' + i.fix).join('\n'),
            h('div', null, h('button', { className: 'btn tiny', style: { marginTop: 6 }, onClick: () => go('settings') }, t('nav.settings')))) : null),
        renderPage()),
      logOpen ? h('div', { className: 'log-drawer' },
        h('div', { className: 'row' }, h('b', null, t('shell.logs')), h('span', { className: 'sp' }),
          h('button', { className: 'btn tiny', onClick: loadLogs }, t('common.refresh'))),
        h('div', { className: 'job-log' }, (logs || []).join('\n') || t('common.none'))) : null),
    h('div', { className: 'toasts' },
      toasts.map((x) => h('div', { key: x.id, className: 'toast ' + x.level }, x.msg))));
}

const root = ReactDOM.createRoot(document.getElementById('dcp-app'));
root.render(h(App));
