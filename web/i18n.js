// i18n.js —— 外壳/新页面用 t()；生图面板用"词典 + 规则"运行时翻译。
//
// 为什么面板不逐字改写源码：面板半是插件版 `lib/client.js` 的适配副本，保持与上游可逐行
// 比对是长期维护的硬要求；把 260+ 条中文文案改成 t("...") 会让 diff 失控。
// 因此面板文案在 DOM 层翻译：
//   ① 精确词典（panel）——静态文案；
//   ② 一次性正则（panelRules）——含插值的整句动态消息；
//   ③ 短语规则（panelPhrases）——"字面量拼接"出来的复合串，反复应用直到稳定。
//
// 三条工程约束（都是踩过坑之后加的）：
//   · 只在"中文字符数严格变少"时才改写节点，任何病态规则都无法颠倒反复写；
//   · 翻译按**分批队列**（每帧最多 120 个节点）执行，绝不长时间占用主线程；
//   · 改写期间挂起 MutationObserver，避免自激。

const state = {
  lang: 'zh',
  dict: null,
  observer: null,
  roots: new Set(),
};

const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);
const ATTRS = ['title', 'placeholder', 'aria-label'];
const CHUNK = 120;          // 每个时间片最多处理的节点数
let applying = false;
const queue = new Set();
let scheduled = false;

function fmt(str, params) {
  if (!params) return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (params[k] === undefined ? m : String(params[k])));
}

/** 中文字符（含全角标点）计数：用于判断一次改写是否真的更有进展。 */
export function cjkCount(s) {
  const m = String(s).match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g);
  return m ? m.length : 0;
}

// ── 词典与规则 ────────────────────────────────────────────

const compiled = { rules: null, phrases: null, forDict: null };

function compile(d) {
  if (compiled.forDict === d) return;
  compiled.rules = (Array.isArray(d.panelRules) ? d.panelRules : []).map((r) => {
    try { return { re: new RegExp(r.pattern), replace: r.replace }; } catch { return null; }
  }).filter(Boolean);
  compiled.phrases = (Array.isArray(d.panelPhrases) ? d.panelPhrases : []).map((r) => {
    try { return { re: new RegExp(r.pattern, 'g'), replace: r.replace }; } catch { return null; }
  }).filter(Boolean);
  compiled.forDict = d;
}

/** 取词典里的翻译；未命中时回落到传入的中文本身（便于开发期发现漏译）。 */
export function translate(text, params) {
  if (text === undefined || text === null) return text;
  const d = state.dict;
  const hit = d && d.panel && Object.prototype.hasOwnProperty.call(d.panel, text) ? d.panel[text] : undefined;
  if (hit !== undefined) return fmt(hit, params);
  if (!d || !CJK.test(text)) return fmt(text, params);
  // 中文就是原文语言：词典命中即返回，规则层只为英文准备。
  if (state.lang === 'zh') return fmt(text, params);
  compile(d);
  for (const rule of compiled.rules) {
    if (rule.re.test(text)) return text.replace(rule.re, rule.replace);
  }
  if (compiled.phrases.length) {
    let out = text;
    for (let pass = 0; pass < 20; pass++) {
      let changed = false;
      for (const rule of compiled.phrases) {
        const next = out.replace(rule.re, rule.replace);
        if (next !== out) { out = next; changed = true; }
      }
      if (!changed) break;
    }
    if (out !== text) return fmt(out, params);
  }
  return fmt(text, params);
}

export function t(key, params) {
  const d = state.dict;
  const hit = d && d.ui && Object.prototype.hasOwnProperty.call(d.ui, key) ? d.ui[key] : undefined;
  return fmt(hit === undefined ? key : hit, params);
}

export function getLang() { return state.lang; }
export function getDict() { return state.dict; }

export async function loadLang(lang) {
  const res = await fetch('/static/i18n/' + (lang === 'en' ? 'en' : 'zh') + '.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('i18n load failed: ' + res.status);
  state.dict = await res.json();
  state.lang = lang === 'en' ? 'en' : 'zh';
  compiled.forDict = null;
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh';
  return state.dict;
}

// ── 批量翻译队列 ──────────────────────────────────────────

function enqueue(node) {
  if (!node) return;
  if (node.nodeType === 3 || node.nodeType === 1) queue.add(node);
  else if (node.nodeType === 11) for (const c of node.childNodes) queue.add(c);
  schedule();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(flush, 0);
}

function insideSkipped(node) {
  let el = node.parentElement;
  while (el) {
    if (SKIP_TAGS.has(el.tagName)) return true;
    el = el.parentElement;
  }
  return false;
}

function translateTextNode(node) {
  const raw = node.nodeValue;
  if (!raw || !CJK.test(raw)) return;
  if (insideSkipped(node)) return;
  const trimmed = raw.trim();
  if (!trimmed) return;
  const out = translate(trimmed);
  if (node.__dcpOut !== undefined && raw !== node.__dcpOut) {
    node.__dcpOrig = undefined;    // React 覆盖了我们写进去的译文：旧原文作废，按当前内容重新记录
    node.__dcpOut = undefined;
  }
  if (node.__dcpOrig === undefined) node.__dcpOrig = raw;    // 记住原文：切语言时先还原
  const want = out !== trimmed
    ? raw.slice(0, raw.indexOf(trimmed)) + out + raw.slice(raw.indexOf(trimmed) + trimmed.length)
    : node.__dcpOrig;
  if (want !== raw && cjkCount(want) < cjkCount(raw)) {
    node.nodeValue = want;
    node.__dcpOut = want;    // 记录“我写进去的值”：还原时只有它没被 React 改过才回退
  }
}

function translateAttrs(el) {
  if (!el.getAttribute) return;
  for (const attr of ATTRS) {
    const cur = el.getAttribute(attr);
    if (cur === null || cur === undefined) continue;
    const store = '__dcpOrig_' + attr;
    if (el[store] === undefined) {
      if (!CJK.test(cur)) continue;
      el[store] = cur;
    }
    const want = translate(el[store]);
    if (cur !== want && cjkCount(want) < cjkCount(cur)) {
      el.setAttribute(attr, want);
      el['__dcpOut_' + attr] = want;
    }
  }
}

function processNode(node) {
  if (node.nodeType === 3) { translateTextNode(node); return; }
  if (node.nodeType !== 1) return;
  translateAttrs(node);
  if (SKIP_TAGS.has(node.tagName)) return;                    // textarea/script：只翻属性，不进正文
  for (const child of node.childNodes) {
    if (child.nodeType === 3 || child.nodeType === 1) queue.add(child);
  }
  schedule();
}

function flush() {
  scheduled = false;
  applying = true;
  try {
    let n = 0;
    for (const node of [...queue]) {
      queue.delete(node);
      processNode(node);
      if (++n >= CHUNK) break;
    }
  } finally {
    applying = false;
  }
  if (queue.size) schedule();
}

/**
 * 把之前翻译过的文本/属性还原成原文（切语言时先还原，再按新词典翻一遍）。
 * 关键点：只有“当前值仍等于翻译器写进去的值”时才回退 —— 否则说明 React
 * 已经用自己的新内容覆盖过这个节点，此时旧原文已失效，直接丢弃记录，
 * 让它作为全新源文本被重新翻译（避免把 React 的中文界面文本改回更旧的中文）。
 */
function restoreText(node) {
  if (node.__dcpOrig === undefined) return;
  if (node.nodeValue === node.__dcpOut) {
    node.nodeValue = node.__dcpOrig;
    node.__dcpOut = undefined;
  } else {
    node.__dcpOrig = undefined;
    node.__dcpOut = undefined;
  }
}

function restoreAttrs(el) {
  if (!el.getAttribute) return;
  for (const attr of ATTRS) {
    const store = '__dcpOrig_' + attr;
    const outStore = '__dcpOut_' + attr;
    if (el[store] === undefined) continue;
    if (el.getAttribute(attr) === el[outStore]) {
      el.setAttribute(attr, el[store]);
      el[outStore] = undefined;
    } else {
      el[store] = undefined;
      el[outStore] = undefined;
    }
  }
}

function restoreRoot(root) {
  if (!root) return;
  if (root.nodeType === 3) { restoreText(root); return; }
  if (root.nodeType === 1) restoreAttrs(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let n = walker.nextNode();
  while (n) {
    if (n.nodeType === 3) restoreText(n);
    else if (n.nodeType === 1) restoreAttrs(n);
    n = walker.nextNode();
  }
}

/** 对一棵子树（面板根）安装翻译：立即入队 + MutationObserver 兜住后续渲染。 */
export function installTranslator(root) {
  if (!root) return () => {};
  enqueue(root);
  if (!state.observer) {
    state.observer = new MutationObserver((records) => {
      if (applying) return;
      for (const rec of records) {
        if (rec.type === 'characterData') enqueue(rec.target);
        else if (rec.type === 'attributes') enqueue(rec.target);
        else rec.addedNodes.forEach((n) => enqueue(n));
      }
    });
  }
  state.observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  state.roots.add(root);
  return () => {
    if (state.observer) state.observer.unobserve(root);
    state.roots.delete(root);
    queue.delete(root);
  };
}

/** 语言切换后调用：先还原原文，再按新词典重新排队翻译。 */
export function retranslateAll() {
  for (const r of state.roots) {
    restoreRoot(r);
    enqueue(r);
  }
}
