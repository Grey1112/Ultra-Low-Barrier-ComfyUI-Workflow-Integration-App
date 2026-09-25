// llm.js —— 本地 LLM 提示词生成页（会话式生成 + 运行时/模型管理 + abliterated 检索）。
//
// 无构建步骤：本文件由浏览器直接当 ES module 加载，React 是全局（window.React）。
// 契约见 docs/INTERNAL-CONTRACT.md §2（页面约定）、§3（Job+SSE）、§4（接口）、§6（i18n）。

import { openJobModal, JobProgress } from '../job-view.js';
import { t as tGlobal } from '../i18n.js';

const h = React.createElement;
const { useState, useEffect, useRef, useCallback } = React;

// ── 小工具 ────────────────────────────────────────────────

/** 1 位小数的 GB 文本；用于 compose 文案（i18n 里没有该数值的键）。 */
function gb(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '0.0 GB';
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

/** 去掉行首的 "Positive prompt:" / "Negative prompt:" 标签与空白。 */
function stripLabel(line) {
  return String(line).replace(/^\s*(?:positive|negative)\s*prompt\s*[:：]\s*/i, '').trim();
}

/**
 * 解析模型回复里的正/负提示词。
 * 规则：优先取**最后**一个同时含 "Positive prompt:" 与 "Negative prompt:" 的围栏块；
 * 取不到围栏时退回整段文本（模型偶发不写围栏）。负向块在遇到下一个空白分隔段落处结束。
 */
function parseFence(text) {
  const raw = String(text == null ? '' : text);
  const fences = [];
  const re = /```[^\n]*\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] && m[1].trim()) fences.push(m[1]);   // 只收有内容的围栏
  }
  // 未闭合的围栏也认（流式截断时常见）。
  // 【踩过的坑】回复以闭合的 ``` 结尾时，旧写法会把"结尾之后"的空串也 push 进 fences，
  // 而这里取的是最后一个围栏 → 拿到空串 → 正/负向永远解析为空 → 「填入 / 复制」全部置灰。
  // 所以只有在"反引号数量为奇数（确实没闭合）且尾巴有内容"时才把它当候选。
  const ticks = (raw.match(/```/g) || []).length;
  const open = raw.lastIndexOf('```');
  if (open >= 0 && ticks % 2 === 1) {
    const tail = raw.slice(open + 3);
    if (tail.trim()) fences.push(tail);
  }

  const source = (fences.length ? fences[fences.length - 1] : raw).replace(/\r\n?/g, '\n');
  const pi = source.search(/(?:^|\n)\s*positive\s*prompt\s*[:：]/i);
  const ni = source.search(/(?:^|\n)\s*negative\s*prompt\s*[:：]/i);
  if (pi < 0 || ni < 0 || ni < pi) return { positive: '', negative: '' };

  const sections = (chunk) =>
    String(chunk)
      .split(/\n\s*\n+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const pos = sections(source.slice(pi, ni))
    .map(stripLabel)
    .filter(Boolean);
  const neg = sections(source.slice(ni))
    .map(stripLabel)
    .filter(Boolean);

  const clean = (s) => String(s)
    .replace(/```[^\n]*/g, ' ')      // 去掉残留的围栏标记（负向块常把结尾的 ``` 一起吃进来）
    .replace(/`+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { positive: clean(pos.join(' ')), negative: clean(neg.join(' ')) };
}

// ── 页面 ──────────────────────────────────────────────────

export default function LlmPage(props) {
  // t 优先用外壳注入的；缺省时回落到 i18n.js 的模块级 t（同一份词典）。
  // post 用于发起 job（下载模型/词表）—— 必须显式从 props 取，否则运行时 ReferenceError。
  const { api, state, refresh, toast, post } = props;
  const t = typeof props.t === 'function' ? props.t : tGlobal;

  const [messages, setMessages] = useState([]);      // [{role, content, meta?}]
  const [draft, setDraft] = useState('');
  // 上下文策略：界面保留完整历史（可整段复制），默认不把上下文发给模型。
  const [sendContext, setSendContext] = useState(false);
  const [reasoning, setReasoning] = useState('off');
  const [streaming, setStreaming] = useState(false);
  const [runtime, setRuntime] = useState(null);      // /app/llm/status
  const [models, setModels] = useState(null);        // {items, dir}
  const [promptOpen, setPromptOpen] = useState(false);
  const [promptText, setPromptText] = useState('');
  const [contextMessages, setContextMessages] = useState(null);
  const [installJob, setInstallJob] = useState('');
  const [modelJob, setModelJob] = useState('');
  const [addPath, setAddPath] = useState('');
  const [addMode, setAddMode] = useState('link');
  const [dlUrl, setDlUrl] = useState('');
  const [dlName, setDlName] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);      // {items, note}
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState('');
  const [removeTarget, setRemoveTarget] = useState('');
  const [err, setErr] = useState('');
  // 本轮新增：推荐模型目录 / 角色词表 / 角色检索
  const [catalog, setCatalog] = useState([]);
  const [chars, setChars] = useState({});
  const [charJob, setCharJob] = useState('');
  const [charQuery, setCharQuery] = useState('');
  const [charHits, setCharHits] = useState([]);
  const [aliasZh, setAliasZh] = useState('');
  const [aliasTag, setAliasTag] = useState('');

  const mounted = useRef(true);
  const sessionId = useRef('s' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  const streamCtl = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (streamCtl.current) { try { streamCtl.current.abort(); } catch { /* 已结束 */ } }
    };
  }, []);

  const fail = useCallback((e) => {
    const msg = (e && e.message) ? e.message : t('toast.failed');
    if (mounted.current) setErr(msg);
    toast && toast(msg, 'error');
  }, [toast, t]);

  // ── 数据加载 ────────────────────────────────────────────

  const loadStatus = useCallback(async () => {
    try {
      const r = await api('/app/llm/status');
      if (mounted.current) setRuntime(r || {});
      // 上下文策略与推理挡位来自设置（对话页直接可调，不用跳设置页）
      const st = await api('/app/settings').catch(() => null);
      if (st && st.llm && mounted.current) {
        setSendContext(st.llm.sendContext === true);
        setReasoning((st.llm.api && st.llm.api.reasoning) || 'off');
      }
    } catch (e) { fail(e); }
  }, [api, fail]);

  const loadModels = useCallback(async () => {
    try {
      const r = await api('/app/llm/models');
      if (mounted.current) setModels(r || { items: [] });
    } catch (e) { fail(e); }
  }, [api, fail]);

  // 推荐模型目录（installer/llm-models.json，字节数与许可都实测核对过）
  const loadCatalog = useCallback(async () => {
    try {
      const r = await api('/app/llm/catalog');
      if (mounted.current) setCatalog((r && r.items) || []);
    } catch (e) { /* 目录读不到不影响聊天，静默降级 */ }
  }, [api]);

  // 角色词表状态（Danbooru 角色 tag 索引）
  const loadCharStatus = useCallback(async () => {
    try {
      const r = await api('/app/characters/status');
      if (mounted.current) setChars(r || {});
    } catch (e) { /* 同上 */ }
  }, [api]);

  /** 从推荐目录下载一个 GGUF（走后端 job + 进度弹窗）。带 sha256 时后端下载后会流式校验。 */
  const downloadCatalogModel = useCallback(async (entry) => {
    try {
      const r = await post('/app/llm/models/download', { url: entry.url, name: entry.file, sha256: entry.sha256 || '', bytes: entry.bytes || 0 });
      toast && toast(t('toast.jobStarted'), 'ok');
      if (props.openJobModal) props.openJobModal(r.jobId, entry.file, () => { loadModels(); loadCatalog(); refresh && refresh(); });
      else setModelJob(r.jobId);
    } catch (e) { fail(e); }
  }, [fail, loadCatalog, loadModels, post, props, refresh, t, toast]);

  /** 校验本地 GGUF 的 sha256（对照推荐目录里登记的值；不在目录里也能算出本地哈希）。 */
  const verifyModelFile = useCallback(async (file) => {
    try {
      const r = await post('/app/llm/models/verify', { file });
      toast && toast(t('toast.jobStarted'), 'ok');
      if (props.openJobModal) props.openJobModal(r.jobId, t('llm.manage.verify') + ' · ' + file, () => { loadModels(); refresh && refresh(); });
      else setModelJob(r.jobId);
    } catch (e) { fail(e); }
  }, [fail, loadModels, post, props, refresh, t, toast]);

  /** 下载/更新角色词表。 */
  const installCharacters = useCallback(async () => {
    try {
      const r = await post('/app/characters/install', {});
      toast && toast(t('toast.jobStarted'), 'ok');
      if (props.openJobModal) props.openJobModal(r.jobId, t('llm.characters.title'), () => loadCharStatus());
      else setCharJob(r.jobId);
    } catch (e) { fail(e); }
  }, [fail, loadCharStatus, post, props, t, toast]);

  /** 搜角色（走后端索引，中英都能搜）。 */
  const searchChars = useCallback(async (q) => {
    try {
      const r = await api('/app/characters/search?q=' + encodeURIComponent(q || '') + '&limit=30');
      if (mounted.current) setCharHits((r && r.items) || []);
    } catch (e) { fail(e); }
  }, [api, fail]);

  /** 加一条中文别名（存到 data/character-aliases.json，随项目迁移走）。 */
  const addAlias = useCallback(async () => {
    const zh = aliasZh.trim();
    const tag = aliasTag.trim();
    if (!zh || !tag) { toast && toast(t('toast.failed'), 'warn'); return; }
    try {
      await post('/app/characters/aliases', { zh, tag });
      setAliasZh(''); setAliasTag('');
      await loadCharStatus();
      toast && toast(t('llm.characters.saved'), 'ok');
    } catch (e) { fail(e); }
  }, [aliasTag, aliasZh, fail, loadCharStatus, post, t, toast]);

  // 上下文条数：优先用外壳 state（只依赖这个原始值，避免 state 对象换引用导致反复重载）。
  const stateContext = state && state.llm && typeof state.llm.contextMessages === 'number'
    ? state.llm.contextMessages : null;

  useEffect(() => {
    loadStatus();
    loadModels();
    loadCatalog();
    loadCharStatus();
    if (stateContext !== null) {
      setContextMessages(stateContext);
      return undefined;
    }
    let alive = true;
    (async () => {
      try {
        const s = await api('/app/settings');
        const n = s && s.llm && typeof s.llm.contextMessages === 'number' ? s.llm.contextMessages : null;
        if (alive && mounted.current) setContextMessages(n);
      } catch (e) { fail(e); }
    })();
    return () => { alive = false; };
  }, [api, fail, loadModels, loadStatus, loadCatalog, loadCharStatus, stateContext]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const loadPrompt = useCallback(async () => {
    if (promptText) { setPromptOpen((v) => !v); return; }
    try {
      const r = await api('/app/llm/prompt');
      if (!mounted.current) return;
      setPromptText((r && r.text) || '');
      setPromptOpen(true);
    } catch (e) { fail(e); }
  }, [api, fail, promptText]);

  // ── 会话 / 流式回复 ─────────────────────────────────────

  const notReady = !!(runtime && runtime.runtime && runtime.runtime.ok === false);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || streaming) return;
    if (notReady) { setErr(t('llm.error.notReady')); toast && toast(t('llm.error.notReady'), 'error'); return; }

    setDraft('');
    setErr('');
    const next = messages.concat([{ role: 'user', content: text }, { role: 'assistant', content: '' }]);
    setMessages(next);
    setStreaming(true);

    const body = {
      sessionId: sessionId.current,
      messages: next
        .slice(0, -1)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content })),
    };

    let acc = '';
    let ctl = null;
    try {
      ctl = new AbortController();
      streamCtl.current = ctl;
      const res = await fetch('/app/llm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* 非 JSON 响应体 */ }
        throw new Error(msg);
      }
      if (!res.body || !res.body.getReader) throw new Error(t('llm.error.serverFailed'));

      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      let done = false;
      let contextUsed = null;

      const setLast = (patch) => {
        if (!mounted.current) return;
        setMessages((prev) => {
          if (!prev.length) return prev;
          const copy = prev.slice();
          copy[copy.length - 1] = Object.assign({}, copy[copy.length - 1], patch);
          return copy;
        });
      };

      while (!done) {
        const step = await reader.read();
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          for (const line of frame.split('\n')) {
            if (line.slice(0, 6) !== 'data: ') continue;
            let data = null;
            try { data = JSON.parse(line.slice(6)); } catch { continue; }
            if (data && data.done) {
              done = true;
              if (typeof data.contextUsed === 'number') contextUsed = data.contextUsed;
              // 后端会把回答规范成"单代码围栏 + 去重后的正负向"；有 replace 就以它为准。
              if (typeof data.replace === 'string' && data.replace) {
                acc = data.replace;
                setLast({ content: acc });
              }
              if (typeof data.answer === 'string' && data.answer) {
                acc = data.answer;
                setLast({ content: acc });
              }
              continue;
            }
            if (data && typeof data.replace === 'string') {
              acc = data.replace;
              setLast({ content: acc });
              // 同一帧里可能还带着"角色词表补全/规范化"的说明（后端把 replace 与 charactersAdded 合并发了）
              if (Array.isArray(data.charactersAdded) && data.charactersAdded.length) {
                setMessages((prev) => prev.concat([{
                  role: 'system',
                  content: t('llm.characters.added') + '：' + data.charactersAdded.join(', '),
                }]));
              }
              if (Array.isArray(data.charactersFixed) && data.charactersFixed.length) {
                setMessages((prev) => prev.concat([{
                  role: 'system',
                  content: t('llm.characters.fixed') + '：' + data.charactersFixed.map((x) => `${x.from} → ${x.to}`).join('；'),
                }]));
              }
              continue;
            }
            if (data && typeof data.note === 'string') {
              setMessages((prev) => prev.concat([{ role: 'system', content: data.note }]));
              continue;
            }
            // 角色词表补全：把补进去/规范化过的规范角色 tag 明确告诉用户（不是静默改内容）。
            if (data && Array.isArray(data.charactersAdded) && data.charactersAdded.length) {
              setMessages((prev) => prev.concat([{
                role: 'system',
                content: t('llm.characters.added') + '：' + data.charactersAdded.join(', '),
              }]));
              continue;
            }
            if (data && Array.isArray(data.charactersFixed) && data.charactersFixed.length) {
              setMessages((prev) => prev.concat([{
                role: 'system',
                content: t('llm.characters.fixed') + '：' + data.charactersFixed.map((x) => `${x.from} → ${x.to}`).join('；'),
              }]));
              continue;
            }
            if (data && typeof data.delta === 'string') {
              acc += data.delta;
              setLast({ content: acc });
            }
          }
        }
      }
      if (mounted.current) {
        setLast(contextUsed === null ? { content: acc } : { content: acc, meta: contextUsed });
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (mounted.current) {
        setMessages((prev) => {
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const copy = prev.slice();
          copy[copy.length - 1] = { role: 'system', content: (e && e.message) || t('toast.failed') };
          return copy;
        });
      }
      fail(e);
    } finally {
      streamCtl.current = null;
      if (mounted.current) setStreaming(false);
    }
  }, [api, draft, fail, messages, notReady, streaming, toast, t]);

  const newSession = useCallback(async () => {
    try {
      await api('/app/llm/session/new', { method: 'POST', body: { sessionId: sessionId.current } });
      if (streamCtl.current) { try { streamCtl.current.abort(); } catch { /* 已结束 */ } }
      sessionId.current = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      if (mounted.current) { setMessages([]); setStreaming(false); setErr(''); }
      toast && toast(t('toast.done'), 'ok');
    } catch (e) { fail(e); }
  }, [api, fail, toast, t]);

  // ── 一键填入 / 一键复制（桥由外壳提供，这里只调用） ───────
  // 解析对象在渲染期算出，供预览框与按钮共用（每次回复变化都会重算）。
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
  const lastAnswer = lastAssistant ? lastAssistant.content : '';
  const parsed = lastAnswer ? parseFence(lastAnswer) : null;
  const hasParsed = !!(parsed && (parsed.positive || parsed.negative));

  /** 复制到剪贴板；优先 clipboard API，失败退回隐藏 textarea + execCommand。 */
  const copyText = useCallback((text, label) => {
    const s = String(text == null ? '' : text);
    if (!s.trim()) { toast && toast(t('toast.failed'), 'warn'); return false; }
    const done = () => toast && toast((label ? label + '：' : '') + t('common.copied'), 'ok');
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = s;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { done(); return true; }
      } catch { /* 落到失败分支 */ }
      toast && toast(t('common.copyFailed'), 'error');
      return false;
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(s).then(done).catch(fallback);
        return true;
      }
    } catch { /* 走 fallback */ }
    return fallback();
  }, [toast, t]);

  const fill = useCallback((which) => {
    const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
    if (!last) { toast && toast(t('llm.tools.noReply'), 'warn'); return; }
    const p = parseFence(last.content);
    if (!p || (!p.positive && !p.negative)) { toast && toast(t('llm.tools.parseFailed'), 'error'); return; }
    const needPos = which === 'positive' || which === 'both';
    const needNeg = which === 'negative' || which === 'both';
    if ((needPos && !p.positive) || (needNeg && !p.negative)) { toast && toast(t('llm.tools.partialMissing'), 'warn'); return; }
    const bridge = typeof window !== 'undefined' ? window.__DCP_BRIDGE__ : null;
    if (!bridge) { toast && toast(t('toast.failed'), 'error'); return; }
    try {
      const r = bridge.fillPrompts({
        positive: needPos ? p.positive : undefined,
        negative: needNeg ? p.negative : undefined,
      });
      // 成功时的提示由桥统一发（含写入条数），这里只在失败时补充说明。
      if (!r || r.ok !== true) toast && toast(t('wb.panelMissing'), 'error');
    } catch (e) { fail(e); }
  }, [fail, messages, toast, t]);

  // ── 运行时 / 服务端 ─────────────────────────────────────

  const withBusy = useCallback(async (key, fn) => {
    setBusy(key);
    try { await fn(); } catch (e) { fail(e); } finally { if (mounted.current) setBusy(''); }
  }, [fail]);

  const startJob = useCallback(async (path, body, title) => {
    try {
      const r = await api(path, { method: 'POST', body });
      if (!r || !r.jobId) throw new Error(t('toast.failed'));
      openJobModal(r.jobId, title, () => {
        if (mounted.current) setInstallJob('');
        loadStatus();
        loadModels();
        refresh && refresh();
      }, (e) => { if (mounted.current) setInstallJob(''); fail(e); });
      return r.jobId;
    } catch (e) { fail(e); return null; }
  }, [api, fail, loadModels, loadStatus, refresh, t]);

  const install = useCallback((variant) => withBusy('install:' + variant, async () => {
    setErr('');
    const jobId = await startJob('/app/llm/runtime/install', { variant }, t('llm.runtime.install'));
    if (jobId && mounted.current) setInstallJob(jobId);
  }), [startJob, withBusy, t]);

  const serverAction = useCallback((action) => withBusy('server:' + action, async () => {
    setErr('');
    const r = await api('/app/llm/server/' + action, { method: 'POST', body: {} });
    const running = action === 'start' ? !!(r && r.running) : false;
    if (mounted.current) {
      setRuntime((prev) => Object.assign({}, prev || {}, { server: Object.assign({}, (prev && prev.server) || {}, { running }) }));
    }
    toast && toast(t(action === 'start' ? 'toast.serverStarted' : 'toast.serverStopped'), 'ok');
    loadStatus();
    refresh && refresh();
  }), [api, loadStatus, refresh, toast, t, withBusy]);

  // ── 模型管理 ────────────────────────────────────────────

  const setDefault = useCallback((file) => withBusy('default:' + file, async () => {
    await api('/app/llm/models/default', { method: 'POST', body: { file } });
    await loadModels();
    refresh && refresh();
    toast && toast(t('toast.saved'), 'ok');
  }), [api, loadModels, refresh, toast, t, withBusy]);

  const removeModel = useCallback((file) => withBusy('remove:' + file, async () => {
    await api('/app/llm/models/remove', { method: 'POST', body: { file } });
    if (mounted.current) setRemoveTarget('');
    await loadModels();
    refresh && refresh();
    toast && toast(t('toast.saved'), 'ok');
  }), [api, loadModels, refresh, toast, t, withBusy]);

  const addModel = useCallback(() => withBusy('add', async () => {
    const p = addPath.trim();
    if (!p) throw new Error(t('toast.failed'));
    await api('/app/llm/models/add', { method: 'POST', body: { path: p, mode: addMode } });
    if (mounted.current) setAddPath('');
    await loadModels();
    refresh && refresh();
    toast && toast(t('toast.saved'), 'ok');
  }), [addMode, addPath, api, loadModels, refresh, toast, t, withBusy]);

  const downloadModel = useCallback(() => withBusy('download', async () => {
    const url = dlUrl.trim();
    const name = dlName.trim();
    if (!url || !name) throw new Error(t('toast.failed'));
    setErr('');
    const jobId = await startJob('/app/llm/models/download', { url, name }, t('llm.manage.download'));
    if (jobId && mounted.current) setModelJob(jobId);
  }), [dlName, dlUrl, startJob, t, withBusy]);

  const downloadUrl = useCallback(async (url, name) => {
    setErr('');
    const jobId = await startJob('/app/llm/models/download', { url, name }, t('llm.manage.download'));
    if (jobId && mounted.current) setModelJob(jobId);
  }, [startJob, t]);

  // ── abliterated 检索 ────────────────────────────────────

  const search = useCallback(async () => {
    const q = query.trim();
    setSearching(true);
    setErr('');
    try {
      const r = await api('/app/llm/search?q=' + encodeURIComponent(q));
      if (mounted.current) setResults({ items: (r && r.items) || [], note: (r && r.note) || '' });
    } catch (e) { fail(e); } finally { if (mounted.current) setSearching(false); }
  }, [api, fail, query]);

  // ── 渲染 ────────────────────────────────────────────────

  const originLabel = (origin) => {
    if (origin === 'preset') return t('llm.manage.origin.preset');
    if (origin === 'downloaded') return t('llm.manage.origin.downloaded');
    return t('llm.manage.origin.added');
  };

  const runtimeOk = !!(runtime && runtime.runtime && runtime.runtime.ok);
  const serverRunning = !!(runtime && runtime.server && runtime.server.running);
  const activeModel = (runtime && runtime.model) || '';
  const items = (models && models.items) || [];
  const hits = (results && results.items) || [];

  const chatCard = h('div', { className: 'card' },
    h('div', { className: 'chat' },
      h('div', { className: 'chat-log', ref: logRef },
        messages.length
          ? messages.map((m, i) => h('div', {
            key: 'm' + i,
            className: 'msg ' + (m.role === 'user' ? 'user' : m.role === 'system' ? 'system' : 'assistant'),
          },
          // 每条消息都能整段复制（用户要求：历史保留在界面上、可整段复制，但不发给模型）
          h('div', { className: 'msg-head' },
            h('span', { className: 'msg-role' }, m.role === 'user' ? t('llm.role.user') : t('llm.role.assistant')),
            h('button', {
              className: 'btn tiny ghost msg-copy',
              title: t('llm.copyOne'),
              onClick: () => copyText(String(m.content || '')),
            }, t('llm.copyOne'))),
          h('div', { className: 'msg-body' }, m.content),
          typeof m.meta === 'number'
            ? h('div', { className: 'msg-meta' }, t('llm.contextCount') + ': ' + m.meta)
            : null))
          : h('div', { className: 'msg system' }, t('common.none'))),
      streaming
        ? h('div', { className: 'row tight' },
          h('span', { className: 'muted' }, t('common.loading')),
          h('button', {
            className: 'btn tiny',
            onClick: () => { if (streamCtl.current) { try { streamCtl.current.abort(); } catch { /* 已结束 */ } } },
          }, t('common.stop')))
        : null,
      h('div', { className: 'chat-input' },
        h('textarea', {
          className: 'textarea',
          value: draft,
          placeholder: t('llm.chat.placeholder'),
          disabled: streaming,
          onChange: (e) => setDraft(e.target.value),
          // 回车直接发送（用户要求）；Shift+回车换行。
          onKeyDown: (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent?.isComposing) {
              e.preventDefault();
              if (!streaming && draft.trim()) send();
            }
          },
        }),
        h('button', {
          className: 'btn primary',
          disabled: streaming || !draft.trim(),
          onClick: send,
        }, t('llm.send')),
        h('button', { className: 'btn', disabled: streaming, onClick: newSession }, t('llm.newSession')))),
    // 整段对话复制 + 上下文策略说明
    h('div', { className: 'row tight chat-foot' },
      h('button', {
        className: 'btn tiny', disabled: !messages.length,
        title: t('llm.copyAll.hint'),
        onClick: () => copyText(messages.map((m) => (m.role === 'user' ? '【用户】' : '【助手】') + '\n' + m.content).join('\n\n')),
      }, t('llm.copyAll')),
      h('span', { className: 'hint' },
        sendContext ? t('llm.ctx.on') : t('llm.ctx.off'))));

  const promptCard = h('div', { className: 'card' },
    h('div', { className: 'row' },
      h('div', { className: 'card-title' }, t('llm.systemPrompt')),
      h('span', { className: 'sp' }),
      h('button', { className: 'btn tiny', onClick: loadPrompt },
        t(promptOpen ? 'llm.systemPrompt.hide' : 'llm.systemPrompt.show'))),
    promptOpen ? h('div', { className: 'fence' }, promptText || t('common.loading')) : null);

  const fieldRow = (label, value, disabled, onCopy, onFill) => h('div', { className: 'field' },
    h('span', { className: 'label' }, label),
    h('div', { className: 'row tight' },
      h('input', { className: 'input', readOnly: true, value: value || '', placeholder: t('llm.tools.empty') }),
      h('button', { className: 'btn tiny', disabled, onClick: onCopy }, t('llm.copy')),
      h('button', { className: 'btn tiny', disabled, onClick: onFill }, t('llm.fill'))));

  const fillCard = h('div', { className: 'card' },
    h('div', { className: 'row' },
      h('div', { className: 'card-title' }, t('llm.tools.title')),
      h('span', { className: 'sp' }),
      h('span', { className: 'muted' }, parsed ? t('llm.tools.parsed') : t('llm.tools.noReply'))),
    // 解析结果预览：正/负向各自一个只读框 + 复制 / 填入
    fieldRow(t('llm.fillPositive'), parsed ? parsed.positive : '', !parsed || !parsed.positive,
      () => copyText(parsed ? parsed.positive : '', t('llm.fillPositive')), () => fill('positive')),
    fieldRow(t('llm.fillNegative'), parsed ? parsed.negative : '', !parsed || !parsed.negative,
      () => copyText(parsed ? parsed.negative : '', t('llm.fillNegative')), () => fill('negative')),
    h('div', { className: 'row tight', style: { marginTop: 6 } },
      h('button', { className: 'btn primary', disabled: !parsed, onClick: () => fill('both') }, t('llm.fillBoth')),
      h('button', {
        className: 'btn', disabled: !parsed,
        onClick: () => copyText(parsed ? `Positive prompt: ${parsed.positive}\n\nNegative prompt: ${parsed.negative}` : '', t('llm.copyBoth')),
      }, t('llm.copyBoth')),
      h('button', {
        className: 'btn', disabled: !lastAnswer,
        onClick: () => copyText(lastAnswer, t('llm.copyReply')),
      }, t('llm.copyReply'))));

  const left = h('div', { className: 'llm-main' },
    // v1.0.1：嵌入式（工作台提示词栏）里不再重复大标题，把纵向空间留给对话与工具按钮。
    props.embedded ? null : h('h1', { className: 'page-title' }, t('llm.title')),
    h('p', { className: 'page-sub' }, t('llm.contextCount') + ': '
      + (contextMessages === null ? t('common.unknown') : String(contextMessages))
      + ' · ' + (runtimeOk ? t('llm.runtime.ready') : t('llm.runtime.missing'))
      + (sendContext ? '' : ' · ' + t('llm.ctx.offShort'))),
    chatCard,
    err ? h('div', { className: 'error' }, err) : null,
    // 用户要求：LLM 在最上方，第二个就是「提示词工具（解析结果 → 面板）」——所以把它排到系统提示词卡之前。
    fillCard,
    promptCard);

  const right = h('div', { className: 'llm-side' },
    // 推理来源（本地 llama.cpp / 外接 OpenAI 兼容 API）
    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('llm.provider.title')),
      h('div', { className: 'row tight' },
        h('span', { className: 'badge' + ((runtime && runtime.provider === 'api') ? ' warn' : ' good') },
          (runtime && runtime.provider === 'api') ? t('llm.provider.api') : t('llm.provider.local')),
        (runtime && runtime.provider === 'api')
          ? h('span', { className: 'badge' + (runtime.api && runtime.api.ok ? ' good' : ' bad') },
            (runtime.api && runtime.api.ok) ? t('llm.provider.apiReady') : t('llm.provider.apiMissing'))
          : null),
      (runtime && runtime.provider === 'api')
        ? h('div', { className: 'hint' }, (runtime.api && runtime.api.baseUrl ? runtime.api.baseUrl + ' · ' : '') + (runtime.api ? runtime.api.model : '') + (runtime.api && runtime.api.hasKey ? ' · key ✓' : ' · no key'))
        : null,
      // 外接 API 是默认来源：没填 Key 时把"下一步做什么"直接写在这里，别让用户对着报错猜。
      (runtime && runtime.provider === 'api' && !(runtime.api && runtime.api.hasKey))
        ? h('div', { className: 'hint' }, t('llm.provider.apiNeedKey'))
        : null,
      // 推理挡位（四挡）：off / low / high / max —— 只有外接 API 需要它
      (runtime && runtime.provider === 'api')
        ? h('div', { className: 'row tight' },
          h('span', { className: 'hint' }, t('llm.reasoning.label')),
          h('select', {
            className: 'select option-dark', value: reasoning,
            onChange: async (e) => {
              const v = e.target.value;
              setReasoning(v);
              try { await api('/app/settings', { method: 'PUT', body: { llm: { api: { reasoning: v } } } }); toast && toast(t('toast.saved'), 'ok'); }
              catch (err) { fail(err); }
            },
          },
            h('option', { value: 'off' }, t('llm.reasoning.off')),
            h('option', { value: 'low' }, t('llm.reasoning.low')),
            h('option', { value: 'high' }, t('llm.reasoning.high')),
            h('option', { value: 'max' }, t('llm.reasoning.max'))),
          h('span', { className: 'hint' }, t('llm.reasoning.hint')))
        : null,
      // 上下文策略：保留在界面、可整段复制，但不发给模型
      h('label', { className: 'check' },
        h('input', {
          type: 'checkbox', checked: sendContext,
          onChange: async (e) => {
            const v = e.target.checked;
            setSendContext(v);
            try { await api('/app/settings', { method: 'PUT', body: { llm: { sendContext: v } } }); toast && toast(t('toast.saved'), 'ok'); }
            catch (err) { fail(err); }
          },
        }),
        t('llm.ctx.toggle')),
      h('div', { className: 'hint' }, t('llm.ctx.hint')),
      h('div', { className: 'hint' }, t('llm.provider.hint'))),

    // 推荐模型（给链接为主；本机已有就不再下载）
    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('llm.catalog.title')),
      h('div', { className: 'hint' }, t('llm.catalog.hint')),
      h('div', { className: 'list list-scroll', style: { marginTop: 6 } },
        catalog.map((m) => h('div', { className: 'list-row', key: m.id },
          h('span', { className: 'name', title: (m.note || '') + (m.vram ? '\n' + m.vram : '') },
            m.recommended ? '★ ' : '',
            m.file,
            m.installed ? h('span', { className: 'badge good', style: { marginLeft: 6 } }, t('llm.catalog.onDisk')) : null,
            h('span', { className: 'muted' }, '  ' + (m.bytes / 1073741824).toFixed(2) + ' GB · ' + t('llm.catalog.license') + ': ' + m.license)),
          h('div', { className: 'row tight' },
            m.page ? h('button', { className: 'btn tiny', title: t('llm.catalog.openPage') + '：' + m.page, onClick: () => window.open(m.page, '_blank', 'noopener') }, t('llm.catalog.open')) : null,
            m.mirror ? h('button', { className: 'btn tiny', title: 'hf-mirror（国内可直连）', onClick: () => window.open(m.mirror, '_blank', 'noopener') }, t('llm.catalog.mirror')) : null,
            m.installed ? h('button', { className: 'btn tiny', onClick: async () => { await post('/app/llm/models/default', { file: m.file }); await loadModels(); toast(t('toast.saved'), 'ok'); } }, t('llm.catalog.setDefault')) : null,
            m.installed ? h('button', { className: 'btn tiny', title: m.sha256 ? 'sha256 ' + m.sha256.slice(0, 16) + '…' : '', onClick: () => verifyModelFile(m.file) }, t('llm.manage.verify')) : null,
            m.installed ? null : h('button', { className: 'btn tiny', onClick: () => downloadCatalogModel(m) }, t('llm.catalog.download'))))))) ,

    // 角色词表（Danbooru 角色 tag 索引）
    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('llm.characters.title')),
      h('div', { className: 'hint' }, t('llm.characters.hint')),
      h('div', { className: 'row tight', style: { marginTop: 6 } },
        h('span', { className: 'badge' + (chars && chars.installed ? ' good' : ' bad') },
          (chars && chars.installed) ? t('llm.characters.installed') : t('llm.characters.missing')),
        (chars && chars.characters) ? h('span', { className: 'muted' }, chars.characters + ' ' + t('llm.characters.count')) : null,
        h('span', { className: 'sp' }),
        h('button', { className: 'btn tiny', onClick: installCharacters }, t('llm.characters.install'))),
      (chars && chars.source) ? h('div', { className: 'muted mono', style: { fontSize: 10 } }, t('llm.characters.source') + ': ' + chars.source) : null,
      h('div', { className: 'row tight', style: { marginTop: 6 } },
        h('input', {
          className: 'input', value: charQuery, placeholder: t('llm.characters.search'),
          onChange: (e) => { setCharQuery(e.target.value); searchChars(e.target.value); },
        })),
      charHits.length
        ? h('div', { className: 'list list-scroll', style: { marginTop: 4 } },
          charHits.map((c) => h('div', { className: 'list-row', key: c.tag },
            h('span', { className: 'name' }, c.tag),
            h('span', { className: 'count' }, String(c.count || 0)),
            h('button', {
              className: 'btn tiny', title: '复制 tag',
              onClick: () => copyText(c.tag, 'tag'),
            }, t('llm.copy')))))
        : null,
      h('div', { className: 'row tight', style: { marginTop: 6 } },
        h('input', { className: 'input narrow', value: aliasZh, placeholder: t('llm.characters.aliasZh'), onChange: (e) => setAliasZh(e.target.value) }),
        h('span', { className: 'muted' }, '→'),
        h('input', { className: 'input narrow', value: aliasTag, placeholder: t('llm.characters.aliasTag'), onChange: (e) => setAliasTag(e.target.value) }),
        h('button', { className: 'btn tiny', onClick: addAlias }, t('common.add'))),
      h('div', { className: 'muted', style: { fontSize: 10 } },
        t('llm.characters.count') + ': ' + (chars && chars.builtinAliases ? chars.builtinAliases : 0) + ' ' + t('common.default')
        + ' + ' + (chars && chars.userAliases ? chars.userAliases : 0) + ' ' + t('common.custom'))),
    // 运行时
    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('llm.runtime.install')),
      h('div', { className: 'row tight' },
        h('span', { className: 'badge ' + (runtimeOk ? 'good' : 'bad') },
          t(runtimeOk ? 'llm.runtime.ready' : 'llm.runtime.missing')),
        runtime && runtime.runtime && runtime.runtime.source
          ? h('span', { className: 'muted' }, String(runtime.runtime.source))
          : null),
      h('div', { className: 'row tight' },
        h('button', {
          className: 'btn tiny primary', disabled: busy === 'install:auto', onClick: () => install('auto'),
        }, t('llm.runtime.auto')),
        h('button', {
          className: 'btn tiny', disabled: busy === 'install:cuda', onClick: () => install('cuda'),
        }, t('llm.runtime.cuda')),
        h('button', {
          className: 'btn tiny', disabled: busy === 'install:cpu', onClick: () => install('cpu'),
        }, t('llm.runtime.cpu'))),
      installJob ? h(JobProgress, { jobId: installJob, onDone: loadStatus, onFail: fail }) : null),

    // 服务端
    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('llm.server.start') + ' / ' + t('llm.server.stop')),
      h('div', { className: 'row tight' },
        h('span', { className: 'badge ' + (serverRunning ? 'good' : '') },
          t(serverRunning ? 'llm.server.running' : 'llm.server.stopped')),
        h('span', { className: 'sp' }),
        h('button', {
          className: 'btn tiny', disabled: !!busy || serverRunning, onClick: () => serverAction('start'),
        }, t('llm.server.start')),
        h('button', {
          className: 'btn tiny danger', disabled: !!busy || !serverRunning, onClick: () => serverAction('stop'),
        }, t('llm.server.stop'))),
      h('div', { className: 'row tight' },
        h('span', { className: 'label' }, t('llm.model')),
        h('span', { className: 'mono' }, activeModel || t('llm.model.none')))),

    // 模型管理
    h('div', { className: 'card' },
      h('div', { className: 'row' },
        h('div', { className: 'card-title' }, t('llm.manage.title')),
        h('span', { className: 'sp' }),
        h('button', { className: 'btn tiny', onClick: loadModels }, t('common.refresh'))),
      items.length
        ? h('div', { className: 'list list-scroll' }, items.map((it, i) => h('div', { className: 'list-row', key: 'md' + i },
          h('span', { className: 'name mono' }, it.file),
          it.default ? h('span', { className: 'chip' }, t('llm.manage.default')) : null,
          it.abliterated ? h('span', { className: 'chip' }, t('llm.search.abliterated')) : null,
          h('span', { className: 'muted' }, gb(it.bytes)),
          h('span', { className: 'muted' }, originLabel(it.origin)),
          h('button', {
            className: 'btn tiny', disabled: !!busy || it.default, onClick: () => setDefault(it.file),
          }, t('llm.manage.setDefault')),
          h('button', {
            className: 'btn tiny danger', disabled: !!busy, onClick: () => setRemoveTarget(it.file),
          }, t('llm.manage.remove')))))
        : h('div', { className: 'muted' }, t('common.none')),

      h('div', { className: 'field' },
        h('span', { className: 'label' }, t('llm.manage.add')),
        h('input', {
          className: 'input', value: addPath,
          placeholder: t('llm.manage.addPath.placeholder'),
          onChange: (e) => setAddPath(e.target.value),
        }),
        h('div', { className: 'row tight' },
          h('span', { className: 'label' }, t('llm.manage.addMode')),
          h('div', { className: 'src-toggle' },
            h('button', { className: addMode === 'link' ? 'on' : '', onClick: () => setAddMode('link') }, 'link'),
            h('button', { className: addMode === 'copy' ? 'on' : '', onClick: () => setAddMode('copy') }, 'copy')),
          h('span', { className: 'sp' }),
          h('button', {
            className: 'btn tiny', disabled: !!busy || !addPath.trim(), onClick: addModel,
          }, t('llm.manage.add'))),
        h('span', { className: 'hint' }, t('llm.manage.addPath'))),

      h('div', { className: 'field' },
        h('span', { className: 'label' }, t('llm.manage.download')),
        h('input', {
          className: 'input', value: dlUrl, placeholder: t('llm.manage.url'),
          onChange: (e) => setDlUrl(e.target.value),
        }),
        h('div', { className: 'row tight' },
          h('input', {
            className: 'input', value: dlName, placeholder: t('llm.manage.filename'),
            onChange: (e) => setDlName(e.target.value),
          }),
          h('button', {
            className: 'btn tiny primary', disabled: !!busy || !dlUrl.trim() || !dlName.trim(), onClick: downloadModel,
          }, t('common.download')))),
      modelJob ? h(JobProgress, { jobId: modelJob, onDone: () => { setModelJob(''); loadModels(); }, onFail: (e) => { setModelJob(''); fail(e); } }) : null),

    // abliterated 检索
    h('div', { className: 'card' },
      h('div', { className: 'card-title' }, t('llm.search.title')),
      h('div', { className: 'search-row' },
        h('input', {
          className: 'input', value: query, placeholder: t('llm.search.placeholder'),
          onChange: (e) => setQuery(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } },
        }),
        h('button', { className: 'btn tiny', disabled: searching, onClick: search }, t('common.search'))),
      results && results.note ? h('div', { className: 'warn' }, results.note) : null,
      results && !hits.length ? h('div', { className: 'hint' }, t('llm.search.none')) : null,
      hits.length
        ? h('div', { className: 'col' }, hits.map((repo, i) => h('div', { key: 'rp' + i },
          h('div', { className: 'row tight' },
            h('span', { className: 'mono' }, repo.repo),
            repo.abliterated ? h('span', { className: 'chip' }, t('llm.search.abliterated')) : null,
            typeof repo.downloads === 'number' ? h('span', { className: 'muted' }, String(repo.downloads)) : null,
            repo.license ? h('span', { className: 'muted' }, t('common.license') + ': ' + repo.license) : null),
          ((repo && repo.files) || []).map((f, j) => h('div', { className: 'list-row', key: 'f' + i + '_' + j },
            h('span', { className: 'name mono' }, f.name),
            h('span', { className: 'muted' }, gb(f.size)),
            h('button', {
              className: 'btn tiny', disabled: !!busy || !f.url,
              onClick: () => downloadUrl(f.url, f.name),
            }, t('llm.search.download')))))))
        : null));

  const removeDialog = removeTarget
    ? h('div', { className: 'modal-mask' },
      h('div', { className: 'modal' },
        h('div', { className: 'modal-title' }, t('llm.manage.remove')),
        h('div', { className: 'mono' }, removeTarget),
        h('div', { className: 'warn' }, t('llm.manage.removeConfirm')),
        h('div', { className: 'modal-foot' },
          h('button', { className: 'btn', onClick: () => setRemoveTarget('') }, t('common.cancel')),
          h('button', {
            className: 'btn danger', disabled: !!busy, onClick: () => removeModel(removeTarget),
          }, t('common.confirm')))))
    : null;

  return h('div', { className: 'page' },
    h('div', { className: 'llm-layout' }, left, right),
    removeDialog);
}
