// app-shell.js —— 独立版外壳：导航、状态、i18n、长任务、面板落位与页面桥。
//
// 与插件版的关系：面板半（panel.js）原样复用，只是从「插件宿主的 shell.overlay 槽位」改成
// 本外壳页面里的一个标签页；外壳自己提供设置 / 首次运行向导 / 本地 LLM / 画师管理四个页面。

import { t as tGlobal, loadLang, getLang, installTranslator, retranslateAll } from './i18n.js';
import { openJobModal, BackgroundJobs } from './job-view.js';

  // 排障/验收用的只读调试钩子（不影响运行路径）。v1.2.1 起加上标签页缓存状态，便于验收脚本断言。
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
  const r = await fetchRetry(path, o);
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

/**
 * v1.2.1：fetch 的**瞬时失败重试**。
 * 常驻工作台之后，页面会长期持有 ComfyUI 的实时通道与轮询，偶尔会出现一次
 * "TypeError: Failed to fetch"（连接被复用/半开时被对端掐掉，浏览器直接 reject）。
 * 以前一次抖动就会把整页画成「Failed to fetch」，用户以为功能坏了；本机回环的
 * 幂等 GET 重试一次几乎必然成功，所以只对 GET、只在网络层 reject 时重试。
 */
async function fetchRetry(path, opts, tries = 3) {
  const o = opts || {};
  const method = String(o.method || 'GET').toUpperCase();
  let last = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(path, o);
    } catch (e) {
      last = e;
      if (method !== 'GET') throw e;
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    }
  }
  throw last || new Error('fetch failed');
}

// ── v1.2.2：服务地址解析 + "失联"状态（U1 / U2）─────────────
//
// 后端字段契约（v1.2.2 起，见 server/index.js）：
//   · /app/state 顶层 **port** = 本程序**实际**监听的端口（本轮起不再把漂移值回写设置文件）；
//   · state.listen.port 只是**配置值**，取消回写后它不再等于实际端口，只能当兜底；
//   · state.comfy.port 是 **ComfyUI 自己**的端口（默认 8188），与"本页面连的服务端口"无关。
// 所以顶栏的"可访问地址"优先用顶层 port 渲染；字段缺失/非法时逐级兜底，绝不把 undefined / NaN 画到界面上。

/**
 * 解析"本程序实际监听地址"。
 * 端口取值顺序：state.port（实际端口）→ state.listen.port（配置兜底）→ null（整块不渲染）。
 * 非法值（空串 / NaN / Infinity / 非整数 / <1 / >65535）一律视为缺失。
 */
function resolveServiceAddress(state) {
  const norm = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) return null;
    return n;
  };
  if (!state || typeof state !== 'object') return null;
  let port = norm(state.port);
  let fromConfig = false;
  if (port === null) {
    port = norm(state.listen && state.listen.port);
    fromConfig = port !== null;
  }
  if (port === null) return null;
  const loc = (typeof window !== 'undefined' && window.location) || {};
  let host = (typeof loc.hostname === 'string' && loc.hostname) ? loc.hostname : '127.0.0.1';
  if (host.indexOf(':') >= 0 && host.charAt(0) !== '[') host = '[' + host + ']';   // IPv6 字面量
  const proto = loc.protocol === 'https:' ? 'https' : 'http';
  // 局域网模式监听非回环地址时，不带令牌的地址打不开 —— 给出的地址必须是真能打开的。
  const token = (state.listen && state.listen.lan === true && typeof state.listen.token === 'string')
    ? state.listen.token : '';
  const url = proto + '://' + host + ':' + port + (token ? '/?token=' + encodeURIComponent(token) : '');
  return { url, port, fromConfig };
}

/**
 * 失联状态的**唯一**出口。
 * U2 的关键：连续失败的轮询绝不能每轮都重画一次失败提示 —— `lost` 同时充当"已经画过"的闩，
 * 只有"连通 → 断连"这一次跳变才允许前端再渲染那条提示（`count` 只累加，不进 DOM）。
 * `__DCP_LINK__` 是只读调试钩子，供排障/验收直接读，不影响渲染路径。
 */
const linkState = { phase: 'boot', lost: false, count: 0, lastError: '', lastOkAt: 0, lastKnownUrl: '', suppressedToasts: 0 };

/** v1.2.2（U2）：同一条 error toast 的节流窗口（毫秒）。窗口内只弹第一条。 */
const TOAST_THROTTLE_MS = 30000;

function publishLink() {
  if (typeof window === 'undefined') return;
  window.__DCP_LINK__ = Object.assign({}, linkState);
}

// "上次成功连上的地址"：断连提示里要告诉用户该用哪个地址重开页面（跨刷新保留在 localStorage）。
const LAST_ADDR_KEY = 'dcp-last-address';
// v1.3.0（需求 4）：第一次启动是否已经自动跳到过「安装中心」（只在没跳过时跳一次）
const FIRST_RUN_KEY = 'dcp-first-run-install';

function rememberAddress(state) {
  const a = resolveServiceAddress(state);
  if (!a) return;
  linkState.lastKnownUrl = a.url;
  try { localStorage.setItem(LAST_ADDR_KEY, a.url); } catch { /* 隐私模式/禁用存储：忽略 */ }
}

function lastKnownAddress() {
  if (linkState.lastKnownUrl) return linkState.lastKnownUrl;
  try { return localStorage.getItem(LAST_ADDR_KEY) || ''; } catch { return ''; }
}

/** 复制到剪贴板：优先 Clipboard API，回落临时 textarea（局域网 http 下 execCommand 仍可用）。 */
async function copyText(text) {
  const val = String(text || '');
  if (!val) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(val);
      return true;
    }
  } catch { /* 回落 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = val;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const done = !!(document.execCommand && document.execCommand('copy'));
    document.body.removeChild(ta);
    return done;
  } catch { return false; }
}

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
      if (!areas.length) { shell.toast(tGlobal('shell.panelNotReady'), 'warn'); return { ok: false, reason: 'panel-not-mounted' }; }
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
  { id: 'install', key: 'nav.install', icon: '📦' },
  { id: 'settings', key: 'nav.settings', icon: '⚙' },
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
  // v1.2.2（U2）：与后端失联的单条可操作提示。null = 连通（或还没断过）；
  // 非 null 时只画一条 banner，之后的每轮失败不再改这个 state（见 refresh 里的节流闩）。
  const [linkLost, setLinkLost] = useState(null);
  const panelSlotRef = useRef(null);
  const panelTranslatorRef = useRef(null);
  const pageCache = useRef({});
  const pageInflight = useRef({});   // 按需加载去重（同一模块只请求一次；也是排障用的"在飞"状态）
  // v1.2.1（排障）：外壳实例的挂载序号与标签页切换足迹。常驻标签页一旦被整体重建，
  // 用户就会发现"提示词/对话又没了"——这两个值能让这种回归一眼可见。
  const bootSeq = useRef(0);
  const tabTrail = useRef([]);
  if (bootSeq.current === 0) bootSeq.current = (window.__DCP_BOOT_SEQ__ || 0) + 1;
  window.__DCP_BOOT_SEQ__ = bootSeq.current;
  if (tabTrail.current[tabTrail.current.length - 1] !== tab) tabTrail.current.push(tab);
  // v1.2.1（排障/验收）：页面缓存与渲染序号的只读快照。常驻标签页的"是否已挂载"完全取决于它，
  // 出问题时（例如某个 pane 一直停在"加载中"）能一条命令看清楚，不用靠猜。
  const shellDebug = () => ({
    tab, renderKey, mounted: [...mountedTabs.current],
    bootSeq: bootSeq.current, trail: tabTrail.current.slice(-12),
    cached: Object.keys(pageCache.current),
    inflight: Object.keys(pageInflight.current).filter((k) => pageInflight.current[k]),
    panes: [...document.querySelectorAll('.tab-panes > .tab-pane')].map((p) => p.getAttribute('data-tab')),
  });

  // v1.2.2（U2）：同一条失败提示的**节流**。
  // 实测（真后端 + headless 浏览器）：页面停在服务实际地址之外时，面板侧艺术家的保存会就地重试，
  // 每次失败都走 __DCP_SAVE_ARTISTS__ 的 catch 弹一条「操作失败：Failed to fetch」——
  // 22 秒里堆出 1918 条 toast，正是用户报的"刷屏"。节流规则：**同一条 error 文案**在窗口期内
  // 只弹第一条，后续只累加 suppressed 计数（只读钩子 __DCP_LINK__ 可见，不进 DOM）；
  // 文案不同的失败、以及非 error 级提示不受影响。
  const toastThrottle = useRef({ msg: '', at: 0, suppressed: 0 });
  const toast = useCallback((msg, level) => {
    const text = String(msg);
    const lv = level || 'info';
    if (lv === 'error') {
      const th = toastThrottle.current;
      const now = Date.now();
      if (th.msg === text && now - th.at < TOAST_THROTTLE_MS) {
        th.suppressed += 1;
        linkState.suppressedToasts = th.suppressed;
        publishLink();
        return;
      }
      th.msg = text;
      th.at = now;
      th.suppressed = 0;
      linkState.suppressedToasts = 0;
      publishLink();
    }
    const id = Math.random().toString(36).slice(2);
    setToasts((cur) => cur.concat({ id, msg: text, level: lv }));
    setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== id)), lv === 'error' ? 12000 : 6000);
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
      // v1.2.2（U2）：恢复连通 —— 提示自行消失（只在这次跳变时改 DOM，函数式更新避免闭包旧值）。
      linkState.phase = 'ready';
      linkState.lost = false;
      linkState.count = 0;
      linkState.lastError = '';
      linkState.lastOkAt = Date.now();
      rememberAddress(st);
      publishLink();
      setLinkLost((cur) => (cur ? null : cur));
      setBootError((cur) => (cur ? '' : cur));
      return st;
    } catch (e) {
      const msg = String((e && e.message) || e || '');
      // v1.2.2（U2）：旧实现这里 setBootError → 整页被刷成「后端接口不可用」，而且 bootError
      // 一旦置位再也清不掉（后端回来了页面也回不来）；5s 轮询每轮都走一次，用户看到的就是"刷屏"。
      // 现在只把**第一条**失败提示放出来（lost 当闩），后续每轮失败只累加计数、不动 DOM。
      linkState.phase = 'ready';
      linkState.count += 1;
      linkState.lastError = msg;
      const first = !linkState.lost;
      linkState.lost = true;
      publishLink();
      if (first) setLinkLost({ lastError: msg });
      return null;
    }
  }, []);

  // 首次装载：i18n → 设置 → 状态 → 画师数据（含 localStorage 一次性导入）→ 安装桥。
  // v1.2.2（U2）：抽成可重入函数 —— 首帧没连上后端时页面不再停在死页，由下面的轻探循环重新调用它。
  const boot = useCallback(async () => {
    linkState.phase = 'boot';
    try {
      {
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
        // v1.2.1（需求 2 的回归修复）：**只写显式传入的键**。
        // 旧实现无条件 PUT favs 与 blacklist，而面板挂载时会 saveFavorites() 一次 ——
        // 用户新建的分组/黑名单会被这次"顺手写回"覆盖成面板手里的旧快照。
        // 现在按 key 独立下发，分组走 /app/artists/groups/replace（后端仍做 50 组归一化）。
        // v1.2.2（U2）：再加一层**单飞 + 合并**。面板侧在保存失败后会就地重试（实测"页面停在旧端口"
        // 时每秒上百次），旧实现每次都发一轮请求、每次都弹一条 toast，把浏览器打到
        // "Failed to fetch"（ERR_INSUFFICIENT_RESOURCES）并堆出上千条提示。
        // 现在：同一时刻只提交一次；提交期间来的 patch 按 key 合并成"最后一份"，本次落地后补交一次。
        // 持久化语义不变（每个 key 的最后一份必定被提交，成功才广播 dcp-artists-changed）。
        let saveBusy = false;
        let saveQueue = null;
        // v1.2.2（U2 的第二半）：**只在服务端数据真的变了才广播** dcp-artists-changed。
        // 为什么必须加：面板侧有两个"状态一变就持久化"的 effect（panel.js:1552 收藏 / :1555 分组），
        // 而面板的 onChanged（panel.js:1494-1498）每次都用 loadFavorites()/loadGroups() 造**新数组**
        // 回填 state —— 于是"广播 → setState → 保存 → 广播"自我闭环。实测（真后端 + headless）：
        // 一个空闲页面每秒发 ~166 次艺术家保存请求，全部是白跑；一旦页面停在旧端口/断连，
        // 这些请求全变成 "Failed to fetch"，配合上面的 toast 就是用户看到的刷屏。
        // 服务端的 PUT/POST 都会回全量 {favs,blacklist,groups}，所以按"回包是否与上一次相同"判定即可；
        // 真正的变更（画师页改收藏/分组、面板内改分组）依然会广播，同步语义不变。
        let lastBroadcast = null;
        const sameStore = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
        const storeOf = (resp, patch) => {
          const src = (resp && typeof resp === 'object') ? resp : {};
          const pick = (k) => (Array.isArray(src[k]) ? src[k]
            : (Array.isArray(patch[k]) ? patch[k]
              : (lastBroadcast && Array.isArray(lastBroadcast[k]) ? lastBroadcast[k] : [])));
          return { favs: pick('favs'), blacklist: pick('blacklist'), groups: pick('groups') };
        };
        const submitArtists = async (patch) => {
          let resp = null;
          if (Array.isArray(patch.favs)) resp = await put('/app/artists/favs', { items: patch.favs });
          if (Array.isArray(patch.blacklist)) resp = await put('/app/artists/blacklist', { items: patch.blacklist });
          if (Array.isArray(patch.groups)) resp = await post('/app/artists/groups/replace', { groups: patch.groups });
          const snap = storeOf(resp, patch);
          if (!sameStore(snap, lastBroadcast)) {
            lastBroadcast = snap;
            window.dispatchEvent(new CustomEvent('dcp-artists-changed'));
          }
        };
        window.__DCP_SAVE_ARTISTS__ = async (next) => {
          const patch = Object.assign({}, next || {});
          if (!Object.keys(patch).length) return;
          if (saveBusy) { saveQueue = Object.assign({}, saveQueue || {}, patch); return; }
          saveBusy = true;
          try {
            let cur = patch;
            for (;;) {
              try {
                await submitArtists(cur);
              } catch (e) {
                toast(tGlobal('toast.failed') + '：' + e.message, 'error');   // toast 自身对同一文案有节流
              }
              if (!saveQueue) break;
              cur = saveQueue;
              saveQueue = null;
            }
          } finally {
            saveBusy = false;
          }
        };
        // v1.2.0：画师页改完分组/收藏后，用这个把共享数据（含分组）刷回来 —— 面板的分组下拉
        // 与"分组随机"池子都读 window.__DCP_ARTISTS__，刷新后广播 dcp-artists-changed 让面板同步。
        window.__DCP_REFRESH_ARTISTS__ = async () => {
          try {
            const a = await api('/app/artists/lists');
            window.__DCP_ARTISTS__ = { favs: a.favs || [], blacklist: a.blacklist || [], groups: a.groups || [] };
            // 刚广播出去的就是这份状态：记进 lastBroadcast，面板随后那次"回写同一份"的保存不会再触发一次广播。
            lastBroadcast = {
              favs: window.__DCP_ARTISTS__.favs, blacklist: window.__DCP_ARTISTS__.blacklist, groups: window.__DCP_ARTISTS__.groups,
            };
            window.dispatchEvent(new CustomEvent('dcp-artists-changed'));
            return window.__DCP_ARTISTS__;
          } catch { return null; }
        };
        // v1.2.1（需求 2）：面板内的「＋分组」入口直接调这里 —— 服务端是唯一真相，
        // 成功后刷新共享数据并广播，面板与画师页立刻同步（不需要面板自己写回整份列表）。
        window.__DCP_ARTIST_GROUP__ = async ({ tag, group, action } = {}) => {
          const t2 = String(tag || '').trim();
          const g = String(group || '').trim();
          if (!t2 || !g) throw new Error('画师与分组名都不能为空');
          const act = action === 'remove' ? 'remove' : 'add';
          const r = await post('/app/artists/groups/' + act, { tag: t2, group: g });
          await window.__DCP_REFRESH_ARTISTS__();
          return r;
        };
        // v1.2.1：面板里"新建分组并加入"用；建组失败（重名/超 50）返回 null，由面板提示。
        window.__DCP_CREATE_GROUP__ = async (name) => {
          const n = String(name || '').trim();
          if (!n) return null;
          try {
            const r = await post('/app/artists/groups/create', { name: n });
            await window.__DCP_REFRESH_ARTISTS__();
            return r;
          } catch { return null; }
        };
        // v1.2.2（U2）：装载成功 → 失联提示的门关上（连通后提示自行消失），并记住可用地址。
        linkState.phase = 'ready';
        linkState.lost = false;
        linkState.count = 0;
        linkState.lastError = '';
        linkState.lastOkAt = Date.now();
        rememberAddress(st);
        publishLink();
        setLinkLost((cur) => (cur ? null : cur));
        setBootError('');
        setReady(true);
        // v1.3.0（需求 4）：向导页已移除 —— **第一次启动项目时自动跳到「安装中心」**，
        // 并让那一页提示用户下载 ComfyUI 等前置组件与对应模型。
        // 判据：后端 setup 未完成，且本机从未自动跳转过（localStorage 记住了就不再打扰）。
        try {
          if (st && st.setup && !st.setup.completed && !localStorage.getItem(FIRST_RUN_KEY)) {
            localStorage.setItem(FIRST_RUN_KEY, '1');
            tabTrail.current.push('auto-first-run:install');
            setTab('install');
          }
        } catch { /* 隐私模式/禁用存储：忽略，用户仍可自己点「安装中心」 */ }
      }
    } catch (e) {
      const msg = String((e && e.message) || e || '');
      linkState.phase = 'boot';
      linkState.count += 1;
      linkState.lastError = msg;
      linkState.lost = true;
      publishLink();
      // 同一轮失败不重复写同一个字符串（React 同值会 bail out，这里只是把意图写清楚）。
      setBootError((cur) => (cur === msg ? cur : msg));
    }
  }, [toast]);

  useEffect(() => { boot(); }, [boot]);

  // v1.2.2（U2）：首帧没连上后端时，页面不再停在死页 —— 每 5s 轻探一次 /app/state，
  // 通了就重新走完整装载（提示随之自行消失）；仍然不通就什么都不做（绝不刷屏）。
  useEffect(() => {
    if (!bootError) return undefined;
    let alive = true;
    const timer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      try { await api('/app/state'); } catch { return; }
      if (alive) boot();
    }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [bootError, boot]);

  const go = useCallback((next) => setTab(next), []);

  // v1.2.1（需求 1）：工作台必须**常驻挂载**。
  // 之前切页 = 卸载 workbench → 面板与 LLM 的 useState 全部重置：用户已填的正/负向提示词、
  // 参数、已出图、整段对话在切到画师/设置页再回来时全没了。现在 workbench 的 `.tab-pane`
  // 首帧之后永不卸载，非当前 tab 只加 `.tab-hidden`（见 shell.css），切回来零重载。
  // 其它页面仍在切走时卸载（它们的开销与状态没有这个需求）。
  const mountedTabs = useRef(new Set());
  mountedTabs.current.add(tab);
  if (ready) mountedTabs.current.add('workbench');

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

  // 状态轮询：ComfyUI 在线状态 / LLM 服务器。
  // v1.2.1：标签页在后台时跳过轮询（常驻工作台会一直持有 ComfyUI 实时通道，
  // 再叠加无意义的轮询只会在切页前后堆一堆半开请求，反而让新请求偶发 "Failed to fetch"）。
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      refresh();
    }, 5000);
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
      install: () => import('./pages/install.js'),
      settings: () => import('./pages/settings.js'),
    };
    const cached = pageCache.current[tab];
    if (!map[tab] || (cached && cached.component)) return;
    // 显式去重：切页很快时 effect 可能连续触发；同一模块只发一次请求，
    // 也保证"在飞"状态可观测（排障钩子里的 pending）。
    if (pageInflight.current[tab]) return;
    pageInflight.current[tab] = true;
    map[tab]().then((m) => {
      pageInflight.current[tab] = false;
      pageCache.current[tab] = { component: m.default };
      setRenderKey((k) => k + 1);
    })
      .catch((e) => {
        pageInflight.current[tab] = false;
        pageCache.current[tab] = null;
        toast(tGlobal('shell.pageLoadFailed') + e.message, 'error');
      });
  }, [tab, toast]);

  if (bootError) {
    // v1.2.2（U2）：首帧失败不再是一张"死页" —— 保持**一条**可操作提示（说明怎么拿到正确地址），
    // 可手动重试，同时在后台每 5s 轻探一次：后端回来就自动接着装载，提示随之消失。
    const bootAddr = lastKnownAddress();
    return h('div', { className: 'page' },
      h('h1', { className: 'page-title' }, tGlobal('shell.title')),
      h('div', { className: 'link-lost', 'data-dcp-link-lost': '1' },
        h('div', { className: 'link-lost-title' }, tGlobal('shell.linkLost')),
        h('div', { className: 'link-lost-hint' }, tGlobal('shell.linkLostHint')),
        bootAddr ? h('div', { className: 'hint' }, tGlobal('shell.linkLostLastOk') + bootAddr) : null,
        h('div', { className: 'error' }, tGlobal('shell.backendDown') + bootError),
        h('div', { className: 'hint' }, tGlobal('shell.backendDownHint')),
        h('div', { className: 'link-lost-actions' },
          h('button', { className: 'btn tiny primary', onClick: () => boot() }, tGlobal('shell.linkLostRetry')))));
  }
  if (!ready || !state) {
    return h('div', { className: 'page' }, h('div', { className: 'muted' }, tGlobal('shell.loading')));
  }

  const issues = (state.selfcheck && state.selfcheck.issues) || [];
  const errors = issues.filter((i) => i.level === 'error');
  const setupDone = !!(state.setup && state.setup.completed);
  // v1.2.2（U1）：顶栏"可访问地址" —— 端口必须来自后端自证的实际端口（/app/state 顶层 port）。
  const addr = resolveServiceAddress(state);
  const lastAddr = lastKnownAddress();

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

  const renderPage = (id) => {
    const map = {
      workbench: () => import('./pages/workbench.js'),
      artists: () => import('./pages/artists.js'),
      install: () => import('./pages/install.js'),
      settings: () => import('./pages/settings.js'),
    };
    if (!map[id]) return null;
    const Cached = pageCache.current[id];
    // v1.2.1（关键）：key 必须**稳定**（只用 tab id），绝不能掺 renderKey。
    // 旧写法把渲染序号拼进 key，在按需加载完成、renderKey 自增时会把刚挂载的页面
    // 整体重建一次 —— 工作台常驻的意义就没了：面板与 LLM 的 useState 会被重置
    // （现象正是用户报的"切一下页面提示词和对话就没了"）。
    if (Cached) return h(Cached.component, { ...pageProps, key: 'page-' + id });
    return h('div', { className: 'page' }, h('div', { className: 'muted' }, t('common.loading')));
  };

  /** v1.2.1：每个已挂载页面一个 `.tab-pane`，非当前 tab 只隐藏不卸载（工作台因此保住提示词与对话）。 */
  const renderPanes = () => h('div', { className: 'tab-panes' },
    TABS.map((t2) => {
      if (!mountedTabs.current.has(t2.id)) return null;
      return h('div', {
        key: 'pane-' + t2.id,
        className: 'tab-pane' + (tab === t2.id ? '' : ' tab-hidden'),
        'data-tab': t2.id,
      }, renderPage(t2.id));
    }));

  // 页面模块按需加载由上面的 effect 负责（见 hook 顺序说明）。
  const shellState = shellDebug();
  if (typeof window !== 'undefined') window.__DCP_SHELL__ = shellState;

  return h('div', { className: 'app' },
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
        // v1.2.2（U1）：本页面连的是哪个服务端口 —— 用 /app/state 的实际端口渲染可访问地址。
        // 字段缺失/非法时 resolveServiceAddress 返回 null（或退化到配置值并换一条 tooltip），
        // 绝不会把 undefined / NaN 画出来。
        addr ? h('span', {
          className: 'badge',
          'data-dcp-service-port': String(addr.port),
          title: t(addr.fromConfig ? 'shell.serviceAddressTitleConfig' : 'shell.serviceAddressTitle'),
        }, t('shell.serviceAddress', { url: addr.url })) : null,
        addr ? h('button', {
          className: 'btn tiny',
          title: t('shell.copyAddress'),
          onClick: async () => {
            const done = await copyText(addr.url);
            toast(done ? t('toast.copied') : t('toast.failed'), done ? 'ok' : 'warn');
          },
        }, t('shell.copyAddress')) : null,
        h('span', { className: 'badge' + (llmReady ? ' good' : ' warn'), title: llmBadgeTitle },
          llmSource + ' ' + (llmReady ? t('shell.llmReady') : t('shell.llmAbsent'))),
        !llmIsApi && state.llm.model ? h('span', { className: 'badge' }, state.llm.model) : null,
        // 后台任务指示器：下载/安装跑在服务端，切页面也看得见（点开即进度弹窗）
        h(BackgroundJobs, { api, t }),
        h('span', { className: 'sp' }),
        h('button', { className: 'btn tiny', onClick: () => { loadLogs(); setLogOpen((v) => !v); } }, logOpen ? t('shell.hideLogs') : t('shell.showLogs')),
        h('button', { className: 'btn tiny', onClick: async () => {
          const st = await refresh();
          // v1.2.2（U2）：断连时不再弹一句没用的失败提示 —— 这条信息由下面那条 banner 承担。
          if (!st) return;
          const okNow = !!(st.selfcheck && st.selfcheck.ok);
          toast(okNow ? t('shell.selfcheckOk') : t('shell.selfcheckIssues'), okNow ? 'ok' : 'warn');
        } }, t('shell.recheck')),
        h('span', { className: 'badge' }, t('shell.language')),
        h('button', { className: 'btn tiny' + (lang === 'zh' ? ' primary' : ''), onClick: () => changeLang('zh') }, '中文'),
        h('button', { className: 'btn tiny' + (lang === 'en' ? ' primary' : '') , onClick: () => changeLang('en') }, 'EN')),
      h('div', { className: 'content', ref: panelSlotRef },
        h('div', { className: 'page', style: { paddingBottom: 0, flex: 'none' } },
          // v1.2.2（U2）：与后端失联的**单条**可操作提示。state 只在"连通 → 断连"跳变时置位，
          // 连续失败不再每 5s 重画（详情见 refresh 里的节流闩）；恢复连通后自动消失。
          linkLost ? h('div', { className: 'link-lost', 'data-dcp-link-lost': '1' },
            h('div', { className: 'link-lost-title' }, t('shell.linkLost')),
            h('div', { className: 'link-lost-hint' }, t('shell.linkLostHint')),
            lastAddr ? h('div', { className: 'hint' }, t('shell.linkLostLastOk') + lastAddr) : null,
            h('div', { className: 'error' }, t('shell.linkLostLast') + (linkLost.lastError || '?')),
            h('div', { className: 'link-lost-actions' },
              lastAddr ? h('button', {
                className: 'btn tiny',
                onClick: async () => {
                  const done = await copyText(lastAddr);
                  toast(done ? t('toast.copied') : t('toast.failed'), done ? 'ok' : 'warn');
                },
              }, t('shell.copyAddress')) : null,
              h('button', { className: 'btn tiny primary', onClick: () => { refresh(); } }, t('shell.linkLostRetry')))) : null,
          !setupDone ? h('div', { className: 'wizard-banner' },
            h('span', null, t('shell.firstRunHint')),
            h('span', { className: 'sp' }),
            h('button', { className: 'btn primary tiny', onClick: () => go('install') }, t('nav.install'))) : null,
          errors.length ? h('div', { className: 'error' },
            errors.map((i) => i.message + ' → ' + i.fix).join('\n'),
            h('div', null, h('button', { className: 'btn tiny', style: { marginTop: 6 }, onClick: () => go('settings') }, t('nav.settings')))) : null),
        renderPanes()),
      logOpen ? h('div', { className: 'log-drawer' },
        h('div', { className: 'row' }, h('b', null, t('shell.logs')), h('span', { className: 'sp' }),
          h('button', { className: 'btn tiny', onClick: loadLogs }, t('common.refresh'))),
        h('div', { className: 'job-log' }, (logs || []).join('\n') || t('common.none'))) : null),
    h('div', { className: 'toasts' },
      toasts.map((x) => h('div', { key: x.id, className: 'toast ' + x.level }, x.msg))));
}

const root = ReactDOM.createRoot(document.getElementById('dcp-app'));
root.render(h(App));
