// models-catalog.js —— v1.3.0（第十二轮）：统一模型目录。
//
// 把"内置权重目录（installer/models.json）"与"用户自定义模型（data/install/state.json 的 custom）"
// 合成一份可操作的清单，并为每一条算出：
//   · installed / installedBytes —— 以 **modelsDir 里文件真实大小** 为准（不是记录）；
//   · requires                    —— 前置组件与前置模型（显式写在数据里，可审计）；
//   · route / encoder / vae       —— 自定义模型用；内置模型由管线规则派生。
//
// 为什么前置要显式写进 models.json：需求要求"下载某模型时，若前置没下就提醒并自动入队"。
// 靠文件名猜前置（qwen_3_06b_base 是 Anima 的编码器…）在生产代码里太脆；
// 数据里写清楚，界面与队列都直接读，出问题也能一眼审计。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths, load } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');
const installState = require('./install-state');

// 目标子目录白名单（也是 ComfyUI 的 models/ 子目录名）
const DEST_DIRS = ['diffusion_models', 'text_encoders', 'vae', 'checkpoints', 'loras', 'unet', 'clip'];

// v1.3.0：**默认模型**（首次启动「一键下载组件 + 默认模型」装的就是它 + 它的前置）。
// 选它的理由：它是面板默认管线（Anima 通用）的默认权重、也是 minimal 档的主模型，
// 体积 3.9 GiB；配套编码器 qwen_3_06b_base 与 VAE qwen_image_vae 由它的 `requires` 声明。
const DEFAULT_MODEL_ID = 'anima-turbo-v1.1';

// 管线家族（与 web/panel.js 的 PIPELINE_RULES 同口径；这里是服务端的一份独立实现，
// 用于**保存自定义模型时**就拦掉"编码器/VAE 配错管线"——那种错要到生成时才炸，报错完全看不懂）。
const ROUTE_RULES = {
  anima: {
    label: 'Anima 3.8B v2',
    latentChannels: 16,
    encoderDim: 1024,
    vaePattern: /^qwen_image_vae\.safetensors$/i,
    encoderPattern: /^qwen_3_06b_base\.safetensors$/i,
    defaultVae: 'qwen_image_vae.safetensors',
    defaultEncoder: 'qwen_3_06b_base.safetensors',
  },
  animaPlain: {
    label: 'Anima（通用）',
    latentChannels: 16,
    encoderDim: 1024,
    vaePattern: /^qwen_image_vae\.safetensors$/i,
    encoderPattern: /^qwen_3_06b_base\.safetensors$/i,
    defaultVae: 'qwen_image_vae.safetensors',
    defaultEncoder: 'qwen_3_06b_base.safetensors',
  },
  qwen: {
    label: 'Qwen-Image 2.1',
    latentChannels: 64,
    encoderDim: 4096,
    vaePattern: /^qwen_image_2\.1_vae_bf16\.safetensors$/i,
    encoderPattern: /^qwen3vl_8b_w4a8\.safetensors$/i,
    defaultVae: 'qwen_image_2.1_vae_bf16.safetensors',
    defaultEncoder: 'qwen3vl_8b_w4a8.safetensors',
  },
};

function catalog() {
  const list = fsx.readJson(paths.modelsJson, []);
  if (!Array.isArray(list)) throw new Error('installer/models.json 解析失败（应为数组）');
  return list;
}

/** 内置目录的 id → 条目。 */
function byId(id) {
  const key = String(id || '').toLowerCase();
  return catalog().find((m) => String(m.id).toLowerCase() === key) || null;
}

function modelsDirFor(opts = {}) {
  const s = load();
  const mode = opts.mode || s.comfy.mode || 'embedded';
  const dir = mode === 'external' ? (opts.externalDir || s.comfy.dir) : paths.comfyEmbedded;
  const comfy = require('./comfy');
  const layout = comfy.detectLayout(dir);
  if (layout.ok) return layout.modelsDir;
  return path.join(dir, 'ComfyUI', 'models');
}

/** 磁盘真值：某个模型的落位文件与大小。 */
function diskState(entry, modelsDir) {
  const file = path.join(modelsDir, entry.dest, entry.file);
  const size = fsx.sizeOf(file);
  const exists = size >= 0;
  const ready = exists && (entry.bytes ? size === entry.bytes : size > 0);
  return { file, exists, size: exists ? size : 0, ready };
}

/** 按文件名猜管线（与 web/panel.js 的 routeFor 同口径；用于自定义模型的默认值）。 */
function guessRoute(file) {
  const f = String(file || '');
  if (/qwen[-_]?image/i.test(f)) return 'qwen';
  if (/^anima-3\.8b/i.test(f)) return 'anima';
  return 'animaPlain';
}

/** 依据模型文件/编码器/VAE 判断一条自定义模型的配置是否自洽；自洽返回 null，否则返回人话原因。 */
function validatePairing({ route, encoder, vae }) {
  const rule = ROUTE_RULES[route];
  if (!rule) return '未知管线：' + route;
  if (!encoder) return '必须指定配套的文本编码器（' + rule.defaultEncoder + '），否则会在编码阶段报维度错误';
  if (!vae) return '必须指定配套的 VAE（' + rule.defaultVae + '），否则会在 VAE 解码时报通道数错误';
  if (!rule.encoderPattern.test(encoder)) {
    return rule.label + ' 管线需要 ' + rule.encoderDim + ' 维文本编码器（文件名匹配 ' + rule.encoderPattern.source
      + '），不能用 ' + encoder + '：编码器的嵌入维度不匹配会在文本编码器深处报归一化形状错误，而不是在出图阶段。';
  }
  if (!rule.vaePattern.test(vae)) {
    return rule.label + ' 管线需要 ' + rule.latentChannels + ' 通道潜空间的 VAE（文件名匹配 ' + rule.vaePattern.source
      + '），不能用 ' + vae + '：通道数不匹配会在 VAEDecode 深处报通道数错误。';
  }
  return null;
}

/** 文件名的安全校验：不允许任何路径成分（防目录穿越），必须带一个常见权重后缀。 */
function normalizeFileName(raw) {
  const name = path.basename(String(raw || '').trim());
  if (!name || name === '.' || name === '..') throw new Error('文件名不能为空');
  if (/[\\/]/.test(String(raw))) throw new Error('文件名里不能带路径（只填文件名，目标目录由「目标类型」决定）：' + raw);
  if (!/\.(safetensors|ckpt|pt|pth|gguf|bin|sft)$/i.test(name)) {
    throw new Error('只支持权重文件扩展名（.safetensors/.ckpt/.pt/.pth/.gguf/.bin/.sft）：' + name);
  }
  return name;
}

function normalizeDest(raw) {
  const d = String(raw || 'diffusion_models').trim();
  if (!DEST_DIRS.includes(d)) throw new Error('目标类型必须是以下之一：' + DEST_DIRS.join(' / '));
  return d;
}

/** 自定义模型的 id：稳定、可读、不冲突（c-<时间戳36>-<随机>）。 */
function newCustomId() {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

/**
 * 归一化一条自定义模型入参 → 可落盘的记录。
 * 关键语义（用户明确要求）：**本地上传的模型即便与内置同名同内容，也是一条独立的自定义模型**
 * （有用户自己起的名字），因此不做任何"去重到内置"的处理。
 */
function normalizeCustom(payload = {}, existing = null) {
  const name = String(payload.name || '').trim().slice(0, 60);
  if (!name) throw new Error('请给这个自定义模型起一个名字（用于在生图面板里显示）');
  const file = normalizeFileName(payload.file);
  const dest = normalizeDest(payload.dest);
  const route = ROUTE_RULES[payload.route] ? payload.route : guessRoute(file);
  const encoder = String(payload.encoder || ROUTE_RULES[route].defaultEncoder).trim();
  const vae = String(payload.vae || ROUTE_RULES[route].defaultVae).trim();
  const why = validatePairing({ route, encoder, vae });
  if (why) throw new Error(why);
  const bytes = Number(payload.bytes) || 0;
  return {
    id: existing ? existing.id : (payload.id || newCustomId()),
    name,
    file,
    dest,
    route,
    encoder,
    vae,
    bytes,
    sha256: String(payload.sha256 || '').trim() || undefined,
    sourceUrl: String(payload.sourceUrl || '').trim() || undefined,
    origin: payload.origin || (existing && existing.origin) || 'uploaded',
    note: String(payload.note || '').trim().slice(0, 300) || undefined,
    createdAt: (existing && existing.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 展开的前置清单：组件 id 用 'runtime' / 'comfyui' / 'node:xxx'；模型用 'model:<id>'。 */
function requiresOf(entry) {
  if (Array.isArray(entry.requires) && entry.requires.length) return entry.requires.map(String);
  if (!entry.custom) return ['runtime', 'comfyui'];
  // 自定义模型：最小前置 = 运行时 + 本体 + 它声明的编码器/VAE（按文件名反查内置 id）
  const req = ['runtime', 'comfyui'];
  for (const f of [entry.encoder, entry.vae]) {
    const hit = catalog().find((m) => m.file.toLowerCase() === String(f).toLowerCase());
    if (hit) req.push('model:' + hit.id);
  }
  return req;
}

/**
 * 统一目录（安装中心、向导、前置解析都用它）。
 * @param {object} opts {mode, externalDir, withTasks}
 */
function list(opts = {}) {
  const modelsDir = modelsDirFor(opts);
  const state = installState.read();
  const comps = installState.componentStatus({ mode: opts.mode, externalDir: opts.externalDir });
  // v1.3.0（需求修正）：界面只显示「前置组件 / ComfyUI 本体」两组，具体组件不再暴露给用户
  const groups = installState.groupStatus({ mode: opts.mode, externalDir: opts.externalDir });
  const builtin = catalog().map((m) => {
    const d = diskState(m, modelsDir);
    const marker = state.models[m.id] || null;
    return {
      id: m.id,
      name: m.file,
      file: m.file,
      dest: m.dest,
      bytes: m.bytes,
      sha256: m.sha256 || '',
      license: m.license || '',
      licenseName: m.licenseName || '',
      licenseNote: m.licenseNote || '',
      tier: m.tier || '',
      note: m.note || '',
      custom: false,
      installed: d.ready,
      installedBytes: d.size,
      path: d.file,
      requires: requiresOf(m),
      route: guessRoute(m.file),
      encoder: null,
      vae: null,
    };
  });
  const custom = installState.listCustom().map((c) => {
    const d = diskState(c, modelsDir);
    return {
      id: c.id,
      name: c.name,
      file: c.file,
      dest: c.dest,
      bytes: c.bytes || d.size,
      sha256: c.sha256 || '',
      license: 'user-provided',
      licenseName: 'user-provided',
      licenseNote: '用户自备权重：许可与合规由用户自行确认（本程序不随包分发权重）。',
      tier: '',
      note: c.note || '',
      custom: true,
      origin: c.origin || 'uploaded',
      route: c.route,
      encoder: c.encoder,
      vae: c.vae,
      sourceUrl: c.sourceUrl || '',
      createdAt: c.createdAt,
      installed: d.ready || d.exists,
      installedBytes: d.size,
      path: d.file,
      requires: requiresOf(c),
    };
  });
  // 前置是否满足（组件缺失 或 前置模型未就绪）
  const all = builtin.concat(custom);
  const index = new Map(all.map((m) => [m.id, m]));
  // 需求 1：界面上**不出现具体组件名** —— 缺失的组件一律按"组"来报（前置组件 / ComfyUI 本体）；
  // 缺失的模型则直接点出文件名（那是用户自己选的东西，名字必须给）。
  const groupTitleOf = (componentId) => {
    const g = installState.GROUPS.find((x) => x.members.includes(componentId));
    return g ? g.title : componentId;
  };
  for (const m of all) {
    const missing = [];
    for (const r of m.requires) {
      if (r.startsWith('model:')) {
        const id = r.slice('model:'.length);
        const dep = index.get(id);
        if (!dep || !dep.installed) missing.push({ kind: 'model', id, title: dep ? dep.name : id, installed: false });
      } else if (r.startsWith('node:')) {
        const ok = !!(comps.nodes && comps.nodes.ok);
        if (!ok) missing.push({ kind: 'component', id: 'nodes', group: 'prereq', title: groupTitleOf('nodes'), installed: false });
      } else {
        const c = comps[r];
        if (!c || !c.ok) {
          const g = installState.GROUPS.find((x) => x.members.includes(r));
          missing.push({ kind: 'component', id: r, group: g ? g.id : 'prereq', title: groupTitleOf(r), installed: false });
        }
      }
    }
    m.missing = missing;
    // 界面用：去重后的"缺哪几组"（只给组名，不给组件名）
    m.missingGroups = [...new Set(missing.filter((x) => x.kind === 'component').map((x) => x.title))];
    m.missingModels = missing.filter((x) => x.kind === 'model').map((x) => x.title);
    m.ready = m.installed && missing.length === 0;
  }
  const installed = all.filter((m) => m.installed);
  return {
    modelsDir,
    comfyDir: opts.mode === 'external' ? (opts.externalDir || load().comfy.dir) : paths.comfyEmbedded,
    components: comps,
    // 界面用这一层（只两组）；`components` 保留给排障/脚本（含每个组件的真实判定）
    groups,
    items: all,
    totals: {
      count: all.length,
      installed: installed.length,
      installedBytes: installed.reduce((a, m) => a + (m.installedBytes || m.bytes || 0), 0),
      pendingBytes: all.filter((m) => !m.installed).reduce((a, m) => a + (m.bytes || 0), 0),
    },
    destDirs: DEST_DIRS,
    // v1.3.0：**默认模型** —— 首次启动引导只装它 + 它自己声明的前置（见 requires），
    // 而不是把 12 个权重全排上。改这里就等于改"一键下载的模型集"。
    defaultModelId: DEFAULT_MODEL_ID,
    defaultModelIds: (() => {
      const req = catalog().find((m) => m.id === DEFAULT_MODEL_ID);
      const deps = (req && Array.isArray(req.requires) ? req.requires : [])
        .filter((r) => r.startsWith('model:')).map((r) => r.slice('model:'.length));
      return [DEFAULT_MODEL_ID, ...deps];
    })(),
    routeRules: Object.fromEntries(Object.entries(ROUTE_RULES).map(([k, v]) => [k, {
      label: v.label, encoder: v.defaultEncoder, vae: v.defaultVae, encoderDim: v.encoderDim, latentChannels: v.latentChannels,
    }])),
  };
}

/** 前置展开为"可直接入队的引用"（组件用 component:<id>，模型用 model:<id>）。 */
function prerequisiteRefs(entry) {
  const out = [];
  for (const r of requiresOf(entry)) {
    if (r.startsWith('model:')) out.push({ kind: 'model', refId: r.slice('model:'.length) });
    else if (r.startsWith('node:')) out.push({ kind: 'component', refId: 'nodes' });
    else out.push({ kind: 'component', refId: r });
  }
  return out;
}

module.exports = {
  DEST_DIRS, ROUTE_RULES, DEFAULT_MODEL_ID,
  catalog, byId, modelsDirFor, diskState, list, requiresOf, prerequisiteRefs,
  guessRoute, validatePairing, normalizeFileName, normalizeDest, normalizeCustom, newCustomId,
};
