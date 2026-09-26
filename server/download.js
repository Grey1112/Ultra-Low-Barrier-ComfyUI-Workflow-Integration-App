// F3 下载策略：官方源优先 → 连接失败（超时）或速度持续过低 → 自动切镜像（并向用户提示）。
//
// 判定参数全部来自设置（download.officialTimeoutMs / slowThresholdKBs / slowWindowMs /
// hfMirror / githubProxies），因此"官方源直连是否可用"这件事不写死在代码里。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const fsx = require('./util/fsx');
const log = require('./util/log');

// ── v1.2.0：下载前"逐个源测速 → 选最快的那个稳定使用" ────────────────
// 用户要求：安装过程中每个源都尝试一次，测出下载速度最高的源后稳定用它（别在慢源上反复切换）。
// 与原有三条换源规则的关系：测速只是**决定起始顺序**；下载中途若发生停滞/变慢，仍按原规则换到
// 下一个候选（测速排名已把备选也排好序），所以"能下完"这件事没有被削弱。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) comfy-panel-standalone/1.2';
const PROBE_BYTES = 1 << 20;              // 每个源探 1 MiB
const PROBE_CAP_MS = 6000;                // 或最多 6 s（谁先到算谁）
const PROBE_MIN_FILE = 8 << 20;           // 文件 < 8 MiB 就不值得先探（探测开销相对太大）
const PREFER_TTL_MS = 10 * 60 * 1000;     // 同一"来源家族"内 10 分钟内沿用上次测得的最快源
const preferByFamily = new Map();         // familyKey → { url, via, mbps, at }

/** 来源家族：同主机 + 同目录前缀（同一批镜像/同一仓库的不同文件算一家，测一次就够）。 */
function familyKeyOf(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\/[^/]*$/, '');
  } catch { return String(url); }
}

function preferredFor(key) {
  const p = preferByFamily.get(key);
  if (!p) return null;
  if (Date.now() - p.at > PREFER_TTL_MS) { preferByFamily.delete(key); return null; }
  return p;
}

/** 探一个候选源：读满 PROBE_BYTES 或到 PROBE_CAP_MS 就收手（不落盘），返回实测 MB/s。 */
async function probeSpeed(url) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  let got = 0;
  let firstByteMs = 0;
  const headers = { 'user-agent': UA, accept: '*/*', Range: `bytes=0-${PROBE_BYTES - 1}` };
  try {
    const connectTimer = setTimeout(() => ctrl.abort(new Error('连接超时')), 8000);
    let res;
    try { res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal }); }
    finally { clearTimeout(connectTimer); }
    if (!res.ok && res.status !== 206) {
      return { ok: false, status: res.status, error: 'HTTP ' + res.status, got, mbps: 0, firstByteMs: Date.now() - t0 };
    }
    firstByteMs = Date.now() - t0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('停滞')), PROBE_CAP_MS)),
      ]);
      if (done) break;
      got += value ? value.length : 0;
      if (got >= PROBE_BYTES || Date.now() - t0 > PROBE_CAP_MS) { try { await reader.cancel(); } catch { /* 忽略 */ } break; }
    }
    const sec = Math.max(0.001, (Date.now() - t0) / 1000);
    return { ok: got > 0, status: res.status, got, sec, firstByteMs, mbps: (got / 1e6) / sec };
  } catch (e) {
    const sec = Math.max(0.001, (Date.now() - t0) / 1000);
    const reason = (ctrl.signal && ctrl.signal.reason && ctrl.signal.reason.message) || (e && e.message) || String(e);
    return { ok: false, error: reason, got, sec, firstByteMs, mbps: got ? (got / 1e6) / sec : 0 };
  }
}

/**
 * 把候选源按实测速度就地重排，并记住这个"来源家族"里最快的是谁。
 * 返回 true 表示真的测过（顺序被改过）。跳过的情况都会明确说明原因（不静默）。
 */
async function pickFastest(candidates, { name, say, expectBytes, disabled } = {}) {
  if (disabled || !Array.isArray(candidates) || candidates.length < 2) return false;
  const log2 = typeof say === 'function' ? say : (m, l) => log.info(m);
  const key = familyKeyOf(candidates[0].url);
  const remembered = preferredFor(key);
  if (remembered) {
    // 按"来源家族"匹配（同一主机的同一目录），所以下一个文件名不同也能命中
    const i = candidates.findIndex((c) => familyKeyOf(c.url) === remembered.winnerFamily);
    if (i > 0) {
      const [hit] = candidates.splice(i, 1);
      candidates.unshift(hit);
      log2(`${name}：沿用上次实测最快的来源 ${hit.via || hit.source}（${remembered.mbps.toFixed(2)} MB/s，10 分钟内不重复测速）`);
      return false;
    }
  }
  if (expectBytes && expectBytes < PROBE_MIN_FILE) {
    log2(`${name}：文件较小（${fsx.fmtBytes(expectBytes)}），跳过逐源测速，按候选顺序下载`);
    return false;
  }
  log2(`${name}：先给 ${candidates.length} 个候选源各测一段（约 ${PROBE_BYTES / 1048576} MiB / 最多 ${PROBE_CAP_MS / 1000} s），再按实测速度选最快的稳定使用…`);
  const rows = [];
  for (const c of candidates) {
    const r = await probeSpeed(c.url);
    rows.push({ cand: c, r });
    const label = c.source === 'official' ? '官方源' : (c.via || c.source);
    log2(`  测速 ${label}：` + (r.ok
      ? `${r.mbps.toFixed(2)} MB/s（首字节 ${r.firstByteMs} ms）`
      : `失败（${r.error || ('HTTP ' + r.status)}）`), r.ok ? 'info' : 'warn');
  }
  const good = rows.filter((x) => x.r.ok && x.r.mbps > 0).sort((a, b) => b.r.mbps - a.r.mbps);
  if (!good.length) {
    log2(`${name}：所有候选源测速都没拿到数据，回落到原有换源规则逐个重试`, 'warn');
    return false;
  }
  const order = good.map((x) => x.cand).concat(rows.filter((x) => !(x.r.ok && x.r.mbps > 0)).map((x) => x.cand));
  candidates.length = 0;
  for (const c of order) candidates.push(c);
  const best = order[0];
  preferByFamily.set(key, { winnerFamily: familyKeyOf(best.url), via: best.via, source: best.source, mbps: good[0].r.mbps, at: Date.now() });
  log2(`${name}：选中最快来源 ${best.source === 'official' ? '官方源' : (best.via || best.source)}（实测 ${good[0].r.mbps.toFixed(2)} MB/s）；本轮后续文件也优先用它`, 'ok');
  return true;
}

/** 判断 URL 属于哪个上游，并据此生成候选来源列表（官方源在前，镜像在后）。
 *
 * 镜像本身是**数据**（settings.download.hfMirrors / githubProxies / nodeMirrors / extraMirrors），
 * 不写死在代码里：换镜像 = 改设置，不需要改代码。模板占位符：
 *   {url}    原始直链整体          {repo}   owner/name
 *   {owner}  owner                 {name}   name
 *   {rev}    revision（默认 main） {path}   resolve/<rev>/ 之后的路径
 *   {file}   文件名                {ver}    版本/标签（Node 的 v22.14.0、GitHub Release 的 tag）
 *   {host}   原始主机名
 */
const HF_HOST = /(^|\.)(huggingface\.co|hf\.co|hf-mirror\.com|aifasthub\.com|modelscope\.(cn|com)|aihub\.caict\.ac\.cn)$/i;
const GH_HOST = /(^|\.)(github\.com|githubusercontent\.com|codeload\.github\.com|api\.github\.com)$/i;
const NODE_HOST = /(^|\.)(nodejs\.org|npmmirror\.com|tsinghua\.edu\.cn|huaweicloud\.com|ustc\.edu\.cn)$/i;

/** 从"模型仓库直链"里解析出 owner/name/rev/path，兼容 HF 与 ModelScope/aifasthub 两种写法。 */
function parseModelUrl(u) {
  const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const p = parts[0] === 'models' ? parts.slice(1) : parts;   // ModelScope 多一层 /models/
  const ri = p.indexOf('resolve');
  if (ri < 2) return null;
  const rev = p[ri + 1] || 'main';
  const rest = p.slice(ri + 2).join('/');
  if (!rest) return null;
  const file = rest.split('/').filter(Boolean).pop() || '';
  return { owner: p[ri - 2], name: p[ri - 1], repo: `${p[ri - 2]}/${p[ri - 1]}`, rev, path: rest, file };
}

/** 从 GitHub Release 资产链接里解析 owner/name/tag/file。 */
function parseReleaseUrl(u) {
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], repo: `${m[1]}/${m[2]}`, ver: m[3], file: m[4].split('/').filter(Boolean).pop() || '' };
}

/** 从 Node 分发链接里解析 ver/file（nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip）。 */
function parseNodeUrl(u) {
  const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const vi = parts.findIndex((s) => /^v\d+\.\d+/.test(s));
  if (vi < 0) return null;
  const file = parts.slice(vi + 1).join('/');
  if (!file) return null;
  return { ver: parts[vi], file };
}

/** 从 jsDelivr 的 GitHub 链接里解析 owner/name/rev/path（/gh/<owner>/<repo>@<ref>/<path>）。 */
function parseJsdelivrUrl(u) {
  const m = u.pathname.match(/^\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.+)$/);
  if (!m) return null;
  return { owner: m[1], name: m[2], repo: `${m[1]}/${m[2]}`, rev: m[3], path: m[4], file: m[4].split('/').pop() };
}

function fillTemplate(tpl, info) {
  return String(tpl)
    .replace(/\{url\}/g, info.url || '')
    .replace(/\{repo\}/g, info.repo || '')
    .replace(/\{owner\}/g, info.owner || '')
    .replace(/\{name\}/g, info.name || '')
    .replace(/\{path\}/g, info.path || '')
    .replace(/\{file\}/g, info.file || '')
    .replace(/\{rev\}/g, info.rev || 'main')
    .replace(/\{ver\}/g, info.ver || '')
    .replace(/\{host\}/g, info.host || '');
}

function buildCandidates(url, settings, opts) {
  const s = settings || {};
  const d = s.download || {};
  const proxies = Array.isArray(d.githubProxies) ? d.githubProxies.filter(Boolean) : [];
  const hfMirrors = Array.isArray(d.hfMirrors) ? d.hfMirrors.filter(Boolean) : [];
  const nodeMirrors = Array.isArray(d.nodeMirrors) ? d.nodeMirrors.filter(Boolean) : [];
  const jsdelivrMirrors = Array.isArray(d.jsdelivrMirrors) ? d.jsdelivrMirrors.filter(Boolean) : [];
  const extras = Array.isArray(d.extraMirrors) ? d.extraMirrors.filter(Boolean) : [];
  let u;
  try { u = new URL(url); } catch { return [{ url, source: 'official', via: '' }]; }

  const out = [{ url, source: 'official', via: '' }];
  const seen = new Set([url, u.href]);
  const push = (candUrl, via) => {
    if (!candUrl) return;
    let key = candUrl;
    try { key = new URL(candUrl).href; } catch { return; }
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: key, source: 'mirror', via });
  };
  const host = u.host.toLowerCase();
  const info = { url, host, owner: '', name: '', repo: '', rev: '', path: '', file: '', ver: '' };
  Object.assign(info, parseModelUrl(u) || {}, parseReleaseUrl(u) || {}, parseNodeUrl(u) || {}, parseJsdelivrUrl(u) || {});

  const tplHost = (tpl) => { try { return new URL(fillTemplate(tpl, info)).host.toLowerCase(); } catch { return ''; } };

  if (HF_HOST.test(host)) {
    // 大权重（HF 系仓库）：走 hfMirrors 梯队。实测 ModelScope / aifasthub 最快，
    // hf-mirror 限速严重所以排最后。仓库在某个镜像上不存在时该镜像会直接 404，自然跳到下一个。
    if (info.repo && info.path) {
      for (const tpl of hfMirrors) {
        // opts.noModelScope：调用方已知该仓库在 ModelScope 上没有镜像（推荐目录里的
        // modelscope:false），就别再去撞一串 404 —— 实测会多花十几秒并把错误报告刷得看不懂。
        if (opts && opts.noModelScope && /modelscope\./i.test(tpl)) continue;
        const h = tplHost(tpl);
        if (h && h === host) continue;      // 模板指回原站：没意义
        push(fillTemplate(tpl, info), h.replace(/^www\./, ''));
      }
    }
  } else if (GH_HOST.test(host)) {
    // GitHub（Release 资产 / raw / codeload / API）：代理前缀 + 原链接。
    // 条目可以写成两种形式：
    //   · 前缀式（无占位符）'https://gh-proxy.com/'      → https://gh-proxy.com/<原链接>
    //   · 模板式（有占位符）'https://kkgithub.com/{repo}/releases/download/{ver}/{file}'
    //     —— 用于"换主机"型代理（kkgithub/bgithub 之类）。
    for (const p of proxies) {
      const tpl = /\{[a-z]+\}/.test(p) ? p : (p.endsWith('/') ? p : p + '/') + '{url}';
      const h = tplHost(tpl);
      if (!h) continue;
      push(fillTemplate(tpl, info), h.replace(/^www\./, ''));
    }
  } else if (/(^|\.)jsdelivr\.net$/i.test(host)) {
    // jsDelivr 的 GitHub 通道：换 CDN 节点 + 回落到 raw.githubusercontent（再叠加 GitHub 代理）。
    if (info.repo && info.path) {
      for (const tpl of jsdelivrMirrors) {
        const h = tplHost(tpl);
        if (h && h === host) continue;
        push(fillTemplate(tpl, info), h.replace(/^www\./, ''));
      }
    }
  } else if (NODE_HOST.test(host)) {
    // Node 便携包：按 nodeMirrors 模板换主机（{ver}/{file} 由原链接推出）。
    if (info.ver && info.file) {
      for (const tpl of nodeMirrors) {
        const h = tplHost(tpl);
        if (h && h === host) continue;
        push(fillTemplate(tpl, info), h.replace(/^www\./, ''));
      }
    }
  }

  for (const tpl of extras) {
    const filled = fillTemplate(tpl, info);
    const h = tplHost(tpl);
    if (h && h === host) continue;
    push(filled, h.replace(/^www\./, '') || 'extra');
  }
  return out;
}

/**
 * 把用户粘贴的"网页链接"规范成可下载的直链：
 *   · HuggingFace:  /blob/<rev>/<path>  → /resolve/<rev>/<path>
 *   · ModelScope:   /models/<o>/<r>/file/view/<rev>/<path> → /models/<o>/<r>/resolve/<rev>/<path>
 *   · 已经是直链的保持原样（含 hf-mirror / resolve）。
 * 这样"在 ModelScope 上找到模型 → 复制浏览器地址 → 粘贴下载"也能直接用（国内常用路径）。
 */
function normalizeDownloadUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return s;
  let out = s;
  // HF blob → resolve
  out = out.replace(/(huggingface\.co|hf-mirror\.com)\/([^/]+)\/([^/]+)\/blob\//, '$1/$2/$3/resolve/');
  // ModelScope file/view → resolve
  out = out.replace(/(modelscope\.cn|modelscope\.com)\/models\/([^/]+)\/([^/]+)\/file\/view\//, '$1/models/$2/$3/resolve/');
  // ModelScope 旧式 ?Revision=master&FilePath=xxx
  if (/modelscope\.(cn|com)\/models\/[^/]+\/[^/]+\?/i.test(out)) {
    try {
      const u = new URL(out);
      const rev = u.searchParams.get('Revision') || 'master';
      const fp = u.searchParams.get('FilePath');
      const m = u.pathname.match(/^\/models\/([^/]+)\/([^/]+)/);
      if (fp && m) out = `${u.origin}/models/${m[1]}/${m[2]}/resolve/${rev}/${fp}`;
    } catch { /* 保持原样 */ }
  }
  return out;
}

function humanSpeed(bytesPerSec) {
  const kbs = bytesPerSec / 1024;
  if (kbs < 1024) return kbs.toFixed(0) + ' KB/s';
  return (kbs / 1024).toFixed(2) + ' MB/s';
}

/**
 * 下载一个文件到 dest。
 * @param {object} o
 * @param {string} o.url            官方 URL（镜像由 buildCandidates 推导）
 * @param {string} o.dest           目标文件路径
 * @param {object} [o.job]          jobs.js 的 job（用于进度播报）
 * @param {string} [o.phase]        进度事件里的 phase 名
 * @param {number} [o.expectBytes]  期望字节数（校验用）
 * @param {string} [o.sha256]       期望 sha256（校验用，可选）
 * @param {string} [o.label]        人话名称（日志/进度用）
 * @param {object} [o.settings]     设置（镜像与阈值）
 * @returns {Promise<{file:string,bytes:number,source:string,via:string,url:string,ms:number,skipped:boolean}>}
 */
async function download(o) {
  const { dest, job, expectBytes, sha256, label } = o;
  const settings = o.settings || {};
  const phase = o.phase || 'download';
  const name = label || path.basename(dest);
  const say = (msg, level = 'info') => {
    if (job) job.emit({ phase, message: msg, level });
    else log.info(msg);
  };

  // 已就绪（大小匹配）直接跳过——安装器可反复运行。
  if (!o.force && expectBytes && fsx.isFile(dest) && fsx.sizeOf(dest) === expectBytes) {
    say(`已存在且大小匹配，跳过：${name}（${fsx.fmtBytes(expectBytes)}）`, 'ok');
    return { file: dest, bytes: expectBytes, source: 'cache', via: '', url: '', ms: 0, skipped: true };
  }

  fsx.ensureDir(path.dirname(dest));
  const sourceUrl = normalizeDownloadUrl(o.url);
  // o.urlsFirst：调用方**实测过很快**的镜像，插在官方源之后、模板梯队之前先试。
  // o.urls：其余已验证镜像，去重后追加在模板梯队之后兜底。
  // 两者都来自 installer/*.json 的 mirrors 数组与 url 字段，保证每个组件都有多个独立来源。
  const declaredFirst = (Array.isArray(o.urlsFirst) ? o.urlsFirst : []).map((x) => normalizeDownloadUrl(x)).filter(Boolean);
  const declared = (Array.isArray(o.urls) ? o.urls : []).map((x) => normalizeDownloadUrl(x)).filter(Boolean);
  const candidates = buildCandidates(sourceUrl, settings, o);
  const seenUrls = new Set(candidates.map((c) => { try { return new URL(c.url).href; } catch { return c.url; } }));
  const asCandidate = (durl, declaredFlag) => {
    let key = durl;
    try { key = new URL(durl).href; } catch { /* 原样比较 */ }
    if (seenUrls.has(key)) return null;
    seenUrls.add(key);
    let via = '';
    try { via = new URL(key).host.replace(/^www\./, ''); } catch { via = 'declared'; }
    return { url: key, source: 'mirror', via, declared: declaredFlag };
  };
  // 官方源之后立刻插入"优先镜像"
  const head = candidates.shift();
  for (const durl of declaredFirst) {
    const c = asCandidate(durl, true);
    if (c) candidates.push(c);
  }
  candidates.unshift(head);
  for (const durl of declared) {
    const c = asCandidate(durl, true);
    if (c) candidates.push(c);
  }
  // 把候选来源明确打进任务日志（排障时一眼看出"到底试了哪些源"）
  if (job) {
    job.emit({ phase, level: 'info', message: `${name} 候选来源 ${candidates.length} 个：` + candidates.map((c) => (c.source === 'official' ? '官方源' : c.via)).join(' → ') });
  }
  // v1.2.0：先逐源测一段，把最快的排到最前（并在 10 分钟内记住它）；o.noProbe 可显式关掉。
  await pickFastest(candidates, { name, say, expectBytes, disabled: o.noProbe === true });
  const timeoutMs = settings.download?.officialTimeoutMs || 10000;
  const startDeadlineMs = settings.download?.startDeadlineMs || 10000;
  const stallDeadlineMs = settings.download?.stallDeadlineMs || 15000;
  const slowKBs = settings.download?.slowThresholdKBs || 200;
  const slowWindowMs = settings.download?.slowWindowMs || 30000;
  // 停滞阈值：真正"没有进展"的门槛。国内网络下镜像常年只有一两百 KB/s，
  // 如果按 slowThreshold 一路判慢就会把所有源都试一遍然后失败 —— 所以最后一个候选
  // 只按"停滞"判（还在动就把它下完），前面几个候选才按 slowThreshold 竞争换源。
  const stallKBs = settings.download?.stallKBs || 30;
  const attempts = [];
  let lastErr = null;
  let switchedNotice = false;
  // 本次下载里**见过的最快窗口均速**（KB/s）。用途见 attempt() 里的"远慢于已知好源"规则：
  // 实测踩到过 aifasthub 稳定在 200~207 KB/s（刚好卡在 slowThreshold 之上），
  // 而同一个文件 30 秒前在 ModelScope 上有 2.6 MB/s —— 只看绝对阈值就会在这里白等 20 分钟。
  let bestKBs = 0;

  const candList = candidates;
  for (let ci = 0; ci < candList.length; ci++) {
    const cand = candList[ci];
    const isLast = ci === candList.length - 1;
    if (cand.source === 'mirror' && attempts.length > 0 && !switchedNotice) {
      say(`${name}：官方源不可用（已重试），本次改用镜像来源 ${cand.via} —— 可在「设置 → 下载」里调整镜像与阈值`, 'warn');
      switchedNotice = true;
    }
    for (let round = 1; round <= 2; round++) {
      const tag = cand.source === 'official' ? '官方源' : `镜像 ${cand.via}`;
      try {
        const r = await attempt(cand, {
          dest, timeoutMs, startDeadlineMs, stallDeadlineMs, slowKBs: isLast ? stallKBs : slowKBs, slowWindowMs, expectBytes, name, say, phase, job, round, isLast,
          index: ci + 1, total: candList.length,
        });
        if (expectBytes && r.bytes !== expectBytes) {
          throw new Error(`大小不符：期望 ${expectBytes}，实际 ${r.bytes}`);
        }
        if (sha256) {
          say(`校验 sha256：${name}`, 'info');
          const got = await fsx.sha256File(dest, (done) => {
            if (job && expectBytes) job.emitPercent(phase, (done / expectBytes) * 100, `校验中 ${name}`);
          });
          if (got.toLowerCase() !== sha256.toLowerCase()) {
            fs.rmSync(dest, { force: true });
            throw new Error(`sha256 校验失败：期望 ${sha256.slice(0, 16)}…，实际 ${got.slice(0, 16)}…（文件已删除，请重试）`);
          }
        }
        say(`${name} 下载完成：${fsx.fmtBytes(r.bytes)}（${tag}，用时 ${(r.ms / 1000).toFixed(1)} s）`, 'ok');
        return { file: dest, bytes: r.bytes, source: cand.source, via: cand.via, url: cand.url, ms: r.ms, skipped: false };
      } catch (e) {
        lastErr = e;
        attempts.push(`${tag}#${round}: ${e.message}`);
        say(`${name} ← ${tag} 失败（第 ${round} 次）：${e.message}`, 'warn');
      }
    }
  }
  const detail = attempts.map((a) => '  · ' + a).join('\n');
  throw new Error(`下载失败：${name}\n已尝试的来源与结果：\n${detail}\n（可在「设置 → 下载」里调整镜像与超时阈值）`);

  async function attempt(cand, ctx) {
    const part = dest + '.part';
    let startAt = 0;
    if (fsx.isFile(part)) startAt = fsx.sizeOf(part);
    // 请求头：
    //   · User-Agent 必须带 —— 实测不带 UA 时 ModelScope 的 CDN 会"连上但不吐数据"（0 字节卡死）；
    //   · Range 一律带（bytes=0- 等价于全量）—— ModelScope / hf-mirror 对 Range 请求才稳定返回 206 流，
    //     顺带天然支持断点续传。
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) comfy-panel-standalone/1.0',
      accept: '*/*',
      Range: `bytes=${startAt}-`,
    };
    const ctrl = new AbortController();
    // 计时从"发出请求"开始，而不是从"收到响应头"开始 —— 用户要的是"10 秒内没正常下载就换源"，
    // 连接慢、TLS 握手慢、只回响应头不吐数据，都算"没正常下载"。
    const reqStartedAt = Date.now();
    const firstByteBudgetMs = Math.min(ctx.timeoutMs, ctx.startDeadlineMs);
    const connectTimer = setTimeout(() => ctrl.abort(new Error(`连接/首字节超时（${Math.round(firstByteBudgetMs / 1000)} s 内没有可用响应，已换源）`)), firstByteBudgetMs);
    let res;
    try {
      res = await fetch(cand.url, { headers, redirect: 'follow', signal: ctrl.signal });
    } catch (e) {
      clearTimeout(connectTimer);
      // 已有部分数据的情况下，重试时不用 Range（部分服务器不支持续传）
      if (startAt > 0) { fs.rmSync(part, { force: true }); ctx.say(`${ctx.name}：续传失败，已丢弃断点重下`, 'warn'); }
      throw new Error((e && e.message) ? e.message : String(e));
    }
    clearTimeout(connectTimer);
    if (!res.ok && res.status !== 206) {
      if (startAt > 0 && res.status === 416) { fs.rmSync(part, { force: true }); }
      throw new Error('HTTP ' + res.status);
    }
    // 服务器忽略 Range 时（返回 200）必须从 0 重写，不能追加。
    const resumed = res.status === 206;
    if (!resumed && startAt > 0) { startAt = 0; fs.rmSync(part, { force: true }); }
    const lenHeader = Number(res.headers.get('content-length') || 0);
    const total = expectBytes || (resumed ? startAt + lenHeader : lenHeader) || 0;
    const t0 = Date.now();
    let got = startAt;
    let windowStart = Date.now();
    let windowBytes = got;
    const ws = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
    const rs = require('node:stream').Readable.fromWeb(res.body);
    // **字节计数必须挂在一个 Transform 上，不能用 'data' 监听**：
    //   · 加 'data' 监听会把流切到 flowing 模式，绕过 pipeline 的背压；
    //   · 而计数一旦缺失，进度恒为 0%、速度恒为 0（用户报的"速度一直显示 0"就是这个），
    //     更糟的是"没有数据就判死"的看门狗会因为 got 永远是 0 而把正常下载掐掉。
    // 这个 bug 在真实下载里藏了很久（文件确实下下来了，所以只看结果看不出来），
    // 是本轮"10 秒内没有进展就换源"规则把每个源都判成 0 字节才暴露出来的。
    const counter = new (require('node:stream').Transform)({
      transform(chunk, _enc, cb) { got += chunk.length; cb(null, chunk); },
    });
    let aborted = null;
    const die = (err) => {
      if (aborted) return;
      aborted = err;
      try { ctrl.abort(err); } catch { /* ignore */ }
      // 关键：卡死的 body 有时不理会 abort，直接销毁两端流才能让 pipeline 立刻拒绝，
      // 否则任务会永远停在 0 字节（实测踩过）。
      try { rs.destroy(err); } catch { /* ignore */ }
      try { ws.destroy(err); } catch { /* ignore */ }
    };

    // 慢速判定用**窗口平均值**而不是瞬时采样：镜像常见"停顿几秒再冲一段"的突发式传输，
    // 瞬时采样会误判成"持续低速"然后把本来能下完的文件掐掉。
    // 显示用的速度另算：近 5 秒滑动窗口（displaySamples），与"慢速判定窗口"解耦 ——
    // 判定窗口可以长到 30 s，但界面上的速度必须是"现在有多快"，否则一开头永远是 0。
    const samples = [{ t: Date.now(), bytes: got }];
    const displaySamples = [{ t: Date.now(), bytes: got }];
    const minStartBytes = ctx.minStartBytes || 65536;
    let lastProgressAt = reqStartedAt;       // 最近一次"真的收到新字节"的时间
    let lastSeen = got;
    // 排障开关（DCP_DL_DEBUG=1）：把每次采样的字节数打出来。默认关闭，不影响正常下载。
    const dbg = process.env.DCP_DL_DEBUG === '1';
    if (dbg) console.log(`[dl] ${cand.url} → status=${res.status} resumed=${resumed} startAt=${startAt} total=${total} len=${lenHeader}`);
    const tick = setInterval(() => {
      const now = Date.now();
      if (got > lastSeen) { lastProgressAt = now; lastSeen = got; }
      if (dbg) console.log(`[dl]   t=${Math.round((now - reqStartedAt))}ms got=${got} (+${got - startAt})`);
      samples.push({ t: now, bytes: got });
      const cutoff = now - (ctx.slowWindowMs || 30000);
      while (samples.length > 2 && samples[0].t < cutoff) samples.shift();
      const oldest = samples[0];
      const spanSec = Math.max(0.001, (now - oldest.t) / 1000);
      const avg = (got - oldest.bytes) / spanSec;
      const inst = (got - windowBytes) / Math.max(0.001, (now - windowStart) / 1000);
      windowStart = now;
      windowBytes = got;
      // 显示用：近 5 秒窗口均速（首帧没有数据时给 null，前端显示"等待数据…"而不是 0）
      displaySamples.push({ t: now, bytes: got });
      while (displaySamples.length > 2 && displaySamples[0].t < now - 5000) displaySamples.shift();
      const dOld = displaySamples[0];
      const dSpan = Math.max(0.001, (now - dOld.t) / 1000);
      const recent = got > dOld.bytes ? (got - dOld.bytes) / dSpan : 0;
      const started = got > startAt;
      const sinceProgressSec = Math.round((now - lastProgressAt) / 1000);
      const etaSec = (total && recent > 1024) ? Math.max(0, Math.round((total - got) / recent)) : null;
      if (ctx.job && total) {
        ctx.job.emitPercent(phase, (got / total) * 100,
          `${ctx.name} ${fsx.fmtBytes(got)}/${fsx.fmtBytes(total)}（窗口均速 ${humanSpeed(avg)}，瞬时 ${humanSpeed(inst)}）`,
          started ? 'info' : 'warn',
          {
            downloaded: got, total,
            speedKBs: started ? recent / 1024 : null,          // 数值速度：前端直接显示，不再从文案里抠
            instantKBs: started ? inst / 1024 : null,
            windowKBs: avg / 1024,
            etaSec,
            waiting: !started,                                  // 连上了但还没吐数据
            sinceProgressSec,
            candidate: cand.via || cand.source || 'official',
            candidateIndex: ctx.index, candidateTotal: ctx.total,
            elapsedSec: Math.round((now - reqStartedAt) / 1000),
          });
      }
      // ── 规则一（用户要求）：**10 秒内没有正常开始下载就换源** ──────────────
      // 计时从"发出请求"开始；判定门槛是"至少收到 minStartBytes（默认 64 KiB）"，
      // 因为有些站会先回一个几百字节的 JS 校验页/错误页，那不算"开始下载"。
      if (got - startAt < minStartBytes && now - reqStartedAt > ctx.startDeadlineMs) {
        die(new Error(`连接已建立但 ${Math.round(ctx.startDeadlineMs / 1000)} s 内只收到 ${fsx.fmtBytes(got - startAt)}（不足 ${fsx.fmtBytes(minStartBytes)}），已换源`));
        return;
      }
      // ── 规则二：下载中途连续 stallDeadlineMs 没有任何新字节 → 换源 ─────────
      // 这条对所有候选都生效（包括最后一个），因为"完全不动"就是坏源。
      if (started && now - lastProgressAt > ctx.stallDeadlineMs) {
        die(new Error(`下载中断：连续 ${Math.round(ctx.stallDeadlineMs / 1000)} s 没有收到任何新数据（已下 ${fsx.fmtBytes(got)}），已换源`));
        return;
      }
      // 只有在"整个窗口都覆盖满 且 窗口均速低于阈值"时才判定为慢速并切换来源。
      // 阈值取**本候选**的（最后一个候选只用停滞阈值，避免所有源都慢时把能下完的文件掐掉）。
      const thresholdKBs = ctx.slowKBs || slowKBs;
      const avgKBs = avg / 1024;
      if (avgKBs > bestKBs) bestKBs = avgKBs;
      if (spanSec * 1000 >= (ctx.slowWindowMs || 30000) && avg < thresholdKBs * 1024) {
        die(new Error(ctx.isLast
          ? `窗口均速持续低于停滞阈值 ${thresholdKBs} KB/s 超过 ${Math.round((ctx.slowWindowMs || 30000) / 1000)} s（窗口均速 ${humanSpeed(avg)}）`
          : `窗口均速持续低于 ${thresholdKBs} KB/s 超过 ${Math.round((ctx.slowWindowMs || 30000) / 1000)} s（窗口均速 ${humanSpeed(avg)}）`));
      }
      // 规则三：**远慢于本次已经见过的好源**就换源。
      // 绝对阈值管不了"刚好卡在阈值上"的源（实测 aifasthub 稳定 201 KB/s），
      // 但只要之前有任何一个候选跑到过 bestKBs，而现在这个连它的 1/4 都不到，就没有理由继续等。
      // 只对非最后一个候选生效，且必须跑满一个慢速窗口，避免突发式传输被误判。
      if (!ctx.isLast && bestKBs >= Math.max(slowKBs, 500) && avgKBs < bestKBs / 4
        && spanSec * 1000 >= (ctx.slowWindowMs || 30000)) {
        die(new Error(`窗口均速 ${humanSpeed(avg)} 远低于本次见过的最快来源（${bestKBs.toFixed(0)} KB/s），已换源`));
      }
    }, 1000);

    try {
      await pipeline(rs, counter, ws);
    } catch (e) {
      if (aborted) throw aborted;
      const msg = (e && e.message) ? e.message : String(e);
      throw new Error((ctrl.signal && ctrl.signal.aborted && ctrl.signal.reason && ctrl.signal.reason.message) ? ctrl.signal.reason.message : msg);
    } finally {
      clearInterval(tick);
    }
    if (aborted) throw aborted;
    const bytes = fsx.sizeOf(part);
    // **完整性检查必须在改名之前**：实测 ModelScope 的 CDN 会在传输中途直接关闭连接，
    // 此时 `Readable.fromWeb` 的流是"正常结束"，`pipeline` 不报错，文件却是截断的
    // （同一个 242 MB 文件出现过 126 MB / 121 MB / 112 MB / 3 MB 四种结果）。
    // 不在这里拦住的话：① 有 expectBytes 的调用方只是报"大小不符"，白下一次；
    // ② 没有 expectBytes 的调用方（例如直接给个直链）会**静默接受损坏文件** —— 这是红线。
    // 抛错时保留 .part，下一轮会用 Range 从断点续传，而不是从头再来。
    if (total > 0 && bytes < total) {
      throw new Error(`数据不完整：只收到 ${fsx.fmtBytes(bytes)} / 应有 ${fsx.fmtBytes(total)}（服务端提前关闭了连接，已保留断点）`);
    }
    fs.rmSync(dest, { force: true });
    fs.renameSync(part, dest);
    return { bytes, ms: Date.now() - t0 };
  }
}

/**
 * 镜像测速：对一条直链的**全部候选来源**各下载一段（默认 100 MiB，可用 bytes 调整）并报告速度。
 * 这是"10 秒无进展就换源"规则的可验证版本：结果直接告诉用户哪个源在本机可用。
 * 不写任何文件（数据读完即丢），因此可以随便点。
 * @returns {Promise<{url:string,bytes:number,items:Array,ok:number,usable:number}>}
 */
async function speedTest(rawUrl, settings, o) {
  const opts = o || {};
  const budget = Math.max(262144, Number(opts.bytes) || 104857600);   // 默认 100 MiB
  const perSourceCapMs = Math.max(5000, Number(opts.capMs) || 45000);
  const startDeadlineMs = settings?.download?.startDeadlineMs || 10000;
  const stallDeadlineMs = settings?.download?.stallDeadlineMs || 15000;
  const url = normalizeDownloadUrl(rawUrl);
  const cands = buildCandidates(url, settings, opts);
  const items = [];
  for (const cand of cands) {
    const item = { url: cand.url, source: cand.source, via: cand.via || (cand.source === 'official' ? 'official' : ''), ok: false };
    const ctrl = new AbortController();
    const headers = {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) comfy-panel-standalone/1.0',
      accept: '*/*',
      Range: `bytes=0-${budget - 1}`,
    };
    const t0 = Date.now();
    let got = 0;
    let lastProgress = t0;
    try {
      const connectTimer = setTimeout(() => ctrl.abort(new Error('连接/首字节超时')), Math.min(10000, startDeadlineMs));
      let res;
      try {
        res = await fetch(cand.url, { headers, redirect: 'follow', signal: ctrl.signal });
      } finally { clearTimeout(connectTimer); }
      item.status = res.status;
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
      item.firstByteMs = Date.now() - t0;
      // 手动读流：可以"读够 budget 就收手"，也能对每次读取加超时（有些服务器无视 abort）。
      const reader = res.body.getReader();
      const readOnce = () => Promise.race([
        reader.read(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`连续 ${Math.round(stallDeadlineMs / 1000)} s 读不到新数据`)), stallDeadlineMs)),
      ]);
      let finished = false;
      for (;;) {
        const { done, value } = await readOnce();
        if (done) { finished = true; break; }
        got += value ? value.length : 0;
        lastProgress = Date.now();
        if (got >= budget) { try { await reader.cancel(); } catch { /* 忽略 */ } break; }
        if (Date.now() - t0 > perSourceCapMs) throw new Error(`超过单源上限 ${Math.round(perSourceCapMs / 1000)} s（已收 ${(got / 1048576).toFixed(1)} MiB）`);
        if (got < 65536 && Date.now() - t0 > startDeadlineMs) throw new Error(`连接后 ${Math.round(startDeadlineMs / 1000)} s 内不足 64 KiB`);
      }
      const sec = (Date.now() - t0) / 1000;
      item.gotBytes = got;
      item.sec = Number(sec.toFixed(2));
      item.mbps = Number((got / 1e6 / Math.max(0.001, sec)).toFixed(2));
      // 判定"可用"：**整个文件读完**（小文件的情况，例如 0.6 MB 的 7zr.exe）或者收到 ≥1 MiB。
      // 早先只按"≥1 MiB"判，导致比 1 MiB 还小的文件即便完整下完也被判 ❌（实测踩到）。
      item.ok = got > 0 && (finished || got >= Math.min(1048576, budget));
      item.note = item.ok ? (finished ? '文件已读完' : '达到测试上限') : '数据量过少';
    } catch (e) {
      item.error = (ctrl.signal && ctrl.signal.reason && ctrl.signal.reason.message) || (e && e.message) || String(e);
      if (got) { item.gotBytes = got; item.sec = Number(((Date.now() - t0) / 1000).toFixed(2)); item.mbps = Number((got / 1e6 / Math.max(0.001, item.sec)).toFixed(2)); }
      // 被判失败但**其实收到了不少数据**：这类源只是慢，不是不能用（国内镜像常年一两百 KB/s）。
      // 单独打 partial 标记，让调用方（测速表/验收脚本）能区分"完全不可用"与"慢但能下"。
      if (got >= 8 * 1048576) { item.partial = true; item.note = '慢，但仍在下（达到单源上限）'; }
    }
    items.push(item);
  }
  const usable = items.filter((i) => i.ok).length;
  const partial = items.filter((i) => i.partial).length;
  return { url, bytes: budget, items, ok: usable, usable, partial, total: items.length };
}

/** 只做"哪个源可达"的探测（HEAD），用于设置页的"测试镜像"与下载前提示。 */
async function probe(url, settings, timeoutMs) {
  const cands = buildCandidates(url, settings);
  const results = [];
  for (const c of cands) {
    const t0 = Date.now();
    try {
      const r = await fetch(c.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(timeoutMs || settings?.download?.officialTimeoutMs || 10000) });
      results.push({ url: c.url, source: c.source, via: c.via, ok: r.ok, status: r.status, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ url: c.url, source: c.source, via: c.via, ok: false, status: 0, ms: Date.now() - t0, error: e.message });
    }
  }
  return results;
}

module.exports = { download, buildCandidates, probe, speedTest, normalizeDownloadUrl, probeSpeed, pickFastest, preferByFamily };
