// 服务端数据存储（全部落在 <项目根>/data/，随项目迁移一起走；不依赖浏览器 localStorage）。
'use strict';

const path = require('node:path');
const fsx = require('./util/fsx');
const { paths } = require('./config');

// ── 画师收藏 / 黑名单（互斥：后执行的操作覆盖）+ 自定义分组（v1.2.0） ──
const MAX_GROUPS = 50;                    // 用户要求：最多 50 个分组
const emptyArtists = () => ({ favs: [], blacklist: [], groups: [], updatedAt: null });

/** 分组归一化：名字去空白/去重（同名后者丢弃）、成员去重且非空；最多 MAX_GROUPS 组。 */
function normGroups(raw) {
  const out = [];
  const seen = new Set();
  for (const g of Array.isArray(raw) ? raw : []) {
    if (!g || typeof g !== 'object') continue;
    const name = String(g.name || '').trim().slice(0, 60);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      items: [...new Set((Array.isArray(g.items) ? g.items : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))],
    });
    if (out.length >= MAX_GROUPS) break;
  }
  return out;
}

function readArtists() {
  const v = fsx.readJson(paths.artistsFile, null);
  if (!v || typeof v !== 'object') return emptyArtists();
  return {
    favs: Array.isArray(v.favs) ? v.favs.filter((x) => typeof x === 'string') : [],
    blacklist: Array.isArray(v.blacklist) ? v.blacklist.filter((x) => typeof x === 'string') : [],
    groups: normGroups(v.groups),
    updatedAt: v.updatedAt || null,
  };
}

function writeArtists(v) {
  const next = {
    favs: [...new Set((v.favs || []).filter((x) => typeof x === 'string' && x.trim()))],
    blacklist: [...new Set((v.blacklist || []).filter((x) => typeof x === 'string' && x.trim()))],
    groups: normGroups(v.groups),
    updatedAt: new Date().toISOString(),
  };
  fsx.writeJsonAtomic(paths.artistsFile, next);
  return next;
}

/** 收藏与黑名单互斥：加入一个列表即从另一个列表移除。 */
function toggleArtist(tag, action) {
  const t = String(tag || '').trim();
  if (!t) throw new Error('tag 为空');
  const cur = readArtists();
  let result = 'none';
  if (action === 'fav') {
    if (cur.favs.includes(t)) { cur.favs = cur.favs.filter((x) => x !== t); result = 'removed'; }
    else { cur.favs = [t, ...cur.favs.filter((x) => x !== t)]; cur.blacklist = cur.blacklist.filter((x) => x !== t); result = 'added'; }
  } else if (action === 'blacklist') {
    if (cur.blacklist.includes(t)) { cur.blacklist = cur.blacklist.filter((x) => x !== t); result = 'removed'; }
    else { cur.blacklist = [t, ...cur.blacklist.filter((x) => x !== t)]; cur.favs = cur.favs.filter((x) => x !== t); result = 'added'; }
  } else {
    throw new Error('action 必须是 fav 或 blacklist');
  }
  const next = writeArtists(cur);
  return { ...next, result };
}

function importArtists(items) {
  const cur = readArtists();
  let imported = 0;
  for (const raw of items || []) {
    const t = String(raw || '').trim();
    if (!t || cur.favs.includes(t)) continue;
    cur.favs.push(t);
    cur.blacklist = cur.blacklist.filter((x) => x !== t);
    imported++;
  }
  const next = writeArtists(cur);
  return { ...next, imported };
}

// ── 画师分组操作（v1.2.0）────────────────────────────────
// 语义：分组是"另一维"，与收藏/黑名单**不互斥**（用户可以既收藏又放进某个组）；
// 分组随机时会像收藏随机一样剔除黑名单。上限 50 组由 MAX_GROUPS 强制。

function createGroup(name) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw new Error('分组名不能为空');
  const cur = readArtists();
  if (cur.groups.some((g) => g.name === n)) throw new Error('分组已存在：' + n);
  if (cur.groups.length >= MAX_GROUPS) throw new Error(`最多只能有 ${MAX_GROUPS} 个分组（当前 ${cur.groups.length} 个）`);
  cur.groups.push({ name: n, items: [] });
  return { ...writeArtists(cur), result: 'created', name: n };
}

function renameGroup(from, to) {
  const a = String(from || '').trim();
  const b = String(to || '').trim().slice(0, 60);
  if (!a || !b) throw new Error('分组名不能为空');
  const cur = readArtists();
  const g = cur.groups.find((x) => x.name === a);
  if (!g) throw new Error('分组不存在：' + a);
  if (a !== b && cur.groups.some((x) => x.name === b)) throw new Error('分组已存在：' + b);
  g.name = b;
  return { ...writeArtists(cur), result: 'renamed', from: a, name: b };
}

function deleteGroup(name) {
  const n = String(name || '').trim();
  const cur = readArtists();
  const before = cur.groups.length;
  cur.groups = cur.groups.filter((g) => g.name !== n);
  if (cur.groups.length === before) throw new Error('分组不存在：' + n);
  return { ...writeArtists(cur), result: 'deleted', name: n };
}

function addToGroup(tag, group) {
  const t = String(tag || '').trim();
  const n = String(group || '').trim();
  if (!t) throw new Error('画师为空');
  const cur = readArtists();
  const g = cur.groups.find((x) => x.name === n);
  if (!g) throw new Error('分组不存在：' + n);
  if (!g.items.includes(t)) g.items = [t, ...g.items];
  return { ...writeArtists(cur), result: 'added', group: n, tag: t };
}

function removeFromGroup(tag, group) {
  const t = String(tag || '').trim();
  const n = String(group || '').trim();
  const cur = readArtists();
  const g = cur.groups.find((x) => x.name === n);
  if (!g) throw new Error('分组不存在：' + n);
  g.items = g.items.filter((x) => x !== t);
  return { ...writeArtists(cur), result: 'removed', group: n, tag: t };
}

/**
 * v1.2.1：整份替换分组列表（面板的「＋分组」用）。
 * 为什么需要它：面板里的分组是本地 state，点一下加/移出后要落盘；逐条调 add/remove
 * 在连续快速点击时会互相覆盖。整份替换 + writeArtists 的 normGroups 归一化（去重、
 * 名字裁剪、最多 MAX_GROUPS 组）语义最明确。
 */
function replaceGroups(groups) {
  const cur = readArtists();
  cur.groups = Array.isArray(groups) ? groups : [];
  return { ...writeArtists(cur), result: 'replaced' };
}

// ── LLM 模型清单 ─────────────────────────────────────────
const emptyLlm = () => ({ items: {}, default: '' });

function readLlmModels() {
  const v = fsx.readJson(paths.llmModelsFile, null);
  if (!v || typeof v !== 'object') return emptyLlm();
  return { items: v.items && typeof v.items === 'object' ? v.items : {}, default: typeof v.default === 'string' ? v.default : '' };
}

function writeLlmModels(v) {
  const next = { items: v.items || {}, default: v.default || '' };
  fsx.writeJsonAtomic(paths.llmModelsFile, next);
  return next;
}

function upsertLlmModel(file, meta) {
  const cur = readLlmModels();
  cur.items[file] = { ...(cur.items[file] || {}), ...meta, file };
  if (!cur.default) cur.default = file;
  return writeLlmModels(cur);
}

function removeLlmModel(file) {
  const cur = readLlmModels();
  delete cur.items[file];
  if (cur.default === file) cur.default = Object.keys(cur.items)[0] || '';
  return writeLlmModels(cur);
}

// ── LLM 会话（v1.2.1：用户端永久保留；只保留最近 N 条**消息**，N 来自设置） ──
// 语义变化：旧的 `newSession()` 会 dropSession（历史被删），本轮改成「新开一个会话 id」，
// 旧会话留在 sessions 里供用户随时回看/复制（需求 5：历史永久保留，除非用户主动删除）。
function readSessions() {
  const v = fsx.readJson(paths.llmSessionsFile, null);
  if (!v || typeof v !== 'object' || !v.sessions || typeof v.sessions !== 'object') {
    return { sessions: {}, lastSessionId: '' };
  }
  return { sessions: v.sessions, lastSessionId: typeof v.lastSessionId === 'string' ? v.lastSessionId : '' };
}

function writeSessions(v) {
  fsx.writeJsonAtomic(paths.llmSessionsFile, v);
  return v;
}

function getSession(id) {
  const all = readSessions();
  return all.sessions[id] || { messages: [], updatedAt: null };
}

/** 会话概览（供「历史会话」列表）：按 updatedAt 倒序，只给摘要不给全文，避免一次拉几十 MB。 */
function listSessions() {
  const all = readSessions();
  const items = Object.keys(all.sessions).map((id) => {
    const s = all.sessions[id] || {};
    const messages = Array.isArray(s.messages) ? s.messages : [];
    const firstUser = messages.find((m) => m && m.role === 'user' && typeof m.content === 'string');
    return {
      id,
      messages: messages.length,
      updatedAt: s.updatedAt || null,
      preview: firstUser ? String(firstUser.content).replace(/\s+/g, ' ').slice(0, 60) : '',
    };
  }).sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return { items, lastSessionId: all.lastSessionId || (items[0] ? items[0].id : '') };
}

function getLastSessionId() {
  return listSessions().lastSessionId;
}

function saveSession(id, messages, limit) {
  const all = readSessions();
  const n = Number.isFinite(limit) ? limit : 40;
  // 归一化：只留 user/assistant，且只保留最近 n 条（n=0 时不留任何上下文）。
  const clean = (messages || [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content }));
  const kept = n <= 0 ? [] : clean.slice(-n);
  all.sessions[id] = { messages: kept, updatedAt: new Date().toISOString() };
  all.lastSessionId = id;
  writeSessions(all);
  return all.sessions[id];
}

function dropSession(id) {
  const all = readSessions();
  if (all.sessions[id]) delete all.sessions[id];
  if (all.lastSessionId === id) {
    // 删掉当前会话后回落到"最近更新"的那一条（与列表排序同一口径）
    const rest = Object.keys(all.sessions).map((k) => ({ id: k, updatedAt: (all.sessions[k] || {}).updatedAt || '' }));
    rest.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    all.lastSessionId = rest.length ? rest[0].id : '';
  }
  writeSessions(all);
  return { ok: true, lastSessionId: all.lastSessionId };
}

// ── 安装状态 ─────────────────────────────────────────────
const emptySetup = () => ({ completed: false, mode: '', comfySource: '', comfyDir: '', modelsDir: '', models: [], artists: false, licenses: false, llm: false, updatedAt: null });

function readSetup() {
  return { ...emptySetup(), ...(fsx.readJson(paths.setupFile, {}) || {}) };
}

function writeSetup(patch) {
  const next = { ...readSetup(), ...patch, updatedAt: new Date().toISOString() };
  fsx.writeJsonAtomic(paths.setupFile, next);
  return next;
}

module.exports = {
  readArtists, writeArtists, toggleArtist, importArtists,
  createGroup, renameGroup, deleteGroup, addToGroup, removeFromGroup, replaceGroups, MAX_GROUPS,
  readLlmModels, writeLlmModels, upsertLlmModel, removeLlmModel,
  getSession, saveSession, dropSession, listSessions, getLastSessionId,
  readSetup, writeSetup,
  dataDir: paths.data,
};
