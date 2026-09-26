# 第十一轮需求基线（v1.2.1 → v1.2.2）

> 核对对象：`D:\FFOutput\COMFY UI`（dev 副本，**工作树**状态）
> 核对时间：2026-09-26 14:00–14:20（本机时区）
> 核对人：reporter（requirements-analyst）
> 核对方式：真实代码逐行阅读 + 本机实测（隔离沙箱，不动 dev 副本的运行中实例）
> 结论口径：**每条结论都附 `文件:行号`；实测结论附可复现命令与原始输出。**

---

## 0. 基线与锚定（先看这里）

### 0.1 工作树指纹（行号会随其它任务改动漂移，请以本表核对）

| 文件 | 总行数 | SHA256（前 16 位） |
| --- | --- | --- |
| `server/index.js` | 684 | `e3022fa6fb0c3c35` |
| `server/comfy.js` | 390 | `57b384db6ebcf96b` |
| `server/config.js` | 377 | `c5aef3c0cfd844a9` |
| `scripts/tray.ps1` | 131 | `fa924d670d15decd` |
| `scripts/start.ps1` | 209 | `ad218caa71ff99c0` |
| `web/app-shell.js` | 473 | `aa7403f08bff17e6` |
| `web/panel.js` | 2666 | `f58d752a0e170f72` |
| `package.json` | 18 | `68a403780a9b218a` |
| `web/i18n/zh.json` | 836 | `2fa7ce0ecb52510e` |
| `web/i18n/en.json` | 1070 | `936dad7013fa3ed6` |

### 0.2 版本与仓库状态

- `git log -1` = `ea9a8a5 feat: v1.2.0 (round 9) ...`，即 **HEAD 是 v1.2.0**；
  工作树里是**未提交**的第十轮（v1.2.1）成果：`git diff --stat` = 22 files, +1089 / −125。
  → 本基线的行号只对**当前工作树**成立；`HEAD` 版本号仍是 `1.2.0`（`git show HEAD:server/config.js` → `const VERSION = '1.2.0';`）。
- 版本号三处（第十轮已一致，`scripts/check.js:167-192` 会强制校验）：
  - `server/config.js:43` `const VERSION = '1.2.1';`
  - `package.json:3` `"version": "1.2.1",`
  - `web/panel.js:146` `const BUILD_TAG = "v1.2.1";`（徽标渲染点 `web/panel.js:2052`）
- 生产自检基线：`node scripts/check.js` → **`结果：pass=19 fail=0`**（退出码 0）。
  其中含 `[5b] 版本号一致性`：`config.VERSION=1.2.1 / package.json=1.2.1 / panel BUILD_TAG=v1.2.1 三处一致`。

### 0.3 现场状态（实现/复核时必须避让）

- dev 副本**此刻有一个运行中的后端**：`node.exe`（pid 24424，命令行 `"<PATH-TO-NODE>\node.exe" server/index.js`，Node v26.8.1），监听 `127.0.0.1:8796`。
  `data\settings.json` 的 `listen.port` = `8796`（`data/settings.json:6`）。
- 当前**没有任何 `python.exe` 在跑**，也没有 8188/8788–8792 的监听者 —— 即"此刻没有活着的 ComfyUI 孤儿"。
- 结论：实现与复核**不要**直接对 dev 副本的 8796 实例做端口/退出实验，也不要覆盖 `data/settings.json`；
  用 §9 的沙箱复现法（拷 `server/ web/ installer/ package.json` 到临时目录）或在实验前备份/实验后还原 `data/settings.json`。

---

## 1. F1｜ComfyUI 脱离进程树的**确切**代码位置

`server/comfy.js:111-128`（一键启动 `launch()` 的 spawn 段）：

```
111:  const args = [layout.mainPy, '--listen', '127.0.0.1', '--port', String(cur.port), '--disable-metadata', ...]
114:  const out = fs.openSync(paths.comfyLog, 'a');
115:  const child = spawn(layout.python, args, {
116:    cwd: path.dirname(layout.mainPy),
117:    detached: true,              ← ① 脱离控制台/进程组
118:    stdio: ['ignore', out, out],
119:    windowsHide: true,
120:  });
121:  child.unref();                 ← ② Node 不再因它而保持事件循环
```

配套状态（**只在内存里**，无任何落盘）：

- `server/comfy.js:16` `const state = { pid, startedAt, lastError, spawnCommand, codeDir }` —— 后端进程一死，pid/codeDir 全部丢失。
- `server/comfy.js:123-127` 写入 `state.pid / startedAt / spawnCommand / codeDir`。
- 导出面：`server/comfy.js:388`（`pidListeningOn / cmdlineOf / codeDirFromCmdline / outputDirInfo / state` 都可被外部复用）。

### 1.1 ⚠️ 重要纠正：`detached: true` **并不**让子进程逃脱 `taskkill /T`

实测（命令与输出见 §8.1）：以 `detached: true` + `unref()` 拉长驻子进程，
`Get-CimInstance Win32_Process -Filter "ParentProcessId=<node>"` **仍能列出它**，
`taskkill /PID <node> /T /F` **确实把它一起杀掉**（与不 detached 的结果完全一致）。

→ 因此**孤儿的成因不是"taskkill /T 追不到 detached 子进程"**，而是下面两条（F2/F4）：

1. 存在**根本不走 taskkill /T** 的退出路径（JS 退出路径里漏调 `comfy.stop()`，见 F2）；
2. 存在**不是本次 node 的子进程**的孤儿被"认领"（见 F4），此后任何 `/T` 都与它无关。

这一条直接决定 t9 的实现口径与 t11 的 V4 实测设计（**不要**把 `/T` 当成修复本身）。

---

## 2. F2｜后端/脚本退出路径清单：谁停了本程序拉起的 ComfyUI？

| # | 退出路径 | 代码位置 | 是否停 ComfyUI | 能否被 JS 捕获 |
| --- | --- | --- | --- | --- |
| P1 | `SIGINT`（控制台 Ctrl+C）→ `shutdown('SIGINT')` | `server/index.js:677` → `671-676` | **否**（只 `llm.stopServer()`，`671-676` 全文没有 `comfy.*`） | 能（唯一能） |
| P2 | `SIGTERM` → `shutdown('SIGTERM')` | `server/index.js:678` | **否** | **不能**（Windows 上永不触发，见 F3） |
| P3 | 托盘"关闭控制台并停止后端" → `Stop-Backend` | `scripts/tray.ps1:51-69`（`taskkill /PID $BackendPid /T /F` 在 `:55`） | **间接**：只杀 node 的进程树；不认识 ComfyUI，也没有归属记录 | **不能**（/F = TerminateProcess） |
| P4 | 上述托盘路径的端口兜底 | `scripts/tray.ps1:59-66` | 同 P3（按端口找监听者） | 不能 |
| P5 | `taskkill /F` / `Stop-Process -Force` / 任务管理器结束进程 / 关控制台窗口 | 无（外部） | **否**（任何 JS 代码都不执行） | 不能 |
| P6 | 启动器等待循环结束后的 `$proc.Kill()` | `scripts/start.ps1:141`、`206` | **否**（`Process.Kill()` 只杀单个进程，无 `/T` 语义） | 不能 |
| P7 | **不存在** 显式退出接口 | 全仓库 grep `/app/quit` = **0 命中** | — | — |

补充：

- 后端**完全没有**注册 `SIGBREAK`、`beforeExit`、`process.on('exit')` 等其它退出口（`server/index.js:677-679` 只有 SIGINT/SIGTERM/unhandledRejection）。
- `shutdown()` 的强制兜底是 `server.close(() => process.exit(0))` + `setTimeout(..., 3000).unref()`（`server/index.js:674-675`）——即便它被触发，也没有任何一行去停 ComfyUI。
- LLM 子进程有显式停止入口（`server/index.js:375` `POST /app/llm/server/stop`，`index.js:673` 退出时也调了 `llm.stopServer()`），
  **这正是 ComfyUI 侧缺的对照物**：ComfyUI 有自己的 `/app/comfy/stop`（`server/index.js:188`），但退出路径一次都没调用它。

**结论（t9-R1 的现状缺口）**：本程序有 3 条"自己的"退出路径（P1 信号、P3 托盘、P6 启动器），
**没有一条**会停止自己拉起的 ComfyUI；而 Windows 上唯一能被 JS 捕获的 P1 恰恰漏了这一步。

---

## 3. F3｜Windows 下 `taskkill /F` 不投递可捕获信号（实测事实）

`scripts/tray.ps1:55` 与 `:63` 都用 `taskkill.exe /PID <pid> /T /F`；`server/index.js:147-154` 的 `taskkill()`
在 win32 分支也是 `taskkill /PID <pid> /T /F`（`server/comfy.js:152`）。

实测（详见 §8.2，被测进程注册了 SIGTERM/SIGINT/SIGBREAK/SIGHUP/exit 五种处理器，每个处理器都会写日志）：

| 手段 | 进程是否终止 | 处理器是否执行 |
| --- | --- | --- |
| `taskkill /PID x /T /F` | 是 | **一个都没有**（日志只有 "started"） |
| `taskkill /PID x /T`（不带 /F） | **否** | 否（原文：`ERROR: ... could not be terminated. Reason: This process can only be terminated forcefully (with /F option).`） |
| `Stop-Process -Id x -Force` | 是 | **一个都没有** |

可推得的硬事实：

1. `/F` = `TerminateProcess`，**不投递任何可捕获信号**，`process.on('SIGTERM')`（`server/index.js:678`）在 Windows 上**永不触发**；
2. 不带 `/F` 又**根本杀不掉**这个无消息循环的 node 进程 → 托盘"先礼后兵"里"礼"不能指望 OS 信号，
   只能由托盘主动 **HTTP 请求后端**（这正是 t9-R3/R5 的必需性，不是可选优化）；
3. 因此进程内的"同步兜底清理"只对 P1（SIGINT）与自身正常退出有效；对 P3/P5 必须在**进程外**兜底
   （托盘先调 `/app/quit`，或下次启动按归属记录清理）。

---

## 4. F4｜孤儿是怎么被"认领"的（第二重缺陷）

1. 任何一条 F2 的路径漏掉 ComfyUI，它就活了下来（`python.exe` 的父进程 node 已经消失）。
2. 下次启动，`launch()` 第一行就短路：
   - `server/comfy.js:99` `if (await probe(cur.port, 1200)) return { online: true, launched: false, port: cur.port };`
   - 于是**不 spawn、不记录 pid**（`state.pid` 保持 `null`，`server/comfy.js:16`）。
3. 状态页照样显示"在线"：`comfy.status()` 的 `online` 只来自端口探活（`server/comfy.js:75` `probe(cur.port)`），
   `running: !!state.pid`（`:79`）才是"是不是我拉的"——两者语义割裂。
   `/app/state` 把它透传成 `comfy.online / comfy.running / comfy.pid`（`server/index.js:148`）。
4. 此后**再退出也清不掉它**：托盘 `/T` 只覆盖"本次 node 的子树"，而孤儿是**上一次** node 的孩子；
   而 `/app/comfy/stop` 的实现是"先看 `state.pid`，没有就按端口找人"：
   - `server/comfy.js:233` `const pid = state.pid || pidListeningOn(cur.port);`
   - `:235` 甚至在错误文案里承认"ComfyUI 在 <port> 端口运行，**但不是本程序拉起的**"。
   → **这条兜底等于"用户自己起的 ComfyUI 也会被停"**，与"只清自己的"红线直接冲突。

**结论**：孤儿问题是一个闭环故障（漏停 → 认领 → 再也停不掉），t9-R2 的"启动时按归属记录清理"
必须解决的是**跨进程**归属，而不是"端口上有没有 ComfyUI"。

---

## 5. F5｜端口漂移的**两段**代码（+ 实测复现）

### 5.1 第一段：EADDRINUSE 静默 +1（无上限 20 次）

`server/index.js:609-618`：

```
609: function listen(port, host, attempt = 0) {
610:   server.once('error', (e) => {
611:     if (e.code === 'EADDRINUSE' && attempt < 20) {
612:       log.warn(`端口 ${port} 已被占用，尝试 ${port + 1}`);
613:       listen(port + 1, host, attempt + 1);
614:       return;
615:     }
616:     log.error('服务启动失败：' + e.message);
617:     process.exit(1);
618:   });
```

- 端口来源：`server/index.js:667` `process.env.DCP_PORT || s.listen.port || 8788`；
  启动器把配置端口写进环境：`scripts/start.ps1:109` `$env:DCP_PORT = [string]$BasePort`（`BasePort` 见 `start.ps1:95`）。
- 只在**日志**里留 WARN，页面上没有任何信号；上限是 **20**（本次要求收紧到 2）。

### 5.2 第二段：把漂移结果**永久回写**进 settings.json

`server/index.js:619-621`：

```
619:   server.listen(port, host, () => {
620:     const actual = server.address().port;
621:     if (actual !== load().listen.port) save({ listen: { port: actual } });
```

- `save()` 落盘的是**归一化后的完整对象**（`server/config.js:295-325`，`:308` `deepMerge(load(), p)` → `:323` `fsx.writeJsonAtomic`），
  所以这一次回写会把漂移后的端口**固化**为配置值：下次启动以它为基准，旧标签页/书签/快捷方式却仍指向老端口。
- 归一化不会把端口改回去（`server/config.js:171` `clampInt(out.listen.port, 1, 65535, 8788)`）。

### 5.3 实测复现（沙箱，dev 副本零改动）

命令与完整输出见 §8.3。要点（占用 18801、18802，配置端口 18801）：

```
[WARN] 端口 18801 已被占用，尝试 18802
[WARN] 端口 18802 已被占用，尝试 18803
[INFO] comfy-panel-standalone v1.2.1 已就绪
[INFO] 打开：http://127.0.0.1:18803/
DCP_READY {"url":"http://127.0.0.1:18803/","lanUrls":[],"port":18803,"version":"1.2.1"}
```

- 漂移**越过了 +1**（连试两次），证明"无限（20 次）探测"是真的；
- 沙箱 `data/settings.json` 的 `listen.port` 由 `18801` 变成 **`18803`**（回写成立）；
- 旧端口 18801/18802 仍被两个替身占着 → 老标签页的相对请求打在"别人"身上。

### 5.4 与启动器的配合（不改，但要理解）

`scripts/start.ps1:122-135`：就绪探测会在 `BasePort .. BasePort+20` 之间**逐个试 `/app/state`**（`:127-132`），
找到就打开浏览器（`:145-157`）并把自己的 `-Port` 传给托盘（`:171`）。
→ 漂移上限从 20 收紧到 2 后，这个扫描窗口**依然成立**（`start.ps1` 不在 t9 的 inScope 内，本轮不改它）。

---

## 6. F6｜前端失败面证据（"操作失败：Failed to fetch" 从哪来、为什么刷屏）

### 6.1 关键前提：`/app/state` **没有**本程序的实际端口字段

实测（沙箱，实际端口 18803）`GET /app/state` 顶层键：

```
version,buildTag,lang,root,paths,comfy,llm,listen,setup,selfcheck,platform,node
has top-level 'port'? False
comfy.port=8188                  ← 这是 ComfyUI 的端口
listen={"lan":false,"port":18803,"token":""}   ← 这是**设置里的**端口
```

- 代码位置：`server/index.js:130-160`（`comfy.port` 来自 `comfy.status().port`，即 `server/comfy.js:83` 的 `cur.port` = **8188**）。
- ⚠️ 现在 `listen.port` 恰好等于实际端口，**只因为 5.2 的回写**；t9-R4 一旦取消回写，
  `listen.port` 就会退回"配置值"，"实际端口可被发现"必须靠**新增字段**（t9 验收第 5 条"`/app/state` 返回实际监听端口"）。
- 顶栏现在显示的是 ComfyUI 端口，不是本程序地址：`web/app-shell.js:442`
  `'ComfyUI ' + online + ' :' + state.comfy.port`。全仓库只有 `web/panel.js:1146` 用了 `window.location.origin`（拼 WS 地址），
  **没有任何地方**校验"我这一页的 origin 是不是后端真实地址"（grep `location.(port|hostname|host|origin)` 仅 1 命中）。

### 6.2 两跳失败面（都在旧 origin 上）

页面用**同源相对路径**发请求：`web/panel.js:453` `fetch("/comfy-panel/api" + path)`、`web/app-shell.js:17-38` `fetch(path)`。
后端漂到 18803 后，停在 18801 的标签页**永远打不到后端**，于是：

| 症状 | 触发点 | 代码位置 | 是否自动重复 |
| --- | --- | --- | --- |
| 整页变成"后端接口不可用：**Failed to fetch**" | `refresh()` 任一异常 → `setBootError` | `web/app-shell.js:179-192`（`:189`）、渲染 `:368-373`、文案 `web/i18n/zh.json:298-299` | **是**：5 s 轮询 `web/app-shell.js:325-332`（`:330`），每轮都再失败；无节流、无"正确地址在哪"的可操作信息 |
| 整页卡在"正在加载…" | 旧 origin 是**别的 HTTP 服务**：HTTP 200 + 非 JSON 体 → `api()` 不抛错、返回 `undefined` | `web/app-shell.js:30-37`（`data=undefined`）→ `setState(undefined)` `:199` → `:374-376` | 是（同上轮询） |
| "**Failed to fetch**" 直接甩在面板错误条 | 生成循环里 `api("/prompt")` 抛网络层错误 → `setError(String(e.message ?? e))` | `web/panel.js:1837-1853`（`:1852`） | 每张图/每次重试都来一条 |
| 面板静默转"离线"（生成按钮置灰） | `/system_stats` 轮询失败 → `setOnline(false)` | `web/panel.js:1103-1108` | **是**：每 2 s 一次 |
| "实时通道未连通：请确认本程序的后端进程仍在运行，然后刷新页面" | WS 连不上，重连 3 s/次，失败 3 次后只提示一次 | `web/panel.js:1181-1192`（提示 `:1183-1189`） | 否（已节流，可作范本） |
| "操作失败"（`toast.failed`） | ① 设置页保存失败 ② 画师写回失败 ③ 任务事件流断开兜底 | `web/pages/settings.js:172`、`:387`；`web/app-shell.js:230`、`:304`；`web/job-view.js:33` | 否（用户动作/任务态触发） |

- 文案键：`web/i18n/zh.json:277` `"toast.failed": "操作失败"`；`en.json:277` 同键（zh/en 行号一致）。
- 已有的**正确范本**：`fetchRetry` 的 GET 三次重试（`web/app-shell.js:50-64`，t10-U3 必须保留）与
  WS 的"只提示一次"节流（`web/panel.js:1183-1189`）。
- 缺的东西只有两件：**(a) 真实端口/地址可知**（见 6.1）、**(b) 断连提示节流且可操作**（t10-U2）。

---

## 7. F7｜`server/comfy.js` 现有进程识别能力清单 + "只清理本程序拉起实例"的归属判定建议

### 7.1 现有能力（可直接复用，无需新依赖）

| 能力 | 函数 | 位置 | 实测/说明 |
| --- | --- | --- | --- |
| 端口探活（是不是 ComfyUI） | `probe(port)` | `server/comfy.js:64-71` | `GET http://127.0.0.1:<port>/system_stats`，1.5 s 超时 |
| 找监听端口的 PID | `pidListeningOn(port)` | `server/comfy.js:156-164` | `Get-NetTCPConnection -State Listen`，非 win32 返回 `null` |
| 读某 PID 的**完整命令行** | `cmdlineOf(pid)` | `server/comfy.js:166-182` | `Get-CimInstance Win32_Process`（8 s 超时，失败返回 `''`） |
| 从命令行反推 `main.py` 所在目录 | `codeDirFromCmdline(cmd)` | `server/comfy.js:184-191` | 正则只认 `main.py`；**认不出就返回 `null`**（安全的失败方向） |
| 带缓存的"端口上那个进程的代码目录" | `codeDirOfRunning(port)` | `server/comfy.js:193-203` | 缓存 60 s |
| 输出目录定位（优先"我拉起的"） | `outputDirInfo(port)` | `server/comfy.js:209-226` | `state.codeDir` 标 `launched-by-app` |
| 终止进程树 | `taskkill(pid)` | `server/comfy.js:147-154` | win32 = `/T /F`；POSIX = `kill(-pid, SIGKILL)` |
| 一键停止（**当前不安全**） | `stop()` | `server/comfy.js:228-248` | `:233` 会停"端口上不是本程序拉起的"实例 |

### 7.2 建议的归属判定（t9-R2 的安全口径）

**记录文件**（t9 的 inScope 已含 `data/run/`，`paths.data` 见 `server/config.js:18`；`.gitignore` 已忽略 `data/`）：

- 路径建议 **每进程一份**：`data/run/comfy-owner-<pid>.json`（避免 dev 副本 / 日常使用版两个后端共用 `data/` 时互相覆盖）；
- 在 `spawn` 成功后**立刻**写（与 `server/comfy.js:123-127` 的 `state` 赋值同一步），字段至少：

```json
{ "schema": 1, "buildTag": "v1.2.2", "pid": 12345, "startedAtMs": 1790402934264,
  "python": "<绝对路径>", "mainPy": "<绝对路径>", "codeDir": "<绝对路径>",
  "port": 8188, "spawnCommand": "<python> <mainPy> --listen ..." }
```

**清理谓词（必须全部满足才允许终止，任一不满足 → 只记日志、绝不动手）**：

1. 记录文件存在、可解析、`schema` 已知、`pid` 是正整数；
2. `pid` 进程存活；
3. `cmdlineOf(pid)` 非空，且 `codeDirFromCmdline(cmdline) === path.resolve(record.codeDir)`
   （或 `cmdline` 归一化后包含 `record.mainPy` 的绝对路径，大小写不敏感）——**这一条专门防 PID 复用误杀**；
4. `pid !== process.pid`（自保）；
5. 终止后删除该记录文件（正常退出路径也要删，避免下次拿旧 pid 去比对）。

**明令禁止（反面清单）**：

- ❌ 不许再按"谁在监听 `comfy.port`"来清理 —— 那正是"用户自己起的实例"（现行 `server/comfy.js:233`）。
  建议把该兜底**从自动路径里摘掉**，或让 `/app/comfy/stop` 在"非本程序拉起"时**拒绝执行并明确回报**
  （现有文案在 `server/comfy.js:235`，可以改成"这不是本程序拉起的实例，已跳过，请手动结束"）。
- ❌ 不许在**记录缺失/命令行读不到**时"猜一个最近启动的 ComfyUI"来杀。
- ❌ 不许把机器专属路径写进任何**被提交**的文件（记录文件在 `data/` 下，已被 `.gitignore` 忽略；`scripts/check.js:141-165` 的脱敏检查也会兜）。

### 7.3 与既有语义的衔接（避免自相矛盾）

- `state.codeDir`（`server/comfy.js:212`）现在只在内存；引入记录文件后，`outputDirInfo()` 可以让"我拉起的"
  跨重启仍然可判定（如需要）；**但不要**改变 `outputDirInfo` 的既有优先级（`:215-224`），它是 v1.2.0 的既有契约。
- `comfy.status()` 的 `running` 语义（`server/comfy.js:79`）在"认领"场景下一直是 `false`：
  引入归属记录后建议同时给出 `owner: 'app' | 'foreign' | 'unknown'` 之类的显式字段，
  供前端区分"我拉起的/别人的"，而不是靠 `running` 猜。

---

## 8. 实测附录（可复现命令与原始输出）

> 所有实验都在 `$env:TEMP` 下的临时候选中进行，未改动 dev 副本任何文件；实验后已清理（`Get-CimInstance ... -match 'dcp-'` 无残留）。

### 8.1 `detached: true` 是否脱离 `taskkill /T`

脚本要点：父进程用 `spawn(process.execPath, ['-e','setInterval(...)'], { stdio:['ignore',fd,fd], detached:true })`
（与 `server/comfy.js:115-121` 同形），父进程把 `parentPid childPid` 写进文件；随后外部执行 `taskkill /PID <parent> /T /F`。

输出：

```
=== mode=detached nodeParent=7304 grandchild=16456 ===
  grandchild alive BEFORE: True
  CIM children of node parent: [16456]                      ← detached 子进程仍在父进程树下
  taskkill /PID 7304 /T /F -> SUCCESS: The process with PID 16456 (child process of PID 7304) has been terminated. | SUCCESS: ... 7304 ...
  >>> grandchild alive AFTER taskkill /T /F on node parent: False   (before=True)
=== mode=attached nodeParent=23560 grandchild=18940 ===
  CIM children of node parent: [18940]
  >>> grandchild alive AFTER taskkill /T /F on node parent: False   (before=True)
```

### 8.2 `taskkill /F` 是否投递可捕获信号

```
A pid=13132 alive=True
--- taskkill /PID 13132 /T /F (force) ---
  SUCCESS: The process with PID 13132 (child process of PID 17924) has been terminated.
A alive after /F: False
A log:
  2026-09-26T06:12:45.954Z A started pid=13132        ← 仅此一行：SIGTERM/SIGINT/SIGBREAK/exit 均未触发
B pid=21140 alive=True
--- taskkill /PID 21140 /T (NO /F) ---
  ERROR: The process with PID 21140 (child process of PID 17924) could not be terminated.
  Reason: This process can only be terminated forcefully (with /F option).
B alive after no-/F: True
C log:
  2026-09-26T06:12:53.758Z C started pid=29176        ← Stop-Process -Force 同样不触发任何处理器
```

### 8.3 端口漂移 + settings.json 回写（沙箱复现）

沙箱：拷 `server/ web/ installer/ package.json` 到 `%TEMP%\dcp-drift`，写 `data/settings.json`（`listen.port=18801`），
用两个替身 HTTP 服务占用 18801/18802，再 `DCP_PORT=18801 node server/index.js`。

```
[WARN] 端口 18801 已被占用，尝试 18802
[WARN] 端口 18802 已被占用，尝试 18803
[INFO] comfy-panel-standalone v1.2.1 已就绪
[INFO] 打开：http://127.0.0.1:18803/
DCP_READY {"url":"http://127.0.0.1:18803/","lanUrls":[],"port":18803,"version":"1.2.1"}
=== settings.json AFTER start ===  {"host":"127.0.0.1","port":18803,"lan":false}
=== listeners === 18801 -> pid 24768(替身)  18802 -> pid 6544(替身)  18803 -> pid 4032(后端)
=== GET /app/state (18803) ===
  top-level keys: version,buildTag,lang,root,paths,comfy,llm,listen,setup,selfcheck,platform,node
  has top-level 'port'? False     comfy.port=8188     listen={"lan":false,"port":18803,"token":""}
=== GET /app/state on the OLD port 18801 (替身) ===   HTTP 200，响应体 "not-this-app"（非 JSON）
```

### 8.4 ⚠️ 替身选型的坑（给 t11-V4）

在**同一台机器 + 同一沙箱**里，用 `powershell.exe` 当"长驻替身"做 detached 实验会**假阴性**：
本机实测 `powershell.exe` 以 `detached: true` 方式拉起后**约 70 ms 就以退出码 0 结束**（日志：`child exit code=0 sig=null`），
于是"杀父之后替身不见了"会被误判成"清理成功"。**替身请用 `node.exe`（或真实 `python.exe`）**——它才会稳定长驻。

---

## 9. 需求基线（第十一轮）—— 现状 × 缺口 × 验收锚点

| 需求 | 现状（证据） | 缺口 | 验收锚点（可实测） |
| --- | --- | --- | --- |
| **R1 退出即停（本程序拉起的 ComfyUI）** | 三条自有退出口全都不停 ComfyUI：`server/index.js:671-678`、`scripts/tray.ps1:51-69`、`scripts/start.ps1:141/206` | 退出路径必须调 `comfy.stop()`（且只停归属记录里那一个）+ 进程内同步兜底 | 用 node 替身（§8.4）造"本程序拉起的既离线又存活"的子进程，触发退出 → 子进程必须消失 |
| **R2 孤儿清理（只清自己的）** | 无归属记录（grep `/app/quit`、`data/run` 均 0 命中），`state` 只在内存（`server/comfy.js:16`） | 落盘归属记录 + §7.2 的五条谓词 | 造"记录存在/进程存活/命令行确为 main.py"→ 被清；"记录缺失"或"命令行不符"→ 不误杀 |
| **R3 优雅退出入口** | 不存在（`/app/quit` 0 命中） | 新增 `POST /app/quit`；重复/并发安全 | 调两次不报错；调用后端口释放（本基线的沙箱可直接复用） |
| **R4 端口不静默漂移** | `server/index.js:611-614`（上限 20）+ `:621`（回写） | 上限 2、每次 WARN、超限快速失败；实际端口可被发现 | §8.3 场景重跑：只剩 2 条 WARN，第 3 次失败退出；`/app/state` 端口 == "打开："日志端口 == 实际监听 |
| **R5 托盘先礼后兵** | `scripts/tray.ps1:55` 直接 `/F`（且 `/F` 不可能触发任何 JS 清理，§8.2） | 先 HTTP 请后端优雅退出（短超时），失败再 `/T /F`；日志区分两条路径 | 托盘日志能区分"优雅退出成功/回退强杀" |
| **R6 版本推进 v1.2.2** | 三处一致 `1.2.1`（`server/config.js:43`、`package.json:3`、`web/panel.js:146`），`check.js:167-192` 强制 | 三处同升 `1.2.2`，徽标仍渲染 `BUILD_TAG`（`web/panel.js:2052`） | `node scripts/check.js` 的 `[5b]` 段通过 |
| **U1 显示真实端口** | `/app/state` **无**顶层端口字段（§6.1）；顶栏显示的是 ComfyUI 端口（`web/app-shell.js:442`） | 后端新增实际端口字段；前端渲染它对非法值保持原样 | 字段存在且等于实际监听端口；字段缺失时不出现 `undefined/NaN` |
| **U2 断连不刷屏** | `web/app-shell.js:179-192` + `:325-332` 每 5 s 重复整页报错 | 节流为单条可操作提示 + 可自愈 | 连续失败只出一条；恢复连通后提示消失；正常请求不被中断 |
| **U3 既有契约** | `fetchRetry` 3 次（`web/app-shell.js:50-64`）、常驻标签页（`:278-280`、`:413-422`）、页面 key 只与 tab id 有关（`:405-409`） | 不得回退 | 代码级核对 + 自检 |
| **U4 i18n 同步** | zh/en 键集一致，`check.js:84-87` 强制 | 新文案两处同时加 | `node scripts/check.js` `[3]` 段通过 |

---

## 10. 下游必须知道的 8 个坑（否则会返工）

1. **别把 `/T` 当修复**：§8.1 已证明 detached 子进程照样被 `/T` 杀掉；真正的漏洞在 JS 退出路径与"跨进程孤儿"。
2. **Windows 上 `SIGTERM` 是死代码**（`server/index.js:678`）：`/F` 不投信号、不带 `/F` 又杀不掉 → 托盘必须主动请求后端。
3. **取消回写后 `listen.port` 不再是实际端口**（§6.1）：U1 依赖的"实际端口"必须由 t9 新增字段提供，否则 U1 无米下锅。
4. **`start.ps1` 不在 t9 的 inScope 内**（`scripts/start.ps1:141/206` 的 `$proc.Kill()` 仍是单进程杀）：
   本轮不改它，但要在交付说明里记为**残余风险**（若要一并修，需队长扩范围）。
5. **`/app/comfy/stop` 的端口兜底（`server/comfy.js:233`）是"只清自己的"红线反面**：自动路径绝不能走它。
6. **替身不要用 powershell.exe**（§8.4）：会给出假的"清理成功"；t11-V4 请用 node/python 长驻替身。
7. **dev 副本此刻有活着的后端（pid 24424，:8796）**，且 `data/settings.json` 是它正在用的文件：
   实验请用 §8.3 的沙箱法，别再制造 `dev-server-8791.log` 那种"又一个游离实例"。
8. **实测端口漂移会把 `data/settings.json` 改掉**（`:621`）；若必须在 dev 副本上做，先备份后还原。

---

## 11. 未验证项与不确定（诚实声明）

1. 本轮**没有**在 dev 副本上直接复现"真实 ComfyUI 被漏停"的端到端场景（当前机器上没有 ComfyUI 运行、也没有可用的 ComfyUI 安装；
   `runtime/comfyui` 下无 `main.py`，自检 `comfy-embedded-missing` 也印证）。
   因此 F1/F2/F4 的"漏停"链条是**代码级结论**（行号已在 §1/§2/§4 给出）+ 用 node 替身做的**机制级实测**（§8.1/§8.2）。
2. §8.1 的结论基于 node 长驻替身；`python.exe` 的子进程关系同理由 `Win32_Process.ParentProcessId` 决定，
   未实测 python 版本（与 ComfyUI 安装缺失有关），但 detached 语义由 libuv 统一实现，风险低。
3. 我**没有**改动任何产品代码、脚本或配置；本报告是本次任务唯一产物。
4. 若 `git` 工作树在本报告之后被其它任务继续修改，§0.1 的 SHA256 就是判断"行号是否还成立"的唯一依据。
