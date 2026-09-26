# 第十一轮独立复核报告（t11 / v1.2.2）

- 复核对象：t9（后端与托盘，attempt 088115b4，core-dev）与 t10（前端，attempt 553e007e，ui-dev）
- 复核者：verifier（本报告的作者，未参与任何实现）
- 裁决：**pass**（8 条验收全部 passed，逐条证据见 §11）
- 产出：本文件（`docs/ROUND11-VERIFY.md`）。复核过程**未修改任何产品代码/脚本/配置**。

## 0. 方法与纪律

- **不复用实现者的结论与脚本**。t9/t10 自述的断言一律只当线索；本报告每一条都是复核者自建 harness 的实测输出。
  - 后端：`%TEMP%\dcp-t11-harness\t11-verify.js`，沙箱 `%TEMP%\dcp-t11-verify`（每次运行重建），10 个测试块、**105/105 通过**。
  - 前端：`%TEMP%\dcp-t11-harness\t11-web.js`，用无头 Edge + CDP（只读拷贝 `.scratch/cdp.cjs` 作驱动），沙箱 `%TEMP%\dcp-t11-web`，**45/45 通过**。
  - 日志：`%TEMP%\dcp-t11-harness\t11-backend-final.log`、`t11-web.log`。harness 与日志都在临时目录，不进入交付物。
- **替身一律用 `node.exe`**（`python.exe` 用 `node.exe` 的字节拷贝，命令行里带 `main.py`）。实测 `powershell.exe` 被 detached 拉起后很快就自行退出，会造成假的"清理成功"，本报告全部避免。
- **禁用假判据**：不使用"杀掉父进程再看子进程是否消失"。`taskkill /PID <父> /T /F` 实测连 detached 子进程一起收（§7），因此所有"孤儿"场景都是**构造真孤儿**（父进程已消失、父链已断）或**构造真正的进程内兜底失效路径**。
- **环境纪律**：dev 副本正在使用的后端（pid 24424 监听 127.0.0.1:8796）全程未被触碰；复核结束时它仍在监听，`data/settings.json` 的 LastWrite 仍是 13:59:40、`data/run` 不存在（说明没有任何本程序写的归属记录被落到 dev 副本）。

## 1. 冻结指纹（复核前冻结、复核后复验一致）

| 文件 | 行数/字节 | SHA256 前 16 位 |
| --- | --- | --- |
| `server/comfy.js` | 28758 B | `e834cf32ed1abc9e` |
| `server/index.js` | 40330 B | `93c615ec26bb44c7` |
| `server/config.js` | 22205 B | `f6eac02a73f15c48` |
| `package.json` | 766 B | `615d5fd53796eb56` |
| `scripts/tray.ps1` | 11275 B | `7c2185d8a36321b9` |
| `web/panel.js` | 172658 B | `02cd8b7495fdf6a1` |
| `web/app-shell.js` | 40072 B | `a93076bb8bca3b86` |
| `web/i18n/zh.json` | 59063 B | `e0bc86cf898f1e84` |
| `web/i18n/en.json` | 69395 B | `689e801e7b3de37f` |
| `web/pages/pages.css` | 10462 B | `61bdaa3f4f213e68` |

复核全部跑完后重新计算：**10 个文件哈希与冻结值完全一致**（0 个被改动）。也就是说本报告的结论对应的正是被复核的那份实现，不是"跑到一半又被改过"的版本。

## 2. V1 生产自检（验收①）

命令（工作目录＝dev 副本）：`node scripts/check.js` → **exit 0，pass=19 fail=0**

关键行：

```
[3] 中英词典  ✓ ui 487 键、panel 333 键，zh/en 完全一致
[4] PowerShell 脚本编码（必须 UTF-8 with BOM + CRLF）  ✓ bootstrap/build-core/start/tray 四个脚本均 BOM + CRLF
[4b] 批处理脚本编码  ✓ start.cmd：CRLF + 纯 ASCII（34 行）
[5] 交付物脱敏（零真实机器路径/用户名）  ✓ 扫描 55 个文本文件：零命中
[5b] 版本号一致性  ✓ config.VERSION=1.2.2 / package.json=1.2.2 / panel BUILD_TAG=v1.2.2 三处一致
                      ✓ 面板头部徽标确实渲染 BUILD_TAG（不是写死的字符串）
```

本报告写入后再跑一次同样的命令，仍然是 `pass=19 fail=0`（报告本身也过了脱敏自查）。

## 3. V2 端口不漂移（验收②③）

对应实现：`server/index.js:704`（`MAX_PORT_BUMP = 2`）、`:758-779`（`listen()`）、`:769-773`（超限报错+退出）、`:711-718`（就绪回调只挂一次）。以下端口号来自最终那次完整运行（自动挑选的空闲连续区间）。

**3.1 自增 2 次后成功绑定（18960/18961 被外部占用）**

| 断言 | 实测 |
| --- | --- |
| 后端就绪 | `ready=true` |
| EADDRINUSE 的 WARN 恰好 2 条 | `[WARN] 端口 18960 已被占用，尝试 18961（第 1/2 次自增）`、`…18962（第 2/2 次自增）` |
| 「打开：」只有一条且＝实际监听端口 | `["打开：http://127.0.0.1:18962/"]` |
| `DCP_READY` 恰好一次，port 一致 | `{"url":"http://127.0.0.1:18962/","lanUrls":[],"port":18962,"version":"1.2.2"}` |
| `/app/state` 顶层 `port` | `18962`（与「打开：」、与 `DCP_READY` 三处一致） |
| `/app/state.listen.port` 仍是设置值 | `{"lan":false,"port":18960,"token":""}` |
| 该端口确实在监听 | TCP 连接成功 |
| `data/settings.json` 字节级未变 | 前后 SHA256 相同，`disk.listen.port=18960` |
| `/app/quit` 后端口释放 | 连不上（ECONNREFUSED） |

**3.2 连试 2 次仍占用（18970/18971/18972 全被占用）**

```
进程已退出 | code=1
以非零码退出 | code=1
WARN 恰好 2 条 | count=2
明确报错 | 端口 18972 仍被占用：已连续自增 2 次仍未找到可用端口，放弃启动（不再继续漂移）。
可操作建议 | [ERROR] 请关闭占用 18970~18972 端口的程序，或用环境变量 DCP_PORT 指定其它端口后重试。
没有继续探测下一个端口 | 未出现"尝试 18973"
失败路径不输出 DCP_READY / 打开： | 没有假装就绪
data/settings.json 未被回写 | disk.listen.port=18970
```

> 这一条也是本轮"端口静默漂移 + 回写 settings.json"的直接反证：超限走**快速失败**，且设置文件在成功/失败两条路径上都**字节级不变**。

## 4. V3 退出入口（验收④）

- 三个 `/app/quit` **并发**请求：全部 `200 / ok=true`。
- 收尾只执行一次：`first=true,false,false`（恰一个 true）。
- 随后后端自行退出 `code=0`，端口释放（连不上）。
- 对应实现：`server/index.js:255-266`（路由）、`:139-168`（`beginQuit` 复用同一 promise）、`:174-194`（`finishQuit` 幂等 + 1500 ms 上限）。

## 5. V4 退出连带停止（验收⑤，三条判据都实测）

### 5.1 优雅退出：真实 `launch()` 拉起的替身，且"**活着但离线**"

场景：配置端口被占两格（后端实际绑在 18982）；`comfy.autoStart=true`、`comfy.dir` 指向假 ComfyUI 目录（`python.exe` = `node.exe` 拷贝）。

| 断言 | 实测 |
| --- | --- |
| autoStart 真的拉起了替身并写下归属记录 | `%TEMP%\dcp-t11-verify\data\run\comfy-owner-1720.json` |
| 替身是 node.exe 的拷贝 | 与 `node.exe` 的 SHA256 相同 |
| 替身命令行含 `main.py` | `…\fake\comfyui\python.exe …\fake\comfyui\main.py --listen 127.0.0.1 --port 18985 --disable-metadata` |
| 替身存活但**离线**（不监听任何端口） | `alive=true`、TCP 连接失败 |
| `/app/quit` 响应 | `{"online":false,"stopped":true,"owner":"app","pids":[1720],"stillAlive":[],"detail":[{"pid":1720,"taskkillOk":true,"source":"memory"}]}` |
| 退出后替身被终止 | `alive=false` |
| 归属记录被删除 | 文件不存在 |
| 后端 exit code | `0`；端口释放；`data/settings.json` 仍未被回写 |
| 日志 | `退出收尾完成（耗时 … ms）：ComfyUI 与 LLM 已停止、HTTP 服务已关闭，进程退出。` |

> 关键：`online:false` 说明后端**没有**因为"端口离线"就 early-return —— 这正是旧实现漏停的那条路径（`server/comfy.js:447-481` 的 `stopOwned` 不以端口在线为条件）。

### 5.2 跨进程孤儿清理（父链已断）

- 由"短命 helper 拉起 detached 替身、helper 立刻退出"构造：实测替身 `pid=25892`，`ppid=8228`，**父进程已不存在**（父链真断）。
- 留下归属记录后**启动后端** → 替身被终止（`alive=false`）、记录被删除，日志：`清理上一次遗留的 ComfyUI 孤儿：pid=25892（命令行入口目录与记录一致）→ 已终止进程树`。

### 5.3 `process.on('exit')` 同步兜底（两个来源都清）

harness 直接使用**真实入口** `server/index.js`（`main()` 会注册 `process.on('exit')`），随后触发 `process.exit(0)`：

- A = 只有内存来源（`state.pid`，harness 先删掉它的记录文件）；
- B = 只有记录来源（手工写 `data/run/comfy-owner-<B>.json`）。

结果：`退出同步兜底（process-exit）：已终止本程序拉起的 ComfyUI pid=5512、pid=25764`；两个 pid 都 `alive=false`，B 的记录被删除。对应实现：`server/index.js:814`、`server/comfy.js:416-437`。

### 5.4 t9 顺手修的 listen 回调缺陷（本轮孤儿的放大器）

端口自增 2 次的场景下（`server/index.js:711-718` 只挂一次 `listening`、`:715-717` 幂等）：

- 「打开：」恰好 1 条、`DCP_READY` 恰好 1 次；
- `comfy.autoStart=true` 时**归属记录恰好 1 份**、命令行含 `main.py` 的替身进程**恰好 1 个**。

> 旧实现（就绪回调挂在 `server.listen(port,host,cb)` 上、每次自增重挂一次）在同样场景会各跑 3 遍，autoStart 一次拉起 3 个 ComfyUI 而内存只记住最后一个 pid → 立刻多出两个新孤儿。这条已被独立复现证伪（现在恒为 1）。

## 6. V5 安全边界（验收⑥，六条反例 + 红线场景）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 用户自己启动的实例（**无任何归属记录**），替身命令行确为 `main.py` | 不清理 | `alive=true`（后端退出后仍存活） |
| 记录的 `codeDir` 与命令行反推目录**不符**（模拟 pid 复用） | 不清理，只 WARN | `alive=true`，日志 `命令行与记录的入口对不上（可能是 pid 已被复用）` |
| 记录存在但命令行**不含** `main.py` | 不清理，只 WARN | `alive=true`，日志 `命令行里没有 main.py（不是 ComfyUI 入口）` |
| 记录 `schema` 未知（99） | 不清理，只 WARN | `alive=true`，日志 `记录 schema 未知：99` |
| 记录是**坏 JSON** | 不清理、不删文件 | 文件保留，WARN `归属记录 comfy-owner-999999.json 不可解析，已跳过（不动任何进程）` |
| 记录指向**死 pid** | 只删记录、不杀任何进程 | 记录被删；同批三个替身全部存活 |
| **读不到命令行**（PATH 前置一个 `powershell.exe` 桩） | 不清理（安全方向：漏清可接受，误杀不可接受） | `alive=true`，记录保留，WARN `读不到命令行，无法确认它是 ComfyUI main.py` |

另外两条红线场景：

- `POST /app/comfy/stop`（用户自己的实例在线、无记录）：返回 `{"online":true,"stopped":false,"owner":"foreign","note":"127.0.0.1:19025 上的 ComfyUI 不是本程序拉起的（没有任何归属记录），已跳过；要停它请手动结束该进程。"}`，随后该实例 **仍活着**。
- `POST /app/quit` 之后，该实例 **仍活着**，且 `data/run` 里没有它的任何记录。
- 托盘的强杀回退路径（见 §7）上，同样有一个"无记录"的替身全程存活。

对应实现：`server/comfy.js:330-349`（五条谓词）、`:355-382`（`cleanupOrphans`）、`:389-405`（`ownedTargets` 两个来源）、`:447-481`（`stopOwned` 不按端口兜底）。

## 7. Windows 硬边界与"三层覆盖"逐层实证

需求基线指出：`taskkill /F` 就是 `TerminateProcess`，不给 node 任何执行机会，所以进程内兜底在硬杀下必然失效。复核要求"三层每层都真的存在且有效"，逐层实测如下（**都是实测，不是照抄声明**）：

| 层 | 机制 | 实测结果 |
| --- | --- | --- |
| ① 托盘先礼后兵（优雅） | `scripts/tray.ps1:68-82` 先 `POST /app/quit`，判据是"后端进程真的消失" | 托盘退出码 0；后端**自行退出 code=0**（不是被强杀）；替身被终止、记录被删；`tray.log` 写 `优雅退出成功：…`；后端 `server.log` 写 `收到退出请求（POST /app/quit）`；**无**"回退到强制终止" |
| ② 托盘强杀后按归属记录清理 | `scripts/tray.ps1:84-114`（`Stop-OwnedComfyUI`），`:156-162` 无论哪条路径都执行 | 顽固后端（`/app/quit` 一律 500）→ 8 s 后 `回退到强制终止（taskkill /T /F）`；**孤儿替身被按记录终止**、记录被删（`已按归属记录终止本程序拉起的 ComfyUI：pid=…`）；无记录替身 `alive=true` |
| ③ 下次启动清孤儿 | `server/index.js:796` → `comfy.cleanupOrphans()` | 见下面的硬杀链路 |
| （附加）进程内同步兜底 | `server/index.js:814` → `comfy.killOwnedSync()` | §5.3 两个来源都被清 |

**硬边界链路实测**（这是最容易"看起来对、其实没验"的一条）：

1. `comfy.autoStart=true` 拉起替身 `pid=25000`，记录已落盘；
2. 对**后端本进程**执行 `taskkill /PID <后端> /F`（**不带 `/T`**，即真正的 TerminateProcess）；
3. 后端已死；**替身 `alive=true`**，且此刻已成孤儿（`ppid=23460` 已消失）——**证明第 3 层的存在是必要的，进程内兜底确实没跑**；
4. 重新启动后端 → 替身被终止（`alive=false`）、记录被删，日志：`清理上一次遗留的 ComfyUI 孤儿：pid=25000（…）→ 已终止进程树`。

> 对照实验（顺带纠正一个常见误解）：对**还活着**的父进程执行 `taskkill /PID <父> /T /F` 时，detached 子进程会**一起被收**（这也是为什么本报告严禁用"杀父看子"当判据）。孤儿真正的成因是**父链断裂**（只杀中间那层、不带 `/T`），而不是 detached 逃逸。

## 8. V6 前端（验收⑦）

### 8.1 静态契约

| 断言 | 证据 |
| --- | --- |
| `fetchRetry` 默认 3 次 | `web/app-shell.js:50` `async function fetchRetry(path, opts, tries = 3)` |
| 只对 GET 重试、非 GET 立即抛 | `if (method !== 'GET') throw e;` |
| `api()` 走 `fetchRetry` | `await fetchRetry(path, o)` |
| 页面组件 key 只与 tab id 相关（无 `renderKey`） | `web/app-shell.js:645` `key: 'page-' + id` |
| zh/en key 集合完全一致 | 递归比对 `ui`/`panel`/`panelRules`/`panelPhrases`：无单边遗漏 |
| 本轮新增文案双语齐全 | `shell.linkLost / linkLostHint / linkLostLastOk / linkLostLast / linkLostRetry / serviceAddress / serviceAddressTitle / serviceAddressTitleConfig / copyAddress` 在 `ui` 命名空间下 zh/en 都在 |
| 提示文案可操作 | zh `…请右键系统托盘图标 →「打开 Web UI」或「复制访问地址」…也可以…找启动时打印的「打开：http://127.0.0.1:<端口>/」，或打开 logs\server.log…`；en 同义 |
| 地址文案是模板 | `shell.serviceAddress = "服务地址 {url}"`（不是写死端口） |
| 提示条有样式 | `web/pages/pages.css` 定义了 `.link-lost` |

### 8.2 U1：顶栏显示**实际**端口（页面停在漂移后的端口也正确）

后端配置端口 19160/19161 被占 → 实际监听 **19162**（`data/settings.json` 里仍是 19160，不被回写）。
页面针对后端实际地址加载后：

```
PASS 顶栏可访问地址用的是后端实际端口（不是配置端口）  | {"attr":"19162","text":"服务地址 http://127.0.0.1:19162"}
PASS 地址文本含实际端口、不含 undefined/NaN
PASS 连通状态：phase=ready、count=0、lost=false
PASS 连通时没有任何失联提示条
```

> 断言**限定在 U1 自己的元素上**（`[data-dcp-service-port]` 的属性与文本），没有对整页文本做"不许出现 NaN"的粗暴 grep —— 面板在 `/system_stats` 缺字段时渲染"内存 NaN"是既有行为（见 §10-B），不属于本轮 U1 的失败面。

### 8.3 U2：断连只给一条可操作提示、恢复后自行消失

强杀后端（页面停在旧地址），连续采样 26 s（13 次 × 2 s，跨 ≥5 个 5 s 轮询周期）：

```
PASS ★连续失败后仍只有一条失联提示（不刷屏）  | 各次采样条数=[1,1,1,1,1,1,1,1,1,1,1,1,1]
PASS ★连续失败期间没有 toast 刷屏（≤1 条）  | 各次采样 toast 数=[0,0,0,0,0,0,0,0,0,0,0,0,0]
PASS ★失败计数持续增长（多轮失败确实发生了）  | linkState.count 轨迹=[1,1,2,2,2,3,3,4,4,4,5,5,6]
PASS 提示条内包含"上次可用地址"（可操作）  | …上次成功连上的服务地址：http://127.0.0.1:19162 | 最近一次失败：Failed to fetch
PASS 提示条给出重试按钮与复制地址按钮  | ["复制地址","立即重试"]
PASS 提示条不是整页死页（侧栏仍在）
PASS 断连期间 /app/state 被重复请求（轮询仍在跑，只是不重画）  | 请求数=18
PASS ★重试语义保留：每轮至少 3 次尝试（3 次重试）  | requests=18 failures=18
```

`linkState.count` 从 1 涨到 6 而 DOM 里的提示条**恒为 1**：多个失败周期 → 一次渲染，这就是"不刷屏"的实质证据。
恢复（后端在**同一个端口**重新起来，页面不刷新）：

```
PASS ★恢复连通后失联提示自行消失（无需刷新页面）
PASS 恢复后 linkState 归零（count=0 / lost=false）
PASS 恢复后顶栏地址仍正确、无 undefined/NaN
```

### 8.4 刷屏源①（toast 节流）独立复现

断连状态下连续 25 次同文案保存失败（每次都会走 `__DCP_SAVE_ARTISTS__` 的 catch）：

```
PASS ★断连时 25 次同文案保存失败只弹出 1 条提示（toast 节流）  | {"toasts":1,"suppressed":24,"texts":["操作失败：Failed to fetch"]}
PASS ★其余 24 次被节流（suppressedToasts 计数可见，未进 DOM）  | suppressedToasts=24
PASS 被节流的正是同一条「操作失败 / Failed to fetch」文案
```

对应实现：`web/app-shell.js:114`（`TOAST_THROTTLE_MS = 30000`）、`:268-296`（同文案 error 只进 DOM 一条，其余只累加 `suppressedToasts`）。

### 8.5 刷屏源②（空闲自我回声）独立复现（含 A/B 对照）

同一 harness、同一 22 s 窗口、只改一个变量（在**沙箱副本**里把 `web/app-shell.js` 的广播闸门 `if (!sameStore(snap, lastBroadcast))` 改成 `if (true)`，或再去掉单飞守卫；测完立即还原，dev 副本不受影响）：

| 变体 | 22 s 内 `/app/artists/*` 请求数 |
| --- | --- |
| 现行文件（闸门 + 单飞） | **0～1 次**（两次运行分别 1 次、0 次） |
| 只去掉广播闸门 | **67 次** |
| 闸门 + 单飞都去掉（＝旧实现形状） | 页面在 60 s 内**根本装载不完**（网络/渲染饱和），窗口内抓到 0 次有效请求 |

```
PASS ★空闲 22s 的艺术家保存请求数大幅下降（自我回声被切断）  | artists 请求=0；窗口内总请求=30
PASS 空闲期没有弹任何 toast
PASS ★A/B 对照①：只去掉广播闸门，回声立刻复活（现行文件是 0~1 次）  | 现行文件=0 次/22s；去闸门=67 次/22s
PASS ★A/B 对照②：再去掉单飞（旧实现形状）后回声更凶，或直接把页面打到装载不出来
```

**反方向也验了**（不能只验"降下来"，还要验"该广播时没被吞掉"）——按真实调用方的写法（先同步 `window.__DCP_ARTISTS__`，`panel.js:353-373` 的 `persistArtists` 就是这么做的）提交真变更：

```
PASS ★真变更（收藏新增）仍会广播 dcp-artists-changed  | bc 0 → 1
PASS 真变更已落库：服务端 favs = [@t11alpha]  | ["@t11alpha"]
PASS ★第二次真变更仍会广播  | bc 1 → 2
PASS 第二次真变更已落库：favs = [@t11beta]  | ["@t11beta"]
PASS ★提交与服务端相同的快照不再广播（闸门生效；旧实现这里会无限广播）  | bc 2 → 2
```

对应实现：`web/app-shell.js:370-420`（单飞 + 按 key 合并 + `submitArtists`）、`:381/:395-398`（`sameStore` 闸门 + 只在真变更时 `dispatchEvent('dcp-artists-changed')`）、`:423-434`（`__DCP_REFRESH_ARTISTS__` 把刚广播的快照记入 `lastBroadcast`，面板随后的"回写同一份"不会再广播）。

### 8.6 既有契约（页面 key / 常驻挂载）

```
PASS 切到「画师」后工作台 pane 仍挂载（key 契约未被破坏）  | before=1 after=1 clicked=true
```

## 9. 越界核查：t10 只碰了它的 inScope

以 t9 完成时刻（14:26 之后）为界，工作树里被写过的文件只有：

| 文件 | LastWrite | 归属 |
| --- | --- | --- |
| `server/index.js` | 14:26:42 | t9（其 inScope） |
| `web/i18n/zh.json` | 14:32:52 | t10 inScope |
| `web/i18n/en.json` | 14:33:01 | t10 inScope |
| `web/pages/pages.css` | 14:33:03 | t10 inScope |
| `web/app-shell.js` | 14:55:18 | t10 inScope |

`web/panel.js` 的 LastWrite 是 **14:23:03**（早于 t10 的全部写入），其 diff 里的 `BUILD_TAG` 变化是 t9 的版本号推进（验收要求三处一致），**不计入 t10 越界**。

## 10. 已知残余（如实记录；按队长裁决**不构成本轮不通过**）

- **A) 面板侧回声写法仍在**：`web/panel.js:1495-1496`（`onChanged` 用 `loadFavorites()/loadGroups()` 造新数组回填 state）与 `web/panel.js:1551-1552`（`useEffect(() => saveFavorites(artistFavs), [artistFavs])`）之间的回路没有被拆除，本轮只从**外壳侧**（广播闸门 + 单飞）切断回声。实测现行实现能收敛（§8.5）。
- **B) 面板在 `/system_stats` 缺 `system` 时渲染"内存 NaN"**：既有行为，本轮未修。复核时已按队长的边界把 U1 断言限定在 `[data-dcp-service-port]` 等本轮自己的字段/元素上，未据此外判。
- **C) `scripts/start.ps1:141 / :206` 的 `$proc.Kill()` 仍是单进程杀**：控制台窗口被强杀时可能遗留后端与 ComfyUI；本轮不修，后果由"下次启动 `cleanupOrphans`"兜住（§5.2/§7 已实测该兜底有效）。
- **D) 直接对后端本进程 `taskkill /F` 时进程内兜底无法执行**：Windows 硬边界，不是缺陷；三层覆盖已逐层实测（§7）。
- **E) 复核者补充的一条边界（不是缺陷，供后续轮次参考）**：如果**绕过共享数据**直接调用外壳写入口（即 `window.__DCP_ARTISTS__` 不先同步，只调 `window.__DCP_SAVE_ARTISTS__({favs:[...]})`），面板的 `[state]` 保存 effect 会按共享存储里的旧快照回写，把这次改动覆盖掉。实测请求序列为 `PUT favs ["@t11alpha"] → PUT favs [] → POST groups [] → PUT favs [] → POST groups []`，最终服务端 `favs=[]`。
  为什么**不算缺陷**：真实 UI 路径不会这样调用 —— 画师页走服务端接口后再 `__DCP_REFRESH_ARTISTS__()`（`web/pages/artists.js:97/137/185` + `:101`），面板自身走 `persistArtists`（`web/panel.js:353-373`，它**先**更新 `window.__DCP_ARTISTS__` 再提交）。两者都让共享存储与提交内容一致，因此不会触发这条回写。它本质是残余 A 的另一种表现，本轮不修（面板侧加固留待后续轮次）。

## 11. 裁决

| # | 验收条款 | 结论 | 证据位置 |
| --- | --- | --- | --- |
| 1 | `node scripts/check.js`：fail=0 且 pass ≥ 19 | passed | §2（pass=19 fail=0 exit 0） |
| 2 | 端口冲突：最多自增 2 次、每次 WARN、超限快速失败并明确报错 | passed | §3.1/§3.2 |
| 3 | 恢复可用端口后 `/app/state` 端口与「打开：」一致且确实在监听 | passed | §3.1 |
| 4 | `POST /app/quit` 使后端退出、端口释放；重复/并发调用无异常 | passed | §4 |
| 5 | 退出连带停止：后端退出时其拉起的长驻子进程被终止 | passed | §5.1（含"活着但离线"）、§5.3 |
| 6 | 记录缺失/进程已不在时不误杀；用户自己的实例不被终止 | passed | §6（六条反例 + 两条红线场景） |
| 7 | 前端断连节流与可操作提示有代码与实证；`fetchRetry` 3 次重试与页面 key 契约仍成立 | passed | §8.1–§8.6 |
| 8 | 结论均附 `文件:行号` 或命令输出证据，无未经验证的断言 | passed | 本报告全文；harness 与日志在 `%TEMP%\dcp-t11-harness` |

**verdict = pass**

- 退出路径（`/app/quit`、`SIGINT/SIGTERM/SIGBREAK`、`process.exit`）与跨进程孤儿都没留下本程序拉起的 ComfyUI；
- 端口冲突不再静默漂移、不再回写 `settings.json`，实际端口可通过 `/app/state` 顶层 `port`、启动日志「打开：」与 `DCP_READY` 三处一致地发现；
- 断连是"一条可操作提示 + 自愈"，并且两个真实刷屏源（同文案 error toast ×上千、空闲自我回声 ×每秒上百）都被独立复现并确认已被切断，同时真变更的广播语义没有被削弱；
- 用户自己启动的 ComfyUI 在所有被复核的路径上都没有被碰。

### 复现命令

```powershell
# ① 生产自检（在 dev 副本目录）
node scripts/check.js

# ② 后端 10 个测试块（105 条断言；沙箱 %TEMP%\dcp-t11-verify，自动重建）
node "$env:TEMP\dcp-t11-harness\t11-verify.js"

# ③ 前端无头 Edge（45 条断言；沙箱 %TEMP%\dcp-t11-web，自动重建）
node "$env:TEMP\dcp-t11-harness\t11-web.js"
```

（harness 全在临时目录；若目录已清理，可按下述要点重建：从 dev 副本拷贝 `server/ web/ installer/ scripts/ package.json` 到沙箱、构造假 ComfyUI 目录（`main.py` 写成 JS + `python.exe` 用 `node.exe` 拷贝）、用 `DCP_PORT` 指定端口起 `server/index.js`。第 8.5 节的 A/B 只在沙箱副本里改 `web/app-shell.js` 的闸门一行，测完立刻还原。）
