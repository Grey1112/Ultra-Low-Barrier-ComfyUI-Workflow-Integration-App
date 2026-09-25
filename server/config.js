// 路径与设置。
//
// 可迁移性：所有项目内路径都从 __dirname 向上推导（<项目根>/server/config.js → <项目根>），
// 项目文件夹改名/换盘符/整体拷贝后自动成立；代码里没有任何绝对机器路径。
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const fsx = require('./util/fsx');

const ROOT = path.resolve(__dirname, '..');

const paths = {
  root: ROOT,
  web: path.join(ROOT, 'web'),
  assets: path.join(ROOT, 'assets'),
  data: path.join(ROOT, 'data'),
  models: path.join(ROOT, 'models'),
  llmModels: path.join(ROOT, 'models', 'llm'),
  runtime: path.join(ROOT, 'runtime'),
  runtimeBin: path.join(ROOT, 'runtime', 'bin'),
  runtimeDl: path.join(ROOT, 'runtime', '_dl'),
  comfyEmbedded: path.join(ROOT, 'runtime', 'comfyui'),
  logs: path.join(ROOT, 'logs'),
  jobs: path.join(ROOT, 'logs', 'jobs'),
  installer: path.join(ROOT, 'installer'),
  licenses: path.join(ROOT, 'LICENSES'),
  artists: path.join(ROOT, 'assets', 'artists'),
  templates: path.join(ROOT, 'assets', 'templates'),
  systemPrompt: path.join(ROOT, 'assets', 'templates', 'anima-system-prompt.txt'),
  modelsJson: path.join(ROOT, 'installer', 'models.json'),
  settingsFile: path.join(ROOT, 'data', 'settings.json'),
  artistsFile: path.join(ROOT, 'data', 'artists.json'),
  llmModelsFile: path.join(ROOT, 'data', 'llm', 'models.json'),
  llmSessionsFile: path.join(ROOT, 'data', 'llm', 'sessions.json'),
  setupFile: path.join(ROOT, 'data', 'setup.json'),
  serverLog: path.join(ROOT, 'logs', 'server.log'),
  comfyLog: path.join(ROOT, 'logs', 'comfyui.log'),
  llmLog: path.join(ROOT, 'logs', 'llama-server.log'),
};

const VERSION = '1.0.0';
const BUILD_TAG = 'v' + VERSION;

const DEFAULTS = {
  version: 1,
  lang: 'zh',
  listen: { host: '127.0.0.1', port: 8788, lan: false },
  comfy: {
    mode: 'embedded',      // embedded | external
    dir: '',               // 外接模式的 ComfyUI 目录（用户填写的绝对路径，只存在 data/ 内）
    port: 8188,
    autoStart: false,
    extraArgs: [],
  },
  download: {
    officialTimeoutMs: 10000,
    // 用户规则：**10 秒内没有实际进展就换源**。
    //   startDeadlineMs 管"连上/发出请求后多久必须开始出数据"；
    //   stallDeadlineMs 管"下载中途连续多久没有新字节就判停滞"。
    startDeadlineMs: 10000,
    stallDeadlineMs: 15000,
    minStartBytes: 65536,
    slowThresholdKBs: 200,
    slowWindowMs: 30000,
    // 停滞阈值：低于它就说明"真的没在动"，任何候选源都会因此换源；
    // 而 slowThreshold 只用来在前几个候选之间"挑更快的"，最后一个候选不再因"慢"被掐。
    stallKBs: 30,
    hfMirror: 'https://hf-mirror.com',
    // aifasthub：实测 86–109 MB/s，是 Anima 系权重最快的镜像之一。
    aifasthub: 'https://aifasthub.com',
    // ModelScope（国内直连通常最快）：HF 的 /resolve/ URL 会自动改写成 modelscope.cn 的对应地址。
    // 注意：ModelScope 仓库**默认分支是 master 而不是 main**，模板里两个都要留。
    modelscope: 'https://modelscope.cn',
    useModelScope: true,
    // HuggingFace 类仓库的镜像梯队（按顺序尝试，10 s 内没进展就下一个）。
    // 占位符：{repo}=owner/name，{path}=resolve/<rev>/ 之后的部分，{file}=文件名，
    //        {rev}=原链接的 revision，{url}=原链接整体。
    // 实测（本机 2026-09）：ModelScope 74–95 Mbps、aifasthub 86–109 Mbps、
    // hf-mirror 仅 0.15–1.2 MB/s（能下但很慢 → 只当兜底，不排前面）。
    hfMirrors: [],
    // GitHub 代理：实测（2026-09 本机，两轮独立探测）**只有两个是快源**：
    //   · gh-proxy.com：4.4–16 MB/s（另一次 230 MB/15 s ≈ 15 MB/s）
    //   · down.npee.cn：4.07–24.92 MB/s（4/4 通过，官方 v0.37.0 资产）
    // ghproxy.net / ghfast.top 能出数据但被限速到 0.10–0.37 MB/s（大文件只当兜底）；
    // ghps.cc 全站 404；hub.gitmirror / github.moeyy.xyz / ghp.ci 等约 20 个域名 DNS 已失效；
    // kkgithub / bgithub 证书不匹配；gh.ddlc.top 429 —— 都不收录，收录了只会浪费一轮超时。
    // 也支持"换主机"式模板：'https://kkgithub.com/{repo}/releases/download/{ver}/{file}'。
    githubProxies: [
      'https://gh-proxy.com/',
      'https://down.npee.cn/?{url}',
      'https://ghproxy.net/',
      'https://ghfast.top/',
    ],
    // 便携 Node（nodejs.org 的 zip）镜像：实测 tuna 29.6 MB/s、官方 17.2 MB/s、
    // 华为云 9.8 MB/s、cdn.npmmirror 9.2 MB/s —— 四个都稳定，官方源在国内也不慢。
    nodeMirrors: [],
    nodeVersion: 'v22.14.0',
    // jsDelivr 的 GitHub 通道（角色词表 danbooru.csv 走这里）：换 CDN 节点 + 回落 raw。
    // 实测 jsdelivr 与 gh-proxy 都能 1–2 s 收全 3.5 MB。
    jsdelivrMirrors: [],
    // 通用兜底：任何直链都会额外追加这些代理（{url} 占位）。
    extraMirrors: [],
    pipIndex: 'https://pypi.tuna.tsinghua.edu.cn/simple',
    pipIndexFallback: 'https://mirrors.aliyun.com/pypi/simple',
  },
  llm: {
    contextMessages: 5,
    defaultModel: '',
    port: 8199,
    ctxSize: 8192,
    gpuLayers: 99,
    // 单次回答的 token 上限：默认 512 —— 期望输出只有约 100 token，
    // 但小模型不设上限会写出几千 token 的思维链/词汤，既慢又会吃光上下文。
    maxTokens: 512,
    // 推理来源：local = 本机 llama.cpp；api = 外接 OpenAI 兼容接口（只做纯聊天，不接工具/内核）。
    // 默认走外接 API：开箱即用、不占显存、不需要先下载几 GB 权重（本地模型仍可一键切回）。
    provider: 'api',
    // 角色 tag 补全：用确定性词表把用户话里的角色名补成规范 Danbooru tag。
    // 关掉后程序完全不动模型输出（个别常用词误命中时可用它一键关闭）。
    characterRepair: true,
    api: {
      // DeepSeek 预设（同样兼容其它 OpenAI 兼容服务；也可填 http://127.0.0.1:8199/v1 用本机 llama-server）
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',       // 只保存在 <项目根>\data\settings.json（不入库、绝不写进日志）
      model: 'deepseek-flash',
      temperature: 0.6,
      // 思考型模型（deepseek-flash 等）会把 token 花在思考上：预算太小会导致正文为空。
      // 所以外接默认给 4096，并把思考关掉（见 thinking）；需要时用户可自行调大/打开。
      maxTokens: 4096,
      // 流式长回答的总超时给足；真正"卡死"由空闲看门狗判定（见 llm.js 的 idleMs）。
      timeoutMs: 300000,
      // 推理挡位（四挡，DeepSeek 实测口径）：
      //   off  = 下发 thinking:{type:'disabled'} + chat_template_kwargs.enable_thinking=false，思考归零（默认，提示词生成最快最稳）
      //   low / high / max = 下发 reasoning_effort（实测 reasoning_tokens：low 620 / high 635 / max 1459，默认档 807）
      // 注意：实测 `effort` 字段无效，必须用 `reasoning_effort`。
      reasoning: 'off',
      // 网络/限流重试次数（429 / 5xx / 连接失败时退避重试）。
      retries: 2,
      // 流式过程中多久没有任何数据就判定卡死（毫秒）。
      idleMs: 90000,
    },
    // 上下文策略：界面上保留完整历史（可整段复制），但默认**不把上下文发给模型**。
    sendContext: false,
    // 每个会话在本地最多保留多少条消息（供界面回溯与复制；与"发给模型多少条"无关）。
    keepMessages: 40,
  },
};

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(out[k] && typeof out[k] === 'object' ? out[k] : {}, v) : v;
  }
  return out;
}

function normalize(s) {
  const out = deepMerge(DEFAULTS, s || {});
  out.lang = out.lang === 'en' ? 'en' : 'zh';
  out.listen.host = out.listen.lan ? '0.0.0.0' : '127.0.0.1';
  out.listen.port = clampInt(out.listen.port, 1, 65535, 8788);
  out.comfy.mode = out.comfy.mode === 'external' ? 'external' : 'embedded';
  out.comfy.port = clampInt(out.comfy.port, 1, 65535, 8188);
  out.llm.port = clampInt(out.llm.port, 1, 65535, 8199);
  out.llm.contextMessages = clampInt(out.llm.contextMessages, 0, 20, 5);
  out.llm.ctxSize = clampInt(out.llm.ctxSize, 512, 262144, 8192);
  out.llm.gpuLayers = clampInt(out.llm.gpuLayers, 0, 999, 99);
  out.llm.maxTokens = clampInt(out.llm.maxTokens, 64, 8192, 512);
  out.llm.provider = out.llm.provider === 'api' ? 'api' : 'local';
  out.llm.characterRepair = out.llm.characterRepair !== false;
  out.llm.api.baseUrl = String(out.llm.api.baseUrl || '').trim().replace(/\/+$/, '');
  out.llm.api.apiKey = String(out.llm.api.apiKey || '').trim();
  out.llm.api.model = String(out.llm.api.model || '').trim();
  out.llm.api.temperature = Math.min(2, Math.max(0, Number(out.llm.api.temperature) || 0.6));
  // 上限放到 393216：像 deepseek-flash 这类模型单次可输出几十万 token，卡在 32768 会白等。
  out.llm.api.maxTokens = clampInt(out.llm.api.maxTokens, 64, 393216, 4096);
  out.llm.api.timeoutMs = clampInt(out.llm.api.timeoutMs, 5000, 1800000, 300000);
  // 推理挡位：四挡；兼容旧键 thinking（disabled→off、server→high）。
  const legacyThinking = out.llm.api.thinking;
  if (out.llm.api.reasoning === undefined && legacyThinking !== undefined) {
    out.llm.api.reasoning = legacyThinking === 'disabled' ? 'off' : 'high';
  }
  out.llm.api.reasoning = ['off', 'low', 'high', 'max'].includes(out.llm.api.reasoning) ? out.llm.api.reasoning : 'off';
  delete out.llm.api.thinking;
  out.llm.api.retries = clampInt(out.llm.api.retries, 0, 5, 2);
  out.llm.api.idleMs = clampInt(out.llm.api.idleMs, 5000, 600000, 90000);
  // 上下文策略：界面保留历史（keepMessages），默认不把上下文发给模型。
  out.llm.sendContext = out.llm.sendContext === true;
  out.llm.keepMessages = clampInt(out.llm.keepMessages, 2, 200, 40);
  out.download.officialTimeoutMs = clampInt(out.download.officialTimeoutMs, 1000, 120000, 10000);
  // 用户规则：10 s 内没进展就换源（两个阈值都可在设置页调）。
  out.download.startDeadlineMs = clampInt(out.download.startDeadlineMs, 2000, 120000, 10000);
  out.download.stallDeadlineMs = clampInt(out.download.stallDeadlineMs, 2000, 300000, 15000);
  out.download.minStartBytes = clampInt(out.download.minStartBytes, 0, 10485760, 65536);
  out.download.slowThresholdKBs = clampInt(out.download.slowThresholdKBs, 1, 100000, 200);
  out.download.slowWindowMs = clampInt(out.download.slowWindowMs, 1000, 600000, 30000);
  out.download.stallKBs = clampInt(out.download.stallKBs, 1, 100000, 30);
  out.download.modelscope = String(out.download.modelscope || 'https://modelscope.cn').trim().replace(/\/+$/, '');
  out.download.hfMirror = String(out.download.hfMirror || 'https://hf-mirror.com').trim().replace(/\/+$/, '');
  out.download.aifasthub = String(out.download.aifasthub || 'https://aifasthub.com').trim().replace(/\/+$/, '');
  out.download.useModelScope = out.download.useModelScope !== false;

  // ── 镜像梯队（数据驱动）────────────────────────────────────
  // 每一项都是一个 URL 模板，支持 {repo} {path} {file} {rev} {url} 占位符。
  // 空数组 = 用下面按"基地址设置"组合出来的默认梯队；用户可在设置页整段替换。
  if (!Array.isArray(out.download.hfMirrors) || !out.download.hfMirrors.length) {
    const ms = out.download.modelscope;
    out.download.hfMirrors = [
      // ① ModelScope：实测 74–95 MB/s。默认分支是 master，少数仓库用 main，两条都放上。
      ...(out.download.useModelScope ? [
        `${ms}/models/{repo}/resolve/master/{path}`,
        `${ms}/models/{repo}/resolve/main/{path}`,
      ] : []),
      // ② aifasthub：实测 86–109 MB/s（晚些时候复测曾降到 1–2 MB/s，属时段性）。
      `${out.download.aifasthub}/models/{repo}/resolve/main/{path}`,
      // ③ hf-api.gitee.com：模板与 HF 完全同形（owner/repo/resolve/main/path），实测 5.8–7 MB/s；
      //    镜像的是 HF 仓库的**某个快照**，没有该文件时会 404（约 0.3 s，可接受）。
      'https://hf-api.gitee.com/{repo}/resolve/main/{path}',
      // ④ ai.gitcode.com：同样是 HF 快照镜像（多一层 hf_mirrors/），实测 17–20 MB/s；
      //    resolve 端点按 IP 限流（429），失败会自动退到下一个源。
      'https://ai.gitcode.com/hf_mirrors/{repo}/resolve/main/{path}',
      // ⑤ hf-mirror：实测只有 0.15–1.2 MB/s，能下完但很慢 → 只当兜底。
      `${out.download.hfMirror}/{repo}/resolve/main/{path}`,
    ];
  } else {
    out.download.hfMirrors = out.download.hfMirrors.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (!Array.isArray(out.download.nodeMirrors) || !out.download.nodeMirrors.length) {
    out.download.nodeMirrors = [
      'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/{ver}/{file}',
      'https://nodejs.org/dist/{ver}/{file}',
      'https://mirrors.huaweicloud.com/nodejs/{ver}/{file}',
      'https://cdn.npmmirror.com/binaries/node/{ver}/{file}',
      'https://registry.npmmirror.com/-/binary/node/{ver}/{file}',
    ];
  } else {
    out.download.nodeMirrors = out.download.nodeMirrors.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (!Array.isArray(out.download.jsdelivrMirrors) || !out.download.jsdelivrMirrors.length) {
    out.download.jsdelivrMirrors = [
      'https://fastly.jsdelivr.net/gh/{repo}@{rev}/{path}',
      'https://gcore.jsdelivr.net/gh/{repo}@{rev}/{path}',
      'https://raw.githubusercontent.com/{repo}/{rev}/{path}',
      'https://gh-proxy.com/https://raw.githubusercontent.com/{repo}/{rev}/{path}',
      'https://ghfast.top/https://raw.githubusercontent.com/{repo}/{rev}/{path}',
    ];
  } else {
    out.download.jsdelivrMirrors = out.download.jsdelivrMirrors.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (!Array.isArray(out.download.githubProxies) || !out.download.githubProxies.length) {
    out.download.githubProxies = DEFAULTS.download.githubProxies.slice();
  } else {
    out.download.githubProxies = out.download.githubProxies.map((x) => String(x || '').trim()).filter(Boolean);
  }
  if (!Array.isArray(out.download.extraMirrors)) out.download.extraMirrors = [];
  else out.download.extraMirrors = out.download.extraMirrors.map((x) => String(x || '').trim()).filter(Boolean);
  if (!Array.isArray(out.comfy.extraArgs)) out.comfy.extraArgs = [];
  return out;
}

function clampInt(v, lo, hi, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

let cache = null;

function load() {
  if (cache) return cache;
  cache = normalize(fsx.readJson(paths.settingsFile, {}));
  return cache;
}

// 只在内存里派生、**不写进 settings.json** 的键（镜像梯队）。
// 为什么必须这样：save() 写的是"归一化后的完整对象"，如果把这些派生值也落盘，
// 那用户只要点过一次保存（或任何一个 PUT /app/settings 的调用），当前版本的默认梯队就被
// **永久固化**进设置文件 —— 之后升级默认镜像（本轮就升级了两次）对这台机器完全无效。
// 实测踩过：跑一次外接 API 测试（内部会 PUT 设置）就把 4 条旧梯队钉进了 settings.json。
const DERIVED_KEYS = ['hfMirrors', 'nodeMirrors', 'jsdelivrMirrors', 'extraMirrors'];

function save(patch) {
  const next = normalize(deepMerge(load(), patch || {}));
  const raw = fsx.readJson(paths.settingsFile, {});
  const p = patch || {};
  const toDisk = JSON.parse(JSON.stringify(next));
  for (const k of DERIVED_KEYS) {
    const explicit = (p.download && p.download[k] !== undefined) || (raw.download && raw.download[k] !== undefined);
    if (!explicit) delete toDisk.download[k];
  }
  // 同一个陷阱的另一半：设置页每次保存都会把 githubProxies 原样回传，等于"用户显式设置过"，
  // 于是默认代理列表也会被第一次保存永久钉住。这里补一条规则：**值等于当前默认值就不落盘**，
  // 这样以后升级默认代理列表对老用户同样生效；用户真改过（不等于默认）时才持久化。
  if (Array.isArray(toDisk.download.githubProxies)
    && JSON.stringify(toDisk.download.githubProxies) === JSON.stringify(DEFAULTS.download.githubProxies)) {
    delete toDisk.download.githubProxies;
  }
  cache = next;
  fsx.writeJsonAtomic(paths.settingsFile, toDisk);
  return next;
}

/** 当前生效的 ComfyUI 目录。embedded = 项目内；external = 用户填写的路径。 */
function comfyDir(settings = load()) {
  if (settings.comfy.mode === 'external') return settings.comfy.dir || '';
  return paths.comfyEmbedded;
}

/** 迁移自检：外接路径失效、项目内运行时缺失等；只报告不阻断（红线：不能静默失败，但也不该拒绝启动）。 */
function selfcheck() {
  const s = load();
  const issues = [];
  const external = [];
  if (s.comfy.mode === 'external') {
    const ok = !!s.comfy.dir && fsx.isDir(s.comfy.dir);
    external.push({ key: 'comfy.dir', path: s.comfy.dir, exists: ok });
    if (!ok) {
      issues.push({
        code: 'comfy-dir-missing', level: 'error',
        message: '外接 ComfyUI 目录不存在（多半是整体拷贝到别的电脑/盘符后路径失效）',
        fix: '打开「设置 → ComfyUI」重新指向本机的 ComfyUI 目录，或改用「内嵌模式」由向导安装。',
        path: s.comfy.dir || '(未填写)',
      });
    }
  } else if (!fsx.isFile(path.join(paths.comfyEmbedded, 'ComfyUI', 'main.py')) && !fsx.isFile(path.join(paths.comfyEmbedded, 'main.py'))) {
    issues.push({
      code: 'comfy-embedded-missing', level: 'warn',
      message: '尚未在项目内安装 ComfyUI（内嵌模式）',
      fix: '打开「首次运行向导」获取 ComfyUI 便携包（或指定本地归档）。',
      path: paths.comfyEmbedded,
    });
  }
  if (!fsx.isFile(paths.systemPrompt)) {
    issues.push({ code: 'system-prompt-missing', level: 'warn', message: '内置系统提示词文件缺失', fix: '恢复 assets/templates/anima-system-prompt.txt。', path: paths.systemPrompt });
  }
  if (!fsx.isFile(path.join(paths.artists, 'Anima2B_Artist_Index_59k.txt'))) {
    issues.push({ code: 'artists-missing', level: 'warn', message: '画师清单缺失，随机画师会降级', fix: '恢复 assets/artists/ 下的两份清单 txt。', path: paths.artists });
  }
  const llmExe = path.join(paths.runtimeBin, 'llama', 'llama-server.exe');
  if (!fsx.isFile(llmExe)) {
    issues.push({ code: 'llm-runtime-missing', level: 'warn', message: '本地 LLM 运行时（llama.cpp）尚未安装', fix: '在「本地 LLM」页点「安装运行时」。', path: llmExe });
  }
  const defaultModel = s.llm.defaultModel;
  if (defaultModel && !fsx.isFile(path.join(paths.llmModels, defaultModel))) {
    issues.push({ code: 'llm-model-missing', level: 'warn', message: '默认 LLM 模型文件不存在', fix: '在「本地 LLM → 模型管理」重新指定默认模型。', path: path.join(paths.llmModels, defaultModel) });
  }
  const host = os.hostname();
  return { ok: issues.filter((i) => i.level === 'error').length === 0, issues, external, host, root: paths.root };
}

module.exports = { paths, load, save, normalize, comfyDir, selfcheck, VERSION, BUILD_TAG, DEFAULTS, deepMerge, clampInt };
