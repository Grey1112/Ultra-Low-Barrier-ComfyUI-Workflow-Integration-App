# 内部接口契约（comfy-panel-standalone v1.3.0）

> 本文件是前端与后端的冻结契约。改动必须同步更新本文件。
> 脱敏要求：本文件与全部交付物**不得出现任何真实机器路径**（示例一律用占位符）。

## 0. 进程与地址

- 后端：Node 标准库，零 npm 依赖。入口 `server/index.js`。
- 默认监听 `127.0.0.1:8788`（设置可改）；`lan=true` 时监听 `0.0.0.0` 并要求 `X-DCP-Token`。
  **回环来源放行**（`req.socket.remoteAddress` ∈ `127.0.0.1` / `::1` / `::ffff:127.0.0.1`）：令牌是给局域网内**其它设备**的；
  本机自己的页面与启动器探活（`scripts/start.ps1` 用 `http://127.0.0.1:<port>/app/state` 且不带令牌）必须放行 ——
  否则开启局域网后本页所有 `/app/*` 立刻 401（外壳会把整页换成"后端 API 不可用"，令牌反而看不到），
  且下次双击 `start.cmd` 会因探活 401 等满 60 秒后判定"后端没就绪"并杀掉后端（v1.1.0 修复）。
- **实际端口可能不是配置端口**（v1.2.2）：`EADDRINUSE` 时最多自增 **2** 次（每次 WARN，`MAX_PORT_BUMP=2`），再占用就 `log.error` + 给出 `DCP_PORT` 建议 + `exit 1`（**不再无限重试**）；
  **不再把漂移值回写** `settings.json` —— `listen.port` 永远是**配置值**，实际端口只活在内存里。
  实际端口的权威来源有三处且必须一致：`GET /app/state` 的**顶层 `port`**（数字）、启动日志「打开：`http://127.0.0.1:<port>/`」、stdout 的 `DCP_READY {…,"port":<port>…}`。
- 静态资源：`GET /` → `web/index.html`；`GET /static/<path>` → `web/<path>`（禁止 `..`）。
- 面板兼容前缀 `/comfy-panel/*` 完全保留（panel.js 零改动即可工作）。

## 1. 设置模型（`data/settings.json`）

```jsonc
{
  "version": 1,
  "lang": "zh",                       // zh | en
  "listen": { "host": "127.0.0.1", "port": 8788, "lan": false },
  "comfy": {
    "mode": "embedded",              // embedded | external
    "dir": "",                       // 外接模式的 ComfyUI 目录（绝对路径；仅存在 data/ 内）
    "outputDir": "",                 // v1.2.0：图片文件夹（输出目录）可选覆盖；空 = 自动判定（见 §4）
    "port": 8188,
    "autoStart": false,
    "extraArgs": []
  },
  "download": {
    "officialTimeoutMs": 10000,
    "slowThresholdKBs": 200,
    "slowWindowMs": 30000,
    "hfMirror": "https://hf-mirror.com",
    "githubProxies": ["https://gh-proxy.com/", "https://ghproxy.net/", "https://ghfast.top/"],
    "pipIndex": "https://pypi.tuna.tsinghua.edu.cn/simple",
    // v1.3.0：下载队列（安装中心）
    "maxTaskHoursModel": 3,          // 单个模型任务的**单来源墙钟上限**（小时）
    "maxTaskHoursComponent": 6,      // 单个组件任务同上
    "autoPrereq": true,              // 下载模型时自动把缺失前置一起入队
    "queueConcurrency": 1            // 1–2；默认串行
  },
  "llm": {
    "contextMessages": 5,            // 0..20
    "defaultModel": "",              // models/llm 下的文件名
    "port": 8199,
    "ctxSize": 8192,
    "gpuLayers": 99,
    "api": {
      "apiKey": ""                   // v1.2.0：**只写**字段。下发时一律替换为 "" 并附 hasKey；
                                     // 保存时若传空串 = "不改"（保留已存值），清空须显式 clearKey:true
    }
  }
}
```

## 2. 子代理必须实现的页面契约

四个页面均为 ES module，导出 React 组件（默认导出），签名统一：

```js
export default function SettingsPage({ api, t, state, refresh, toast }) { /* ... */ }
```

- `api(path, opts)`：`async (path, opts) => any`，`path` 以 `/app/` 开头；非 2xx 抛 `Error(message)`（message 取自响应体 `error` 字段）。
- `t(key, params)`：i18n 取值；`params` 用 `{name}` 占位替换。
- `state`：`GET /app/state` 的结果（见 §4）。
- `refresh()`：重新拉取 `/app/state` 与页面自身数据。
- `toast(msg, level)`：`level ∈ info|ok|warn|error`。
- 样式只用 `web/styles/shell.css` + `web/pages/pages.css` 里已有的类名；**新增类名必须写进 `web/pages/pages.css`**（对应上游红线 3.4）。
- 组件内不写死中文/英文文案，一律 `t("...")`。

### 2.1 常驻标签页契约（v1.2.1 新增，**改动前必读**）

外壳把每个**已挂载过**的页面放在一个持久的 `.tab-pane` 里：`<div class="tab-panes"><div class="tab-pane" data-tab="workbench">…`。
非当前标签页只加 `.tab-hidden`（`display:none`），**不卸载**。

- **为什么**：卸载工作台就会丢掉面板与 LLM 的 `useState` —— 用户填好的正/负向提示词、参数、已出图与整段对话会一起消失（这就是 v1.2.1 修的"切到设置就失去提示词与 LLM 历史"）。
- **页面 key 必须稳定**：`renderPage(id)` 传的 `key` 只能是 tab id。**绝不能掺 `renderKey`** —— 按需加载完成时 `renderKey` 会自增，掺进去会把刚挂载的页面整体重建，等于白常驻。
- **钩子显隐**：`web/styles/shell.css` 的 `.tab-pane` / `.tab-pane.tab-hidden`；新增页面若自带全屏容器，注意别覆盖 `.tab-pane` 的 `display`。
- **副作用要自律**：常驻页面的 `useEffect(..., [])` 只在首次挂载时跑一次，之后即使隐藏也活着（面板的 ComfyUI 实时通道就是靠这个特性实现"生成中切页不断"）。因此在标签页隐藏期间**不必要的轮询必须自己让路**（例：外壳的 `/app/state` 5 秒轮询在 `document.visibilityState === 'hidden'` 时跳过）。
- **排障钩子**：`window.__DCP_SHELL__` = `{tab, renderKey, mounted, bootSeq, trail, cached, inflight, panes}`；页面加载卡住时先看 `cached` / `inflight` / `bootSeq`（`bootSeq` 应该永远是 1）。
- **数据桥（跨页面写画师数据）**：外壳提供 `window.__DCP_SAVE_ARTISTS__(patch)`（按 key 传：`favs` / `blacklist` / `groups` 各自独立，**不要整份回传**）、`window.__DCP_REFRESH_ARTISTS__()`、`window.__DCP_ARTIST_GROUP__({tag, group, action})`、`window.__DCP_CREATE_GROUP__(name)`；面板只读 `window.__DCP_ARTISTS__`。

### 2.2 服务地址与断连提示契约（v1.2.2 新增，**改动前必读**）

- **服务地址徽标**：外壳顶栏渲染「服务地址 {url}」，DOM 锚点 `data-dcp-service-port="<port>"`。
  端口取值链：`state.port`（**实际端口**）→ `state.listen.port`（配置兜底，tooltip 换成"这是配置值，可能与实际不同"）→ `null`（整块不渲染）。
  **非法值一律视为缺失**（空串 / `NaN` / `Infinity` / 非整数 / `<1` / `>65535`），界面上绝不出现 `undefined` / `NaN`。
  ⚠️ `state.comfy.port` 是 **ComfyUI 自己的端口**（默认 8188），**不是**本程序的服务端口，别拿它渲染地址。
- **断连只在"连通 → 断连"这一次跳变画一条 banner**：`linkState.lost` 同时充当"已经画过"的闩，之后每轮失败只累加 `count`、**不重画**；恢复连通（`/app/state` 再次成功）即自行消失。
  banner 必须**可操作**：写明"本页面可能不是服务实际所在的地址"，并给出三条获取真实地址的途径（托盘「打开 Web UI / 复制访问地址」、服务端窗口的「打开：http://127.0.0.1:<端口>/」、`logs\server.log`），带「复制地址」「立即重试」。
- **首帧就连不上不再是死页**：装载失败后每 5 s 轻探 `/app/state`，通了自动完成装载（旧实现一旦置位 `bootError`，后端回来也回不来）。
- **只读排障钩子** `window.__DCP_LINK__ = {phase, lost, count, lastError, lastOkAt, lastKnownUrl, suppressedToasts}`：
  验收用 `count` 证明"提示只画过一次"、用 `suppressedToasts` 证明 toast 被节流；它只读、不参与渲染。
- **同文案 error toast 节流 30 s**：窗口内只弹第一条，其余只累加 `suppressedToasts`（不进 DOM）。
- **`__DCP_SAVE_ARTISTS__(patch)` 单飞 + 按 key 合并**：并发调用合流为一次请求；**只有服务端回包与上次不同才广播** `dcp-artists-changed`（真变更照旧广播，同步语义不变）。这是为了断开"广播 → setState → 保存 → 广播"的空闲自我回声。

## 3. 长任务（下载/安装）统一用 Job + SSE

- 发起：`POST /app/setup/run`、`POST /app/llm/runtime/install`、`POST /app/llm/models/download`、`POST /app/models/download` 返回 `{ jobId }`。
- 事件流：`GET /app/jobs/{jobId}/events`（`text/event-stream`），每帧：
  `data: {"phase":"comfy|models|artists|llm|done","message":"...","percent":0-100,"level":"info|ok|warn|error"}`
  结束时最后一帧为 `data: {"phase":"done","ok":true|false,"result":{...},"error":"..."}` 然后关闭。
- 轮询兜底：`GET /app/jobs/{jobId}` → `{ state:"running|done|failed", events:[...], result, error }`。
- **任务列表（第七轮新增）**：`GET /app/jobs?kind=&state=` → `{items:[{id,kind,title,state,percent,speedKBs,message,startedAt,endedAt,error}], running:[…]}`。
  用途固定为两件事：① 外壳顶栏的全局任务条（`BackgroundJobs`，2 s 轮询）；② **页面重挂载**（向导按 `kind=setup` 取 `running[0].id`），保证"切走再切回仍看得到安装进度"。
- 下载类帧额外带数值字段（第七轮新增）：`{downloaded,total,speedKBs,instantKBs,windowKBs,etaSec,waiting,sinceProgressSec,candidate,candidateIndex,candidateTotal,elapsedSec}` —— 前端直接用，不再从文案里抠速度。
- 所有下载必须显式报错，不允许静默失败（红线）。

### 3.1 持久化下载队列（v1.3.0 新增，**改动前必读**）

安装中心与向导里的"每个任务"都是队列里的一个任务，由 `server/install-queue.js` 管理：

- **任务字段**：`{id, key, kind:'model'|'component', refId, title, file, dest, url, urls, urlsFirst, bytes, sha256,
  state, attempts, triedHosts, downloaded, total, speedKBs, etaSec, candidate, percent, waiting, error, note, addedAt, startedAt, endedAt}`
- **状态机**：`queued → running → done | failed | paused | canceled`；`paused` 可 `resume` 回 `queued`；
  `canceled` 的 `resume` 等价于重新排队（本地文件已被删，从头下）。`skipped` 预留给"组件已就绪"。
- **持久化**：`data/install/tasks.json`（原子写；进度落盘节流 3 s）。**关窗口、重启后端都不丢**：
  启动时 `bootstrap()` 把上次的 `running` 收敛为 `paused` 并写明"后端重启，已中断（点继续从断点续传）"。
- **调度（第六批：三通道）**：队列分三条**互不阻塞**的通道，数组顺序即调度优先级（先占坑的先得带宽）—— `lane:"comfyui"`（ComfyUI 本体，独立通道，`download.comfyuiConcurrency` 默认 1）、`lane:"prereq"`（前置组件整组，默认 2）、`lane:"model"`（模型，默认 2）。**为什么 comfyui 必须独立**：早期它与 prereq 共用一条上限为 1 的通道，前置组件一开跑 ComfyUI 就只能干等（用户报的"模型/组件下载挤占 ComfyUI"）。老队列数据在 `bootstrap` 时自动迁移到新通道。
- **ComfyUI 两阶段**：`phase:"download"` 阶段只调 `downloadPortableArchive()`（不碰 `runtime/comfyui`），完成后设 `phase:"install"` 并通过 `ctl.released` 交还通道（`finish()` 把它重新排成 `queued`），几秒后再由 `pump()` 调 `installFromArchive()` 解压。模型若在此之前下完，前端按"99% + 等待 ComfyUI"展示（后端状态仍是 `done`）。
- **暂停/取消的传导**：`download({control})` 每 1 s 采样一次用户意图，暂停抛 `code=DCP_PAUSED`
  （**保留 `.part` 断点**），取消抛 `code=DCP_CANCELED`；两者都**不**被当作"这个源失败、换下一个"。
- **自动换源（retask）**：清掉 `download.forgetPreferred()` 的最快源记忆 + 把 `triedHosts` 作为
  `skipHosts` 传给下载引擎 + 重新入队（断点保留，靠 `Range` 续传）。
- **取消删文件**：`cancel?deleteFile=1`（默认）删除 `dest` 与 `dest.part`；**组件任务只清下载缓存**，
  绝不删已装好的组件目录（红线）。
- **模型任务的 `force:true`**：队列任务是"明确要下"，不做"已存在就跳过"的隐式短路。
- **组件任务**调用 `comfy-install.installComponent(job, refId, opts)`；已就绪的组件会直接回报
  `skipped:true`（这就是"再次点安装不会重下 1.79 GB"的落点）。

## 4. HTTP 接口清单

### 状态
| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/app/state` | `{**port**:本程序**实际监听**端口(v1.2.2，数字), version, buildTag, lang, root, comfy:{mode,dir,port,online,running,pid}, llm:{runtime:{ok,source,exe}, model, modelCount, server:{running,port}, contextMessages, sendContext, keepMessages, reasoning, **provider:"local\|api"**, **api:{ok,baseUrl,model,hasKey,missing}**}, **listen:{lan,port,token}**, setup:{completed, runtime, comfyui, models, artists, llm}, selfcheck:{ok, issues:[]}}`（三处加粗字段为 v1.1.0 补齐：前端按推理来源判定"能不能发消息"、顶栏徽标显示实际来源、设置页读取局域网令牌都依赖它们；顶层 `port` 为 **v1.2.2** 新增 —— 取消端口回写后 `listen.port` 只剩"配置值"语义） |
| POST | `/app/quit` | **v1.2.2**：优雅退出 → `{ok:true, quitting:true, first, calls, comfy:<stopOwned 结果>, llm:<stopServer 结果>, note}`。收尾顺序：停**本程序拉起的** ComfyUI → 停本地 LLM 运行时 → 关 HTTP 服务 → 落盘日志 → `process.exit(0)`。**并发/重复调用安全**：收尾只执行一次（`first` 只有一个为 `true`），后续调用复用同一份结果；非 POST 返回 405 |
| GET | `/app/selfcheck` | `{ok, issues:[{code,level,message,fix,path?}], external:[{key,path,exists}]}` |
| GET | `/app/settings` | 设置全量 |
| PUT | `/app/settings` | 部分更新（深合并），返回更新后设置 |

### ComfyUI 进程
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/comfy/detect?dir=` | `{ok, dir, codeDir, modelsDir, mainPy, python, layout:"portable|venv|unknown", error?}`；`dir` 省略时用设置里的 |
| POST | `/app/comfy/launch` | `{online, launched, error?}`（已在跑则 `online:true, launched:false`） |
| POST | `/app/comfy/stop` | **v1.2.2 语义变更**：只停**本程序拉起的**实例 → `{online, stopped, owner:"app"\|"foreign"\|"none", pids?, stillAlive?, detail?, note?}`。`owner:"foreign"` = 端口上那个 ComfyUI **不是**本程序拉起的（没有任何归属记录），**已跳过、绝不动手**；已删除"按端口反查监听进程再杀"的旧兜底（那会误杀用户自己启动的实例）。判据是"**子进程还在**"而不是"端口是否在线"——我们自己拉起的实例可能已离线但进程仍在，退出时照样要停掉 |
| GET | `/app/comfy/status` | `{online, running, pid, dir, mode, port, candidates:[...]}` |
| GET | `/app/comfy/log?tail=300` | `{path, lines:[...]}` |
| GET | `/app/comfy/outputdir` | **v1.2.0**：图片文件夹（输出目录）当前解析结果 `{dir, source, exists, count, override, candidates:[...]}`。`source` ∈ `setting` / `running:launched-by-app` / `running:running-process` / `layout` / `fallback`；`count` = 该目录内图片数（递归） |

### 画师数据（服务端持久化）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/artists/lists` | `{favs:[tag], blacklist:[tag], groups:[{name, items:[tag]}]}` |
| POST | `/app/artists/toggle` | body `{tag, action:"fav"|"blacklist"}` → `{favs, blacklist, result:"added"|"removed"}`；两态互斥（后执行覆盖） |
| PUT | `/app/artists/favs` | body `{items:[...]}` |
| PUT | `/app/artists/blacklist` | body `{items:[...]}` |
| POST | `/app/artists/import` | body `{items:[...]}` 合并导入（用于 localStorage `dcp-artist-favs` 一次性迁移）→ `{favs, imported}` |
| GET | `/app/artists/search?q=&source=all\|top\|favs&limit=50` | `{items:[{tag, blacklisted:bool}], total}` |

| GET | `/app/artists/groups` | **v1.2.0**：`{groups:[{name, items:[tag]}], max:50}`（`/app/artists/lists` 也带 `groups`） |
| POST | `/app/artists/groups/create` | body `{name}` → `{groups, result:"created", name}`；重名或超过 50 组返回 400 |
| POST | `/app/artists/groups/rename` | body `{from, to}` |
| POST | `/app/artists/groups/delete` | body `{name}`（只删分组，不动画师与收藏/黑名单） |
| POST | `/app/artists/groups/add` | body `{tag, group}` → 画师入组（不重复；**与收藏/黑名单不互斥**） |
| POST | `/app/artists/groups/remove` | body `{tag, group}` → 从组内移出 |
| POST | `/app/artists/groups/replace` | **v1.2.1**：body `{groups}` → 整份替换分组列表（面板的「＋分组」用；后端仍做归一化：去重、名字裁剪 60 字、最多 50 组） |
| POST | `/app/output/delete` | **v1.2.0**：body `{name, sub}` → 删除 output 目录内的一张图，返回 `{ok:true, file, dir, bytes, removedDirs}`；只允许 output 内的图片（越界/非图片 404），被删空的模型子目录会被移除 |
| GET | `/app/output/file?name=&sub=` | 直读 output 目录内的图片（ComfyUI 离线也能看本机作品） |

### 本地 LLM（F2）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/llm/status` | `{runtime:{ok,source:"cuda|cpu|none",exe,version?}, model, models:[...], server:{running,port,pid}, error?}` |
| POST | `/app/llm/runtime/install` | body `{variant:"auto"\|"cuda"\|"cpu"}` → `{jobId}` |
| GET | `/app/llm/models` | `{items:[{file, bytes, mtime, origin:"preset"\|"added"\|"downloaded", default:bool, abliterated:bool}], dir}` |
| POST | `/app/llm/models/add` | body `{path, mode:"link"\|"copy"}` → `{item}`（`link` 同卷用硬链接，跨卷自动回落 copy） |
| POST | `/app/llm/models/download` | body `{url, name}` → `{jobId}` |
| POST | `/app/llm/models/default` | body `{file}` → `{ok}` |
| POST | `/app/llm/models/remove` | body `{file}` → `{ok}` |
| GET | `/app/llm/search?q=` | 经 HF 镜像检索 abliterated GGUF：`{items:[{repo, downloads, license?, files:[{name,size,url}], abliterated:bool}], note?}` |
| POST | `/app/llm/server/start` | `{running, port, error?}` |
| POST | `/app/llm/server/stop` | `{running:false}` |
| POST | `/app/llm/chat` | body `{messages:[{role,content}], sessionId}` → SSE：`data: {"delta":"..."}` … `data: {"done":true,"contextUsed":N}`。**v1.2.1**：思考内容按 `data: {"reasoning":"<本帧文本>","thinking":<累计字符数>}` **单独成帧**（与 `delta` 分离）；服务端规范化后的正文以 `data: {"replace":"..."}` 下发；只有思考没有正文时**不再重复发一遍** `delta` |
| POST | `/app/llm/session/new` | **v1.2.1 语义变更**：开一个新会话、**不删旧会话** → `{ok:true, sessionId, kept}`（`kept` = 现有历史条数）。旧的"丢弃某会话上下文"仍可用 `POST /app/llm/session/discard` |
| GET | `/app/llm/sessions` | **v1.2.1**：历史会话摘要列表 `{items:[{id, messages, updatedAt, preview}], lastSessionId}`（**只给摘要**，正文按需拉；按 `updatedAt` 倒序） |
| DELETE | `/app/llm/session/:id` | **v1.2.1**：用户主动删除一条历史会话 → `{ok:true, lastSessionId}`（删掉当前会话时按更新时间回落到最近一条）。这是唯一的真删除入口 |
| GET | `/app/llm/session/:id` | `{messages:[...]}`（服务端保留最近 `keepMessages` 条；`:id` 为 `new`/`discard` 时返回 400） |
| GET | `/app/llm/prompt` | `{text}`：`assets/templates/anima-system-prompt.txt` 原文 |

### 首次运行向导（F1/M4）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/setup/plan?mode=embedded\|external&sel=minimal` | `{mode, steps:[{id,title,detail}], models:[{id,file,bytes,license,tier,installed}], totalBytes, missing:[...]}` |
| POST | `/app/setup/run` | body `{mode, comfySource:{kind:"portable"\|"archive"\|"dir"\|"git"\|"skip", path?}, models:[ids], copyMode:"link"\|"copy", artists:true, licenses:true, force?:boolean\|{runtime,comfyui,nodes,artists,licenses}} → {jobId}`。**v1.3.0 语义变更：只装缺的** —— 已就绪的组件与模型直接跳过（日志写「已就绪，跳过」），`force` 才强制重做；返回值新增 `report:{skippedComponents,skippedModels,failedModels}` |
| GET | `/app/setup/status` | `{completed, runtime, comfyui, models, artists, llm, comfyDir, modelsDir}` |

### 安装中心：状态 / 模型库 / 下载队列 / 自定义模型（v1.3.0 新增）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/install/state` | `{version, recorded, components:{<id>:{id,title,ok,detail,error?}}, modelsDir, comfyDir, totals, queue}`；`ok` 一律以**磁盘真值**判定（`runtime`=7z 可执行在位；`comfyui`=`main.py` + `python_embeded\python.exe` 都在；`nodes`=自定义节点目录非空；`artists`=两份清单在位；`licenses`=`LICENSES/` 非空） |
| GET | `/app/models/library` | 统一目录：内置（`installer/models.json`）+ 自定义（`data/install/state.json` 的 `custom`）。每项：`{id,name,file,dest,bytes,sha256,license,tier,custom,installed,installedBytes,path,requires,missing:[{kind,id,title}],ready,route,encoder,vae,task:{id,state,percent,speedKBs,error,note,candidate,etaSec}\|null}`；顶层还有 **`groups`（v1.3.0：界面只显示这一层 —— `[{id:"prereq"\|"comfyui", title, what, members, pending, ok, done, total}]`）**、`components`（逐组件真值，仅供排障/脚本）、`modelsDir/comfyDir/totals/destDirs/routeRules`、**`defaultModelId` / `defaultModelIds`**（首次启动「一键下载组件 + 默认模型」装的集合：默认模型 + 它 `requires` 里的配套模型） |
| POST | `/app/models/enqueue` | body `{ids:[...], autoPrereq?:bool}` → `{tasks:[{id,refId,title,state}], addedPrereqs:[{kind,id,title,taskId}]（已去重）, existed:[], errors:[]}`；**前置缺失时自动入队** |
| POST | `/app/components/enqueue` | **v1.3.0（第四批）：只有两组，且每组一个任务** —— body `{groups:["prereq"\|"comfyui"]}`（省略=两组）→ `{ok, groups:[{group,id,title,state}], tasks:[id]}`。`prereq` 是"整组一个任务"（内部逐个装、进度聚合），`comfyui` 是"下载→解压两阶段"任务；传 `ids:[...]` 只接受这两个值（其余组件名一律 400，界面上也不存在） |
| GET | `/app/install/queue` | `{items:[…], counts:{total,queued,running,paused,done,failed,canceled,skipped}, running, runningCount, groups:[{group,title,taskId,state,percent,phase,message,speedKBs,candidate,done,active,error}], **totalSpeedKBs**（所有在跑任务速度之和）, **runningSpeeds[]**（`{id,title,speedKBs,percent,lane}`）}`（前端 2 s 轮询）。任务字段另含 **`lane`**（`comfyui` / `prereq` / `model`）、**`phase:"download"\|"install"`**、`message`、**`downloadPercent`**（下载阶段 0–100；`percent` = 它的 90%，最后 10% 留给解压） |
| POST | `/app/install/queue/:id/(pause\|resume\|retry\|retask\|cancel\|move-up\|move-down)` | 控制；`cancel` body `{deleteFile:false}` 可保留本地文件（默认删除）。`retask` = 自动换源 |
| POST | `/app/install/queue/clear` | 清掉已结束（done/failed/canceled/skipped）的任务 → `{removed}`。⚠️ **实现顺序要求**：这条判断必须在 `/app/install/queue/<id>/<action>` 前缀分支**之前**，否则会被当成一个 id 而回报 404（v1.3.0 第六批修的就是这个） |
| GET | `/app/models/custom` | `{items:[…自定义条目], routeRules, destDirs, modelsDir}` —— **生图面板读它**（不读 ComfyUI 的 object_info） |
| POST | `/app/models/custom` | body `{name, file, dest, route, encoder, vae, sourceUrl?, note?}` → `{ok, item, file, exists}`；文件名带路径 / 扩展名不在白名单 / 编码器或 VAE 与管线家族不符 → **400 + 人话原因** |
| PATCH/PUT | `/app/models/custom/:id` | 改名/改配对（部分更新，其余字段继承） |
| DELETE | `/app/models/custom/:id?deleteFile=1` | 删记录；`deleteFile=1` 才删磁盘文件（默认只删记录） |
| POST | `/app/models/pick-file` | 弹系统文件选择框 → `{ok, path, bytes}`，非 Windows/失败时 `{ok:false, hint}`（**不静默**） |
| POST | `/app/models/import-local` | body `{srcPath, name?, dest, route, encoder, vae, modelName?, register?}` → `{ok, file, bytes, linked, item}`；同卷优先**硬链接** |
| POST | `/app/models/upload?uploadId&name&dest&modelsDir` | **请求体为原始文件字节**（在 `readJsonBody` 之前分流），落盘 `<modelsDir>/<dest>/<name>`（先写 `.uploading` 再改名）→ `{ok, uploadId, file, rel, total}` |
| GET | `/app/models/upload-status?uploadId=` | `{state, received, total, percent, file, error}` |
| POST | `/app/models/register-upload` | body `{name, dest, modelName, route, encoder, vae, note?}` → 落盘文件登记为自定义模型（文件不存在时 400） |

> `POST /app/models/download` **v1.3.0 起委托队列**：返回 `{ok, jobId:第一个任务id, taskIds, addedPrereqs, existed, errors}` —— `jobId` 字段保留，旧前端/脚本不会炸。

### 面板兼容接口（原样保留）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/comfy-panel/config` | `{base, comfyDir, port}` |
| GET | `/comfy-panel/health` | `{clientAlive, clientBundle}` |
| POST | `/comfy-panel/client-alive` | `{ok:true}` |
| GET | `/comfy-panel/artists` | `{all:[tag], top:[tag]}` |
| POST | `/comfy-panel/launch` | 同 `/app/comfy/launch` |
| ANY | `/comfy-panel/api/*` | 反代 ComfyUI：**请求体一律原始字节直通**（`req.pipe()`；multipart 上传与二进制不会被 UTF-8 解码破坏），响应头只透传 `content-type` / `content-length`，绝不把浏览器 cookie 或其它头带给 ComfyUI |
| WS | `/comfy-panel/ws?clientId=` | 裸 TCP 中继到 `127.0.0.1:<comfy.port>/ws`，改写 `Host`/`Origin`，只保留 6 个握手头 |

> 说明：插件版曾把 JSON/text 请求体解码成字符串再转发；独立版统一改为原始字节直通（语义等价、且对二进制更安全）。
> 另外实现里还提供契约之外的自用端点：`GET /app/logs`、`GET /app/artists/lists/info`、`GET /app/models/catalog`、
> `GET /app/download/probe`、**`GET /app/download/speedtest?url=&mib=&capMs=`（镜像测速：每个候选来源各真下 N MiB）**、
> **`GET /app/jobs?kind=&state=`（任务列表 + running）**、
> `GET /app/llm/prompt`、`GET /app/llm/session/:id`；`/app/state` 额外返回 `paths` / `platform` / `node`。

## 5. 数据落盘

| 文件 | 内容 |
|---|---|
| `data/settings.json` | 设置（唯一可能含用户外部绝对路径的文件） |

> `settings.json` 只保存**用户真正设过的值**（第七轮起）：`save()` 不落盘"派生出来的镜像梯队"（`hfMirrors` / `nodeMirrors` / `jsdelivrMirrors` / `extraMirrors`），并且**等于当前默认值的 `githubProxies` 也不落盘**。
> 目的：任何一次 `PUT /app/settings` 都不会把当时的默认镜像列表固化到文件里，升级默认梯队对老用户同样生效。
| `data/artists.json` | `{favs:[], blacklist:[], groups:[{name, items:[]}], updatedAt}`（`groups` 为 v1.2.0 起；最多 50 组） |
| `data/llm/models.json` | LLM 模型清单与默认项 |
| `data/llm/sessions.json` | 会话：`{sessions:{<id>:{messages:[...], updatedAt}}, lastSessionId}`（v1.2.1 起带 `lastSessionId`，用于"自动接回上一次对话"；每会话最多 `keepMessages` 条，默认 40 / 可调 2–2000） |
| `data/run/comfy-owner-<pid>.json` | **v1.2.2**：ComfyUI **进程归属记录**（每个由本程序拉起的实例一份）。字段：`{schema:1, buildTag, pid, ownerPid, startedAtMs, python, mainPy, codeDir, port, spawnCommand}`。`launch()` 成功后立刻写、子进程 `exit` 时立刻删；启动时 `cleanupOrphans()` 只按这里**自己写过**的记录清孤儿。**含本机 pid 与本机绝对路径**，不进交付包、也不需要跟着迁移（见 `MIGRATION.md`） |
| `data/setup.json` | 向导完成状态 |
| `data/install/state.json` | **v1.3.0**：安装状态。`{schema, updatedAt, components:{<id>:{ok,verifiedAt,detail,staleReason?}}, models:{<id>:{file,bytes,sha256,verified,at}}, custom:{<id>:{id,name,file,dest,route,encoder,vae,bytes,sha256?,sourceUrl?,origin,note?,createdAt,updatedAt}}}`。**记录只是缓存/审计**：组件与模型的"装没装"一律以磁盘真值为准（文件不在了就当没装，可自愈） |
| `data/install/tasks.json` | **v1.3.0**：下载队列快照（见 §3.1）。**关窗口/重启后端后进度都还在**；重启时 `running` → `paused` |
| `logs/server.log` | 后端日志 |
| `logs/comfyui.log` | ComfyUI 子进程 stdout/stderr |
| `logs/jobs/<jobId>.log` | 长任务日志（可下载/查看） |

所有写入走 `store.js` 的原子写（临时文件 + rename），JSON 产物**不带 BOM**（归属记录同样原子写）。

> **归属记录（`data/run/`）与迁移**：里面的 `pid`、`python`、`mainPy`、`codeDir` 都是**本机**的值，拷到别的机器既无意义也不会误伤 ——
> 清理前必须过五条谓词（记录可解析 → 进程存活 → 命令行含 `main.py` → 命令行反推的入口目录 == 记录 `codeDir`（或命令行含记录 `mainPy`）→ pid ≠ 自身），
> 任一条不满足就**只记 WARN、绝不动手**（宁可漏清、绝不误杀）。详见 `docs/FULL-REFERENCE.md` 的第十一轮附录与 `docs/ROUND11-VERIFY.md`。

## 6. i18n 契约

- `web/i18n/zh.json` / `en.json`：
  ```jsonc
  {
    "ui":   { "nav.generate": "生图", "...": "..." },       // 外壳与新页面用，key 由开发者在代码里使用
    "panel": { "<面板中的中文原文>": "<英文译文>" },          // 精确匹配
    "panelRules": [ { "pattern": "^画师清单不可读：(.*)$", "replace": "Artist list unreadable: $1" } ]
  }
  ```
- 面板翻译由 `web/i18n.js` 的运行时翻译器完成（MutationObserver + 精确词典 + 正则规则），**不改写面板源码文案**（理由见决策记录：保住与上游 client.js 的可比对性）。
- `zh.json` 的 `panel` 段必须包含面板全部中文原文（映射到自身），便于校验覆盖率。
- **v1.2.2 新增的外壳文案**（两侧必须同时存在，`check.js` `[3]` 会核键集）：
  `shell.serviceAddress` / `shell.serviceAddressTitle` / `shell.serviceAddressTitleConfig` / `shell.copyAddress` /
  `shell.linkLost` / `shell.linkLostHint` / `shell.linkLostLastOk` / `shell.linkLostLast` / `shell.linkLostRetry`。
