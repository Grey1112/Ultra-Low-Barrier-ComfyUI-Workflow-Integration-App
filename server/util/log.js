// 日志：写 logs/server.log（追加、单文件上限 5 MB 后滚动）+ 内存环形缓冲（供 UI 查看）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 5 * 1024 * 1024;
const ring = [];
const RING_MAX = 500;
let logFile = null;

function setup(dir) {
  logFile = path.join(dir, 'server.log');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function rotateIfNeeded() {
  if (!logFile) return;
  try {
    const st = fs.statSync(logFile);
    if (st.size > MAX_BYTES) fs.renameSync(logFile, logFile.replace(/\.log$/, '.1.log'));
  } catch { /* 文件不存在：正常 */ }
}

function line(level, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const text = `[${ts}] [${level}] ${msg}`;
  ring.push(text);
  if (ring.length > RING_MAX) ring.shift();
  if (process.env.DCP_QUIET !== '1') {
    if (level === 'ERROR') console.error(text);
    else console.log(text);
  }
  if (logFile) {
    try {
      rotateIfNeeded();
      fs.appendFileSync(logFile, text + '\n', 'utf8');
    } catch { /* 磁盘问题不该拖垮服务 */ }
  }
  return text;
}

module.exports = {
  setup,
  info: (m) => line('INFO', m),
  warn: (m) => line('WARN', m),
  error: (m) => line('ERROR', m),
  recent: (n = 200) => ring.slice(-n),
  file: () => logFile,
};
