// comfy-panel-standalone —— 本地后端服务入口（Node 标准库，零 npm 依赖）。
//
// 职责：① 托管 web/ 静态资源；② 反代 ComfyUI 的 HTTP/WS（保留插件的 /comfy-panel/* 前缀，
// 面板半零改动即可工作）；③ 画师清单只读接口；④ 设置/收藏/黑名单等数据持久化；
// ⑤ ComfyUI 进程管理；⑥ 首次运行向导与下载；⑦ 本地 LLM（llama.cpp）子进程与对话。
//
// 安全姿态：默认只监听 127.0.0.1；开启局域网监听时必须带令牌（X-DCP-Token）。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { paths, load, save, selfcheck, VERSION, BUILD_TAG, comfyDir } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');
const store = require('./store');
const jobs = require('./jobs');
const dl = require('./download');
const comfy = require('./comfy');
const installer = require('./comfy-install');
const llm = require('./llm');
const characters = require('./characters');
const works = require('./works');

// 镜像测速同一时刻只允许一个（测速本身很占带宽，并发跑会把彼此的结果都拉低）。
const TEST = { running: false };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, value) {
  const body = JSON.stringify(value === undefined ? null : value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res, status, text, type) {
  res.writeHead(status, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    const err = new Error('请求体不是合法 JSON：' + e.message);
    err.status = 400;
    throw err;
  }
}

/** 回环来源判断（本机自己的浏览器 / 启动器探活）。 */
function isLoopback(req) {
  const a = (req.socket && (req.socket.remoteAddress || '')) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function lanGuard(req, url) {
  const s = load();
  if (!s.listen.lan) return true;
  // v1.1.0（修复 B7 的第三层缺口）：回环来源放行。
  // README §9.2 的口径是「局域网内**其它设备**必须带上令牌」，而旧实现对所有来源一律要求令牌，
  // 由此产生两个真实故障：
  //   ① 设置页勾选并保存后，**本页**后续 /app/* 全部 401 → 外壳把整页换成「后端 API 不可用」，
  //      令牌行反而永远看不到（用户报的"开启局域网后看不到令牌"，根因就在这里）；
  //   ② 启动器 scripts/start.ps1 用 http://127.0.0.1:<port>/app/state 探活且不带令牌，
  //      一旦 lan=true 被持久化，下次双击 start.cmd 会等满 60 秒、报"后端没有就绪"并杀掉后端。
  // 只放行本机并不削弱安全姿态：未开启局域网时本来就不校验；局域网内其它设备仍然必须带令牌。
  if (isLoopback(req)) return true;
  const token = s.listen.token;
  if (!token) return true;
  const given = req.headers['x-dcp-token'] || url.searchParams.get('token');
  return given === token;
}

function ensureLanToken() {
  const s = load();
  if (s.listen.lan && !s.listen.token) {
    save({ listen: { token: crypto.randomBytes(12).toString('hex') } });
  }
  return load().listen.token;
}

/**
 * v1.2.0：设置下发时把 API Key 换成布尔 `hasKey`。
 * 页面拿不到明文，就不可能"回传空值把 Key 抹掉"（config.save 同时把空值当"不改"，双重保险）；
 * 顺带也把 Key 从不必要的响应体里去掉。真正要用 Key 的接口（测试连接 / 对话 / 拉模型清单）
 * 都在服务端读配置，不依赖页面回传。
 */
function redactSettings(s) {
  const out = JSON.parse(JSON.stringify(s));
  if (out.llm && out.llm.api) {
    out.llm.api.hasKey = !!out.llm.api.apiKey;
    out.llm.api.apiKey = '';
  }
  return out;
}

// ── 路由 ─────────────────────────────────────────────────

async function handleApp(req, res, url, body) {
  const p = url.pathname;
  const s = load();

  if (p === '/app/state') {
    const status = await comfy.status();
    const setup = store.readSetup();
    const lstatus = llm.serverStatus();
    return sendJson(res, 200, {
      version: VERSION,
      buildTag: BUILD_TAG,
      lang: s.lang,
      root: paths.root,
      paths: {
        models: paths.models,
        llmModels: paths.llmModels,
        runtime: paths.runtime,
        comfyEmbedded: paths.comfyEmbedded,
        logs: paths.logs,
        data: paths.data,
        output: works.outputDir(),
      },
      comfy: { mode: s.comfy.mode, dir: status.dir, port: status.port, online: status.online, running: status.running, pid: status.pid, layout: status.layout, modelsDir: status.modelsDir, outputDir: works.outputDir(), outputSource: works.outputInfo().source, outputOverride: works.outputOverride() },
      // v1.1.0（修复 B6）：必须下发 provider 与 api —— 前端要按推理来源判定"能不能发消息"，
      // 只给 runtime 的话外接 API 模式（默认来源）永远被判成"本地 LLM 未就绪"。
      llm: { runtime: lstatus.runtime, model: lstatus.model, modelCount: lstatus.models.length, server: lstatus.server, contextMessages: s.llm.contextMessages, sendContext: s.llm.sendContext === true, keepMessages: s.llm.keepMessages, reasoning: s.llm.api.reasoning, provider: lstatus.provider, api: lstatus.api },
      // v1.1.0（修复 B7）：局域网令牌只在 PUT /app/settings 时生成，而设置页保存后只刷新本接口，
      // 页面里的 settings 副本不重拉 —— 不下发 listen 的话令牌行永远读不到值。
      listen: { lan: s.listen.lan === true, port: s.listen.port, token: s.listen.lan ? (ensureLanToken() || '') : '' },
      setup,
      selfcheck: selfcheck(),
      platform: process.platform,
      node: process.version,
    });
  }

  if (p === '/app/settings') {
    if (req.method === 'GET') return sendJson(res, 200, redactSettings(s));
    if (req.method === 'PUT' || req.method === 'POST') {
      const next = save(body || {});
      if (next.listen.lan) ensureLanToken();
      return sendJson(res, 200, redactSettings(load()));
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (p === '/app/selfcheck') return sendJson(res, 200, selfcheck());

  if (p === '/app/logs') {
    return sendJson(res, 200, { file: log.file(), lines: log.recent(Number(url.searchParams.get('tail') || 300)) });
  }

  // ── ComfyUI 进程 ──
  if (p === '/app/comfy/detect') {
    const dir = url.searchParams.get('dir') || comfyDir(s);
    return sendJson(res, 200, comfy.detectLayout(dir));
  }
  if (p === '/app/comfy/status') return sendJson(res, 200, await comfy.status());
  if (p === '/app/comfy/launch' && req.method === 'POST') {
    const r = await comfy.launch();
    return sendJson(res, r.error && !r.online ? 500 : 200, r);
  }
  if (p === '/app/comfy/stop' && req.method === 'POST') return sendJson(res, 200, await comfy.stop());
  if (p === '/app/comfy/log') return sendJson(res, 200, comfy.logTail(Number(url.searchParams.get('tail') || 300)));
  // v1.2.0：输出目录（图片文件夹）当前解析结果 —— 界面据此显示"图会落在哪"，并可手动覆盖。
  if (p === '/app/comfy/outputdir') {
    const info = works.outputInfo(true);
    let count = 0;
    if (fsx.isDir(info.dir)) {
      try { count = works.scanImages(info.dir).length; } catch { count = 0; }
    }
    return sendJson(res, 200, {
      dir: info.dir, source: info.source, exists: fsx.isDir(info.dir), count,
      override: info.override, candidates: info.candidates,
    });
  }

  // ── 画师数据 ──
  if (p === '/app/artists/lists') return sendJson(res, 200, store.readArtists());
  // v1.2.0：自定义分组（最多 store.MAX_GROUPS 组；分组与收藏/黑名单不互斥）
  if (p === '/app/artists/groups') {
    return sendJson(res, 200, { groups: store.readArtists().groups, max: store.MAX_GROUPS });
  }
  if (p.startsWith('/app/artists/groups/') && req.method === 'POST') {
    const action = p.slice('/app/artists/groups/'.length);
    try {
      if (action === 'create') return sendJson(res, 200, store.createGroup(body.name));
      if (action === 'rename') return sendJson(res, 200, store.renameGroup(body.from, body.to));
      if (action === 'delete') return sendJson(res, 200, store.deleteGroup(body.name));
      if (action === 'add') return sendJson(res, 200, store.addToGroup(body.tag, body.group));
      if (action === 'remove') return sendJson(res, 200, store.removeFromGroup(body.tag, body.group));
      return sendJson(res, 404, { error: '未知的分组操作：' + action });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }
  if (p === '/app/artists/favs' && (req.method === 'PUT' || req.method === 'POST')) {
    const cur = store.readArtists();
    return sendJson(res, 200, store.writeArtists({ ...cur, favs: body.items || [] }));
  }
  if (p === '/app/artists/blacklist' && (req.method === 'PUT' || req.method === 'POST')) {
    const cur = store.readArtists();
    return sendJson(res, 200, store.writeArtists({ ...cur, blacklist: body.items || [] }));
  }
  if (p === '/app/artists/toggle' && req.method === 'POST') {
    return sendJson(res, 200, store.toggleArtist(body.tag, body.action));
  }
  if (p === '/app/artists/import' && req.method === 'POST') {
    return sendJson(res, 200, store.importArtists(body.items || []));
  }
  if (p === '/app/artists/search') {
    const q = (url.searchParams.get('q') || '').trim();
    const source = url.searchParams.get('source') || 'all';
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 50)));
    const artists = comfy.readArtists();
    const black = new Set(store.readArtists().blacklist);
    let pool;
    if (source === 'top') pool = artists.top;
    else if (source === 'favs') pool = store.readArtists().favs;
    else pool = artists.all;
    const norm = (x) => String(x).replace(/\\/g, '').toLowerCase();
    const nq = norm(q);
    const hits = (nq ? pool.filter((t) => norm(t).includes(nq)) : pool).slice(0, limit);
    return sendJson(res, 200, { items: hits.map((tag) => ({ tag, blacklisted: black.has(tag) })), total: pool.length });
  }
  if (p === '/app/artists/lists/info') {
    const a = comfy.readArtists();
    return sendJson(res, 200, { all: a.all.length, top: a.top.length, files: a.files });
  }
  // 本机作品：某位画师在本机 output 目录里有哪些图（画师页用）
  if (p === '/app/artists/works') {
    return sendJson(res, 200, works.list({
      artist: url.searchParams.get('artist') || '',
      q: url.searchParams.get('q') || '',
      limit: url.searchParams.get('limit') || 60,
    }));
  }
  // 直读 output 目录里的图片（ComfyUI 不在线也能看本机作品）
  if (p === '/app/output/file') {
    const file = works.resolveInOutput(url.searchParams.get('name'), url.searchParams.get('sub'));
    if (!file) return sendJson(res, 404, { error: '文件不存在或不在 output 目录内' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg',
      'cache-control': 'no-store',
    });
    return fs.createReadStream(file).pipe(res);
  }
  // 打开本机文件夹（图片 / 日志 / 模型）
  if (p === '/app/open-folder' && req.method === 'POST') {
    return sendJson(res, 200, works.openFolder(String(body.which || 'output')));
  }
  // v1.2.0：删除一张本机作品（面板「删除」/ 画师页「本机作品」都用它）。
  // 只允许 output 目录内的图片文件；删完若模型子目录空了就顺手收掉。
  if (p === '/app/output/delete' && req.method === 'POST') {
    const r = works.removeImage(body.name, body.sub);
    log.info(`删除作品请求：${String(body.sub || '')}/${String(body.name || '')} → ${r.ok ? '成功' : '失败(' + r.error + ')'}`);
    return sendJson(res, r.ok ? 200 : 404, r);
  }

  // ── 本地 LLM ──
  if (p === '/app/llm/status') return sendJson(res, 200, llm.serverStatus());
  if (p === '/app/llm/api/test' && req.method === 'POST') {
    try {
      return sendJson(res, 200, await llm.testApi());
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  // 列出外接服务公开的模型（填完 Key 先列模型再选，社区客户端惯例）
  if (p === '/app/llm/api/models') {
    try {
      return sendJson(res, 200, await llm.listApiModels());
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === '/app/llm/prompt') return sendJson(res, 200, { text: llm.systemPrompt(), file: paths.systemPrompt });
  // 推荐模型目录（含实测字节数 / 许可 / 是否已安装）
  if (p === '/app/llm/catalog') return sendJson(res, 200, { items: llm.catalog() });

  // ── 角色词表（Danbooru 角色 tag 索引 + 中文别名）──
  if (p === '/app/characters/status') return sendJson(res, 200, characters.status());
  if (p === '/app/characters/search') {
    const q = url.searchParams.get('q') || '';
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 30)));
    return sendJson(res, 200, { items: characters.search(q, limit) });
  }
  if (p === '/app/characters/install' && req.method === 'POST') {
    const job = jobs.run('characters', '下载角色词表', async (j) => characters.install(j));
    return sendJson(res, 200, { jobId: job.id });
  }
  if (p === '/app/characters/resolve' && req.method === 'POST') {
    return sendJson(res, 200, { items: characters.resolveFromText(String(body.text || '')) });
  }
  if (p === '/app/characters/aliases') {
    if (req.method === 'GET') return sendJson(res, 200, { builtin: characters.BUILTIN_ALIASES, user: characters.readUserAliases() });
    if (req.method === 'POST') {
      const cur = characters.readUserAliases();
      const map = { ...cur };
      if (body.remove) delete map[String(body.remove)];
      if (body.zh && body.tag) map[String(body.zh).trim()] = String(body.tag).trim();
      return sendJson(res, 200, { user: characters.saveUserAliases(map) });
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (p === '/app/llm/models') {
    if (req.method === 'GET') return sendJson(res, 200, llm.listModels());
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (p === '/app/llm/models/add' && req.method === 'POST') return sendJson(res, 200, llm.addModel({ srcPath: body.path, mode: body.mode }));
  if (p === '/app/llm/models/remove' && req.method === 'POST') return sendJson(res, 200, llm.removeModel(body.file));
  if (p === '/app/llm/models/default' && req.method === 'POST') return sendJson(res, 200, llm.setDefaultModel(body.file));
  if (p === '/app/llm/models/download' && req.method === 'POST') {
    const job = jobs.run('llm-download', '下载 LLM 模型 ' + (body.name || ''), async (j) => llm.downloadModel(j, { url: body.url, name: body.name, sha256: body.sha256, bytes: body.bytes }));
    return sendJson(res, 200, { jobId: job.id });
  }
  if (p === '/app/llm/models/verify' && req.method === 'POST') {
    const job = jobs.run('llm-verify', '校验模型完整性 ' + (body.file || ''), async (j) => {
      const r = await llm.verifyModel(body.file, body.sha256);
      j.log(`文件：${r.file}（${fsx.fmtBytes(r.bytes)}）`);
      j.log(`本地 sha256：${r.sha256}`);
      if (!r.known) j.log('没有可对照的期望值（该文件不在推荐目录里，也没传 sha256）；只算出本地哈希，不做判定。', 'warn');
      else if (r.ok) j.log(`与期望值一致：${r.expected}`, 'ok');
      else j.log(`与期望值不一致！期望 ${r.expected}`, 'error');
      return r;
    });
    return sendJson(res, 200, { jobId: job.id });
  }
  if (p === '/app/llm/runtime/install' && req.method === 'POST') {
    const job = jobs.run('llm-runtime', '安装 llama.cpp 运行时', async (j) => llm.installRuntime(j, body.variant || 'auto'));
    return sendJson(res, 200, { jobId: job.id });
  }
  if (p === '/app/llm/search') {
    try {
      return sendJson(res, 200, await llm.searchAbliterated(url.searchParams.get('q')));
    } catch (e) {
      return sendJson(res, 200, { items: [], note: '检索失败：' + e.message });
    }
  }
  if (p === '/app/llm/server/start' && req.method === 'POST') {
    try {
      return sendJson(res, 200, await llm.startServer());
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === '/app/llm/server/stop' && req.method === 'POST') return sendJson(res, 200, llm.stopServer());
  if (p === '/app/llm/session/new' && req.method === 'POST') return sendJson(res, 200, llm.newSession(body.sessionId || 'default'));
  if (p.startsWith('/app/llm/session/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/app/llm/session/'.length));
    return sendJson(res, 200, store.getSession(id));
  }
  if (p === '/app/llm/chat' && req.method === 'POST') {
    const sessionId = body.sessionId || 'default';
    // 兼容两种请求体：{ message:"..." } 或 { messages:[{role,content},...] }（取最后一条 user）。
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...msgs].reverse().find((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content);
    const userContent = (typeof body.message === 'string' && body.message) ? body.message : (lastUser ? lastUser.content : '');
    if (!userContent) return sendJson(res, 400, { error: '缺少用户消息（message 或 messages 里最后一条 user）' });
    try {
      await llm.chat(sessionId, userContent, res, { fresh: !!body.fresh });
    } catch (e) {
      if (!res.headersSent) return sendJson(res, 500, { error: e.message });
      try { res.write('data: ' + JSON.stringify({ done: true, error: e.message }) + '\n\n'); res.end(); } catch { /* ignore */ }
    }
    return undefined;
  }

  // ── 首次运行向导 / 安装 ──
  if (p === '/app/setup/plan') {
    try {
      return sendJson(res, 200, installer.plan({
        mode: url.searchParams.get('mode') || load().comfy.mode,
        sel: url.searchParams.get('sel') || '',
        externalDir: url.searchParams.get('dir') || '',
      }));
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    }
  }
  if (p === '/app/setup/status') {
    const setup = store.readSetup();
    const status = await comfy.status();
    const ls = llm.serverStatus();
    return sendJson(res, 200, {
      ...setup,
      runtime: fsx.isFile(path.join(paths.runtimeBin, '7zr.exe')) || !!require('./util/zip').find7z([paths.runtimeBin]),
      comfyui: status.layout !== 'unknown' && status.dir === comfyDir(s) ? status.layout : (setup.comfyDir ? 'installed' : false),
      models: (setup.models || []).length,
      artists: setup.artists,
      llm: ls.runtime.ok,
      comfyDir: status.dir,
      modelsDir: status.modelsDir,
      online: status.online,
    });
  }
  if (p === '/app/setup/run' && req.method === 'POST') {
    const job = jobs.run('setup', '首次运行向导', async (j) => installer.runSetup(j, body || {}));
    return sendJson(res, 200, { jobId: job.id });
  }
  if (p === '/app/models/download' && req.method === 'POST') {
    const job = jobs.run('models', '下载模型', async (j) => installer.installModels(j, body.models || [], {
      mode: body.mode || load().comfy.mode,
      externalDir: body.externalDir,
      modelsFrom: body.modelsFrom,
      copyMode: body.copyMode,
      force: !!body.force,
    }));
    return sendJson(res, 200, { jobId: job.id });
  }
  if (p === '/app/models/catalog') {
    const pl = installer.plan({ mode: s.comfy.mode, sel: url.searchParams.get('sel') || '', externalDir: s.comfy.dir });
    return sendJson(res, 200, pl);
  }

  // ── 任务 ──
  // 任务清单：外壳的"后台任务"指示器与向导重新挂载都靠它 —— 任务活在服务端，
  // 切页面/关页面都不会丢进度（本轮修的真实缺陷）。
  if (p === '/app/jobs') {
    const kind = url.searchParams.get('kind') || '';
    const state = url.searchParams.get('state') || '';
    let items = jobs.list();
    if (kind) items = items.filter((j) => String(j.kind).startsWith(kind));
    if (state) items = items.filter((j) => j.state === state);
    // running = **第一个正在跑的任务对象**（无则 null）；runningCount 让它同时能当"有没有在跑"用。
    // 契约见 docs/INTERNAL-CONTRACT.md §3。
    const running = state
      ? (items.find((j) => j.state === 'running') || null)
      : jobs.running(kind || undefined);
    return sendJson(res, 200, { items, running, runningCount: items.filter((j) => j.state === 'running').length });
  }
  if (p.startsWith('/app/jobs/')) {
    const rest = p.slice('/app/jobs/'.length);
    if (rest.endsWith('/events')) {
      const id = rest.slice(0, -'/events'.length);
      return jobs.stream(id, req, res);
    }
    const job = jobs.get(rest);
    if (!job) return sendJson(res, 404, { error: '任务不存在：' + rest });
    return sendJson(res, 200, { id: job.id, kind: job.kind, title: job.title, state: job.state, events: job.events, result: job.result, error: job.error, startedAt: job.startedAt, endedAt: job.endedAt, logFile: job.logFile });
  }

  // 镜像探测（设置页"测试镜像"）
  if (p === '/app/download/probe') {
    const target = url.searchParams.get('url') || 'https://huggingface.co/';
    const results = await dl.probe(target, s);
    return sendJson(res, 200, { target, results });
  }

  // 镜像测速（设置页"测速"）：对一条直链的全部候选来源各下载一段（默认 100 MiB）并报告速度。
  // 这是"10 秒内没有进展就换源"规则的现场验证 —— 不落盘，随便点。
  if (p === '/app/download/speedtest') {
    const target = url.searchParams.get('url') || '';
    if (!target) return sendJson(res, 400, { error: '缺少 url 参数' });
    const bytes = Math.max(1, Math.min(1024, Number(url.searchParams.get('mib')) || 100)) * 1048576;
    if (TEST.running) return sendJson(res, 409, { error: '已有测速在进行中，请稍候' });
    TEST.running = true;
    try {
      const r = await dl.speedTest(target, s, { bytes, capMs: Number(url.searchParams.get('capMs')) || 45000 });
      return sendJson(res, 200, r);
    } catch (e) {
      return sendJson(res, 500, { error: e.message });
    } finally { TEST.running = false; }
  }

  return sendJson(res, 404, { error: '未知接口：' + p });
}

async function handleComfyPanel(req, res, url) {
  const s = load();
  const status = await comfy.status();
  if (url.pathname === '/comfy-panel/config') {
    return sendJson(res, 200, { base: `http://127.0.0.1:${status.port}`, comfyDir: status.dir, port: status.port, version: VERSION, buildTag: BUILD_TAG });
  }
  if (url.pathname === '/comfy-panel/health') {
    return sendJson(res, 200, { ok: true, clientAlive: Date.now(), clientBundle: 'comfy-panel-standalone', buildTag: BUILD_TAG });
  }
  if (url.pathname === '/comfy-panel/client-alive' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/comfy-panel/artists' && req.method === 'GET') {
    try {
      const a = comfy.readArtists();
      return sendJson(res, 200, { all: a.all, top: a.top });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: e.message });
    }
  }
  if (url.pathname === '/comfy-panel/launch' && req.method === 'POST') {
    const r = await comfy.launch();
    return sendJson(res, 200, r);
  }
  if (url.pathname.startsWith('/comfy-panel/api/')) {
    return comfy.proxy(req, res, status.port);
  }
  return sendJson(res, 404, { error: '未知的面板接口：' + url.pathname });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel.startsWith('/static/')) rel = rel.slice('/static'.length);
  let file;
  try {
    file = fsx.safeJoin(paths.web, decodeURIComponent(rel));
  } catch {
    return sendText(res, 400, 'bad path');
  }
  if (fsx.isDir(file)) file = path.join(file, 'index.html');
  if (!fsx.isFile(file)) return sendText(res, 404, 'not found: ' + rel);
  const ext = path.extname(file).toLowerCase();
  // 静态直接托管、禁用缓存：改前端代码刷新即生效（对应需求 F1「摆脱 ?rev= 快照机制」）
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-store, must-revalidate',
    'content-length': fsx.sizeOf(file),
  });
  fs.createReadStream(file).pipe(res);
  return undefined;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  const run = async () => {
    if (!lanGuard(req, url)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '局域网访问需要令牌：请在地址后加 ?token=<令牌>（设置页可见）' }));
    }
    if (url.pathname.startsWith('/app/')) {
      const needBody = ['POST', 'PUT', 'PATCH'].includes(req.method);
      const body = needBody ? await readJsonBody(req) : {};
      return handleApp(req, res, url, body);
    }
    if (url.pathname.startsWith('/comfy-panel/')) return handleComfyPanel(req, res, url);
    return serveStatic(req, res, url);
  };

  run().catch((e) => {
    log.error(`请求处理失败 ${req.method} ${url.pathname}：${e.stack || e.message}`);
    if (!res.headersSent) sendJson(res, e.status || 500, { error: e.message });
    else try { res.end(); } catch { /* ignore */ }
  });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  if (url.pathname !== '/comfy-panel/ws') { socket.destroy(); return; }
  if (!lanGuard(req, url)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  const s = load();
  comfy.relaySocket(req, socket, head, s.comfy.port);
});

// ── 启动 ─────────────────────────────────────────────────

function listen(port, host, attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 20) {
      log.warn(`端口 ${port} 已被占用，尝试 ${port + 1}`);
      listen(port + 1, host, attempt + 1);
      return;
    }
    log.error('服务启动失败：' + e.message);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const actual = server.address().port;
    if (actual !== load().listen.port) save({ listen: { port: actual } });
    const s = load();
    const token = s.listen.lan ? ensureLanToken() : '';
    const urls = [`http://127.0.0.1:${actual}/`];
    if (s.listen.lan) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (ni.family === 'IPv4' && !ni.internal) urls.push(`http://${ni.address}:${actual}/?token=${token}`);
        }
      }
    }
    log.info(`comfy-panel-standalone ${BUILD_TAG} 已就绪`);
    log.info('打开：' + urls[0]);
    if (s.listen.lan) log.info('局域网地址：' + urls.slice(1).join('  '));
    log.info(`项目根目录：${paths.root}`);
    log.info(`ComfyUI 模式：${s.comfy.mode}（${comfyDir(s) || '未配置'}）`);
    for (const issue of selfcheck().issues) log.warn(`自检：${issue.message} → ${issue.fix}`);
    // comfy.autoStart：启动后自动把 ComfyUI 拉起来（默认关闭；在设置页打开）。
    if (s.comfy.autoStart) {
      if (!comfyDir(s)) {
        log.warn('已开启「启动后自动拉起 ComfyUI」，但还没有配置 ComfyUI 目录 —— 跳过自动启动');
      } else {
        log.info('已开启「启动后自动拉起 ComfyUI」，正在后台探测/启动…');
        comfy.launch()
          .then((r) => {
            if (r.online) log.info('ComfyUI 就绪（自动启动）');
            else log.warn('ComfyUI 自动启动未成功：' + (r.error || '未知原因'));
          })
          .catch((e) => log.warn('ComfyUI 自动启动异常：' + e.message));
      }
    }
    // 供启动脚本读取（stdout 关键行，脚本据此打开浏览器）
    process.stdout.write('DCP_READY ' + JSON.stringify({ url: urls[0], lanUrls: urls.slice(1), port: actual, version: VERSION }) + '\n');
  });
}

function main() {
  fsx.ensureDir(paths.data);
  fsx.ensureDir(paths.logs);
  fsx.ensureDir(paths.jobs);
  fsx.ensureDir(paths.llmModels);
  fsx.ensureDir(paths.runtimeDl);
  fsx.ensureDir(paths.runtimeBin);
  log.setup(paths.logs);
  const s = load();
  log.info(`comfy-panel-standalone 启动中（Node ${process.version}，${process.platform}）`);
  const port = Number(process.env.DCP_PORT || s.listen.port || 8788);
  const host = process.env.DCP_HOST || (s.listen.lan ? '0.0.0.0' : '127.0.0.1');
  listen(port, host);

  const shutdown = (sig) => {
    log.info('收到 ' + sig + '，正在退出…');
    try { llm.stopServer(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('未处理的 Promise 拒绝：' + (e && e.stack ? e.stack : e)));
}

if (require.main === module) main();

module.exports = { server, main };
