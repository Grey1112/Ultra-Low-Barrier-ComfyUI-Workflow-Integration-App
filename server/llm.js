// 本地 LLM 提示词生成（F2）：llama.cpp 子进程管理 + 模型管理 + 对话（最多 N 条上下文）。
//
// 设计要点（全部对应需求）：
//   · 运行时是 llama.cpp 官方预编译单目录（CUDA 版优先、CPU 版兜底），放 runtime/bin/llama/
//   · 默认模型 = models/llm/ 下预置的 GGUF（完全版随项目携带；核心版不含，由向导下载/指认）
//   · 对话上下文只保留最近 N 条（N 来自设置，0–20，默认 5）；系统提示词永远取自
//     assets/templates/anima-system-prompt.txt 原文，不追加任何其它身份/工具内容
//   · "新开对话" = 删除服务端会话 + 关闭 prompt 缓存 + 擦除 llama.cpp 的 slot 缓存
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { paths, load, save } = require('./config');
const fsx = require('./util/fsx');
const characters = require('./characters');
const log = require('./util/log');
const zip = require('./util/zip');
const dl = require('./download');
const store = require('./store');

const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10';
const server = { child: null, port: null, model: null, startedAt: null, lastError: null };

/** 推荐模型目录（installer/llm-models.json）：字节数/许可以实测为准，见文件里的 verified 字段。 */
function catalog() {
  const list = fsx.readJson(path.join(paths.installer, 'llm-models.json'), []);
  if (!Array.isArray(list)) return [];
  const installed = new Set(listModels().items.map((m) => m.file));
  return list.map((m) => ({ ...m, installed: installed.has(m.file) }));
}

const runtimeExe = () => path.join(paths.runtimeBin, 'llama', 'llama-server.exe');
const runtimeDir = () => path.join(paths.runtimeBin, 'llama');

// ── 运行时安装 ───────────────────────────────────────────

function hasNvidiaGpu() {
  const r = spawnSync('nvidia-smi', ['-L'], { encoding: 'utf8' });
  return r.status === 0 && /GPU \d|NVIDIA/i.test(r.stdout || '');
}

async function fetchJson(url, settings) {
  for (const c of dl.buildCandidates(url, settings || load())) {
    try {
      const r = await fetch(c.url, { headers: { 'user-agent': 'comfy-panel-standalone' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch { /* 换下一个来源 */ }
  }
  return null;
}

/** 解析 llama.cpp 最新一个带 Windows 资产的 release，并挑选 cuda/cpu 包。 */
async function resolveRuntimeAssets(job) {
  const releases = await fetchJson(RELEASE_API);
  if (!Array.isArray(releases)) throw new Error('无法获取 llama.cpp 发布信息（GitHub 与镜像都不可达）。可手动把 llama-server.exe 放进 runtime/bin/llama/ 后重试。');
  for (const rel of releases) {
    const withSize = (a) => ({ name: a.name, size: a.size, url: `https://github.com/ggml-org/llama.cpp/releases/download/${rel.tag_name}/${a.name}` });
    const names = (rel.assets || []).map((a) => a.name);
    const cuda = (rel.assets || []).filter((a) => /^llama-b\d+-bin-win-cuda-[\d.]+-x64\.zip$/.test(a.name)).map(withSize).sort((a, b) => b.name.localeCompare(a.name));
    const cudart = (rel.assets || []).filter((a) => /^cudart-llama-bin-win-cuda-[\d.]+-x64\.zip$/.test(a.name)).map(withSize).sort((a, b) => b.name.localeCompare(a.name));
    const cpu = (rel.assets || []).filter((a) => /^llama-b\d+-bin-win-cpu-x64\.zip$/.test(a.name)).map(withSize);
    if (!cpu.length) continue;
    job.log(`llama.cpp 版本：${rel.tag_name}`);
    return { tag: rel.tag_name, cuda, cudart, cpu, names };
  }
  throw new Error('llama.cpp 最新发布里没有 Windows x64 资产');
}

function verifyRuntime(exe) {
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000 });
  const out = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const verLine = out.find((l) => /version|build/i.test(l)) || out[0] || '';
  return { ok: r.status === 0, version: verLine, status: r.status };
}

async function installRuntime(job, variant) {
  const settings = load();
  const want = variant === 'auto' ? (hasNvidiaGpu() ? 'cuda' : 'cpu') : variant;
  job.log(`目标运行时：${want}${variant === 'auto' ? '（自动探测：检测到 NVIDIA GPU 就用 CUDA 版，否则用 CPU 版）' : ''}`);
  const assets = await resolveRuntimeAssets(job);
  const order = [];
  if (want === 'cuda') {
    for (const c of assets.cuda) order.push({ kind: 'cuda', asset: c, cudart: assets.cudart[0] });
    order.push({ kind: 'cpu', asset: assets.cpu[0] });
  } else {
    order.push({ kind: 'cpu', asset: assets.cpu[0] });
  }

  const target = runtimeDir();
  let lastErr = null;
  for (const cand of order) {
    try {
      job.log(`获取 ${cand.asset.name} （${fsx.fmtBytes(cand.asset.size || 0)}）…`);
      const zf = path.join(paths.runtimeDl, cand.asset.name);
      await dl.download({ url: cand.asset.url, dest: zf, job, phase: 'llm', label: cand.asset.name, expectBytes: cand.asset.size, settings });
      fs.rmSync(target, { recursive: true, force: true });
      fsx.ensureDir(target);
      job.log('解压运行时…');
      zip.unzipTo(zf, target, null);
      // 某些发行包多包一层目录
      zip.hoistSingleRoot(target, (l) => job.log(l));
      let exe = runtimeExe();
      if (!fsx.isFile(exe)) {
        const found = findFile(target, 'llama-server.exe');
        if (found) exe = found;
      }
      if (!fsx.isFile(exe)) throw new Error('解压后未找到 llama-server.exe');

      // CUDA 版通常需要额外的 cudart 运行库
      if (cand.kind === 'cuda') {
        const needCudart = !fs.readdirSync(path.dirname(exe)).some((n) => /^cudart64.*\.dll$/i.test(n));
        if (needCudart && cand.cudart) {
          job.log('CUDA 版需要 cudart 运行库，继续获取 ' + cand.cudart.name + ' …');
          const cf = path.join(paths.runtimeDl, cand.cudart.name);
          await dl.download({ url: cand.cudart.url, dest: cf, job, phase: 'llm', label: cand.cudart.name, expectBytes: cand.cudart.size, settings });
          zip.unzipTo(cf, path.dirname(exe), null);
        }
      }
      const v = verifyRuntime(exe);
      if (!v.ok) throw new Error('运行时自检失败（llama-server --version 退出码 ' + v.status + '）：' + (v.version || '无输出'));
      job.log(`运行时就绪：${exe}｜${v.version}`, 'ok');
      return { exe, variant: cand.kind, version: v.version, tag: assets.tag };
    } catch (e) {
      lastErr = e;
      job.log(`${cand.kind} 版安装失败：${e.message}`, 'warn');
    }
  }
  throw new Error('llama.cpp 运行时安装失败：' + (lastErr ? lastErr.message : '未知错误'));
}

function findFile(root, name) {
  const stack = [root];
  while (stack.length) {
    const d = stack.shift();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
      if (e.isDirectory()) stack.push(p);
    }
  }
  return null;
}

// ── 模型管理 ─────────────────────────────────────────────

function listModels() {
  fsx.ensureDir(paths.llmModels);
  const meta = store.readLlmModels();
  const settings = load();
  const files = fs.readdirSync(paths.llmModels).filter((f) => /\.gguf$/i.test(f));
  // 默认项必须**真实存在**：手删文件、或迁移时没带上模型时自动回落到第一个可用模型，
  // 而不是让"默认模型文件不存在"变成一个死活起不来的状态（实测踩过一次）。
  const wanted = settings.llm.defaultModel || meta.default || (files.length ? files[0] : '');
  const def = files.includes(wanted) ? wanted : (files.length ? files[0] : '');
  const items = [];
  for (const f of files) {
    const full = path.join(paths.llmModels, f);
    const st = fs.statSync(full);
    const m = meta.items[f] || {};
    items.push({
      file: f,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      origin: m.origin || 'preset',
      abliterated: !!m.abliterated || /abliterated|uncensored|heretic/i.test(f),
      source: m.source || '',
      default: def === f,
    });
  }
  items.sort((a, b) => (b.default - a.default) || a.file.localeCompare(b.file));
  return { items, dir: paths.llmModels, default: def };
}

function setDefaultModel(file) {
  const full = path.join(paths.llmModels, file);
  if (!fsx.isFile(full)) throw new Error('模型文件不存在：' + file);
  save({ llm: { defaultModel: file } });
  store.upsertLlmModel(file, { origin: (store.readLlmModels().items[file] || {}).origin || 'preset' });
  store.writeLlmModels({ ...store.readLlmModels(), default: file });
  return { ok: true, default: file };
}

function addModel({ srcPath, mode }) {
  if (!srcPath) throw new Error('未提供本地模型路径');
  const abs = path.resolve(srcPath);
  if (!fsx.isFile(abs)) throw new Error('文件不存在：' + abs);
  if (!/\.gguf$/i.test(abs)) throw new Error('只接受 .gguf 文件');
  const name = path.basename(abs);
  const target = path.join(paths.llmModels, name);
  fsx.ensureDir(paths.llmModels);
  fs.rmSync(target, { force: true });
  let linked = false;
  if ((mode || 'link') === 'link') {
    try { fs.linkSync(abs, target); linked = true; } catch { linked = false; }
  }
  if (!linked) fs.copyFileSync(abs, target);
  store.upsertLlmModel(name, { origin: 'added', source: abs, addedAt: new Date().toISOString() });
  const meta = store.readLlmModels();
  if (!meta.default) setDefaultModel(name);
  log.info(`已添加 LLM 模型：${name}（${linked ? '硬链接' : '复制'}）`);
  return { item: { file: name, bytes: fsx.sizeOf(target), linked, source: abs }, linked };
}

function removeModel(file) {
  const target = path.join(paths.llmModels, file);
  if (!fsx.isFile(target)) throw new Error('模型文件不存在：' + file);
  fs.rmSync(target, { force: true });
  const meta = store.removeLlmModel(file);
  const s = load();
  if (s.llm.defaultModel === file) save({ llm: { defaultModel: meta.default || '' } });
  return { ok: true };
}

async function downloadModel(job, { url, name, sha256, bytes }) {
  if (!url) throw new Error('未提供下载地址');
  const fileName = (name && /\.gguf$/i.test(name)) ? name : (name || path.basename(new URL(url).pathname) || 'model.gguf');
  const file = path.basename(fileName);
  const target = path.join(paths.llmModels, file);
  fsx.ensureDir(paths.llmModels);
  // 目录里登记的 sha256 / 字节数优先（UI 传上来的可能是空）
  const entry = catalog().find((m) => m.file === file) || {};
  const want = String(sha256 || entry.sha256 || '').toLowerCase();
  const size = Number(bytes || entry.bytes || 0) || undefined;

  // 已存在且大小正确时不能直接跳过：本轮实测过"字节数一模一样、内容却是坏的"（断点续传错位）。
  // 有 sha256 就先验一遍，坏了就删掉重下；没有 sha256 才退回"只看字节数"。
  if (fsx.isFile(target) && (!size || fsx.sizeOf(target) === size)) {
    if (want) {
      job.log('本地已有同尺寸文件，先校验 sha256 再决定是否复用…');
      const got = await sha256File(target);
      if (got === want) {
        job.log('本地文件 sha256 一致，跳过下载', 'ok');
        store.upsertLlmModel(file, { origin: 'downloaded', source: url, sha256: got, addedAt: new Date().toISOString() });
        const m0 = store.readLlmModels();
        if (!m0.default) setDefaultModel(file);
        return { file: target, bytes: fsx.sizeOf(target), source: 'cache', via: '', url: '', ms: 0, skipped: true, sha256: want, verified: true };
      }
      job.log(`本地文件 sha256 不一致（实际 ${got.slice(0, 16)}…），删除后重新下载`, 'warn');
      fs.rmSync(target, { force: true });
    } else {
      job.log('本地已有同尺寸文件，且该模型没有内置 sha256 —— 按"字节数相符"复用（不做内容校验）', 'warn');
      return { file: target, bytes: fsx.sizeOf(target), source: 'cache', via: '', url: '', ms: 0, skipped: true, sha256: null, verified: false };
    }
  }

  if (!want) job.log('该模型没有内置 sha256，本次只校验字节数（不做完整性校验）', 'warn');
  // 校验交给下载引擎（它会在写完后流式算哈希，不一致就删文件并报错）
  const r = await dl.download({
    url, dest: target, job, phase: 'llm', label: file, settings: load(),
    expectBytes: size, sha256: want || undefined,
    // 目录里声明的已验证镜像（国内可达：ModelScope 默认分支是 master、aifasthub 是 main）。
    urls: Array.isArray(entry.mirrors) ? entry.mirrors : undefined,
    // 目录里标了 modelscope:false 的仓库别去撞 ModelScope（实测只会拿到一串 404）
    noModelScope: entry.modelscope === false,
  });
  if (!want) job.log('已跳过完整性校验（只校验字节数）', 'warn');
  else job.log('sha256 校验通过：' + want.slice(0, 16) + '…', 'ok');
  store.upsertLlmModel(file, { origin: 'downloaded', source: url, sha256: want || undefined, addedAt: new Date().toISOString() });
  const meta = store.readLlmModels();
  if (!meta.default) setDefaultModel(file);
  return { ...r, sha256: want || null, verified: !!want };
}

/** 流式计算文件 sha256（不整块读进内存）。 */
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = require('node:crypto').createHash('sha256');
    const s = fs.createReadStream(file, { highWaterMark: 8 * 1024 * 1024 });
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * 校验本地模型文件的 sha256：期望值默认取推荐目录里的，也可由调用方传入（便于用户拿官方哈希自检）。
 * 找不到任何期望值时如实返回 unknown，不假装通过。
 */
async function verifyModel(file, expect) {
  const name = path.basename(String(file || ''));
  if (!name) throw new Error('未提供文件名');
  const target = path.join(paths.llmModels, name);
  if (!fsx.isFile(target)) throw new Error('模型文件不存在：' + name);
  const want = String(expect || (catalog().find((m) => m.file === name) || {}).sha256 || '').toLowerCase();
  const t0 = Date.now();
  const got = await sha256File(target);
  const bytes = fsx.sizeOf(target);
  return {
    file: name, bytes, sha256: got, expected: want || null, ms: Date.now() - t0,
    known: !!want, ok: want ? got === want : null,
  };
}

/** 经 HF 镜像检索 abliterated / 去审查 GGUF；上游确实没有就如实返回 note。 */
async function searchAbliterated(query) {
  const q = String(query || '').trim() || 'abliterated GGUF';
  const s = load();
  const url = `${s.download.hfMirror.replace(/\/+$/, '')}/api/models?search=${encodeURIComponent(q)}&limit=20&full=false`;
  let list = null;
  for (const c of dl.buildCandidates(url, s)) {
    try {
      const r = await fetch(c.url, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { list = await r.json(); break; }
    } catch { /* 换下一个 */ }
  }
  if (!Array.isArray(list)) {
    return { items: [], note: '模型检索不可达（HuggingFace 与镜像都没响应）。可手动下载 GGUF 后在「模型管理」里用本地路径添加。' };
  }
  const items = [];
  for (const m of list) {
    const id = m.id || m.modelId;
    if (!id) continue;
    const detail = await fetchJson(`${s.download.hfMirror.replace(/\/+$/, '')}/api/models/${id}?blobs=false`, s).catch(() => null);
    const siblings = (detail && Array.isArray(detail.siblings) ? detail.siblings : []).map((x) => x.rfilename).filter((n) => /\.gguf$/i.test(n));
    if (!siblings.length) continue;
    items.push({
      repo: id,
      downloads: m.downloads || 0,
      license: (m.tags || []).find((t) => /^license:/.test(t))?.replace('license:', '') || (detail && detail.cardData && detail.cardData.license) || '',
      abliterated: /abliterated|uncensored|heretic|de-censor/i.test(id),
      files: siblings.slice(0, 40).map((n) => ({ name: n, url: `${s.download.hfMirror.replace(/\/+$/, '')}/${id}/resolve/main/${n}` })),
    });
  }
  const note = items.length
    ? '模型来自 HuggingFace（经镜像）。abliterated / 去审查版本只在本地使用，禁止再分发（涉及 Qwen Research 等许可）。'
    : '镜像上没有检索到匹配的 GGUF。上游可能确实未发布「溶解版（abliterated）」权重——本程序不会伪造或改名充数：你可以改用「模型管理 → 从本地路径添加」指定自己已有的 GGUF。';
  return { items, note };
}

// ── 子进程管理 ───────────────────────────────────────────

function serverStatus() {
  const exe = runtimeExe();
  const models = listModels();
  const s = load();
  return {
    provider: s.llm.provider,
    api: apiReady(s),
    runtime: {
      ok: fsx.isFile(exe),
      exe,
      source: fsx.isFile(exe) ? (/cudart64/i.test(safeReaddir(path.dirname(exe)).join(',')) ? 'cuda' : 'cpu') : 'none',
      version: fsx.isFile(exe) ? (verifyRuntime(exe).version || '') : '',
    },
    model: load().llm.defaultModel || models.default || '',
    models: models.items,
    server: { running: !!server.child && server.child.exitCode === null, port: server.port, pid: server.child ? server.child.pid : null, model: server.model, startedAt: server.startedAt, lastError: server.lastError },
  };
}

function safeReaddir(d) {
  try { return fs.readdirSync(d); } catch { return []; }
}

function llamaHealth(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: b }));
    });
    req.on('error', () => resolve({ ok: false, status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0 }); });
    req.end();
  });
}

async function startServer() {
  const s = load();
  const exe = runtimeExe();
  if (!fsx.isFile(exe)) throw new Error('LLM 运行时尚未安装（缺少 runtime/bin/llama/llama-server.exe）。请在「本地 LLM」页点「安装运行时」。');
  const models = listModels();
  const model = s.llm.defaultModel || models.default;
  if (!model) throw new Error('还没有可用的 GGUF 模型。请把模型放进 models/llm/，或在「模型管理」里添加/下载。');
  const modelPath = path.join(paths.llmModels, model);
  if (!fsx.isFile(modelPath)) throw new Error('默认模型文件不存在：' + modelPath);
  if (server.child && server.child.exitCode === null && server.model === model) {
    const h = await llamaHealth(s.llm.port);
    if (h.ok) return { running: true, port: s.llm.port, pid: server.child.pid, model, reused: true };
  }
  if (server.child && server.child.exitCode === null) stopServer();

  const port = s.llm.port;
  // 启动参数"阶梯"：先按设置的层数全量 offload；显存不足（ComfyUI 正在跑图时会占掉大半显存，
  // llama.cpp 会直接 GGML_ASSERT(ctx->mem_buffer != NULL) 退出）就自动降层数、最后退到纯 CPU。
  // 另外不同版本的 llama-server 参数略有差异（例如 --no-webui 是后加的），所以每组再试一次不带该参数的形态。
  const wantLayers = s.llm.gpuLayers;
  const layerLadder = [...new Set([wantLayers, Math.max(1, Math.floor(wantLayers / 2)), 8, 0])];
  const mkArgs = (layers, extra) => ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port),
    '-c', String(s.llm.ctxSize), '-ngl', String(layers), '--jinja', ...extra];
  const variants = [];
  for (const layers of layerLadder) {
    variants.push(mkArgs(layers, ['--no-webui']));
    if (layers === wantLayers) variants.push(mkArgs(layers, []));
  }
  fsx.ensureDir(paths.logs);
  let lastLog = '';
  for (const args of variants) {
    const before = fsx.sizeOf(paths.llmLog);
    const out = fs.openSync(paths.llmLog, 'a');
    log.info(`启动 llama-server：${exe} ${args.join(' ')}`);
    const child = spawn(exe, args, { cwd: path.dirname(exe), detached: false, stdio: ['ignore', out, out], windowsHide: true });
    fs.closeSync(out);
    server.child = child;
    server.port = port;
    server.model = model;
    server.startedAt = Date.now();
    server.lastError = null;
    child.on('exit', (code) => {
      log.warn(`llama-server 退出：code=${code}`);
      if (server.child === child) { server.child = null; server.lastError = 'llama-server 退出（code ' + code + '），详见 logs/llama-server.log'; }
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      const h = await llamaHealth(port, 2000);
      if (h.ok) return { running: true, port, pid: child.pid, model, waitedMs: Date.now() - t0, args };
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (child.exitCode !== null) {
      try {
        const text = fs.readFileSync(paths.llmLog, 'utf8').slice(before < 0 ? 0 : before);
        lastLog = text.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ');
      } catch { /* ignore */ }
      if (/mem_buffer|out of memory|CUDA error|failed to allocate/i.test(lastLog)) {
        log.warn('llama-server 显存不足（ComfyUI 可能正占用显存），自动降低 GPU 层数重试…');
      }
      if (args === variants[variants.length - 1]) break;
      log.warn('llama-server 启动失败，换一组启动参数重试：' + lastLog);
      continue;
    }
  }
  throw new Error('llama-server 启动失败。最后日志：' + (lastLog || '(见 logs/llama-server.log)')
    + ' 常见原因：显存不足（ComfyUI 正占用显存时请先点面板的「释放显存」，或把 GPU 层数设为 0 用 CPU 跑）'
    + '、CUDA 运行库缺失（可在「本地 LLM」页改装 CPU 版运行时）。');
}

function stopServer() {
  if (!server.child || server.child.exitCode !== null) { server.child = null; return { running: false }; }
  const pid = server.child.pid;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' });
    else process.kill(pid, 'SIGKILL');
  } catch (e) {
    log.warn('停止 llama-server 失败：' + e.message);
  }
  server.child = null;
  server.model = null;
  return { running: false, pid };
}

/** 擦除 llama.cpp 的 slot 缓存（"新开对话彻底清空推理缓存"）。 */
async function eraseSlot() {
  const port = server.port || load().llm.port;
  for (const p of ['/slots/0?action=erase', '/slots?action=erase']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* 该版本没有这个端点就算了 */ }
  }
  return false;
}

// ── 对话 ─────────────────────────────────────────────────

function systemPrompt() {
  try {
    return fs.readFileSync(paths.systemPrompt, 'utf8');
  } catch {
    throw new Error('内置系统提示词缺失：' + paths.systemPrompt);
  }
}

/** 计算发给 llama-server 的上下文：系统提示词 + 最近 N 条对话（N 来自设置，含本轮用户消息）。 */
function buildContext(sessionId, userContent) {
  const s = load();
  const n = s.llm.contextMessages;
  const session = store.getSession(sessionId);
  const history = session.messages || [];
  const merged = [...history, { role: 'user', content: userContent }];
  const tail = n <= 0 ? [] : merged.slice(-n);
  return { n, messages: tail, history };
}

/** 同一行里按逗号去重（保序、大小写不敏感）：小模型很容易在负向里退化成重复刷词。 */
function dedupeTags(line) {
  const parts = String(line || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.join(', ');
}

/**
 * 把模型输出规范成系统提示词要求的**单代码围栏**格式。
 * 只在能识别出正/负向标签时改写；识别不出就原样返回（绝不伪造内容）。
 * 这不是"追加系统提示词"，只是输出格式兜底：2B 级小模型对围栏的遵循率并不稳定。
 */
function normalizeAnswer(raw) {
  const original = String(raw || '');
  const unboxed = original.replace(/\r/g, '');
  // 若模型已经给了代码围栏，只取**第一个**围栏的内容（多变体时一个围栏一个变体）。
  let working = unboxed;
  const fence = unboxed.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  if (fence) working = fence[1];
  else working = unboxed.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '');
  working = working.trim();

  const posRe = /(?:^|\n)\s*(?:Positive\s*prompt|正向提示词)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Negative\s*prompt|负向提示词)\s*[:：]|$)/i;
  const negRe = /(?:^|\n)\s*(?:Negative\s*prompt|负向提示词)\s*[:：]\s*([\s\S]*)$/i;
  const pm = working.match(posRe);
  const nm = working.match(negRe);
  const cutVariant = (s) => String(s).split(/\n\s*(?:变体|variant)\s*\d/i)[0];
  // 小模型有时会把负向提示词刷成长串"近义词词汤"（不是字面重复，去重抓不到）。
  // 系统提示词本来就要求"只写有效 tag、不堆砌"，所以这里设一个明确的条数上限，
  // 超了就截断并**明确告知用户**（绝不静默改内容）。
  const MAX_TAGS = 120;
  const MAX_CHARS = 800;
  const cap = (s) => {
    const parts = s.split(',').map((x) => x.trim()).filter(Boolean);
    let text = parts.length > MAX_TAGS ? parts.slice(0, MAX_TAGS).join(', ') : s;
    let trimmed = Math.max(0, parts.length - MAX_TAGS);
    // 小模型还可能**不用逗号**直接刷成一长串近义词（词汤）——按字符数兜底截断。
    if (text.length > MAX_CHARS) {
      const cut = text.slice(0, MAX_CHARS);
      const at = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(' '));
      text = cut.slice(0, at > MAX_CHARS * 0.6 ? at : MAX_CHARS).trim().replace(/[,;]$/, '');
      trimmed += 1;
    }
    return { text, trimmed };
  };
  let trimmed = 0;
  let positive = '';
  let negative = '';
  if (pm) {
    let p = cutVariant(pm[1]).replace(/\n+/g, ' ').trim();
    // 小模型有时会把负向内容塞进正向段（在 "Negative prompt:" 标签之前就开始写负向 tag）。
    // 实证补丁：正向里若出现典型的负向起手词，且不在开头，就从那里截断。
    const negLead = p.search(/(?:^|[,;]\s*)(worst quality|low quality|jpeg artifacts|blurry)\b/i);
    if (negLead > 20) p = p.slice(0, negLead).replace(/[,;\s]+$/, '');
    const r = cap(dedupeTags(p));
    positive = r.text;
    trimmed += r.trimmed;
  }
  if (nm) {
    const r = cap(dedupeTags(cutVariant(nm[1]).replace(/\n+/g, ' ').trim()));
    negative = r.text;
    trimmed += r.trimmed;
  }
  // 同一 tag 不该同时出现在正负向：从负向里剔除已经出现在正向的 tag。
  if (positive && negative) {
    const posSet = new Set(positive.split(',').map((x) => x.trim().toLowerCase()));
    const kept = negative.split(',').map((x) => x.trim()).filter((x) => x && !posSet.has(x.toLowerCase()));
    if (kept.length !== negative.split(',').length) negative = kept.join(', ');
  }
  if (!positive && !negative) return { text: original.trim(), positive: '', negative: '', normalized: false, trimmed: 0 };
  const out = '```\nPositive prompt: ' + positive + '\n\nNegative prompt: ' + negative + '\n```';
  return { text: out, positive, negative, normalized: out !== original.trim(), trimmed };
}

// ── 外接 OpenAI 兼容接口（provider = 'api'） ───────────────
//
// 只做"纯聊天内核"：一段系统提示词 + 最近 N 条对话 → 流式正文。
// 不接工具、不接检索、不接推理内核（用户明确要求"最简便的聊天内核"）。

/** 角色 tag 补全开关（设置页「角色词表补全」可关；关掉后完全不动模型输出）。 */
function charRepairOn(s = load()) {
  return s.llm.characterRepair !== false;
}

function apiConfig(s = load()) {
  const a = s.llm.api || {};
  return {
    baseUrl: normalizeApiBase(a.baseUrl),
    apiKey: String(a.apiKey || ''),
    model: String(a.model || ''),
    temperature: a.temperature === undefined ? 0.6 : a.temperature,
    maxTokens: a.maxTokens || 4096,
    timeoutMs: a.timeoutMs || 300000,
    reasoning: ['off', 'low', 'high', 'max'].includes(a.reasoning) ? a.reasoning : 'off',
    retries: a.retries === undefined ? 2 : a.retries,
    idleMs: a.idleMs || 90000,
    sendContext: s.llm.sendContext === true,
    keepMessages: s.llm.keepMessages || 40,
  };
}

/**
 * 归一化外接接口地址：用户可能填 `https://api.deepseek.com`、`.../v1`、
 * 甚至直接粘 `.../v1/chat/completions`（社区客户端都容忍这三种写法）。
 * 统一成"根地址"，请求时再拼 `/chat/completions` 与 `/models`。
 */
function normalizeApiBase(raw) {
  let u = String(raw || '').trim().replace(/\s+/g, '');
  if (!u) return '';
  u = u.replace(/\/+$/, '');
  u = u.replace(/\/chat\/completions$/i, '').replace(/\/completions$/i, '');
  u = u.replace(/\/+$/, '');
  return u;
}

/**
 * OpenAI 兼容请求体：推理挡位（四挡）在这里落地。
 *   · off  —— 关思考：同时下发 `thinking:{type:'disabled'}`（DeepSeek/Anthropic 姿势）与
 *             `chat_template_kwargs.enable_thinking:false`（llama.cpp/Qwen 姿势）；对不认字段的服务是安全的。
 *   · low / high / max —— 下发 `reasoning_effort`（DeepSeek 实测有效；`effort` 字段实测被忽略）。
 */
function apiRequestBody(c, messages, stream) {
  const body = {
    model: c.model,
    messages,
    stream,
    temperature: c.temperature,
    max_tokens: c.maxTokens,
  };
  if (c.reasoning === 'off') {
    body.thinking = { type: 'disabled' };
    body.chat_template_kwargs = { enable_thinking: false };
  } else {
    body.reasoning_effort = c.reasoning;
  }
  return body;
}

function apiReady(s = load()) {
  const c = apiConfig(s);
  return { ok: !!(c.baseUrl && c.model), baseUrl: c.baseUrl, model: c.model, hasKey: !!c.apiKey, missing: [!c.baseUrl ? 'baseUrl' : '', !c.model ? 'model' : ''].filter(Boolean) };
}

/** 拉取该服务公开的模型清单（社区客户端都这么做：填完 Key 先列模型再选）。 */
async function listApiModels() {
  const c = apiConfig();
  if (!c.baseUrl) throw new Error('还没填 baseUrl');
  const headers = { 'content-type': 'application/json' };
  if (c.apiKey) headers.authorization = 'Bearer ' + c.apiKey;
  const res = await fetch(c.baseUrl + '/models', { headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`获取模型列表失败（HTTP ${res.status}）：${text.slice(0, 200)}`);
  let j = null;
  try { j = JSON.parse(text); } catch { throw new Error('模型列表不是合法 JSON：' + text.slice(0, 120)); }
  const items = (Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : []).map((m) => ({
    id: String(m.id || m.name || ''),
    name: m.name || '',
    context: m.context_window || m.context_length || null,
    maxOutput: m.max_output_tokens || null,
    effort: m.effort && Array.isArray(m.effort.supported_levels) ? m.effort.supported_levels : null,
  })).filter((m) => m.id);
  return { baseUrl: c.baseUrl, current: c.model, items };
}

/** 连一次外接接口做自检：列模型 + 真发一条短对话（思考型模型也能拿到正文才算通过）。 */
async function testApi() {
  const c = apiConfig();
  const r = apiReady();
  if (!r.ok) throw new Error('外接 API 配置不完整，缺少：' + r.missing.join('、'));
  const headers = { 'content-type': 'application/json' };
  if (c.apiKey) headers.authorization = 'Bearer ' + c.apiKey;
  let models = null;
  let modelKnown = null;
  try {
    const res = await fetch(c.baseUrl + '/models', { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json();
      const ids = (Array.isArray(j.data) ? j.data : []).map((m) => String(m.id || '')).filter(Boolean);
      if (ids.length) { models = ids.slice(0, 200); modelKnown = ids.includes(c.model); }
    }
  } catch { /* 有些服务没有 /models，继续试对话 */ }
  const t0 = Date.now();
  const res = await fetch(c.baseUrl + '/chat/completions', {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(Math.min(120000, c.timeoutMs)),
    body: JSON.stringify(apiRequestBody(c, [{ role: 'user', content: '只回答两个字：可以' }], false)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`接口返回 ${res.status}：${text.slice(0, 300)}（检查 baseUrl / 模型名 / API Key）`);
  let content = '';
  let reasoning = '';
  try {
    const j = JSON.parse(text);
    const msg = (j.choices || [{}])[0].message || {};
    content = msg.content || '';
    reasoning = msg.reasoning_content || '';
  } catch { /* 忽略 */ }
  if (!content && reasoning) {
    throw new Error(`模型只返回了思考内容、没有正文（思考型模型常见）。当前推理挡位：${c.reasoning}；`
      + `把「推理挡位」设为 off（关思考），或把「单次回答上限」调大（当前 ${c.maxTokens}）后重试。`);
  }
  return {
    ok: true, ms: Date.now() - t0, model: c.model, baseUrl: c.baseUrl, hasKey: !!c.apiKey,
    models, modelKnown, reasoning: c.reasoning, maxTokens: c.maxTokens, sample: content.slice(0, 80),
  };
}

/** 把外接接口的 SSE 转成本程序的前端 SSE（与本地路径共用解析逻辑）。 */
async function pipeOpenAIStream(upstream, res, label, opts = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
  let answer = '';
  let reasoning = '';
  let truncated = false;
  let upstreamError = '';
  let buf = '';
  let thinkNoted = false;
  const idleMs = opts.idleMs || 90000;
  let lastData = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastData > idleMs) {
      upstreamError = `上游 ${Math.round(idleMs / 1000)} 秒没有任何数据（判为卡死）`;
      try { upstream.destroy(); } catch { /* ignore */ }
    }
  }, 5000);
  upstream.setEncoding('utf8');
  upstream.on('data', (chunk) => {
    lastData = Date.now();
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const choice = j.choices && j.choices[0];
        const delta = (choice && (choice.delta || choice.message)) || {};
        if (choice && choice.finish_reason === 'length') truncated = true;
        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          // 思考型模型会先"想"很久：给前端一条明确进度，别让用户对着空气等。
          if (!thinkNoted) {
            thinkNoted = true;
            res.write('data: ' + JSON.stringify({ note: '模型正在思考（这些内容不会写进提示词）…' }) + '\n\n');
          }
          res.write('data: ' + JSON.stringify({ thinking: reasoning.length }) + '\n\n');
        }
        if (delta.content) {
          answer += delta.content;
          res.write('data: ' + JSON.stringify({ delta: delta.content }) + '\n\n');
        }
      } catch { /* 不完整帧：忽略 */ }
    }
  });
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    upstream.on('end', done);
    upstream.on('error', (e) => { upstreamError = upstreamError || e.message; done(); });
    res.on('close', () => { try { upstream.destroy(); } catch { /* ignore */ } done(); });
  });
  clearInterval(idleTimer);
  // 只给了思维链、没有正文：原样交给用户并说明（绝不静默给空回答）。
  if (!answer && reasoning) {
    answer = reasoning;
    res.write('data: ' + JSON.stringify({ delta: reasoning }) + '\n\n');
    res.write('data: ' + JSON.stringify({ note: `${label} 只输出了思考内容（未产出正文），已原样返回；可把「单次回答上限」调大或把「思考模式」设为关闭` }) + '\n\n');
  }
  return { answer, reasoning, truncated, upstreamError };
}

/**
 * 流式对话：本地 llama-server 或外接 OpenAI 兼容接口，都转成本程序的前端 SSE。
 * 只把最近 N 条上下文送进模型（系统提示词固定取自 assets/templates/anima-system-prompt.txt，不计入 N）。
 */
async function chat(sessionId, userContent, res, opts = {}) {
  const s = load();
  const { n, messages, history } = buildContext(sessionId, userContent);
  // 上下文策略：界面保留完整历史，但默认**不把历史发给模型**（只发当前这一句）。
  // 这样同一段对话可以反复引用、整段复制，又不会让模型的回答被上一轮带偏。
  const sendContext = s.llm.sendContext === true;
  const keepMessages = s.llm.keepMessages || 40;
  const reqMessages = sendContext ? messages : [{ role: 'user', content: userContent }];
  // 「新开对话」等价于历史为空：此时不允许复用 prompt 缓存（配合 /slots 擦除，彻底清空推理缓存）。
  const fresh = !!opts.fresh || history.length === 0;

  // ── 外接 API 路径（不需要本地运行时/模型） ──
  if (s.llm.provider === 'api') {
    const c = apiConfig(s);
    const ready = apiReady(s);
    if (!ready.ok) throw new Error('外接 API 配置不完整，缺少：' + ready.missing.join('、') + '（在「设置 → LLM / 外接 API」里填写）');
    log.info(`LLM 对话（外接 API）：session=${sessionId} 发给模型 ${reqMessages.length} 条（上下文策略 sendContext=${sendContext}）model=${c.model} base=${c.baseUrl} reasoning=${c.reasoning}`);
    const headers = { 'content-type': 'application/json' };
    if (c.apiKey) headers.authorization = 'Bearer ' + c.apiKey;
    const body = JSON.stringify(apiRequestBody(c, [{ role: 'system', content: systemPrompt() }, ...reqMessages], true));
    // 429/5xx/连接失败时退避重试（社区客户端的常规做法）；4xx 里除 429 外不重试，直接报错。
    let upstream = null;
    let lastErr = null;
    for (let attempt = 0; attempt <= c.retries; attempt++) {
      try {
        upstream = await fetch(c.baseUrl + '/chat/completions', { method: 'POST', headers, body, signal: AbortSignal.timeout(c.timeoutMs) });
      } catch (e) {
        lastErr = new Error(`无法连接外接 API（${c.baseUrl}）：${e.message}。检查地址、网络与代理设置。`);
        if (attempt < c.retries) { await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); continue; }
        throw lastErr;
      }
      if (upstream.ok) break;
      const t = await upstream.text().catch(() => '');
      const retriable = upstream.status === 429 || upstream.status >= 500;
      const hint = upstream.status === 401 || upstream.status === 403 ? '（API Key 无效或没权限）'
        : upstream.status === 404 ? '（baseUrl 或模型名不对：DeepSeek 填 https://api.deepseek.com 即可，其它服务多数要写到 /v1）'
          : upstream.status === 429 ? '（触发限流，稍后再试）' : '';
      lastErr = new Error(`外接 API 返回 ${upstream.status}${hint}：${t.slice(0, 300)}`);
      if (!retriable || attempt >= c.retries) throw lastErr;
      log.warn(`外接 API ${upstream.status}，第 ${attempt + 1} 次重试…`);
      res.write('data: ' + JSON.stringify({ note: `上游返回 ${upstream.status}，正在重试（第 ${attempt + 1}/${c.retries} 次）…` }) + '\n\n');
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    const { Readable } = require('node:stream');
    const nodeStream = Readable.fromWeb(upstream.body);
    const r = await pipeOpenAIStream(nodeStream, res, '外接 API', { idleMs: c.idleMs });
    let answer = r.answer;
    const norm = normalizeAnswer(answer);
    if (norm.normalized) { answer = norm.text; res.write('data: ' + JSON.stringify({ replace: answer, normalized: true }) + '\n\n'); }
    // 角色 tag 补全 + 规范化（确定性词表）：模型答不出/漏掉的角色在这里补成规范 Danbooru tag，
    // 写法不规范的（`rem (re:zero)` → `rem_(re:zero)`）就地改成规范写法，并说明改了什么。
    const rep = charRepairOn() ? characters.repairAnswer(userContent, answer) : { answer, added: [], fixed: [], resolved: [] };
    let addedChars = [];
    let fixedChars = [];
    if (rep.added.length || (rep.fixed && rep.fixed.length)) {
      answer = rep.answer;
      addedChars = rep.added;
      fixedChars = rep.fixed || [];
      res.write('data: ' + JSON.stringify({ replace: answer, charactersAdded: rep.added, charactersFixed: fixedChars }) + '\n\n');
    }
    if (norm.trimmed) res.write('data: ' + JSON.stringify({ note: `已省略 ${norm.trimmed} 处冗余内容（模型有堆砌/复读倾向，超出 120 tag 或 800 字上限）` }) + '\n\n');
    if (r.truncated) res.write('data: ' + JSON.stringify({ note: '回答触达长度上限被截断（可把「单次回答上限」调大）' }) + '\n\n');
    const kept = store.saveSession(sessionId, [...history, { role: 'user', content: userContent }, { role: 'assistant', content: answer }], keepMessages);
    res.write('data: ' + JSON.stringify({ done: true, contextUsed: reqMessages.length, contextSent: sendContext, keptTotal: kept.messages.length, kept: kept.messages.length, answer, positive: norm.positive, negative: norm.negative, normalized: norm.normalized, charactersAdded: addedChars, charactersFixed: fixedChars, truncated: r.truncated, upstreamError: r.upstreamError || undefined, provider: 'api' }) + '\n\n');
    res.end();
    return { answer, kept: kept.messages.length, truncated: r.truncated, provider: 'api', charactersAdded: addedChars, charactersFixed: fixedChars };
  }

  // ── 本地路径 ──
  const st = serverStatus();
  if (!st.runtime.ok) throw new Error('LLM 运行时尚未安装');
  if (!st.model) throw new Error('还没有设置默认 GGUF 模型');
  if (!st.server.running) await startServer();

  const payload = {
    model: server.model || st.model,
    messages: [{ role: 'system', content: systemPrompt() }, ...reqMessages],
    stream: true,
    // 采样参数针对"短小、结构化"的提示词生成调过：低温 + 收紧截断 + DRY 抑制退化。
    // （小模型用默认参数时很容易在负向提示词里刷成长串近义词，纯 repeat_penalty 压不住。）
    temperature: opts.temperature === undefined ? 0.6 : opts.temperature,
    top_p: opts.topP === undefined ? 0.9 : opts.topP,
    top_k: opts.topK === undefined ? 40 : opts.topK,
    min_p: opts.minP === undefined ? 0.05 : opts.minP,
    // 硬上限：Qwen3.x 这类"会思考"的模型在不限 token 时会写出几千 token 的思维链，
    // 既慢又会把上下文吃光（实测：一次回答 7390 token 直接顶到 8191 上限被截断）。
    max_tokens: opts.maxTokens === undefined ? (s.llm.maxTokens || 512) : opts.maxTokens,
    // 关掉思考链：提示词生成要的是"一个代码围栏"，不需要思维过程。
    chat_template_kwargs: { enable_thinking: false },
    // 抑制小模型的复读机式退化（实测不加时负向提示词会刷成一长串重复/近义 tag）。
    repeat_penalty: 1.1,
    repeat_last_n: 256,
    dry_multiplier: 0.8,
    dry_base: 1.75,
    dry_allowed_length: 2,
    dry_penalty_last_n: 512,
    cache_prompt: !fresh,
  };
  log.info(`LLM 对话：session=${sessionId} 发给模型 ${reqMessages.length} 条（上下文策略 sendContext=${sendContext}，本地保留上限 ${keepMessages}）fresh=${fresh}`);

  const port = server.port || s.llm.port;
  const body = JSON.stringify(payload);
  const upstream = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, resolve);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  if (upstream.statusCode !== 200) {
    let err = '';
    upstream.on('data', (c) => { err += c; });
    await new Promise((r) => upstream.on('end', r));
    throw new Error(`llama-server 返回 ${upstream.statusCode}：${err.slice(0, 400)}`);
  }

  const piped = await pipeOpenAIStream(upstream, res, '本地模型');
  let answer = piped.answer;
  const truncated = piped.truncated;

  // 输出格式兜底：规范成"单代码围栏"。改写了就告诉前端替换显示内容（保证复制即得正负两段）。
  const norm = normalizeAnswer(answer);
  if (norm.normalized) {
    answer = norm.text;
    res.write('data: ' + JSON.stringify({ replace: answer, normalized: true }) + '\n\n');
  }
  // 角色 tag 补全（确定性词表，见 server/characters.js）：模型漏掉的角色在这里补齐，
  // 写法不规范的（`rem (re:zero)` → `rem_(re:zero)`）就地改成规范写法，并说明改了什么。
  const rep = charRepairOn() ? characters.repairAnswer(userContent, answer) : { answer, added: [], fixed: [], resolved: [] };
  let addedChars = [];
  let fixedChars = [];
  if (rep.added.length || (rep.fixed && rep.fixed.length)) {
    answer = rep.answer;
    addedChars = rep.added;
    fixedChars = rep.fixed || [];
    res.write('data: ' + JSON.stringify({ replace: answer, charactersAdded: rep.added, charactersFixed: fixedChars }) + '\n\n');
  }
  if (norm.trimmed) {
    res.write('data: ' + JSON.stringify({ note: `已省略 ${norm.trimmed} 处冗余内容（模型有堆砌/复读倾向，超出 120 tag 或 800 字上限）` }) + '\n\n');
  }
  if (truncated) {
    res.write('data: ' + JSON.stringify({ note: '回答触达长度上限被截断（可再点一次生成，或把描述写得更短）' }) + '\n\n');
  }

  const kept = store.saveSession(sessionId, [...history, { role: 'user', content: userContent }, { role: 'assistant', content: answer }], keepMessages);
  res.write('data: ' + JSON.stringify({
    done: true,
    contextUsed: reqMessages.length, contextSent: sendContext, keptTotal: kept.messages.length,
    kept: kept.messages.length,
    answer,
    positive: norm.positive,
    negative: norm.negative,
    normalized: norm.normalized,
    charactersAdded: addedChars,
    charactersFixed: fixedChars,
    truncated,
    upstreamError: piped.upstreamError || undefined,
    provider: 'local',
  }) + '\n\n');
  res.end();
  return { answer, kept: kept.messages.length, truncated, upstreamError: piped.upstreamError, normalized: norm.normalized, provider: 'local', charactersAdded: addedChars, charactersFixed: fixedChars };
}

function newSession(sessionId) {
  store.dropSession(sessionId);
  eraseSlot().catch(() => {});
  return { ok: true, sessionId };
}

module.exports = {
  installRuntime, runtimeExe, hasNvidiaGpu, resolveRuntimeAssets,
  listModels, addModel, removeModel, setDefaultModel, downloadModel, searchAbliterated,
  sha256File, verifyModel,
  serverStatus, startServer, stopServer, eraseSlot,
  systemPrompt, buildContext, chat, newSession,
  apiConfig, apiReady, testApi, listApiModels, normalizeApiBase, catalog,
  server,
};
