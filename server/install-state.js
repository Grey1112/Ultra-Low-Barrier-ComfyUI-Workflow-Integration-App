// install-state.js —— v1.3.0（第十二轮）：安装状态（组件 / 模型 / 自定义模型）。
//
// 为什么需要它（修的是用户报的恶性 bug）：
//   · 旧实现的"装完了没有"只写在 data/setup.json 里，而那个文件**只在向导全部跑完时才写**；
//     中途关窗口 / 下载卡住 / 解压失败 → 没有任何记录 → 下次点「开始安装」**从头再来一遍**：
//     又去下 1.79 GB 的 ComfyUI 便携包、又全量解压，并把已装好的权重目录一起删掉。
//     （本机实测就是这样：runtime/_dl 里留着 .part，runtime/comfyui 只剩一个空壳。）
//   · 本模块把状态**逐组件、逐模型**落盘（data/install/state.json），并且**判定一律以磁盘真值优先**：
//     记录只是缓存与审计，文件不在了就当作没装。这样"手动删了文件"也能自愈，不存在"记着装了其实没了"。
//
// 目录：data/install/  →  {state.json, tasks.json}
// 两者都在 data/ 下（.gitignore 已整体忽略），随项目迁移但不进交付包。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { paths, load, comfyDir } = require('./config');
const fsx = require('./util/fsx');
const log = require('./util/log');

const SCHEMA = 1;

// 组件清单：id 是稳定契约（接口 / 队列 / 前端都用它）。
// v1.3.0（需求修正）：对用户**只显示两组** ——「前置组件」与「ComfyUI 本体」。
//   · 每个组件仍然独立判定、独立可装（后端逻辑不变，排障时需要粒度）；
//   · `visible:false` 的组件不单独出现在界面上，只作为所属组的成员参与"这一组是否就绪"；
//   · `group` 指明它归属哪一组（见 GROUPS）。
const COMPONENTS = [
  { id: 'runtime', group: 'prereq', visible: false, title: '运行时与解压工具（7-Zip）' },
  { id: 'nodes', group: 'prereq', visible: false, title: '自定义节点（comfyui-anima-3-8B）' },
  { id: 'artists', group: 'prereq', visible: false, title: '画师清单（59,676 位 Danbooru tag）' },
  { id: 'licenses', group: 'prereq', visible: false, title: '许可与第三方声明' },
  { id: 'comfyui', group: 'comfyui', visible: false, title: 'ComfyUI 本体（便携包）' },
];

// 面向用户的两组：安装中心与向导都**只渲染这两个条目**，组内具体装了什么不再暴露。
const GROUPS = [
  {
    id: 'prereq',
    title: '前置组件',
    // 需求：**不出现任何具体组件名** —— 只说"这一组装的是什么用途"。
    what: '出图要用到的附带件（解压、画师词库、许可文本等）。程序会自动挑需要的下载，不用你逐个选。',
    members: ['runtime', 'nodes', 'artists', 'licenses'],
  },
  {
    id: 'comfyui',
    title: 'ComfyUI 本体',
    what: '真正的出图引擎（约 1.79 GB，自带 Python 与依赖）。没有它无法出图。',
    members: ['comfyui'],
  },
];

const empty = () => ({ schema: SCHEMA, updatedAt: null, components: {}, models: {}, custom: {} });

function readRaw() {
  const v = fsx.readJson(paths.installStateFile, null);
  if (!v || typeof v !== 'object') return empty();
  return {
    schema: SCHEMA,
    updatedAt: v.updatedAt || null,
    components: v.components && typeof v.components === 'object' ? v.components : {},
    models: v.models && typeof v.models === 'object' ? v.models : {},
    custom: v.custom && typeof v.custom === 'object' ? v.custom : {},
  };
}

function writeRaw(v) {
  const next = { ...v, schema: SCHEMA, updatedAt: new Date().toISOString() };
  fsx.ensureDir(paths.installDir);
  fsx.writeJsonAtomic(paths.installStateFile, next);
  return next;
}

/** 记录式读取（不做磁盘校验）—— 仅供接口/审计展示。 */
function read() {
  return readRaw();
}

// ── 组件：磁盘真值判定 ────────────────────────────────────

function sevenZipExe() {
  const binDir = paths.runtimeBin;
  for (const n of ['7za.exe', '7zr.exe', '7za', '7zr']) {
    const p = path.join(binDir, n);
    if (fsx.isFile(p)) return p;
  }
  return null;
}

function embeddedMainPy() {
  const dir = paths.comfyEmbedded;
  const cands = [path.join(dir, 'ComfyUI', 'main.py'), path.join(dir, 'main.py')];
  return cands.find((p) => fsx.isFile(p)) || null;
}

/**
 * 单个组件的**真实状态**（不看记录）：
 *   ok=true 表示"确实已就绪，可以跳过安装"。
 */
function verifyComponent(id, opts = {}) {
  const s = load();
  switch (id) {
    case 'runtime': {
      const exe = sevenZipExe();
      return { id, ok: !!exe, detail: { exe: exe || null }, sizeBytes: exe ? fsx.sizeOf(exe) : 0 };
    }
    case 'comfyui': {
      const mode = opts.mode || (s.comfy.mode === 'external' ? 'external' : 'embedded');
      const comfy = require('./comfy');   // 延迟 require：避免 config ← comfy 的加载环
      const dir = mode === 'external' ? (opts.externalDir || s.comfy.dir) : paths.comfyEmbedded;
      const layout = comfy.detectLayout(dir);
      // 「解压完成」的判据必须是 主入口 + 解释器 都有：便携包解压到一半就中断时，
      // 目录里可能已经有 ComfyUI\ 但还没有 python_embeded —— 那种半成品不能当"已安装"。
      const ok = !!(layout.ok && layout.python);
      return {
        id, ok,
        detail: { dir, codeDir: layout.codeDir || null, layout: layout.ok ? layout.layout : 'unknown', mainPy: layout.mainPy || null, python: layout.python || null, external: mode === 'external' },
        error: ok ? null : (layout.error || '缺少 python_embeded 解释器（解压未完成）'),
      };
    }
    case 'nodes': {
      const mode = opts.mode || (s.comfy.mode === 'external' ? 'external' : 'embedded');
      const dir = mode === 'external' ? (opts.externalDir || s.comfy.dir) : paths.comfyEmbedded;
      const comfy = require('./comfy');
      const layout = comfy.detectLayout(dir);
      const dest = layout.ok
        ? path.join(layout.codeDir, 'custom_nodes', 'comfyui-anima-3-8B')
        : path.join(dir, 'ComfyUI', 'custom_nodes', 'comfyui-anima-3-8B');
      // 只要目录里有内容就算装过（节点仓库的入口文件可能是 __init__.py 也可能是 pyproject.toml 形态）
      let ok = false;
      try { ok = fsx.isDir(dest) && fs.readdirSync(dest).length > 0; } catch { ok = false; }
      return { id, ok, detail: { dir: dest } };
    }
    case 'artists': {
      const dir = paths.comfyEmbedded;
      const layout = require('./comfy').detectLayout(dir);
      const targets = [path.join(dir, 'model-notes')];
      if (layout.ok) targets.push(path.join(layout.codeDir, 'model-notes'));
      const files = ['Anima2B_Artist_Index_59k.txt', 'Anima2B_Artist_top200.txt'];
      const found = [];
      for (const t of targets) {
        for (const f of files) if (fsx.isFile(path.join(t, f))) found.push(path.join(t, f));
      }
      return { id, ok: found.length >= files.length, detail: { files: found, targets } };
    }
    case 'licenses': {
      const dest = path.join(paths.comfyEmbedded, 'LICENSES');
      let n = 0;
      try { n = fsx.isDir(dest) ? fs.readdirSync(dest).length : 0; } catch { n = 0; }
      return { id, ok: n > 0, detail: { dir: dest, files: n } };
    }
    default:
      return { id, ok: false, detail: {}, error: '未知组件：' + id };
  }
}

/** 全部组件的真实状态表。 */
function componentStatus(opts = {}) {
  const out = {};
  for (const c of COMPONENTS) out[c.id] = { ...c, ...verifyComponent(c.id, opts) };
  return out;
}

/**
 * v1.3.0（需求修正）：面向用户的**两组**聚合状态。
 * 界面只显示这一层（"前置组件" / "ComfyUI 本体"），组内具体组件不再暴露；
 * 组的 `ok` = 所有成员都就绪。`pending` 列出还差的成员（排障与日志用，界面不展示明细）。
 */
function groupStatus(opts = {}) {
  const comps = componentStatus(opts);
  return GROUPS.map((g) => {
    const members = g.members.map((id) => comps[id]).filter(Boolean);
    const pending = members.filter((m) => !m.ok).map((m) => m.id);
    return {
      id: g.id,
      title: g.title,
      what: g.what,
      members: g.members.slice(),
      pending,
      ok: pending.length === 0,
      // 组进度：已就绪成员数 / 成员总数（界面用它画一条粗略进度）
      done: g.members.length - pending.length,
      total: g.members.length,
    };
  });
}

/** 把一次成功的安装写进记录（磁盘真值仍以文件系统为准）。 */
function markComponent(id, detail) {
  const cur = readRaw();
  cur.components[id] = { ok: true, verifiedAt: new Date().toISOString(), detail: detail || {} };
  writeRaw(cur);
  return cur.components[id];
}

/** 组件被清掉/需要重装时只清下载缓存，**不动已装好的目录**（红线：绝不误删用户数 GB 的数据）。 */
function markComponentStale(id, reason) {
  const cur = readRaw();
  if (cur.components[id]) cur.components[id] = { ...cur.components[id], ok: false, staleReason: reason || '', staleAt: new Date().toISOString() };
  writeRaw(cur);
  return cur;
}

// ── 模型 ────────────────────────────────────────────────

/** 记录一个模型安装完成（含 sha256 校验结论）。 */
function markModel(id, info) {
  const cur = readRaw();
  cur.models[id] = {
    file: info.file || '',
    bytes: Number(info.bytes) || 0,
    sha256: info.sha256 || '-',            // 'ok' | 'mismatch' | '-'
    verified: info.verified !== false,
    at: new Date().toISOString(),
  };
  writeRaw(cur);
  return cur.models[id];
}

function markerFor(id) {
  return readRaw().models[id] || null;
}

function unmarkModel(id) {
  const cur = readRaw();
  delete cur.models[id];
  writeRaw(cur);
  return cur;
}

// ── 自定义模型 ────────────────────────────────────────────

function listCustom() {
  const cur = readRaw();
  return Object.values(cur.custom || {}).filter((x) => x && x.id);
}

function getCustom(id) {
  return readRaw().custom[String(id)] || null;
}

function putCustom(entry) {
  const cur = readRaw();
  cur.custom[entry.id] = entry;
  writeRaw(cur);
  return entry;
}

function removeCustom(id) {
  const cur = readRaw();
  const had = !!cur.custom[String(id)];
  delete cur.custom[String(id)];
  writeRaw(cur);
  return { removed: had, id: String(id) };
}

/** 一次安装收尾后刷新整体审计信息（给 /app/state 与安装中心用）。 */
function summary(opts = {}) {
  const comps = componentStatus(opts);
  const missingComponents = Object.values(comps).filter((c) => !c.ok).map((c) => c.id);
  return {
    version: SCHEMA,
    updatedAt: readRaw().updatedAt,
    components: comps,
    missingComponents,
    customCount: listCustom().length,
    models: readRaw().models,
    comfyDir: comfyDir(load()),
    modelsDir: comfyDir(load()),
  };
}

module.exports = {
  SCHEMA, COMPONENTS, GROUPS,
  read, writeRaw, summary,
  verifyComponent, componentStatus, groupStatus, markComponent, markComponentStale, sevenZipExe, embeddedMainPy,
  markModel, markerFor, unmarkModel,
  listCustom, getCustom, putCustom, removeCustom,
};
