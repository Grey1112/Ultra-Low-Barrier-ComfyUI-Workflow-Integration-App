# comfy-panel-standalone 完整技术参考（v1.2.2）

> **本文档面向谁**：接手本项目的维护者（可能在没有任何上下文的情况下冷启动）。
> **一句话作用**：把「这个项目由哪些文件组成、每个文件负责什么、数据落在哪、为什么这么设计」讲清楚，
> 使你能在不读完全部源码的情况下定位问题、改动功能、并判断改动的影响面。
>
> 姊妹文档：`docs/INTERNAL-CONTRACT.md`（前后端冻结契约，接口与数据格式的权威定义）。
> 其他交付物：`README.md`（给使用者）、`FEATURES.md`（功能清单）、`MIGRATION.md`（迁移指南）。
>
> **脱敏约定**：本文档不出现任何真实机器路径与用户名。示例一律使用
> `<项目根>`、`<你的ComfyUI目录>`、`%USERPROFILE%`、`%LOCALAPPDATA%`、`<盘符>` 等占位符。

---

## 1. 三分钟总览

**一句话**：本机跑一个零 npm 依赖的 Node 后端，它一边托管静态前端（外壳页面 + 复用插件版生图面板），
一边反代 / 管理 ComfyUI 与 llama.cpp 两个本地 AI 进程；所有状态落在项目内的 `data/`，
所以**整个项目文件夹拷到另一台 Windows 机器上即可继续用**（详见 `MIGRATION.md`）。

### 1.1 组件拓扑

```
┌──────────────────────── 浏览器（同源页面，默认 http://127.0.0.1:8788/）────────────────────────┐
│  web/index.html                                                                                 │
│    ├─ vendor/react.production.min.js + react-dom.production.min.js   （UMD，随项目携带）        │
│    ├─ panel-host.js   最小宿主适配层：window.__ModuleLoader__.load + ctx.slots.* 替身            │
│    ├─ panel.js        插件版 lib/client.js 的「适配副本」（2000+ 行 UI + 图构建器）             │
│    ├─ app-shell.js    ES module 外壳：导航 / 状态 / i18n / 长任务 / 三个标签页                   │
│    └─ pages/workbench.js  三合一工作台：生图 .wb-gen / 本地 LLM .wb-llm / 画师 .wb-art 三栏并排  │
└───────────────────────────────────────────┬─────────────────────────────────────────────────────┘
            同源 fetch / EventSource / WebSocket（无跨域、无第三方 CDN）
                                            │
┌───────────────────────────────────────────▼─────────────────────────────────────────────────────┐
│ 本地 Node 后端  server/index.js（Node 标准库 http/net/fs/crypto，零 npm 依赖）                  │
│   ├─ 静态资源      GET /            → web/index.html                                            │
│   │                GET /static/<p>  → web/<p>（fsx.safeJoin 防 ../ 穿越，cache-control: no-store）│
│   ├─ 管理接口      /app/*           → 配置 / 任务 / ComfyUI 进程 / 向导 / 本地 LLM / 画师数据     │
│   ├─ 面板兼容前缀  /comfy-panel/*   → 原插件面板「零改动」可用的兼容面：                          │
│   │                ├─ /config /health /client-alive /artists /launch                            │
│   │                ├─ /api/*   仅转发 content-type 的 HTTP 反代（原始字节直通）                  │
│   │                └─ /ws      裸 TCP 中继到 ComfyUI /ws（改写 Host/Origin，只保留 6 个握手头）  │
│   ├─ data/ 持久化  settings / artists / llm 清单与会话 / setup / **characters 角色词表**            │
│   │                （全部原子写、无 BOM；角色词表与用户别名见 §5.1）                              │
│   └─ 子进程                                                                                     │
│        ├─ ComfyUI      内嵌 runtime/comfyui/... 或外接用户目录；--listen 127.0.0.1 --disable-metadata │
│        ├─ llama-server runtime/bin/llama/llama-server.exe；--host 127.0.0.1 --port 8199         │
│        └─ 托盘助手     scripts/tray.ps1（由启动器另起的独立 powershell 进程，带 NotifyIcon）      │
│                        外接 API 模式（llm.provider=api）下不起 llama-server，直接打远端          │
└───────────────────────────────────────────┬─────────────────────────────────────────────────────┘
                    回环 127.0.0.1（默认）           │            回环 127.0.0.1
                    开 LAN 时必须带令牌              │
        ┌───────────────────────────────────────────┴──────────────────────────────┐
        ▼                                                                          ▼
  ComfyUI（默认 :8188）                                                     llama.cpp（默认 :8199）
  权重：<modelsDir>/diffusion_models|text_encoders|vae                    模型：models/llm/*.gguf
  画师清单：<comfyDir>/model-notes/*.txt                                  系统提示词：assets/templates/anima-system-prompt.txt
```

### 1.2 五条主数据流

| # | 流向 | 通道 | 说明 |
|---|---|---|---|
| 1 | 面板 → ComfyUI | `POST /comfy-panel/api/prompt` 等 | 面板 `api(path)` 拼 `/comfy-panel/api` + 路径；后端反代到 `127.0.0.1:<comfy.port>`；提交前有管线兼容性硬闸门 |
| 2 | ComfyUI → 面板（进度/预览） | `WS /comfy-panel/ws?clientId=` | 后端把握手改写为 ComfyUI 自己的 Host/Origin（否则 403），纯字节双工中继；含实时预览二进制帧 |
| 3 | 浏览器 → 后端（管理） | `/app/*` | 设置、画师、LLM、向导、自检、任务事件流；非 2xx 统一 `{error}` |
| 4 | 长任务进度 | `GET /app/jobs/{jobId}/events`（SSE） | 每帧 `{phase,message,percent,level}`；末帧 `{phase:"done",ok,result|error}`；同时落盘 `logs/jobs/<kind>-<id>.log` |
| 5 | 本地 LLM 生成提示词 | `POST /app/llm/chat`（SSE） | 后端按 `llm.provider` 分流：`local` 走 llama-server `/v1/chat/completions`，`api` 走外接 `/chat/completions`；两条路径**共用**同一个 SSE 封装与**输出规范化**，并在末尾做**角色 tag 补全**（`characters.repairAnswer`，补了就回一帧 `charactersAdded`）。前端「填入」经 `window.__DCP_BRIDGE__.fillPrompts()` → 面板 `window.__DCP_PANEL_API__.setPrompts()`（真 `setState`）；「复制」走剪贴板（见 §4.8） |

---

## 2. 交付物全清单

### 2.1 逐目录/逐文件

| 路径 | 内容 | 是否入库 | 备注 |
|---|---|---|---|
| `start.cmd` | 双击启动入口 | ✅ | 优先 `pwsh`，没有则 `powershell -ExecutionPolicy Bypass`；失败时 `pause` 并给常见原因 |
| `package.json` | `name/version/license/engines` + `start`/`check` 脚本 | ✅ | `dependencies`/`devDependencies` **均为空对象**（零 npm 依赖的硬证据） |
| `.gitignore` | 排除运行期数据/运行时/权重/产物 | ✅ | 「核心版 = git 仓库本身」的实现手段 |
| `LICENSE` | 本项目 MIT 全文 | ✅ | 只覆盖本项目自身代码与文档 |
| `THIRD_PARTY.md` | 第三方组件与许可逐项说明 | ✅ | 含 ComfyUI(GPL-3.0) 与各权重的义务说明 |
| `README.md` / `FEATURES.md` | 使用者向说明 / 功能清单 | ✅ | 由另一路并行编写；`scripts/build-core.ps1` 会把它们当作交付必备文档校验 |
| `MIGRATION.md` | 迁移指南 | ✅ | 本文档姊妹篇 |
| `server/index.js` | HTTP 服务入口、路由、静态托管、端口自增 | ✅ | 唯一的 `require.main === module` 入口 |
| `server/config.js` | 路径推导、设置默认值/归一化/读写、`selfcheck()` | ✅ | 所有项目内路径都从 `__dirname` 向上推导 |
| `server/jobs.js` | 长任务注册表 + SSE 事件流 + 任务日志 | ✅ | `run()/stream()/frame()` |
| `server/download.js` | F3 下载策略、镜像候选、断点续传、校验 | ✅ | `download()/buildCandidates()/probe()` |
| `server/comfy.js` | ComfyUI 布局探测、进程起停、HTTP 反代、WS 中继、画师清单只读 | ✅ | 反代与中继逻辑继承插件版实测结论 |
| `server/comfy-install.js` | 向导安装器：7-Zip 引导、ComfyUI 四种来源、自定义节点、模型、画师、许可 | ✅ | Node 侧实现，替代插件版的 PowerShell 安装器 |
| `server/llm.js` | llama.cpp 运行时安装、模型管理、会话、流式对话与输出规范化；**`provider` 分支（local / api）**、`chatViaApi` 路径用的 `testApi`/`pipeOpenAIStream`、`catalog()`、角色补全挂钩 | ✅ | 系统提示词只读原文，不追加内容 |
| `server/characters.js` | **角色词表**：Danbooru 角色 tag 索引（下载/懒加载/检索）+ 中文别名表 + `repairAnswer()` 输出补全 | ✅ | 词表数据落在 `data/characters/`（不入库）；见 §3.11 |
| `server/store.js` | `data/` 下的四类 JSON 读写（含收藏/黑名单互斥） | ✅ | 全部经 `fsx.writeJsonAtomic` |
| `server/util/fsx.js` | 原子写、`safeJoin`、`sha256File`、`copyTree`（可硬链接） | ✅ | 「不得出现绝对机器路径」的红线文件 |
| `server/util/log.js` | `logs/server.log` 追加写 + 5 MB 滚动 + 内存环（500 行） | ✅ | `DCP_QUIET=1` 可静音控制台 |
| `server/util/zip.js` | 纯 JS ZIP 解压 + 7-Zip 调用 + 单根目录上提 | ✅ | 只支持 store(0)/deflate(8) |
| `web/index.html` | 页面骨架与脚本装载顺序 | ✅ | 22 行，顺序不可换 |
| `web/panel-host.js` | `window.__ModuleLoader__` 适配器 | ✅ | 让插件版面板在没有插件宿主的网页里原样运行 |
| `web/panel.js` | 生图面板（插件版 `lib/client.js` 适配副本） | ✅ | ~146 KB / 2278 行；改动锚点见 §4.6 |
| `web/app-shell.js` | 外壳：侧栏导航、顶栏徽标、页面懒加载、i18n、桥、日志抽屉 | ✅ | 页面桥 `window.__DCP_BRIDGE__` |
| `web/i18n.js` | `t()` 词典 + 面板 DOM 运行时翻译器 | ✅ | MutationObserver + 精确词典 + 正则规则 |
| `web/job-view.js` | 任务视图：`runJob()` / `<JobProgress>` / `openJobModal()` | ✅ | SSE + 轮询兜底 |
| `web/pages/settings.js` | 设置页（含自检结果展示、**推理来源 / 外接 API**、ModelScope / 停滞阈值 / 国内优选源） | ✅ | 窗口行为两项按设计隐藏（页面侧；启动器侧的托盘见 §3.12 与决策 ⑰） |
| `web/pages/wizard.js` | 首次运行向导页 | ✅ | 档位/来源/复制方式/模型多选 |
| `web/pages/workbench.js` | **三合一工作台**：生图 / 本地 LLM / 画师三栏并排 + 布局切换 + 折叠 | ✅ | 布局偏好存 `localStorage` 的 `dcp-workbench-layout`；见 §4.8 |
| `web/pages/llm.js` | 本地 LLM 页（对话、运行时、模型管理、abliterated 检索、**推荐模型目录**、**角色词表**、**提示词工具：填入 + 复制**） | ✅ | 含 `parseFence()` 正负向解析（本轮修掉围栏 bug，见决策 ⑱） |
| `web/pages/artists.js` | 画师页（收藏、黑名单、检索、从浏览器旧数据导入） | ✅ | `localStorage` key 仍为 `dcp-artist-favs`（仅作一次性导入源） |
| `web/pages/pages.css` | 新页面样式 | ✅ | 新增类名必须写进这里（契约 §2） |
| `web/styles/shell.css` | 外壳样式（含 `.panel-slot` 等） | ✅ | — |
| `web/styles/workbench.css` | **三栏工作台布局样式**：栅格比例、每栏独立滚动、折叠、窄窗口 CSS 断点降级 | ✅ | `web/index.html` 第三个样式表；见 §4.8 |
| `web/vendor/react.production.min.js` / `react-dom.production.min.js` | React UMD 生产构建 | ✅ | MIT；随项目携带，避免依赖宿主 或 CDN |
| `web/vendor/LICENSE-react.txt` | React 许可 | ✅ | — |
| `web/i18n/zh.json` / `en.json` | 词典：`ui` **333 键**、`panel` **317 键**、`panelRules` **4 条**、`panelPhrases`（`en` **57 条** / `zh` 空） | ✅ | 中英键数一致；`zh.panel` 把面板中文映射到自身 |
| `assets/artists/Anima2B_Artist_Index_59k.txt` | 59,676 条画师 tag（Anima 2B 训练快照） | ✅ | MIT（ThetaCursed/Anima-Style-Explorer） |
| `assets/artists/Anima2B_Artist_top200.txt` | 前 200 高频画师 | ✅ | 同上 |
| `assets/artists/NOTICE.md` | 画师清单来源与许可声明 | ✅ | 再分发须保留 |
| `assets/templates/anima-system-prompt.txt` | **本地 LLM 的系统提示词原文** | ✅ | 代码只读不改（决策 ⑥⑦） |
| `installer/models.json` | 12 条模型目录表（含 `bytes`/`sha256`/`license*`/`urls`/`verified`） | ✅ | **保持 UTF-8 with BOM**（历史交付约束） |
| `installer/llm-models.json` | **7 条推荐本地 LLM 目录**（`id`/`file`/`bytes`/`repo`/`url`/`license`/`recommended`/`vram`/`modelscope`/`note`/`verified`） | ✅ | 字节数经 hf-mirror API 与 ModelScope Range 双向核对；见 §3.10 |
| `docs/INTERNAL-CONTRACT.md` | 前后端冻结契约 | ✅ | 改动必须同步 |
| `docs/HANDOVER.md` | **项目交接文档**（第七轮新增）：交接物清单、10 分钟上手、架构地图与改动风险、10 条红线、数据落盘边界、下载/镜像体系、**验证手册（22 个脚本的基线与用途）**、维护任务手册、发布流程、已知限制、开发机环境事实（已去标识化）、许可边界、七轮变更摘要、名词表 | ✅ | 已过脱敏；**必须与代码同批更新**（改接口/加脚本/改发布流程时） |
| `docs/FULL-REFERENCE.md` | 本文件 | ✅ | — |
| `scripts/start.ps1` | 启动器：Node 解析 → 起后端 → 等就绪 → 开浏览器 → 起托盘 → **最小化控制台** → 跟随日志 | ✅ | UTF-8 with BOM + CRLF；所有路径参数**必须加引号**（决策 ⑲） |
| `scripts/tray.ps1` | **托盘助手**（独立 PowerShell 进程）：打开 UI / 复制地址 / 打开日志 / 关闭控制台并停止后端（**v1.2.2：先礼后兵** —— 先 `POST /app/quit` 请后端优雅退出，失败才 `/T /F`；两条路径最后都按归属记录再清一次 ComfyUI）；看护后端、自动消失 | ✅ | 只用系统程序集，不落资源文件、不写注册表；日志 `logs/tray.log`；见 §3.12 |
| `scripts/bootstrap.ps1` | 便携 Node 引导（默认 `v22.14.0`，官方源 + 两个 npmmirror 镜像） | ✅ | 幂等；已存在直接跳过 |
| `scripts/build-core.ps1` | 核心版打包 + 交付前自查（隐私/权重/GPL/文档/语法） | ✅ | 产出 `release/core` |
| `scripts/normalize-ps1.cjs` | 把 `.ps1` 规范化为 BOM+CRLF 并做 PowerShell 解析校验 | ✅ | 临时文件 → 校验 → 原子替换 |
| `LICENSES/*.txt|.md` + `LICENSES/README.md` | 各上游许可全文与逐项说明 | ✅ | 向导会整体复制到 `<comfyDir>/LICENSES/` |

### 2.2 `release/core` 的产物规则（`scripts/build-core.ps1`）

- **顶层白名单目录**：`server`、`web`、`scripts`、`assets`、`installer`、`docs`、`LICENSES`。
- **顶层白名单文件**：`start.cmd`、`README.md`、`FEATURES.md`、`MIGRATION.md`、`LICENSE`、`THIRD_PARTY.md`、`.gitignore`、`package.json`。
- **递归排除**：文件名命中 `runtime`、`models`、`data`、`logs`、`dist`、`release`、`node_modules`、`.scratch` 的整条路径；
  扩展名命中 `.safetensors .ckpt .pt .pth .onnx .gguf .7z .zip .rar .tar .gz .png .jpg .jpeg .webp .gif .log .part` 的文件。
- **打包后三项扫描**（任一失败即 `exit 1`）：
  1. 隐私扫描：若干「盘符 + 已知目录名」形态的绝对路径模式、用户漫游数据目录，以及本机用户名
     （**具体模式串以 `scripts/build-core.ps1` 的 `$privacyPatterns` 为准**；本文档不复写这些字面量，以免自身成为命中源）；
  2. 权重/压缩包扫描：`release/core` 内不得出现任何被排除的扩展名；
  3. GPL 代码片段扫描（警告级）：`comfy/ldm`、`class ComfyUI`、`from comfy`、`import comfy`、`nodes.py`。
- **文档齐全性**：`README.md`、`FEATURES.md`、`MIGRATION.md`、`docs/FULL-REFERENCE.md` 四份必须存在。
- **语法自检**：对 `release/core/server/**/*.js` 与 `web/panel.js`、`web/panel-host.js` 跑 `node --check`。
- **可选**：`-GitInit` 初始化仓库并首次提交，然后断言 git 跟踪清单里没有权重/压缩包；`-ScanOnly` 只扫描不重打包；`-SkipClean` 不删旧产物。

### 2.3 明确**不入库**的目录与原因

| 目录 | 内容 | 不入库原因 |
|---|---|---|
| `runtime/` | 便携 Node（`runtime/node/node.exe`）、7-Zip（`runtime/bin/7zr.exe`）、llama.cpp（`runtime/bin/llama/`）、下载暂存（`runtime/_dl/`）、内嵌 ComfyUI（`runtime/comfyui/`） | 二进制/平台相关，体积大且可重新获取；`.gitignore` 同时排除 `ComfyUI/`、`python_embeded/`、`venv/`、`custom_nodes/` |
| `models/` | 扩散模型/编码器/VAE（`models/diffusion_models` 等）与 `models/llm/*.gguf` | 权重体积（十几到几十 GB）且许可多为**非商业**，禁止随包分发 |
| `data/` | 设置、收藏与黑名单、LLM 清单与会话、向导状态、**角色词表（`characters/`）与用户别名** | 运行期数据；`settings.json` **可能含用户外部绝对路径**（`comfy.dir`）与 **外接 API 的 Key**（`llm.api.apiKey`），绝不能入库 |
| `logs/` | `server.log`、`comfyui.log`、`llama-server.log`、`jobs/*.log` | 运行期产物，含本机路径与诊断细节 |
| `release/`、`dist/` | 打包产物 | 可重建 |
| `node_modules/` | — | 本项目零 npm 依赖，目录不应存在 |

---

## 3. 后端（`server/*.js`）

通用约定：

- 全部 CommonJS，`'use strict'`；只 `require('node:*')` 与仓库内相对路径（`grep` 可验证零外部依赖）。
- 所有入口参数化自 `config.load()`（带内存缓存），写设置一律走 `config.save(patch)` → 深合并 + 归一化 + 原子写。
- 一切失败都要有可读 `message`：禁止静默失败（契约红线）。

### 3.1 `server/index.js` —— HTTP 服务与路由

**职责**：建 `http.createServer`、按前缀分派、静态托管、`upgrade` 事件处理 WS 中继、启动时建目录并打印就绪信息。

关键点：

- `main()`：确保 `data/`、`logs/`、`logs/jobs/`、`models/llm/`、`runtime/_dl/`、`runtime/bin/` 存在 → `log.setup(logs)` → 端口取 `process.env.DCP_PORT || settings.listen.port || 8788`，主机取 `process.env.DCP_HOST || (lan ? '0.0.0.0' : '127.0.0.1')`。
- `listen(port, host, attempt)`：**端口占用最多自增 2 次**（v1.2.2；`EADDRINUSE` 且 `attempt < MAX_PORT_BUMP=2`，每次 WARN，日志带「第 N/2 次自增」），超限 `log.error` + 给出 `DCP_PORT` 建议 + `exit(1)`；
  **实际端口只存内存**（`actualPort` / `listenPort()`），**不再** `save({listen:{port:actual}})` 回写设置（旧行为会把"设置里的端口"悄悄改掉，见决策 ⑪）；就绪日志「打开：」与 `DCP_READY` 都用实际端口，`/app/state` 顶层 `port` 也由它下发。
- `main()` 在 `listen()` **之前**先跑一次 `comfy.cleanupOrphans()`（按 `data/run` 归属记录清上一次遗留的、确属本程序的 ComfyUI 孤儿）。
- 启动就绪后向 stdout 打一行机器可读标记：`DCP_READY {"url","lanUrls","port","version"}`（启动脚本据此判断就绪、`start.ps1` 也用它搜「局域网地址：」）。
- 退出路径（v1.2.2）：`POST /app/quit`、`SIGINT`/`SIGTERM`/`SIGBREAK` 全部走 `beginQuit()`（停本程序拉起的 ComfyUI → 停 LLM）→ `finishQuit()`（关 HTTP → 落盘日志 → `process.exit(0)`，1.5 秒兜底）；另有 `process.on('exit')` 的**纯同步**兜底 `comfy.killOwnedSync()`。
  *（为什么不能只靠信号：Windows 上 `taskkill /F` = `TerminateProcess`，实测 SIGTERM/SIGINT/SIGBREAK/exit 处理器一个都不跑；所以托盘必须先发 `/app/quit`，见 §3.12 与第十一轮附录。）*
- `unhandledRejection` 记 `logs/server.log`。
- `lanGuard(req, url)`：仅当 `listen.lan === true` **且**设置了 `listen.token` 时校验；令牌来源 `X-DCP-Token` 头或 `?token=` 查询参数。未通过返回 401 + 中文提示。
- `ensureLanToken()`：开启 LAN 且无令牌时用 `crypto.randomBytes(12).toString('hex')` 生成并落盘；同一逻辑在 `listen()` 成功后与 `PUT /app/settings` 后各调一次。
- `readJsonBody()`：空体返回 `{}`；剥掉可能的 BOM 后 `JSON.parse`，失败抛 400「请求体不是合法 JSON」。
- `serveStatic()`：`/` → `/index.html`；`/static/<path>` 去掉 `/static` 前缀后经 `fsx.safeJoin(paths.web, ...)`（`..` 穿越即 400）；目录则补 `index.html`；响应头 `cache-control: no-store, must-revalidate` —— **这就是「改前端代码刷新即生效」的实现**（对应摆脱插件版 `?rev=` 快照机制）。
- 静态 MIME 表：html/js/mjs/css/json/txt/md/svg/png/jpg/ico/woff2，其余 `application/octet-stream`。
- `handleApp()` 见 §8 接口表；`handleComfyPanel()` 见 §9。

### 3.2 `server/config.js` —— 路径、设置、自检

**职责**：唯一的路径来源（`paths`）、默认设置（`DEFAULTS`）、归一化与夹紧（`normalize`）、加减（`load`/`save`）、生效 ComfyUI 目录（`comfyDir`）、启动自检（`selfcheck`）。

- `ROOT = path.resolve(__dirname, '..')`，其余 28 个路径全部基于 `ROOT`：`web`、`assets`、`data`、`models`、`llmModels=models/llm`、`runtime`、`runtimeBin=runtime/bin`、`runtimeDl=runtime/_dl`、`comfyEmbedded=runtime/comfyui`、`logs`、`jobs=logs/jobs`、`installer`、`licenses`、`artists=assets/artists`、`templates`、`systemPrompt`、`modelsJson`、`settingsFile`、`artistsFile`、`llmModelsFile`、`llmSessionsFile`、`setupFile`、`serverLog`、`comfyLog`、`llmLog`。
- `VERSION = '1.1.0'`，`BUILD_TAG = 'v' + VERSION`。
- `load()` 带内存缓存（首次读 `data/settings.json` 后常驻）；`save(patch)` = `normalize(deepMerge(load(), patch))` → 更新缓存 → `fsx.writeJsonAtomic`。
- `deepMerge`：对象递归合并；数组与标量整体替换；`undefined` 不覆盖。
- `normalize()` 的夹紧规则（越界/非法一律回落默认值）：
  `lang ∈ {zh,en}`；`listen.host` **由 `lan` 推导**（`lan ? 0.0.0.0 : 127.0.0.1`）；`listen.port 1..65535`；
  `comfy.mode ∈ {embedded,external}`；`comfy.port 1..65535`；`llm.port 1..65535`；
  `llm.contextMessages 0..20`；`llm.ctxSize 512..262144`；`llm.gpuLayers 0..999`；
  `download.officialTimeoutMs 1000..120000`；`download.slowThresholdKBs 1..100000`；`download.slowWindowMs 1000..600000`；
  `download.githubProxies` 必须为数组；`comfy.extraArgs` 必须为数组。
- `comfyDir(settings)`：`external` → `settings.comfy.dir`（用户填的绝对路径）；否则项目内 `runtime/comfyui`。
- `selfcheck()` 返回 `{ok, issues[], external[], host, root}`；`ok` 仅当**没有 error 级**问题。已实现的 6 个 issue code：

| code | level | 触发条件 | fix 文案（节选） |
|---|---|---|---|
| `comfy-dir-missing` | error | `external` 模式下 `comfy.dir` 为空或不是目录 | 重新指向本机 ComfyUI 目录，或改用内嵌模式 |
| `comfy-embedded-missing` | warn | 内嵌模式找不到 `runtime/comfyui/ComfyUI/main.py` 或 `runtime/comfyui/main.py` | 打开首次运行向导获取便携包 |
| `system-prompt-missing` | warn | `assets/templates/anima-system-prompt.txt` 不存在 | 恢复该文件 |
| `artists-missing` | warn | `assets/artists/Anima2B_Artist_Index_59k.txt` 不存在 | 恢复两份清单 txt |
| `llm-runtime-missing` | warn | `runtime/bin/llama/llama-server.exe` 不存在 | 在「本地 LLM」页安装运行时 |
| `llm-model-missing` | warn | 设置的 `llm.defaultModel` 指向的文件不存在 | 重新指定默认模型 |

  `external[]` 只含 `{key:'comfy.dir', path, exists}`，供设置页/自检接口显示外接路径是否有效。

  本轮新增的归一化键（全部静默夹紧/回落默认值，不报错）：
   `llm.provider ∈ {local, api}`（非 `api` 一律 `local`）；`llm.api.baseUrl` 去尾部斜杠、`apiKey`/`model` 去首尾空白；
   `llm.api.temperature 0..2`（默认 0.6）；`llm.api.maxTokens 64..32768`（默认 1024）；`llm.api.timeoutMs 5000..600000`（默认 120000）；
   `download.stallKBs 1..100000`（默认 **30**）；`download.modelscope` 去尾部斜杠（默认 `https://modelscope.cn`）；
   `download.useModelScope`（**默认 true**，只有显式 `false` 才关）。

   **注意**：`download.officialFirst` 目前**只在设置页与 `PUT /app/settings` 之间传递**，`DEFAULTS` 里没有这个键，因此 `normalize()` 不会保留它 —— 「一键填入国内优选源」按钮会一并把它设为 `false`，实际生效的是镜像候选顺序与 `stallKBs`（见决策 ⑯ 的说明）。

### 3.3 `server/jobs.js` —— 长任务 + SSE

**职责**：把「下载 / 安装」这类分钟级任务统一成 `jobId` + 事件流 + 落盘日志。

- `create(kind, title)`：生成 `id = Date.now().toString(36)-随机6位`；`logFile = logs/jobs/<kind>-<id>.log`；给 job 挂三个便捷方法：
  `job.emit(ev)`（补 `phase/level/at`）、`job.emitPercent(phase, percent, message, level)`（percent 夹到 0..100 取整）、`job.log(message, level)`。
  内存上限：超过 `MAX_JOBS = 40` 时按 `startedAt` 淘汰最早的**已结束**任务。
- `frame(job, ev)`：事件入内存数组（`MAX_EVENTS = 800`，超出裁掉最旧的）→ 广播给所有 SSE 监听者（监听者抛错不影响任务）→ **同步追加** JSON 行到 `job.logFile`。
- `run(kind, title, body)`：`create` + `setImmediate(async () => { try { finish(job, await body(job)) } catch (e) { fail(job, e) } })`；**抛错即 `job.fail`，绝不静默**。
- `finish`/`fail`：置终态、记录 `result`/`error`，各补一帧 `{phase:'done', ok:true|false, ...}` 并关闭监听者（给每个 listener 发 `null` 作为「结束」信号）。
- `stream(id, req, res)`：404（任务不存在）→ 写 `text/event-stream` 头（含 `x-accel-buffering: no`）→ **先补发全部历史事件**→ 若任务已结束再补终帧并 `end()`；否则挂监听，每 15 秒写 `: ping` 心跳，`req` 关闭/出错时清理。
- 注意：SSE 断流不是任务失败——前端 `job-view.js` 在 `onerror` 时用 `GET /app/jobs/{id}` 轮询兜底。

### 3.4 `server/download.js` —— F3 下载策略

**职责**：给定一个官方 URL，推导候选来源列表并逐个尝试；判定「该切镜像了」；支持断点续传；做大小与 sha256 校验。

`buildCandidates(url, settings)`：

1. 第 0 项永远是 `{source:'official'}`（原 URL）。
2. 主机匹配 `huggingface.co` / `hf.co` / `hf-mirror.com`（含子域）→ 追加两项：
   ① **hf-mirror**：把 **host/protocol/port** 换成 `download.hfMirror`（默认 `https://hf-mirror.com`），路径不变，`via:'hf-mirror'`；
   ② **ModelScope**（`download.useModelScope !== false` 时才加）：把 `/{owner}/{repo}/resolve/{rev}/{path}` 改写成 `<modelscope>/models/{owner}/{repo}/resolve/{r}/{path}`；
   **revision 段必须跳过**（否则会拼成 `resolve/master/main/...`，实测踩过）；`rev === 'main'` 时按 `[master, main]` 顺序去重各加一项（`new Set` 去重），`via:'modelscope'`。
3. 主机匹配 `github.com` / `githubusercontent.com` / `codeload.github.com` → 对 `download.githubProxies` 每一项追加 `代理前缀 + 原URL`（前缀自动补 `/`），`via` 记为代理主机名。
4. URL 解析失败时只返回官方源。

`normalizeDownloadUrl(raw)`（**本轮新增**）：把用户粘贴的**网页链接**规范成直链 —— HF `/blob/` → `/resolve/`；ModelScope `/models/<o>/<r>/file/view/` → `/resolve/`；ModelScope 旧式 `?Revision=<rev>&FilePath=<path>` → `/resolve/<rev>/<path>`（默认 rev = `master`）；已经是直链的原样返回。解析失败保持原样（不猜）。

`download(o)` 的判定与流程（**这是 F3 的核心**）：

| 阶段 | 行为 |
|---|---|
| 已就绪 | 未传 `force` 且 `expectBytes` 精确匹配现有文件大小 → 直接返回 `{skipped:true, source:'cache'}`（安装器可反复运行） |
| URL 规范化 + 候选 | 先 `normalizeDownloadUrl(o.url)`，再 `buildCandidates()`；**候选来源列表打进任务日志**：`<文件名> 候选来源 N 个：官方源 → hf-mirror → modelscope → …` |
| 候选循环 | 官方源优先；每个候选**最多 2 轮**；一旦进入镜像且尚未提示过，播报一条 `warn`：官方源不可用、本次改用镜像 `<via>`、可在设置里调 |
| 连接超时 | `AbortController` + `setTimeout(officialTimeoutMs)`，只约束**建立连接**阶段；超时即换下一个候选 |
| 慢速判定（**窗口均速**） | 每 1.5 s 采样一次并保留窗口内样本；**只有整个窗口覆盖满 且 窗口均速 < 阈值**时才 abort。阈值按候选取：**最后一个候选用 `stallKBs`（默认 30）**，其余用 `slowThresholdKBs`（默认 200）。进度文案同时给出窗口均速与瞬时速度 |
| 无数据看门狗 | 连上后 `20–60 s`（`clamp(slowWindowMs, 20000, 60000)`）一个字节都没动 → 判死换源；同时**显式销毁两端流**（卡死的 body 可能不理会 abort，实测踩过） |
| 请求头 | 固定带 `user-agent`（缺它时 ModelScope CDN 连上不吐数据）与 `Range: bytes=<n>-`（`0-` 等价全量；ModelScope / hf-mirror 对 Range 才稳定返回 206 流，顺带支持续传） |
| 断点续传 | 目标用 `<dest>.part`；若 `.part` 已存在则发 `Range: bytes=<n>-`；收到 `206` 续写（append）；收到 `200` 说明服务器不支持续传 → 丢弃断点重下；`416` 也丢弃 `.part`；启动即失败时同样丢弃断点并提示 |
| 落地 | 全部字节写完后 `rmSync(dest)` + `rename(part, dest)`（同卷原子） |
| 校验 | 先比 `bytes === expectBytes`（不符即抛）；再算 sha256（分块 4 MiB，边算边报百分比），不符则**删除文件**并抛错 |
| 全失败 | 抛一条汇总错误，逐行列出「`<来源>#<轮次>: 错误`」，并提示去「设置 → 下载」调镜像/阈值 |

`probe(url, settings, timeoutMs)`：对候选列表逐个发 `HEAD`，返回 `[{url, source, via, ok, status, ms, error?}]`；供 `GET /app/download/probe`（设置页「测试镜像」）使用。

### 3.5 `server/comfy.js` —— 探测、进程、反代、WS 中继、画师

- `detectLayout(dir)`：在 `[dir/main.py, dir/ComfyUI/main.py]` 中找入口；解释器候选按序探测
  `dir/venv/Scripts/python.exe`、`dir/venv/bin/python`、`dir/python_embeded/python.exe`、`dir/python.exe`，以及**入口同级目录**的同名四种（导入型安装）；
  `modelsDir` 取 `入口同级/models`（存在时）否则 `dir/models`，都不存在时仍返回「入口同级/models」作为预期落位；
  `layout`：入口就是 `dir` 本身 → `venv`，否则 → `portable`；失败返回 `{ok:false, layout:'unknown', error, candidates}`。
- `current()` / `baseUrl(port)` / `probe(port, timeoutMs=1500)`：`probe` 打 `/system_stats` 判断在线。
- `status()`：`{online, running, pid, mode, dir, port, layout, modelsDir, mainPy, python, startedAt, lastError, candidates}`。`running` 表示**本进程拉起过**（`state.pid` 非空），与 `online`（端口可达）是两件事。
- `launch()`：已在线直接返回 `{online:true, launched:false}`；否则探测布局 → 未找到 main.py/python 时**返回可操作的中文错误**（不再静默断开）；
  参数固定 `--listen 127.0.0.1 --port <comfy.port> --disable-metadata` **再拼** `settings.comfy.extraArgs`；
  `cwd` = 入口脚本所在目录（便携包 = 内层 `ComfyUI/`），`detached + unref`，stdout/stderr 追加 `logs/comfyui.log`，`windowsHide`；
  然后**最多等 180 秒**（每 2 s 探一次 `/system_stats`），超时返回「进程已启动但 180 秒内没有就绪」并指向日志文件。
（实测：冷启动 + 与另一个 ComfyUI 实例抢显存时 90 秒不够 —— Python 侧导入很重，故放宽到 180 秒。）
- `taskkill(pid)`：Windows 走 `taskkill /PID <pid> /T /F`（**实测 `/T` 能连 detached 子进程一起收** —— 孤儿的成因是父链断裂，不是 detached 逃逸）；其它平台先给进程组 `SIGTERM`、仍在则升到 `SIGKILL`。
- **进程归属（v1.2.2）**：`ownerDir()` / `writeOwnerRecord()` / `removeOwnerRecord()` / `listOwnerRecords()` / `verifyOwnership()`（五条谓词）/ `cleanupOrphans()` / `ownedTargets()` / `stopOwned()` / `killOwnedSync()`；记录落在 `data/run/comfy-owner-<pid>.json`，`launch()` 成功后即写、子进程 `exit` 即删。**绝不按"谁在监听 `comfy.port`"清理**（那会误杀用户自己启动的实例）。
- `pidListeningOn(port)`：Windows 上用 `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort <port> -State Listen ... OwningProcess"` 反查监听者。
- `stop()`：不在线 → `{stopped:false, note:'ComfyUI 当前未在运行'}`；在线则优先杀自己拉起的 pid，否则杀端口监听者；**最多等 15 秒**确认端口释放，超时返回错误（含 `killed` 结果）。
- `logTail(lines=300)`：读 `logs/comfyui.log` 返回最后 N 行（上限 5000），文件不存在返回空数组。
- `readArtists()`：**懒加载 + 成功才缓存**。候选目录顺序为 `assets/artists/` → `<comfyDir>/model-notes/` → `<comfyDir>/ComfyUI/model-notes/`；
  对 `Anima2B_Artist_Index_59k.txt` 与 `Anima2B_Artist_top200.txt` 分别读全文、按行 trim、**只保留以 `@` 开头的行**；任一缺失即抛 500「画师清单不可读，已探测：…」。
- `resetArtistsCache()`：清空缓存（向导复制完清单后调用）；对应插件版「清单变更需重启」的改进（决策 ⑧）。
- `proxy(req, res, port)`：把 `/comfy-panel/api` 之后的部分作为上游路径；**只转发一个请求头 `content-type`**，请求体原始字节 `req.pipe(up)`；
  响应只回传上游的 `content-type`/`content-length` 并追加 `cache-control: no-store`；上游不可达 → 502 + 中文提示「请先点『启动 ComfyUI』」。
- `relaySocket(req, socket, head, port)`：`net.connect(127.0.0.1, port)` 后手写握手行：
  `GET /ws<search> HTTP/1.1` + `Host: 127.0.0.1:<port>` + `Origin: http://127.0.0.1:<port>`，再按白名单复制 6 个头
  （`upgrade`、`connection`、`sec-websocket-key`、`sec-websocket-version`、`sec-websocket-extensions`、`sec-websocket-protocol`）；
  写入 `head` 后双向 `pipe`。任一方向错误/关闭都销毁两端（含 `failed` 幂等标志，避免重复日志）。

  > 为什么必须改写 `Host`/`Origin`：ComfyUI 0.37 注册了 `create_origin_only_middleware`，比对 Host 与 Origin 的 netloc；
  > 面板来源是本后端端口（默认 8788）≠ 8188，不改写则 WS 握手一律 403，进度条/计时/实时预览全哑。**Cookie 不透传**。

### 3.6 `server/comfy-install.js` —— 向导安装器

固定上游常量（改动需同步本文件与 `THIRD_PARTY.md`）：

| 常量 | 值 |
|---|---|
| `COMFYUI_GIT` | `https://github.com/comfyanonymous/ComfyUI` |
| `COMFYUI_COMMIT` | `e638023d54497dbe0579565e5de4bb7076899592`（与插件版安装器同一实测 commit） |
| `ANIMA_NODE_GIT` | `https://github.com/GumGum10/comfyui-anima-3-8B.git` |
| `ANIMA_NODE_COMMIT` | `381c13af328b958febf86c155d2f4b007cd0f55b` |
| `PORTABLE_ASSETS` | `ComfyUI_windows_portable_nvidia.7z`、`ComfyUI_windows_portable_nvidia_cu126.7z`、`ComfyUI_windows_portable.7z` |
| `RELEASE_API` | `https://api.github.com/repos/comfyanonymous/ComfyUI/releases/latest`（先问 API 取当前资产名，失败再回落候选名） |

- `catalog()`：读 `installer/models.json`（必须是数组）。
- `modelsDirFor(mode, externalDir)`：外接 → 用户目录；内嵌 → `detectLayout` 成功则用其 `modelsDir`，未装本体时预期 `runtime/comfyui/ComfyUI/models`。
- `installedState(entry, modelsDir)`：`ready` 仅当文件大小**精确等于**目录表的 `bytes`。
- `resolveSelection(list, spec)`：支持 `id`、`file`、`file.safetensors`、`tier`（minimal/standard/full）、`all`、`none`，逗号（中英文）分隔取并集；无法识别的部分记进 `unknown`。
- `ensure7z(job)` —— **7-Zip 引导链**（详见 §6.5）。
- `resolvePortableAsset(job)`：经 F3 取 Releases JSON，挑 `ComfyUI_windows_portable*.7z` 中名字含 `nvidia` 的那个（否则第一个），并返回其 `browser_download_url`。
- `installComfyUI(job, opts)` —— 四种来源（详见 §6.2）。
- `proxyGitClone(git, url, dest)`：依次尝试原 URL 与 `download.githubProxies` 前缀，全失败抛最后一条 stderr。
- `which(name)`：`where`/`which` 查可执行文件。
- `runJobCmd(job, spec)`：`spawnSync` 执行并把最后 15 行输出写进任务日志；非 0 退出即抛错。
- `installNodes(job, opts)`：目标 `<codeDir>/custom_nodes/comfyui-anima-3-8B`；已存在则跳过；有 git 就 clone + checkout 固定 commit，
  git 失败自动回落 `https://codeload.github.com/GumGum10/comfyui-anima-3-8B/zip/<commit>`（走 `zip.unzipTo` + `hoistSingleRoot`）；
  最后用 **ComfyUI 自己的解释器**跑 `pip install -r requirements.txt -i <download.pipIndex>`（失败只警告，不阻断）。
- `installModels(job, ids, opts)`：目标 `<modelsDir>/<dest>/<file>`；每个模型两步——
  ① 若传了 `opts.modelsFrom.dir`，在本地已有 ComfyUI 目录里找同名文件（`findModelFile`：先查四个常见位置，再做深度 ≤4 的浅递归，
  跳过 `venv/python_embeded/.git/node_modules/output/temp`），找到就硬链接（失败回落复制）并**校验大小是否与目录表一致**（不一致只警告）；
  ② 否则联网下载（`expectBytes + sha256`）。已就绪的模型跳过并计入 `skipped`。
- `installArtists(job, opts)`：把 `assets/artists/` 的三份文件（两份 txt + `NOTICE.md`）复制到 `<comfyDir>/model-notes/`，
  `detectLayout` 成功时**再复制一份**到 `<codeDir>/model-notes/`；随后 `comfy.resetArtistsCache()`。
- `installLicenses(job, opts)`：把 `LICENSES/` 全部文件复制到 `<comfyDir>/LICENSES/`，并把 `THIRD_PARTY.md` 复制为 `<comfyDir>/THIRD_PARTY-NOTICE.md`。
- `plan(opts)`：返回 `{mode, modelsDir, comfyDir, steps[6], models[12], selected, unknown, totalBytes, tiers{minimal,standard,full}, platform}`；
  `steps` 固定为 runtime / comfyui / nodes / models / artists / licenses。
- `runSetup(job, opts)`：向导主流程，按 `skip.{runtime,comfyui,nodes,models,artists,licenses}` 逐段执行（详见 §6.1）。

### 3.7 `server/llm.js` —— 本地 LLM（llama.cpp）

- `hasNvidiaGpu()`：`nvidia-smi -L` 成功且输出含 `GPU <n>`/`NVIDIA`。
- `resolveRuntimeAssets(job)`：拉 `https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=10`（经 F3 镜像），
  取**第一个含 Windows x64 CPU 资产**的 release，并按正则挑出
  `llama-b\d+-bin-win-cuda-[\d.]+-x64.zip`（取版本号最大者）、`cudart-llama-bin-win-cuda-[\d.]+-x64.zip`、`llama-b\d+-bin-win-cpu-x64.zip`。
- `installRuntime(job, variant)`：`auto` = 有 N 卡选 CUDA 否则 CPU；CUDA 优先尝试（**每个 cuda 包都带上第一个 cudart**），失败自动回落 CPU；
  解压到 `runtime/bin/llama/`（`unzipTo` + `hoistSingleRoot`，找不到就地全树搜 `llama-server.exe`）；
  CUDA 包若目录里没有 `cudart64*.dll` 才去下 cudart 并解到同一目录；最后 `verifyRuntime(exe)` 跑 `llama-server --version`（20 s 超时），**非 0 退出即视为失败并继续下一个候选**。
- `verifyRuntime(exe)`：返回 `{ok, version, status}`；`version` 取输出里第一行匹配 `version|build` 的文本。
- `listModels()`：扫 `models/llm/*.gguf`，组装 `{file, bytes, mtime, origin, abliterated, source, default}`；
  `origin` 来自 `data/llm/models.json`（缺省 `preset`）；`abliterated` 来自元数据或文件名正则 `/abliterated|uncensored|heretic/i`；默认模型排最前。
- `setDefaultModel(file)`：文件必须存在；同时写设置 `llm.defaultModel` 与 `data/llm/models.json` 的 `default`。
- `addModel({srcPath, mode})`：只接受 `.gguf`；`link`（默认）先试硬链接，失败回落复制；记录 `{origin:'added', source, addedAt}`；清单为空时自动设为默认。
- `removeModel(file)`：删文件 + 删清单项；若删的是默认模型则把默认切到清单里剩下的第一个。
- `downloadModel(job, {url, name})`：走 F3，落到 `models/llm/`，登记为 `downloaded`。
- `searchAbliterated(query)`：打 `<hfMirror>/api/models?search=<q>&limit=20&full=false`，再对每个仓库拉 `/api/models/<id>?blobs=false` 取 `siblings` 里的 `.gguf`（最多 40 个）；
  返回 `{items, note}`；**检索不到就如实说明**（「上游可能确实未发布 abliterated 权重，本程序不会伪造或改名充数」），不伪造结果。
- `serverStatus()`：`{runtime:{ok,exe,source:'cuda'|'cpu'|'none',version}, model, models, server:{running,port,pid,model,startedAt,lastError}}`；
  `source` 靠 `runtime/bin/llama/` 下是否存在 `cudart64*.dll` 判断。
- `startServer()`：要求运行时与模型都存在；**同模型且健康检查通过**则复用（`reused:true`），否则先停旧进程；
  基础参数 `-m <model> --host 127.0.0.1 --port <llm.port> -c <ctxSize> -ngl <gpuLayers> --jinja`，
  先试追加 `--no-webui`，失败再试不带（老版本没有该参数）；**最多等 120 秒**（`/health` 每 1.5 s 一次，2 s 超时），
  进程提前退出则把新写进 `logs/llama-server.log` 的最后 4 行作为错误线索并换参数重试；最终失败提示「CUDA 运行库缺失或显存不足 —— 可改装 CPU 版」。
- `stopServer()`：Windows `taskkill /T /F`，其它平台 `SIGKILL`；清空 `server.child/model`。
- `eraseSlot()`：依次 `POST /slots/0?action=erase`、`POST /slots?action=erase`（3 s 超时，端点不存在就跳过）。
- `systemPrompt()`：**逐字节读 `assets/templates/anima-system-prompt.txt` 原文**，读不到抛错。
- `buildContext(sessionId, userContent)`：取会话历史 + 本轮用户消息，取**最后 N 条**（`N = settings.llm.contextMessages`，0 表示不带历史，系统提示词不计入 N）。
- `chat(sessionId, userContent, res, opts)`：
  1. 运行时/模型缺失或服务未起 → 报错/自动 `startServer()`；
  2. 组装 OpenAI 兼容请求（见下表），`fresh = opts.fresh || 历史为空` 时 `cache_prompt:false`；
  3. 把上游 `text/event-stream` 逐行解析，`delta.content` 原样转发为 `data:{"delta":...}`（`reasoning_content` 只累积不转发）；
  4. 若**只有思维链没有正文**，把思维链交给用户并附 `note`「模型只输出了思考内容」；
  5. `normalizeAnswer()` 规范化输出，改写了就补发 `data:{"replace":...,"normalized":true}`；
  6. 截断/去冗分别补发 `note`；
  7. 落盘会话（最近 N 条），最后一帧 `{done:true, contextUsed, kept, answer, positive, negative, normalized, truncated, upstreamError?}`。

  采样参数（针对「短小、结构化」的提示词生成调过）：`temperature 0.6`、`top_p 0.9`、`top_k 40`、`min_p 0.05`、
  `max_tokens = settings.llm.maxTokens || 512`、`chat_template_kwargs:{enable_thinking:false}`、
  `repeat_penalty 1.1`、`repeat_last_n 256`、`dry_multiplier 0.8`、`dry_base 1.75`、`dry_allowed_length 2`、`dry_penalty_last_n 512`。
- `normalizeAnswer(raw)` —— 小模型输出规范化（**不是**往系统提示词里追加内容）：
  1. 若有多段代码围栏，**只取第一个**围栏内容；没有围栏则剥掉所有 ``` 标记；
  2. 用正则抓 `Positive prompt:` / `正向提示词：` 与 `Negative prompt:` / `负向提示词：` 两段；**抓不到就原样返回**（绝不伪造）；
  3. 每段先按 `变体 N` / `variant N` 截断，再**同行按逗号去重**（保序、大小写不敏感）；
  4. 正向段若在 20 字符之后出现典型负向起手词（`worst quality`/`low quality`/`jpeg artifacts`/`blurry`）就从那里截断；
  5. 条数上限 `MAX_TAGS = 120`、字符上限 `MAX_CHARS = 800`，超出则截断并让上层报一条**明确的 note**（说明省略了多少处）；
  6. 负向里剔除已在正向出现的 tag；
  7. 输出统一为单个代码围栏：`Positive prompt: …` 空行 `Negative prompt: …`；返回 `{text, positive, negative, normalized, trimmed}`。
- `newSession(sessionId)`：删服务端会话 + 异步擦除 slot 缓存。

**本轮新增/改动（`provider` 分支与角色补全挂钩）**：

- `catalog()`：读 `installer/llm-models.json`（必须是数组），与 `listModels()` 比对后给每条打上 `installed`；供推荐模型卡片一键下载 / 设为默认。
- `apiConfig(s = load())`：归一化外接配置 `{baseUrl（去尾斜杠）, apiKey, model, temperature（默认 0.6）, maxTokens（默认 1024）, timeoutMs（默认 120000）}`。
- `apiReady(s = load())`：`{ok, baseUrl, model, hasKey, missing[]}`；**`ok` 只要求 `baseUrl` 与 `model`**（本机端点常不需要 Key）。
- `testApi()`：先试 `GET <baseUrl>/models`（`AbortSignal.timeout(15000)`，`data[].id` 截到 200 条；**失败不抛**，有些服务没这个端点）→ 再 `POST <baseUrl>/chat/completions`（`messages:[{user:'ping'}]`、`max_tokens:8`、`stream:false`，超时取 `min(60000, timeoutMs)`）；非 2xx 抛 `接口返回 <status>：<正文前 300 字>（检查 baseUrl / 模型名 / API Key）`；成功返回 `{ok, ms, model, baseUrl, hasKey, models, sample}`。
- `pipeOpenAIStream(upstream, res, label)`：**两条路径共用的 SSE 转换器** —— 写 `text/event-stream` 头 → 按行解析 `data:` 帧（`[DONE]` 跳过）→ `delta.content` 转成本项目前端的 `{delta}`；`finish_reason === 'length'` 记 `truncated`；`reasoning_content` 只累积不转发；**只有思维链没有正文**时把思维链当正文回给用户并补一条 note；`res` 关闭时销毁上游。
- `chat()` 的 **`provider === 'api'` 分支**（不启本地进程、不需要运行时/模型）：`apiReady` 不通过就抛「外接 API 配置不完整，缺少：…」→ `POST <baseUrl>/chat/completions`（`{model, messages:[systemPrompt, ...messages], stream:true, temperature, max_tokens}`）→
  非 2xx 时按状态码给**中文提示**（`401/403` Key 无效、`404` baseUrl/模型名不对且提示多数服务要写到 `/v1`、`429` 限流）→ `pipeOpenAIStream` → `normalizeAnswer()` → `characters.repairAnswer()` → 落盘会话 → 结束帧带 `provider:'api'` 与 `charactersAdded`。
- **本地路径同样调用** `pipeOpenAIStream` 与 `normalizeAnswer`，并在规范化之后追加 `characters.repairAnswer(userContent, answer)`；补到角色时发一帧 `{replace: answer, charactersAdded: [...]}`，结束帧里 `provider:'local'`。**两条路径行为一致，便于对照。**
- `serverStatus()` 新增 `provider: s.llm.provider` 与 `api: apiReady(s)`（LLM 栏的「推理来源」徽标据此渲染）。

### 3.8 `server/store.js` —— `data/` 四类数据

- 画师：`readArtists()`（缺省 `{favs:[],blacklist:[],updatedAt:null}`，只保留字符串项）、`writeArtists()`（去重去空、写 `updatedAt`）、
  `toggleArtist(tag, action)`（**互斥：加入一个列表即从另一个列表移除**，返回 `result: added|removed`）、
  `importArtists(items)`（合并导入，返回 `imported` 计数）。
- LLM 清单：`readLlmModels()/writeLlmModels()/upsertLlmModel()`（首个模型自动成为默认）/`removeLlmModel()`（删默认时自动切换）。
- 会话：`getSession(id)`、`saveSession(id, messages, limit)`（只留 `user/assistant` 且 `content` 为字符串，取最后 `limit` 条；`limit<=0` 清空）、`dropSession(id)`。
- 向导状态：`readSetup()/writeSetup(patch)`（字段 `completed, mode, comfySource, comfyDir, modelsDir, models[], artists, licenses, llm, updatedAt`）。
- **原子写**：以上所有写入都走 `fsx.writeJsonAtomic`（临时文件 + rename，Windows 上 rename 失败则先删目标再 rename），产物**不带 BOM**。
- **「互斥」的两层含义**：① 收藏与黑名单互斥（`toggleArtist` 与面板的 `toggleFavExclusive/toggleBlacklistExclusive` 都实现同一语义，后执行的操作覆盖）；
  ② 并发写入层面**没有跨进程锁**——整个后端是单进程、所有 JSON 写入都是同步 `writeFileSync`+`renameSync`，
  靠 Node 单线程天然串行；如果你以后把某段写入改成异步，请自行加锁，否则可能出现「读到一半的旧值」。

### 3.9 `server/util/*.js`

**`fsx.js`** —— `writeJsonAtomic`（缩进 2 + 结尾换行 + 无 BOM）、`writeTextAtomic`、`readJson`（剥 BOM，失败回落 fallback）、
`ensureDir`、`exists/isFile/isDir/sizeOf`、`sha256File(file, onProgress)`（4 MiB 分块流式）、
`safeJoin(root, rel)`（解析后必须落在 root 内，否则抛 `path escapes root`）、`fmtBytes`、
`copyTree(src, dest, {link, filter, onFile})`（`link=true` 时**先试 `fs.linkSync`（硬链接），失败自动回落 `copyFileSync`**；返回 `{files, linked}`）。

**`zip.js`** —— 纯 JS ZIP 解压：`findEocd`（从尾部 65557 字节内向前找 `0x06054b50`）、`zipCentralDirectory`（读中央目录）、
`unzipTo(zipPath, destDir, onFile)`（只支持 method 0 store 与 method 8 deflate，**带目录穿越防护**，返回 `{files, bytes}`）；
7-Zip 部分：`find7z(binDirs)`（先候选目录里的 `7za.exe/7zr.exe/7z.exe/7za/7z`，再系统 Program Files 两个 7-Zip 目录与 `%LOCALAPPDATA%\Programs\7-Zip`，最后 `where`/`which` 兜底）、
`extractWith7z(exe, archive, destDir, {onLine})`（`x <archive> -y -o<dest> -bso0 -bsp0 -bb1`，非 0 退出即抛错并附最后 3 行输出）、
`hoistSingleRoot(destDir, onLine)`（解压后只有单一顶层目录时把其内容上提一层，GitHub 归档的常见形态）。

**`log.js`** —— 写 `logs/server.log`（`[ISO 时间] [LEVEL] 消息`），单文件超过 `MAX_BYTES = 5 MiB` 时滚动为 `server.1.log`；
内存环形缓冲 `RING_MAX = 500` 行供 `GET /app/logs` 读取；`DCP_QUIET=1` 时不打控制台（仍写文件）；磁盘异常吞掉不拖垮服务。

### 3.10 可调项来自设置还是常量

| 可调项 | 来源 | 键/常量 | 说明 |
|---|---|---|---|
| 后端监听端口 | 设置 | `listen.port`（默认 8788） | 也可用环境变量 `DCP_PORT` 覆盖；**被占用时最多自增 2 次（v1.2.2），超限快速失败退出**，实际端口**只存内存、不回写设置**（见 `/app/state` 顶层 `port`） |
| 后端监听主机 | 设置 | 由 `listen.lan` 推导 | 也可用 `DCP_HOST` 覆盖 |
| 局域网开关/令牌 | 设置 | `listen.lan`、`listen.token`（令牌自动生成） | 令牌不在默认值里，开启 LAN 时生成 |
| ComfyUI 模式/目录/端口 | 设置 | `comfy.mode`、`comfy.dir`、`comfy.port`（8188） | — |
| ComfyUI 额外启动参数 | 设置（**仅 JSON**） | `comfy.extraArgs` | 设置页未暴露输入框，需手改 `data/settings.json` |
| ComfyUI 随面板自动启动 | 设置 | `comfy.autoStart`（默认 false） | 有开关；`main()` 就绪后按该值调用 `comfy.launch()`（未配置目录时只记一条 warn） |
| 下载超时/慢速阈值/窗口 | 设置 | `download.officialTimeoutMs`、`slowThresholdKBs`、`slowWindowMs` | 设置页有输入框 |
| **下载停滞阈值** | 设置 | `download.stallKBs`（默认 **30** KB/s） | **只对最后一个候选生效**（只要还在动就下完）；见决策 ⑯ |
| HF 镜像 / ModelScope / GitHub 代理 / pip 源 | 设置 | `download.hfMirror`、`modelscope`、`useModelScope`、`githubProxies`、`pipIndex` | 设置页可改；代理是「逐行一个、按顺序尝试」的数组 |
| LLM 上下文条数 | 设置 | `llm.contextMessages`（0–20，默认 5） | 即时生效（每次对话都重读设置） |
| **LLM 推理来源** | 设置 | `llm.provider`（`local` / `api`） | `api` 时不启 llama-server，直接打外接接口；见决策 ⑮ |
| **外接 API 配置** | 设置 | `llm.api.baseUrl` / `apiKey` / `model` / `temperature` / `maxTokens` / `timeoutMs` | 设置页有输入框与「测试连接」；**`apiKey` 只写 `data/settings.json`，不进日志** |
| LLM 端口 / 上下文长度 / GPU 层数 | 设置 | `llm.port`（8199）、`llm.ctxSize`（8192）、`llm.gpuLayers`（99） | `gpuLayers` 设置页未暴露；三者改动需**重启 llama-server** 才生效 |
| LLM 每次回答上限 | 设置页 + `llm.maxTokens` | 默认 512（`DEFAULTS` 内，范围 64–8192） | 设置页「本地 LLM」分组可直接改 | 即时 |
| SSE 心跳间隔 | 常量 | `jobs.js` 15000 ms | — |
| 任务内存上限 | 常量 | `MAX_EVENTS 800`、`MAX_JOBS 40` | — |
| ComfyUI 就绪等待 | 常量 | 90 s（轮询 2 s） | `comfy.js` |
| ComfyUI 停止确认 | 常量 | 15 s（轮询 1 s） | `comfy.js` |
| llama-server 就绪等待 | 常量 | 120 s（轮询 1.5 s，健康检查 2 s） | `llm.js` |
| 下载无数据看门狗 | 常量（由设置推算） | `clamp(slowWindowMs, 20000, 60000)` | 连上后一个字节都没动就换源；`download.js` |
| 下载请求头 | 常量 | `User-Agent` + `Range: bytes=<n>-` | 缺 UA 时 ModelScope CDN 会连上不吐数据；带 Range 顺带支持续传 |
| 角色词表来源 | 常量 | `characters.js` 的 `SOURCES`（GitHub raw → jsDelivr → hf-mirror） | 逐个尝试，解析出的条目 < 500 视为失败换源 |
| 角色英文名最小 post 计数 | 常量 | 20 | 低于它不当作角色命中（避免把普通单词当角色） |
| llama.cpp 版本来源 | 常量 | `RELEASE_API`（`?per_page=10`） | — |
| ComfyUI / Anima 节点 commit | 常量 | `COMFYUI_COMMIT`、`ANIMA_NODE_COMMIT` | 升级需同步文档 |
| 便携 Node 版本 | 常量 | `bootstrap.ps1 -Version` 默认 `v22.14.0` | 可命令行覆盖 |
| 日志单文件上限 | 常量 | 5 MiB；内存环 500 行 | `log.js` |
| 后端就绪等待（启动器） | 常量 | 60 s，探测端口 `base..base+20` | `scripts/start.ps1` |
| 托盘看护间隔 | 常量 | 3000 ms | `scripts/tray.ps1`（后端没了就自动退出） |

### 3.11 `server/characters.js` —— 角色词表 + 中文别名 + 输出补全

**为什么存在**（模块头注释与决策 ⑭）：8 GB 显存下**没有**能可靠地把角色名翻成 Danbooru 规范 tag 的文生文模型，所以把"确定性的那一半"做进程序：把用户话里的角色名（含中文别名）解析成规范 tag，再校验/补全模型输出。

| 成员 | 行为 |
|---|---|
| `CHAR_DIR` / `CSV_FILE` / `META_FILE` | `data/characters/`、`danbooru.csv`、`index.json`（元数据：条数/来源/时间/字节数） |
| `SOURCES` | 3 个来源：`raw.githubusercontent.com`（tagcomplete 的 `danbooru.csv`，MIT）→ `cdn.jsdelivr.net` 同源 → `hf-mirror.com` 上的同源镜像 |
| `parseCsv(text)` | 按 `tag,category,post_count(,aliases)` 切分；**只保留 `category=4`（角色）**；镜像没有 category 列时全收 |
| `normalizeKey(s)` | 归一化：小写、`_`→空格、全角括号→半角、压缩空白。`rem_(re:zero)` → `rem (re:zero)`，所以 `rem` 能命中 |
| `install(job)` | 逐个来源 `dl.download(..., force:true)` → 解析 → 条目 < 500 视为失败换源 → `buildIndex()` 并写 `index.json` |
| `ensureLoaded()` | **懒加载**：首次用到才读 CSV 并建 `byName` / `byAlias` 索引；读失败只记 warn 并返回 `null`（不影响其它功能） |
| `lookup(name)` | 精确（归一化）匹配 → 别名 → **"去掉括号后缀"的包含匹配**；多条命中时取 **post 计数最高** 的一条（避免把 `rem` 判成冷门同名角色） |
| `search(q, limit=30)` | 模糊搜索（给 UI 搜索框用），tag 或别名包含关键词即可 |
| `BUILTIN_ALIASES` | **563 条**内置中文别名（`蕾姆 → rem_(re:zero)`、`初音未来 → hatsune_miku`、`甘雨 → ganyu_(genshin_impact)` …）；583 条候选经词表逐条解析后删掉 20 条（词表里不存在 / 本身是常用中文词），**563 条 100% 精确命中** |
| 内置别名自检 | `buildIndex()` 建完索引后逐条用 `byName`/`byAlias` 校验 `BUILTIN_ALIASES`：未命中的记进 `cache.aliasMisses`（当前 **0 条**）并 `log.warn` 一行 —— 词表升级改名后能立刻发现，不静默 |
| `readUserAliases()` / `saveUserAliases(map)` | 读写 `data/character-aliases.json`（必须是对象，数组视为空）；`allAliases()` = 内置 + 用户（用户覆盖同名） |
| `resolveFromText(text)` | ① 别名命中（**长别名优先**，避免 `初音` 抢先命中 `初音未来`）→ ② 英文名（1–3 词组合，要求 `count >= 20`）；按出现顺序去重 |
| `repairAnswer(userText, answer)` | 模型输出缺角色 tag 时**补进正向段**（`Positive prompt:` 那一行的末尾，逗号分隔单行；没有该标签就追加到末尾），返回 `{answer, added, resolved}` |
| `status()` | 给 UI 用：`{installed, loading, characters, source, bytes, updatedAt, dir, aliasFile, userAliases, builtinAliases, aliasMisses, aliasMissSamples}` |

**补全的去重规则**（`repairAnswer`）：回复里已出现该角色就算"已有" —— 归一化后整体包含，**或**裸名（去掉 `(...)` 后缀、长度 > 3）作为独立 tag 出现（`(^|[,_\s])bare([,_\s]|$)`）。**只补不删**，补了什么一定通过 `charactersAdded` 回给前端。

### 3.12 `scripts/start.ps1` / `scripts/tray.ps1` —— 启动器与托盘

> 说明：这一小节讲的是 PowerShell 启动脚本（不是 `server/*.js`），放在本节是为了与"后端进程生命周期"对照阅读。

**`start.ps1` 的就绪后动作（新增）**：

1. `Start-Process <node> -ArgumentList "`"<server/index.js>`"" -WorkingDirectory <root> -NoNewWindow -Redirect*` —— **路径一律加引号**（决策 ⑲）；
2. 等 `/app/state` 就绪（`base..base+20`，最多 60 s）；
3. `if (-not $NoBrowser) { Start-Process $url }`；
4. `if (-not $NoTray -and -not $Foreground)`：`Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','"<tray.ps1>"','-Url','"<url>"','-BackendPid',<pid>,'-Port',<port>,'-Root','"<root>"') -WindowStyle Hidden`；
5. 托盘起来后 `Add-Type` 声明 `user32!ShowWindow` + `kernel32!GetConsoleWindow`，`ShowWindow(hwnd, 6)`（**6 = SW_MINIMIZE**）；失败只警告；
6. `while (-not $proc.HasExited) { Start-Sleep -Seconds 1 }`，退出时把 `$proc.ExitCode` 作为自己的退出码。

**新增参数**：`-NoTray`（不装托盘、也不最小化控制台）。`-Foreground` 下同样不装托盘（日志直接打在当前控制台）。

**`tray.ps1` 的机制**：

| 部分 | 实现 |
|---|---|
| 进程模型 | 由启动器另起的**独立 powershell 进程**（`-WindowStyle Hidden`）。理由：WinForms 的 `NotifyIcon` 需要**消息循环**，放在启动器里会挡住启动流程（决策 ⑰） |
| 图标 | `[System.Drawing.SystemIcons]::Application` —— **取系统图标，不落资源文件、不写注册表、不引入第三方依赖** |
| 菜单 | 打开 Web UI（双击图标同效）、复制访问地址（`[Windows.Forms.Clipboard]::SetText`）、打开日志文件夹（`explorer <root>\logs`）、关闭控制台并停止后端（**v1.2.2 先礼后兵**：先 `POST /app/quit` 并最多等 8 秒，失败才 `taskkill /PID <pid> /T /F`；拿不到 pid 就按端口 `Get-NetTCPConnection -State Listen` 找监听进程；两条路径最后都按 `data/run` 归属记录再清一次本程序拉起的 ComfyUI） |
| 看护 | `Forms.Timer` 每 3000 ms 检查后端（按 pid，退化到按端口）；后端没了 → 销毁图标并 `Application::Exit()`，**不留幽灵图标** |
| 日志 | `logs/tray.log`（就绪参数、退出原因、WinForms 加载失败原因）；写日志失败被静默吞掉 |
| 降级 | 拿不到 WinForms → 记日志并 `exit 2`；启动器侧 `try/catch` 兜底，托盘起不来就**保持控制台可见**并提示可用 `Ctrl+C` 退出 |
| `-StopOnly` | 只执行"停止后端"一个动作后退出（不建托盘），供脚本/自检调用 |

**可迁移性**：脚本全部从 `$PSScriptRoot` / `$MyInvocation.MyCommand.Path` 推导路径，**不记任何绝对路径**；换机器、换盘符、改目录名后托盘与控制台最小化同样有效。

---

## 4. 前端

### 4.1 `web/index.html` —— 装载顺序（不可换）

```
react.production.min.js → react-dom.production.min.js → panel-host.js → panel.js → app-shell.js(type=module)
```

原因：`panel-host.js` 的 `require('react')` 要能取到 `window.React`；`panel.js` 在加载时**立即**调用
`window.__ModuleLoader__.load({...})`；`app-shell.js` 依赖 `window.__DCP_PANEL__` 已经就位。
样式有**三个**（顺序也是固定的，`workbench.css` 依赖 `shell.css` 的 CSS 变量）：`/static/styles/shell.css` → `/static/styles/workbench.css` → `/static/pages/pages.css`。

### 4.2 `web/panel-host.js` —— 最小宿主适配层

面板半（`panel.js`）保留了插件版的插件式客户端模块包装：

```js
window.__ModuleLoader__.load({ id: "dsh-comfy-panel", factory: (require) => { ... } })
```

`panel-host.js` 只补三件事：

1. `window.__ModuleLoader__.load(mod)`：建 `module.exports`，注入 `requireFn`（只认 `'react'` → `window.React`，其它 id 抛错），
   执行 `factory`；若导出对象上有 `apply` 就调用 `apply(makeCtx())`；
2. `ctx` 替身：`effect(fn)`（收集返回值作为 disposer）、`slots.inject(name, cb)`（**直接执行 cb**，独立版没有 ui-layout 服务要等）、
   `slots.register(meta, component)`（记住 meta 与组件，返回 `{dispose}`）、`get()`→`undefined`、`logger`→`console`；
3. 把结果挂到 `window.__DCP_PANEL__ = { id, meta, Fab, Panel, CSS, BUILD_TAG, test, dispose }`，
   并派发 `dcp-panel-ready` 事件。

面板的 `exports.__test` 是冒烟测试入口（纯函数 + 三个图构建器 + Panel/Fab + CSS + `BUILD_TAG`）；
`Panel` 优先取 `exports.__test.Panel`，否则用 `slots.register` 捕获到的组件。外壳只用 `Panel`（`Fab` 不再使用，因为页面是标签页而非悬浮层）。

### 4.3 `web/app-shell.js` —— 外壳

- **3 个标签**：`workbench`（工作台，默认）/`settings`/`wizard`；页面模块用动态 `import()` 懒加载并缓存到 `pageCache`。
  （第一轮是 5 个标签 `generate`/`llm`/`artists`/`settings`/`wizard`；生图、LLM、画师三个页面被合并进 `pages/workbench.js` 的三栏里，所以导航只剩三项。）
- 首屏顺序：`/app/state` → `/app/settings` → `loadLang(settings.lang)` → `/app/artists/lists`（写入 `window.__DCP_ARTISTS__`）→
  尝试一次性导入浏览器旧收藏（`localStorage['dcp-artist-favs']` → `POST /app/artists/import`）→ 安装 `window.__DCP_SAVE_ARTISTS__`（内部 `PUT /app/artists/favs` + `/app/artists/blacklist`，成功后派发 `dcp-artists-changed`）。
- `api(path, opts)`：`fetch` → 非 2xx 抛 `Error(响应体 error|message || 'HTTP <status>')`。
- 顶栏：ComfyUI 在线徽标（`:` + 端口）、LLM 运行时就绪徽标、当前 LLM 模型、显示/隐藏日志抽屉、重新自检、语言切换（中文/EN）。
- 侧栏品牌行：`🎨 超低门槛 ComfyUI 工作流集成应用` + `buildTag · 内嵌模式|外接模式`。
- 状态轮询：`setInterval(refresh, 5000)`（`/app/state`）。
- 自检 error 会渲染成红条并给「去设置」按钮；`setup.completed` 为假时显示向导横幅。
- **页面桥** `window.__DCP_BRIDGE__`：
  `fillPrompts({positive, negative})`（**优先调用面板自己暴露的 `window.__DCP_PANEL_API__.setPrompts()`，真正走 React setState**；面板未挂载时才退回 DOM 赋值。原实现的 DOM 赋值会被 React 的 value tracker 吞掉、只改显示不改 state，提交时用的仍是旧值 —— 这是实测（真实键盘事件 vs DOM 赋值对比）才发现的）。另提供 `readPrompts()` 供验收与排障。原始实现片段：查 `.panel-slot textarea` 走 `setNativeValue`，再 `go('generate')`）、
  `generate()`（找文案匹配 `/生成\s*\d*\s*张/` 且未禁用的按钮并 `click()`）、`go(tab)`。
- i18n 装载：`tab === 'workbench'` 且面板挂载后 `installTranslator(slot)`（并在 300 ms 后补装一次，覆盖面板延迟渲染）。
- 钩子顺序注意：加载页面模块的 `useEffect` **必须在任何提前 `return` 之前**（否则条件分支会改变 hook 数量 → React #310）。

### 4.4 `web/pages/*.js` —— 页面

统一签名（契约 §2）：`export default function XxxPage({ api, t, state, refresh, toast, ... })`。

| 页面 | 关键内容 |
|---|---|
| `workbench.js` | **三合一工作台**（见 §4.8）：顶部布局切换 + 三栏 `.wb-gen` / `.wb-llm` / `.wb-art`；生图栏直接渲染 `window.__DCP_PANEL__.Panel`，LLM 栏渲染 `LlmPage`、画师栏渲染 `ArtistsPage`（都带 `embedded: true` 标记） |
| `settings.js` | 语言；ComfyUI（模式 / 外接目录 + 「检测」 / 端口 / 自动启动）；监听（端口 / LAN 开关 / 提示 / 显示令牌）；下载源（HF 镜像、**ModelScope 基地址 + `useModelScope` 开关**、GitHub 代理多行文本、官方源超时、慢速阈值、慢速窗口、**停滞阈值 `stallKBs`**、**「一键填入国内优选源」**、「测试镜像」按钮打 `/app/download/probe`、pip 源只读显示）；本地 LLM（**推理来源下拉 + 外接 API 五字段 + 「测试连接」**、上下文条数 / 默认模型 / 端口 / 上下文长度 / 单次回答上限 / 系统提示词文件只读显示）；**「窗口」卡片只显示一条说明**（见 §12 决策 ④/⑰）；底部自检结果列表 |
| `wizard.js` | 步骤 1 运行模式（内嵌 / 外接 + 外接目录 + 检测）；内嵌时步骤 2 来源（便携版 / 压缩包 / 已有目录 / Git / 跳过 + 路径输入 + 复制方式 硬链接/复制 + 「本地已有 ComfyUI 目录」可选复用）；步骤 3 模型（minimal/standard/full 档位按钮 + 逐项勾选 + 合计 GB）；步骤 4 画师；步骤 5 本地 LLM（说明可跳过）；底部「开始安装」+ ComfyUI 启动/停止；`<JobProgress>` 实时日志 |
| `llm.js` | 左栏：对话（SSE 流式、中止、新建会话）、系统提示词查看、**「提示词工具」卡片**（正/负向只读预览 + 📋 复制 / ⬅ 填入 + 填正负 + 复制正+负 + 复制整段回复）；右栏：**推理来源徽标**、**推荐模型（一键下载 / 设为默认）**、**角色词表卡片（下载/更新、搜角色、加中文别名）**、运行时安装（自动/CUDA/CPU）、服务启停、模型管理（列表 + 设为默认 + 移除确认弹窗 + 本地路径添加 link/copy + URL 下载）、abliterated 检索（结果分仓库列文件、逐个下载）。`parseFence()` 取**最后一个有内容**的、同时含正/负向标签的围栏（未闭合围栏只在反引号数为奇数且尾巴有内容时才算候选；见决策 ⑱） |
| `artists.js` | 收藏胶囊列表、黑名单胶囊列表（带「收藏与黑名单互斥」说明）、检索（全部 / 高频 / 收藏 三个源 + 关键词）、「从浏览器旧数据导入」按钮 |

### 4.5 `web/job-view.js` —— 长任务视图

- `runJob(jobId, handlers)`：`new EventSource('/app/jobs/<id>/events')`；`phase === 'done'` 时按 `ok` 调 `onDone/onFail`；
  `onerror` 时关闭 SSE 并 **`fetch('/app/jobs/<id>')` 轮询兜底一次**（区分 done/failed/running）。
- `JobProgress`：进度条 + 最后 300 行日志 + 错误条。
- `openJobModal(jobId, title, onDone, onFail)`：独立 React root 挂到 `document.body`，完成后 1.2 s 自动关闭。

### 4.6 `web/panel.js` 相对插件版的改动锚点

面板半 = 插件版 `lib/client.js` 的**适配副本**（保留插件式模块包装、保留全部业务逻辑与图构建器）。
除下面这些锚点外，其余代码与上游保持逐行可比对；**这是维护本文件的核心约束**（决策 ②）。

| # | 锚点（搜索用） | 插件版 | 独立版改法 |
|---|---|---|---|
| 1 | `const BUILD_TAG` | 随插件版本号走 | 固定 `"v1.1.0"`，注释说明「独立版静态托管、无 `?rev=` 快照机制，改代码刷新即生效」 |
| 2 | 头部标题（`dcp-head` 内 `h("span", { title: "面板构建 " + BUILD_TAG ... })`） | `🎨 ComfyUI 生图 <版本>` | `🎨 超低门槛 ComfyUI 工作流集成应用 v1.1.0`，`title` 说明静态托管与刷新即生效 |
| 3 | `artistStore()/loadFavorites()/loadBlacklist()/persistArtists()/saveFavorites()/saveBlacklist()` | 收藏读写 `localStorage['dcp-artist-favs']` | 改为读写 `window.__DCP_ARTISTS__`，持久化交给外壳的 `window.__DCP_SAVE_ARTISTS__`（服务端 `data/artists.json`）；`FAV_STORAGE_KEY` 常量保留但只作历史兼容说明 |
| 4 | 新增互斥工具 `toggleFavExclusive/toggleBlacklistExclusive/withoutBlacklisted/normalizeCustomArtist` | 无 | 收藏与黑名单互斥（后执行覆盖）；三档随机剔除黑名单；自定义画师名字规范化（去 `@`/下划线转空格/只留 Danbooru tag 字符） |
| 5 | 图上三按钮（`curArtist` 段：`dcp-secrow`） | 无 | `⭐ 收藏/取消收藏`、`🎯 选为画师`（切到 `fixed` 并固定）、`🚫 拉黑/取消拉黑`；画师 tag 来自生成元数据或**落盘文件名**（`/<画师>_<序号>_00001_.png`） |
| 6 | 指定画师分区（`artistMode === "fixed"`） | 只能从清单列表点选（「用户只能从列表选择」红线） | **两种来源**：清单/收藏里点选（可切「全部清单 / 仅收藏」）+ **自定义画师自由输入**（不校验清单、无二次确认，有意放宽原红线） |
| 7 | 清单不可用文案 | `画师清单不可用：host 半未更新，重启 宿主应用 后可用` | 两处改为 `画师清单不可用：assets/artists/ 下缺少清单 txt（本次生成不注入画师）` 与 `…（自定义画师仍可直接输入使用）` |
| 8 | `api()` 的 401/403 提示 | `请用启动日志里最新的带 token 地址重开页面`（宿主签名 cookie） | 改为「局域网模式需要令牌，请用带 `?token=` 的地址打开页面」 |
| 9 | `exports.__test` 追加项 | — | 追加 `loadBlacklist, saveBlacklist, toggleFavExclusive, toggleBlacklistExclusive, withoutBlacklisted, normalizeCustomArtist, artistStore`；`BUILD_TAG` 已在列 |
| 10 | `apply(ctx)` 与 `exports.inject = ["slots"]` | 由插件宿主 fiber 提供槽位 | 原样保留（`panel-host.js` 提供替身），仍注册到 `shell.overlay`，只是组件被外壳当作页面渲染 |

**已知遗留（不影响功能，勿当成 bug）**：第 8 点只改了面板两处 `catch` 文案，而 `web/i18n/{zh,en}.json` 的 `panel`
词典里长期残留 6 条宿主时代的诊断文案（面板源码里已不存在这些原文，属纯历史残留）。**v1.2.0 已把这 6 条从两份词典删除**
（键集仍保持 zh/en 一致，由 `scripts/check.js` 的第 [3] 项强制）。若以后再遇到同类残留，处理口径是：
**先确认面板源码里已无该原文，再同时从 `zh.json` 与 `en.json` 的 `panel` 段删除**（词典用中文原文做键）。

### 4.7 为什么 i18n 用「DOM 层词典 + 正则规则」而不是改写面板源码

契约 §6 定义了词典结构：`ui`（外壳与新页面用键）、`panel`（面板中文原文 → 译文，精确匹配）、
`panelRules`（`{pattern, replace}`，用于带插值的动态消息）。实现落在 `web/i18n.js`：

- `translate(text, params)`：先查 `panel` 精确词典；未命中且文本含 CJK 时才逐条试 `panelRules`（`new RegExp(pattern)` + `String.replace`）；
  坏规则只被忽略，不影响渲染；最后再做 `{name}` 占位替换。
- `installTranslator(root)`：先 `walk(root)` 翻一遍，再挂一个全局 `MutationObserver`
  （`childList/subtree/characterData/attributes`，`attributeFilter = ['title','placeholder','aria-label']`）兜住后续渲染；
  `SCRIPT/STYLE/NOSCRIPT/TEXTAREA/CODE/PRE` 子树跳过；文本节点只翻「trim 后整体命中」的情况，并保留前后空白与相邻文本。
- **原文记忆与自激防护**（实现细节，改这段代码前必读）：
  ① 翻过的文本节点把原文存进 `node.__dcpOrig`，属性把原文存进 `el.__dcpOrig_<attr>`（属性只在原值含 CJK 时才记录）；
  ② 只在值**真的变化**时才写 DOM，否则「把属性写回同一个值」也会再触发一次回调，与 MutationObserver 自激成死循环、卡死主线程；
  ③ 写 DOM 期间置全局 `applying = true`，观察器回调开头 `if (applying) return;`。
- 语言切换：外壳整体重渲染（`renderKey` 自增）+ `retranslateAll()`；后者先 `restore(root)` 把 `__dcpOrig*` 里的原文写回，
  再 `walk(root)` 用新词典重翻。因此即使某些面板节点没有随 React 重渲染被替换，也不会残留上一种语言的文本。

**代价与取舍**（决策 ③）：

- 保持与上游 `lib/client.js` 的**可逐行比对**（这是长期维护的硬要求）；如果把面板里 317 条中文文案改成 `t("...")`，diff 会失控。
- 代价是**动态文案必须靠 `panelRules` 覆盖**：当前 4 条规则全部是「一键替换提示词」那类带字数的消息
  （例如 `^已替换正向（(.*?) 字）与负向（(.*?) 字）$`）。文案一旦变化（改字、改标点）就要同步改规则。
- `zh.json` 的 `panel` 段把中文映射到自身，便于**覆盖率校验**。

### 4.8 三栏工作台与 i18n 现状

**`web/pages/workbench.js`（本轮新增）**：

- 结构：`div.wb.wb-layout-<layout>` → `div.wb-bar`（布局切换）+ `div.wb-grid`（三栏）。
- `layout ∈ {'3','2','gen'}`，初值 `localStorage.getItem('dcp-workbench-layout') || '3'`，每次变更写回；`localStorage` 不可用时（隐私模式）`try/catch` 静默忽略，**不写进 `data/settings.json`**（纯界面偏好）。
- `collapsed` 是页面内 state（`{gen, llm, art}`），标题条 `▾/▸` 按钮切换；折叠后只渲染标题条，不渲染 `.wb-body`。
- 三栏内容：生图栏渲染 `window.__DCP_PANEL__.Panel`（缺失时显示「生图面板未加载」错误条）；LLM 栏渲染 `LlmPage`、画师栏渲染 `ArtistsPage`，都带 `embedded: true`（当前仅作标记，布局由 CSS 负责）。
- 传给子页面的是外壳同一套 props（`api/state/refresh/toast/t/post/put/fmtBytes/openJobModal`），因此提示词「填入」不需要跨页跳转。

**`web/styles/workbench.css`（本轮新增）**：

| 关键点 | 实现 |
|---|---|
| 栅格比例 | `.wb-layout-3 .wb-grid { grid-template-columns: minmax(360px,1.08fr) minmax(320px,.95fr) minmax(250px,.72fr) }`（生图最宽、画师最窄）；`.wb-layout-2` 两栏；`.wb-layout-gen` 单列 |
| 每栏独立滚动 | `.wb-col` 是 `flex column` + `overflow:hidden`；LLM / 画师栏 `.wb-body { overflow-y:auto }`，生图栏交给面板自身的 `.dcp-body` 滚动 |
| 折叠 | `.wb-col.folded { flex:none }`（只留标题条） |
| 断点降级 | `@media (max-width:1560px)`：三栏布局**收起画师栏**、栅格变两列；`@media (max-width:1180px)`：三栏/两栏栅格都变单列，**两栏布局收起 LLM 栏** |
| 面板从"抽屉"变"栏内全宽" | `.wb-gen .dcp-panel { position:relative; inset:auto; width:100%; max-width:none; height:100% }` —— 只改布局，不动面板代码（保住决策 ②） |
| 窄列适配 | `.wb-llm .llm-layout { flex-direction:column }`、`.wb-art .artist-cols { grid-template-columns:minmax(0,1fr) }`、收窄 `.chat-log` / `.chip-wrap` / `.list-scroll` 的最大高度 |
| 滚动条 | 三处滚动容器统一 8px 细滚动条 |

**i18n 现状（本轮）**：`ui` **333 键**、`panel` **317 键**、`panelRules` **4 条**，中英键数**一一对应**（`node -e` 直接比对即可验证；`scripts/check.js` 会断言键集一致且英文无汉字残留）。
本轮新增的 `ui` 键集中在：`wb.*`（布局/折叠/各栏提示）、`llm.catalog.*`（推荐模型）、`llm.characters.*`（角色词表/别名/补全提示）、`llm.provider.*`（推理来源徽标）、`llm.copy` / `llm.copyBoth` / `llm.copyReply`（复制按钮）、`settings.llm.api*`（外接 API 五字段 + 测试连接）、`settings.download.modelscope` / `useModelScope` / `stall` / `presetCn`（新下载设置）。
`panelPhrases` 是**英文侧的短语替换表**（`en.json` **57 条**，用于短语级替换；`zh.json` 侧是**空数组** —— 中文就是原文语言，不需要替换）。**工作台本身不新增面板文案**，所以 `panel` 词典的键数增长来自页面侧文案（`ui` 段），面板 DOM 翻译层（§4.7）逻辑未变。

---

## 5. 数据与状态

### 5.1 `data/` 下每个 JSON 的字段与语义

| 文件 | 结构 | 字段语义 | 写入方 |
|---|---|---|---|
| `data/settings.json` | 见 §7 | 全局设置。**唯一可能含用户外部绝对路径的文件**（`comfy.dir`），所以绝不入库 | `config.save()` |
| `data/artists.json` | `{favs:[tag], blacklist:[tag], updatedAt}` | 收藏 / 黑名单（互斥）；tag 为原始形态（含 `@` 与 `\(` `\)` 转义） | `store.writeArtists/toggleArtist/importArtists` |
| `data/llm/models.json` | `{items:{ "<文件名>": {file, origin, source, addedAt} }, default}` | LLM 模型清单与默认项；`origin ∈ preset|added|downloaded` | `store.upsertLlmModel/removeLlmModel`、`llm.addModel/downloadModel/setDefaultModel` |
| `data/llm/sessions.json` | `{sessions:{ "<sessionId>": {messages:[{role,content}], updatedAt} }}` | 每个会话只保留最近 N 条（N = `llm.contextMessages`，0 表示不留） | `store.saveSession/dropSession` |
| `data/setup.json` | `{completed, mode, comfySource, comfyDir, modelsDir, models[], artists, licenses, llm, updatedAt}` | 向导完成状态与结果快照 | `store.writeSetup`（仅 `runSetup` 末尾） |
| `data/characters/danbooru.csv` | CSV：`tag,category,post_count(,aliases)` | **角色词表数据**（MIT）。实测：**3,518,020 B**、**140,782 行**，其中 `category=4` 的角色 tag **40,931** 条；只读不写，可删（删了首次用角色功能时再点「下载/更新词表」） | `characters.install()`（经 F3 下载，`force:true`） |
| `data/characters/index.json` | `{characters, source, updatedAt, bytes}` | 词表元数据（条数 / 来源 URL / 时间 / 字节数）；给 UI 显示状态用 | `characters.buildIndex()` |
| `data/character-aliases.json` | `{"<中文/日文名>": "<Danbooru tag 名>"}` | **用户自建的中文/日文角色别名**（非对象/数组视为空）；与内置 563 条合并时**用户项覆盖内建同名项** | `characters.saveUserAliases()`（`POST /app/characters/aliases`） |

> 说明：`data/llm/sessions.json` 与 `data/setup.json` 只在**首次需要时**创建（`fsx.writeJsonAtomic` 会自动建目录）；
> 一个全新解压的项目里 `data/` 可能只有 `settings.json`（甚至为空）。

### 5.2 原子写策略

`fsx.writeJsonAtomic(file, value)`：

1. `ensureDir(dirname)`；
2. 写临时文件 `file + '.tmp-' + process.pid + '-' + Date.now()`（`JSON.stringify(value, null, 2) + '\n'`，UTF-8 **无 BOM**）；
3. `renameSync(tmp, file)`；Windows 上目标存在时 rename 可能失败 → `rmSync(file)` 后重试 rename。

因此任何时刻读者看到的要么是完整旧文件、要么是完整新文件（同卷 rename 原子）。所有 JSON 都不带 BOM，
是为了让 `JSON.parse` 与 PowerShell 的 `ConvertFrom-Json` 都能直接吃（`fsx.readJson` 仍会防御性剥掉 BOM）。

### 5.3 为什么运行期配置单独放 `data/`

1. **可能含用户外部路径**：`comfy.dir` 是用户自己机器的绝对路径。把它写进仓库文件（例如 `package.json`）会同时污染
   「零机器路径」的交付红线与 `.gitignore` 的「runtime/models/data/logs 不入库」原则。
2. **可迁移性**：`data/` 随项目文件夹整体拷贝即可带走设置与收藏；而 `runtime/`、`models/` 允许在新机器上重新获取
   （见 `MIGRATION.md` 的两种迁移方式）。
3. **写权限与生命周期不同**：`data/` 是「每次运行都可能改」的小文件；源码目录期望是只读的。
4. **前端不再依赖浏览器存储**：独立版把收藏/黑名单改为服务端 JSON（决策 ⑤），因此换浏览器、清缓存、换机器都不会丢；
   浏览器 `localStorage` 只保留为**一次性导入源**。

---

## 6. 安装与首次运行

### 6.1 向导每一步做了什么

对应 `comfy-install.js::runSetup()`，每一步都会 `job.phase(...)` 并播报进度（前端用 SSE 显示）：

| 顺序 | phase | 行为 | 失败处理 |
|---|---|---|---|
| 1 | `runtime` | `ensure7z()` 拿到可用的 7-Zip（见 §6.5） | 抛错终止（后续解压不可能成功） |
| 2 | `comfyui` | 外接模式：`detectLayout(externalDir)` 校验后 `save({comfy:{mode:'external',dir}})`；<br>内嵌模式：`installComfyUI()` 按来源获取本体 | 抛错终止 |
| 3 | `nodes` | 内嵌模式才做：克隆/下载 `comfyui-anima-3-8B` 并 checkout 固定 commit，再用 ComfyUI 自己的解释器装其依赖 | **只记 error 不终止**（Anima 3.8B v2 管线不可用，其它管线不受影响） |
| 4 | `models` | `installModels()`：本地复用（`modelsFrom.dir`）→ 硬链接/复制 → 否则 F3 下载 + 大小/sha256 校验 | 单个模型失败会记 error 并继续下一个（`urls` 为空则记 error 跳过） |
| 5 | `artists` | 复制两份清单 + `NOTICE.md` 到 `<comfyDir>/model-notes/`（便携布局再复制一份到 `<codeDir>/model-notes/`），然后刷新画师缓存 | 文件缺失则跳过该文件 |
| 6 | `licenses` | 复制 `LICENSES/*` 到 `<comfyDir>/LICENSES/`，并写 `THIRD_PARTY-NOTICE.md` | — |

收尾：内嵌模式 `save({comfy:{mode:'embedded',dir:''}})`；`store.writeSetup({completed:true, ...})`；
最后一条任务日志为「向导完成 ✅」。`skip.{runtime,comfyui,nodes,models,artists,licenses}` 可单独跳过任意段（供后续增量补装）。

### 6.2 四种 ComfyUI 来源的差异与风险

| `comfySource.kind` | 做什么 | 体积/耗时 | 风险与注意 |
|---|---|---|---|
| `portable`（默认） | 先问 GitHub Releases API 取当前 `ComfyUI_windows_portable*.7z` 资产名（含 `nvidia` 优先），失败按 `PORTABLE_ASSETS` 三个候选名依次试；下载到 `runtime/_dl/`，用 7-Zip 解到 `runtime/comfyui/`，再 `hoistSingleRoot` | 数 GB / 数分钟；解压还需数分钟 | 需要能访问 GitHub（或配置代理）；磁盘需预留压缩包 + 解压两份空间；资产名随上游变动（所以先问 API） |
| `archive` | 用用户指定的本地 `.7z` 归档，跳过下载 | 同便携包 | 归档必须是官方 Windows 便携包结构（含 `python_embeded/python.exe`），否则解压后校验失败 |
| `dir` | 从**已有的本地 ComfyUI 目录**导入到 `runtime/comfyui/`：整体导入代码目录（`copyMode=link` 时优先硬链接），并单独导入 `python_embeded/`；**保留 `venv/`** | 硬链接同卷近瞬时、几乎不占额外空间；跨卷回落复制 → 可能几 GB | 需要解释器（`venv` 或 `python_embeded`）随目录一起存在；跳过 `__pycache__/.git/output/temp/input/user`；复制模式请预留磁盘 |
| `git` | `git clone --depth 1`（含代理重试）→ `fetch` + `checkout` 固定 commit → 用系统 `python`/`py` 建 `venv` → `pip install -r requirements.txt -i <pipIndex>` | 需网络 + 系统 Python | 没有 git 直接报错并建议改用便携包；需要系统 Python 3；pip 依赖体积与耗时不可控；Windows 下装 torch 可能很大 |
| `external` | **不动本体**：只校验用户目录并写设置（向导在外接模式发送这个 kind） | 0 | 该目录的 `venv/`、`python_embeded/` 由用户自己保证；本项目只负责探测与拉起 |
| `skip` | 明确跳过本体获取（例如你已经手动放好了 `runtime/comfyui/`） | 0 | 后续模型/节点步骤仍会尝试按布局落位 |

### 6.3 模型校验（字节数 + sha256）

- 目录表 `installer/models.json` 每条含 `bytes` 与 `sha256`；下载后先比字节数，再算 sha256（4 MiB 分块，边算边报百分比）。
- **任一不符即失败**：字节数不符直接抛；sha256 不符则**删除已下载文件**并提示重试。
- `installedState()` 的「已就绪」判定只看**大小精确相等**（廉价、可反复运行）；因此「大小对但内容坏」的文件不会被自动发现——
  需要时用 `POST /app/models/download` 带 `force:true` 重下，或手动对比 sha256。
- 从本地已有 ComfyUI 目录复用权重时**只比大小并给警告**，不算 sha256（离线复用优先可用性）。

### 6.4 画师清单与许可的落位

| 内容 | 源 | 落位 |
|---|---|---|
| `Anima2B_Artist_Index_59k.txt`、`Anima2B_Artist_top200.txt`、`NOTICE.md` | `assets/artists/` | `<comfyDir>/model-notes/`；`detectLayout` 成功时再一份 `<codeDir>/model-notes/` |
| 各上游许可全文 | `LICENSES/*` | `<comfyDir>/LICENSES/` |
| 第三方声明 | 项目根 `THIRD_PARTY.md` | `<comfyDir>/THIRD_PARTY-NOTICE.md` |

读取优先级（`comfy.artistDirs()`）：**项目内 `assets/artists/` 优先** → `<comfyDir>/model-notes/` → `<comfyDir>/ComfyUI/model-notes/`（决策 ⑧）。
面板只认以 `@` 开头的行；文件缺失时面板显示「画师清单不可用」并**照常允许生成**（不注入画师）。

### 6.5 `runtime/bin` 里的 7-Zip 引导链

`installer.ensure7z(job)` 的判定顺序：

1. 已存在 `runtime/bin/7za.exe` → 直接用（`source:'bundled'`）；
2. `find7z([runtimeBin])` 找到**位于 runtime/bin 内**的 `7za.exe`/`7z.exe` → 用；
3. 没有 `7zr.exe` 就下载 `https://www.7-zip.org/a/7zr.exe`（约 0.6 MB，官方源，走 F3：先官方再镜像）到 `runtime/bin/7zr.exe`；
4. 用 `7zr.exe` 解 `7z<版本>-extra.7z`：版本号从 `https://www.7-zip.org/download.html` 的正则 `7z(\d+)-extra\.7z` 抓取，
   抓不到回落 `2603`；下载到 `runtime/_dl/7z-extra.7z`，解到 `runtime/_dl/7z-extra/`，
   从中挑 `x64/7za.exe`（或根层 `7za.exe`）复制为 `runtime/bin/7za.exe`（有 `7za.dll` 一并复制）→ `source:'bundled'`；
5. 第 4 步失败 → 回落用 `7zr.exe`（能解 7z 但大包更慢），记 warn；
6. `7zr` 也没有但系统装了 7-Zip → `source:'system'`（并提示「改用系统已安装的 7-Zip」）；
7. 全都不可用 → 抛错「没有可用的 7-Zip（随项目获取失败，系统也未安装）。请安装 7-Zip 后重试。」

> 为什么这么绕：7-Zip 官方 `7zr.exe` 是**独立精简版**（无安装、无注册表），但它处理官方 Windows 便携包那种大体积 7z 明显更慢；
> 而完整版 `7za.exe` 只在 `7z<版本>-extra.7z` 里。用「精简版解出完整版」既避开了安装程序，又能拿到快的解压器。

### 6.6 llama.cpp 运行时解析与安装

1. `installRuntime(job, variant)`：`auto` → `hasNvidiaGpu()`（`nvidia-smi -L`）为真则 CUDA，否则 CPU。
2. `resolveRuntimeAssets(job)`：拉 releases 列表（经 F3：官方 API → GitHub 代理），取第一个含 Windows x64 CPU 资产的 release；
   同时列出该 release 的 CUDA 包（按名字倒序，即版本号最大优先）、`cudart` 包与 CPU 包；日志打印 `llama.cpp 版本：<tag>`。
3. 下载顺序：CUDA 版（每个 cuda 包都配第一个 cudart）→ 失败则 CPU 版兜底。
4. 解压到 `runtime/bin/llama/`（`unzipTo` + `hoistSingleRoot`），找不到 `llama-server.exe` 就全树搜索；
   CUDA 版若目录内缺 `cudart64*.dll` 才下载并解压 cudart 到同一目录。
5. **`--version` 自检**：`verifyRuntime(exe)` 起进程（20 s 超时）跑 `llama-server --version`，取含 `version|build` 的那行；
   退出码非 0 即视为失败，换下一个候选（CUDA → CPU）。
6. 全部失败 → 抛错「llama.cpp 运行时安装失败：<最后一次错误>」。
7. 运行期：`startServer()` 用 `-ngl <gpuLayers>` 决定 GPU 层数；显存不足或 CUDA 运行库缺失时进程会退出，
   接口会提示改装 CPU 版（见 FAQ）。

---

## 7. 配置参考（`data/settings.json`）

> 键路径为 JSON 路径；「生效方式」中「即时」= 下次请求/下次读设置即生效，「重启」= 需要重启后端子进程或整套程序。
> 所有非法值都会被 `config.normalize()` 夹紧或回落默认值（**不会报错**，静默纠正）。

| 键路径 | 默认值 | 取值范围 | 作用 | 生效方式 |
|---|---|---|---|---|
| `version` | `1` | 整数 | 设置结构版本（预留） | — |
| `lang` | `"zh"` | `zh` \| `en` | 界面语言；非 `en` 一律按 `zh` | 即时（前端重载词典） |
| `listen.host` | `"127.0.0.1"` | 只读派生 | 由 `listen.lan` 推导：`lan ? 0.0.0.0 : 127.0.0.1` | 重启 |
| `listen.port` | `8788` | 1–65535 | 后端**配置**端口；被占用时最多自增 2 次（v1.2.2）、实际端口**不回写**（看 `/app/state` 顶层 `port`） | 重启 |
| `listen.lan` | `false` | `true` \| `false` | 是否允许局域网访问（`true` 时监听 `0.0.0.0` 且**必须带令牌**） | 重启 |
| `listen.token` | 无（自动生成） | 24 位十六进制 | LAN 令牌；来源 `X-DCP-Token` 头或 `?token=` 参数 | 即时 |
| `comfy.mode` | `"embedded"` | `embedded` \| `external` | 内嵌（项目内 `runtime/comfyui`）或外接（用户目录） | 即时（每次 `comfyDir()` 重读） |
| `comfy.dir` | `""` | 绝对路径 | 外接模式的 ComfyUI 根目录（含 `main.py`） | 即时 |
| `comfy.port` | `8188` | 1–65535 | ComfyUI 端口（HTTP 与 WS 都用它） | 重启 ComfyUI 后生效 |
| `comfy.autoStart` | `false` | `true` \| `false` | 启动后自动探测/拉起 ComfyUI（`autoStart: true` 时 `launch()` 在后台执行，不阻塞端口就绪） | 重启后生效 |
| `comfy.extraArgs` | `[]` | 字符串数组 | 追加到 ComfyUI 启动命令末尾；**设置页未暴露**，需改 JSON | 重启 ComfyUI |
| `download.officialTimeoutMs` | `10000` | 1000–120000 | 官方源**连接/首字节**超时预算；实际生效值取 `min(它, startDeadlineMs)` | 即时 |
| `download.startDeadlineMs` | `10000` | 2000–120000 | **第七轮新增**：从"发出请求"计时，这么久内累计收到不足 64 KiB（`minStartBytes`）就换下一个源 | 即时 |
| `download.stallDeadlineMs` | `15000` | 2000–300000 | **第七轮新增**：下载中途连续这么久没有新字节就判停滞换源（**含最后一个候选**） | 即时 |
| `download.minStartBytes` | `65536` | 0–10485760 | **第七轮新增**："算作已开始下载"的最小字节数（挡掉 895 B / 4 KB 的验证页与人机校验页） | 即时 |
| `download.slowThresholdKBs` | `200` | 1–100000 | 慢速阈值；低于它开始计时（只用于在候选之间挑更快的） | 即时 |
| `download.slowWindowMs` | `30000` | 1000–600000 | 慢速持续多久算「不可用」并切镜像 | 即时 |
| `download.hfMirror` | `"https://hf-mirror.com"` | URL | HuggingFace 镜像前缀（结尾斜杠会被剥掉）；也是默认梯队最后一条兜底模板的基地址 | 即时 |
| `download.aifasthub` | `"https://aifasthub.com"` | URL | **第七轮新增**：aifasthub 基地址（实测最快的权重镜像之一） | 即时 |
| `download.modelscope` | `"https://modelscope.cn"` | URL | **ModelScope 基地址**（结尾斜杠会被剥掉）；默认梯队的第一、二条模板用它。注意 ModelScope 仓库**默认分支是 `master`**，所以模板里 `master` 与 `main` 各留了一条 | 即时 |
| `download.useModelScope` | `true` | `true` \| `false` | 是否启用 ModelScope 两条模板；**只有显式 `false` 才关**（`normalize` 用 `!== false` 判定） | 即时 |
| `download.hfMirrors` | `[]`（空 = 自动派生 6 条） | URL 模板数组 | **第七轮新增**：HF 系仓库的镜像梯队，按顺序尝试。占位符 `{repo} {owner} {name} {rev} {path} {file} {host} {url}`。派生默认值：ModelScope(`master`) → ModelScope(`main`) → aifasthub → `hf-api.gitee.com` → `ai.gitcode.com/hf_mirrors` → hf-mirror | 即时 |
| `download.nodeMirrors` | `[]`（空 = 自动派生 5 条） | URL 模板数组 | **第七轮新增**：Node 便携包镜像；占位符 `{ver} {file}`。派生默认值：清华 TUNA → 官方 → 华为云 → cdn.npmmirror → registry.npmmirror | 即时 |
| `download.jsdelivrMirrors` | `[]`（空 = 自动派生 5 条） | URL 模板数组 | **第七轮新增**：jsDelivr 的 GitHub 通道（角色词表走这里）；占位符 `{repo} {rev} {path}`。派生默认值：fastly → gcore → raw.githubusercontent → gh-proxy(raw) → ghfast(raw) | 即时 |
| `download.extraMirrors` | `[]` | URL 模板数组 | **第七轮新增**：通用兜底，任何直链都会追加（`{url}` 占位） | 即时 |
| `download.nodeVersion` | `"v22.14.0"` | 形如 `v22.14.0` | 便携 Node 版本（`scripts/bootstrap.ps1` 用的是它自己的同名常量，改这里不会改引导脚本） | 重启引导脚本 |
| `download.stallKBs` | `30` | 1–100000 | **停滞阈值**（KB/s）：低于它就说明真的没在动；**最后一个候选只按它判**，避免所有源都慢时把能下完的文件掐掉 | 即时 |
| `download.githubProxies` | `["https://gh-proxy.com/","https://ghproxy.net/","https://ghfast.top/"]` | URL 数组 | GitHub 加速来源，**按顺序尝试**。两种写法都支持：前缀式 `https://gh-proxy.com/`（自动补 `{url}`）与换主机式 `https://kkgithub.com/{repo}/releases/download/{ver}/{file}`。**实测只有 gh-proxy.com 快**，另两条是限速兜底；`ghps.cc` 已全站 404 故移除 | 即时 |
| `download.pipIndex` | `"https://pypi.tuna.tsinghua.edu.cn/simple"` | URL | `pip install` 的 `-i` 源（git 模式与节点依赖） | 即时 |
| `llm.contextMessages` | `5` | 0–20 | 送进模型的**最近**对话条数（系统提示词不计入）；0 = 不带历史 | 即时 |
| `llm.defaultModel` | `""` | `models/llm/` 下的文件名 | 默认 GGUF；空则由清单/第一个文件决定 | 重启 llama-server |
| `llm.port` | `8199` | 1–65535 | llama-server 端口 | 重启 llama-server |
| `llm.ctxSize` | `8192` | 512–262144 | `-c` 上下文长度 | 重启 llama-server |
| `llm.gpuLayers` | `99` | 0–999 | `-ngl` 卸载到 GPU 的层数（99 ≈ 全量）；设 0 即纯 CPU | 重启 llama-server |
| `llm.maxTokens` | `512` | 64–8192 | 单次回答 token 上限（小模型不设上限会写出几千 token 的思维链/词汤） | 即时 |
| `llm.provider` | `"local"` | `local` \| `api` | **推理来源**：本机 llama.cpp / 外接 OpenAI 兼容接口；非 `api` 一律归 `local` | 即时（每次 `chat()` 重读） |
| `llm.api.baseUrl` | `"https://api.deepseek.com"` | URL（`normalizeApiBase()` 归一化：去尾部斜杠、剥掉误粘的 `/chat/completions`） | 外接接口根地址，`https://api.deepseek.com`、`.../v1` 两种写法都接受 | 即时 |
| `llm.api.model` | `"deepseek-flash"` | 模型名 | 外接模型；可用 `POST /app/llm/api/models` 拉列表后选 | 即时 |
| `llm.api.reasoning` | `"off"` | `off` / `low` / `high` / `max` | 推理挡位四挡：off 下发 `thinking:{type:'disabled'}`+`chat_template_kwargs.enable_thinking:false`；low/high/max 下发 `reasoning_effort`（**实测 `effort` 字段无效**）。旧键 `thinking` 自动迁移（disabled→off、server→high） | 即时 |
| `llm.sendContext` | `false` | 布尔 | 历史是否发给模型；false 时界面保留历史、每轮只发当前这句 | 即时 |
| `llm.keepMessages` | `40` | 2–200 | 每个会话在**本地**保留多少条（供回看/复制，与"发给模型几条"无关） | 即时 |
| `llm.api.maxTokens` | `4096` | 64–393216 | 思考型模型会把预算先花在思考上，给小了正文为空 | 即时 |
| `llm.api.retries` | `2` | 0–5 | 429 / 5xx / 连接失败时的退避重试次数 | 即时 |
| `llm.api.idleMs` | `90000` | 5000–600000 | 流式"多久没数据算卡死"的空闲看门狗（取代原来的总超时判定） | 即时 |
| `llm.api.apiKey` | `""` | 字符串 | 外接 API Key。**只写在 `data/settings.json`（已 gitignore）；不进日志、不进交付文档**；页面用密码框且不回显 | 即时 |
| `llm.api.model` | `""` | 字符串 | 外接服务的模型 id（`apiReady` 要求它非空） | 即时 |
| `llm.api.temperature` | `0.6` | 0–2 | 外接路径的采样温度（越界夹紧） | 即时 |
| `llm.api.maxTokens` | `1024` | 64–32768 | 外接路径的单次回答上限（比本地默认 512 宽，因为远端不占本机显存） | 即时 |
| `llm.api.timeoutMs` | `120000` | 5000–600000 | 外接请求超时；`testApi()` 的对话自检取 `min(60000, 该值)` | 即时 |

**修改方式**：设置页（大部分项）→ `PUT /app/settings`（部分更新、深合并）；或直接编辑 `data/settings.json`（**改前先停后端**，
否则内存缓存会覆盖你的修改，因为 `load()` 带缓存、`save()` 会写回）。`llm.maxTokens`、`comfy.extraArgs`、`llm.gpuLayers` 只能手改 JSON。

> 本轮新增键里，`llm.api.apiKey` 是**唯一含密钥的设置项**：① 只落 `data/settings.json`；② `config.load()` 的日志与 `/app/state`、`/app/selfcheck` 都**不返回**它（`/app/llm/status` 只回 `hasKey: true/false`）；③ 交付文档与 `installer/llm-models.json` 里都不会出现真实 Key。

---

## 8. 接口参考

**权威定义在 `docs/INTERNAL-CONTRACT.md` §4**（含返回结构）。本节只补两件事：① **典型调用方**；② 契约与当前实现的差异（供同步契约时使用）。

### 8.1 状态与设置

| 方法 | 路径 | 典型调用方 |
|---|---|---|
| GET | `/app/state` | 外壳首屏与 5 秒轮询（`app-shell.js`）；**v1.2.2 起顶层多一个 `port`**（本程序**实际监听**端口，见下方说明） |
| POST | `/app/quit` | **新增（v1.2.2）**：托盘「关闭控制台并停止后端」的优雅退出入口。返回 `{ok, quitting, first, calls, comfy, llm, note}`；收尾顺序 = 停本程序拉起的 ComfyUI → 停 LLM → 关 HTTP → 落盘 → `exit 0`。**重复/并发调用只收尾一次**（`first` 只有一个 `true`），非 POST 返 405 |
| GET | `/app/selfcheck` | 设置页保存后、外壳「重新自检」按钮 |
| GET | `/app/settings` | 外壳首屏、设置页装载与保存后 |
| PUT/POST | `/app/settings` | 设置页「保存」、外壳 `changeLang()` |
| GET | `/app/logs?tail=300` | 外壳顶栏「显示日志」抽屉 |
| GET | `/app/download/probe?url=` | 设置页「测试镜像」 |
| GET | `/app/download/speedtest?url=&mib=&capMs=` | **新增（第七轮）**：镜像测速 —— 对该直链的**每个候选来源各真下 N MiB**（默认 100，读满即停、不落盘），返回 `{url,bytes,items:[{url,source,via,status,firstByteMs,gotBytes,sec,mbps,ok,note,error}],ok,usable,total}`；同一时刻只允许一个（并发时 409）。设置页「下载源 → 镜像测速」 |

> **`/app/state` 的字段（v1.1.0 补齐三处）**：`llm.provider`（`local`/`api`）与 `llm.api`（`{ok,baseUrl,model,hasKey,missing}`）—— 前端必须按**推理来源**判定"能不能发消息"与顶栏徽标，
> 只给 `llm.runtime` 时外接 API 模式（产品默认来源）会被恒判"本地 LLM 未就绪"；以及 `listen:{lan,port,token}` ——
> 设置页的令牌行读的就是它（见 §9 的局域网边界）。三处都在 `server/index.js` 的 `/app/state` 分支里一次性给出，
> 数据源是 `llm.serverStatus()`（本来就返回 `provider`/`api`）与 `load()`。
>
> **v1.2.2 新增顶层 `port`**：本程序**实际监听**的端口（数字），来自内存里的 `actualPort`（监听前回落到 `DCP_PORT` / `listen.port`）。
> 为什么必须单独给一个字段：取消端口回写后 `listen.port` 只剩"配置值"语义，而实际端口可能因占用自增而与它不同；
> 前端顶栏的「服务地址」徽标就靠它渲染（`data-dcp-service-port`），取值链 = 顶层 `port` → `listen.port`（兜底并换 tooltip）→ 不渲染。
> ⚠️ 同层的 `comfy.port` 是 **ComfyUI 自己的端口**（默认 8188），**不是**服务端口，两者永远不要混用。

### 8.2 ComfyUI 进程与兼容面

| 方法 | 路径 | 典型调用方 |
|---|---|---|
| GET | `/app/comfy/detect?dir=` | 设置页「检测」、向导步骤 1「检测」 |
| GET | `/app/comfy/status` | `/app/state` 内部（`comfy.status()`） |
| POST | `/app/comfy/launch` | 向导底部「启动 ComfyUI」、`/comfy-panel/launch` |
| POST | `/app/comfy/stop` | 向导底部「停止 ComfyUI」。**v1.2.2 语义变更**：只停**本程序拉起的**实例，返回 `{online, stopped, owner:"app"\|"foreign"\|"none", pids?, stillAlive?, detail?, note?}`；端口上那个 ComfyUI 若无归属记录则回报 `owner:"foreign"` 并**跳过**（旧实现按端口反查再杀，会误杀用户自己启动的实例） |
| GET | `/app/comfy/log?tail=` | 排障（当前无页面按钮；可直接浏览器访问） |
| GET | `/comfy-panel/config` | **面板**（`panel.js` 启动时拿 `base`） |
| GET | `/comfy-panel/health` | 存活诊断 |
| POST | `/comfy-panel/client-alive` | 面板 `apply()` 里的探针 |
| GET | `/comfy-panel/artists` | 面板画师区懒加载（`{all,top}`） |
| POST | `/comfy-panel/launch` | 面板「启动 ComfyUI」按钮 |
| ANY | `/comfy-panel/api/*` | 面板全部 ComfyUI 调用（prompt/history/view/object_info/free/interrupt…） |
| WS | `/comfy-panel/ws?clientId=` | 面板进度/实时预览 |

### 8.3 画师 / LLM / 向导 / 任务

| 方法 | 路径 | 典型调用方 |
|---|---|---|
| GET | `/app/artists/lists` | 外壳首屏、画师页、`window.__DCP_SAVE_ARTISTS__` 之后 |
| POST | `/app/artists/toggle` | 画师页（⭐ / 🚫 按钮）；面板本身走 `__DCP_SAVE_ARTISTS__` 的 PUT |
| PUT | `/app/artists/favs`、`/app/artists/blacklist` | 外壳 `__DCP_SAVE_ARTISTS__`（面板的乐观更新回写） |
| POST | `/app/artists/import` | 外壳首屏一次性导入、画师页「从浏览器旧数据导入」 |
| GET | `/app/artists/search?q=&source=&limit=` | 画师页检索 |
| GET | `/app/artists/lists/info` | 契约未列出（返回清单条数与文件路径） |
| GET | `/app/llm/status` | 本地 LLM 页装载、操作后刷新 |
| GET | `/app/llm/prompt` | 本地 LLM 页「显示系统提示词」 |
| GET | `/app/llm/models` | 本地 LLM 页模型管理 |
| POST | `/app/llm/models/add` \| `/remove` \| `/default` | 本地 LLM 页「添加/移除/设为默认」 |
| POST | `/app/llm/models/download` | 本地 LLM 页 URL 下载、检索结果下载 |
| GET | `/app/llm/search?q=` | 本地 LLM 页 abliterated 检索 |
| POST | `/app/llm/runtime/install` | 本地 LLM 页「自动/CUDA/CPU」 |
| POST | `/app/llm/server/start` \| `/stop` | 本地 LLM 页服务启停 |
| POST | `/app/llm/chat` | 本地 LLM 页对话（SSE）；按 `llm.provider` 分流本地 / 外接 |
| GET | `/app/llm/catalog` | **新增**：推荐模型目录（`installer/llm-models.json` + 每条 `installed`）；LLM 栏「推荐模型」卡片 |
| POST | `/app/llm/api/test` | **新增**：外接 API 连通性自检（先 `/models` 再一条极短对话）；设置页「测试连接」；成功 200，失败 500 + `{error}` |
| GET | `/app/characters/status` | **新增**：角色词表状态（`installed/loading/characters/source/bytes/updatedAt/dir/aliasFile/userAliases/builtinAliases`） |
| GET | `/app/characters/search?q=&limit=` | **新增**：角色检索（`limit` 夹到 1–200，默认 30）；返回 `{items:[{tag,count,aliases}]}` |
| POST | `/app/characters/install` | **新增**：下载/更新角色词表，走 job + SSE（`kind='characters'`）；返回 `{jobId}` |
| POST | `/app/characters/resolve` | **新增**：把一段文本解析成角色 tag（`{text}` → `{items:[{tag,count,matched}]}`），用于验收与排障 |
| GET/POST | `/app/characters/aliases` | **新增**：GET 返回 `{builtin, user}`；POST 用 `{zh, tag}` 新增或 `{remove}` 删除，返回 `{user}`；其它方法 405 |
| POST | `/app/llm/session/new` | 本地 LLM 页「新建会话」 |
| GET | `/app/llm/session/:id` | 排障/契约完整性（页面未直接调用） |
| GET | `/app/setup/plan?mode=&sel=&dir=` | 向导装载与切档位 |
| POST | `/app/setup/run` | 向导「开始安装」 |
| GET | `/app/setup/status` | 状态展示（向导/排障） |
| POST | `/app/models/download` | 增量补装模型（当前**无页面按钮**，可 curl 调用） |
| GET | `/app/models/catalog?sel=` | 模型目录（当前**无页面按钮**） |
| GET | `/app/jobs` | **新增（第七轮）**：任务列表 —— `?kind=`（前缀匹配，如 `setup`）、`?state=`（如 `running`）可选，返回 `{items:[{id,kind,title,state,percent,speedKBs,message,startedAt,endedAt,error}],running:[…]}`。**顶栏全局任务条**（`BackgroundJobs`，2 s 轮询）与**向导重挂载**（按 `kind=setup` 取 `running[0].id`）都用它 |
| GET | `/app/jobs/{jobId}` | `job-view.js` 的 SSE 断流轮询兜底 |
| GET | `/app/jobs/{jobId}/events` | `job-view.js` 的 `runJob()` |

### 8.4 契约与实现的差异（同步 `INTERNAL-CONTRACT.md` §4 时的待办）

1. `/comfy-panel/api/*`：契约写「JSON/text 转 UTF-8，其余原始 Buffer」，**实现是「一律原始字节直通」**
   （`req.pipe(up)` / `upRes.pipe(res)`），字符集完全依赖上游 `content-type` 声明。实现更安全，但契约文字需修正。
2. `/app/state` 还返回 `paths{models,llmModels,runtime,comfyEmbedded,logs,data}`、`platform`、`node`、`comfy.layout`、`comfy.modelsDir`、
   `llm.modelCount`、`llm.contextMessages`。
3. `/comfy-panel/config` 还返回 `version`、`buildTag`；`/comfy-panel/health` 还返回 `ok`、`clientBundle`、`buildTag`。
4. `/app/setup/run` 的请求体比契约多 `externalDir`、`modelsFrom:{dir}`、`skip:{...}`、`sel`；
   `comfySource.kind` 还接受 `"external"`（外接模式向导会发这个值）。
5. `/app/setup/plan` 还返回 `modelsDir`、`comfyDir`、`unknown`、`tiers`、`platform`、每条模型的 `dest/existingBytes/note`。
6. `/app/llm/prompt` 还返回 `file`；`/app/llm/models` 还返回 `default`；
   `/app/llm/status` 的 `server` 还含 `model`、`startedAt`、`lastError`；**`/app/llm/status` 顶层还含 `provider` 与 `api`（`apiReady()` 的结果）**。
7. 契约未列出但**已存在**的接口：`GET /app/logs`、`GET /app/artists/lists/info`、`GET /app/models/catalog`、`GET /app/download/probe`、
   **`GET /app/download/speedtest`、`GET /app/jobs`**、
   **`GET /app/llm/catalog`、`POST /app/llm/api/test`、`GET /app/characters/status`、`GET /app/characters/search`、`POST /app/characters/install`、`POST /app/characters/resolve`、`GET|POST /app/characters/aliases`**。
8. `/app/jobs/{id}` 还返回 `id/kind/title/startedAt/endedAt/logFile`。
9. `/app/llm/chat` 的 SSE 帧在第七轮多了一个 **`charactersFixed`**（数组，`[{from,to}]`）：角色 tag 被就地改成规范写法的记录；与 `charactersAdded` 同一帧或独立帧发出，前端渲染成"已把角色 tag 改成规范写法：X → Y"。
9. **`/app/llm/chat` 的 SSE 帧**比契约多两类：`{replace, normalized}`（输出被规范化）与 `{replace, charactersAdded:[tag]}`（角色 tag 补全）；结束帧多 `provider`、`charactersAdded`、`normalized`。同步契约时需要补上。
10. **新增 job `kind`**：`characters`（角色词表下载）；`GET /app/jobs/{id}/events` 的帧结构与既有任务完全一致。

---

## 9. 安全与隐私边界

| 边界 | 实现 | 为什么 |
|---|---|---|
| 默认只监听回环 | `listen.lan=false` → `host=127.0.0.1` | 本地工具默认不该暴露到局域网；要给别人用得显式开启 |
| LAN 必须带令牌 | `lanGuard()` 校验 `X-DCP-Token` 或 `?token=`；开启 LAN 时自动生成 24 位十六进制令牌并落盘。**回环来源放行（v1.1.0）**：`remoteAddress` ∈ `127.0.0.1` / `::1` / `::ffff:127.0.0.1` 时不校验 —— 令牌是给局域网内**其它设备**的；旧实现把本机也挡在门外，后果是"设置页保存后本页全部 401、令牌行永远看不到"以及"`start.ps1` 的 127.0.0.1 探活 401 → 下次双击 `start.cmd` 报后端没就绪并杀掉后端" | 同网段任何人扫到端口即可操作你的 ComfyUI/LLM；令牌是最小可用门槛。回环放行不削弱默认姿态：`lan=false` 时本来就不校验 |
| WS 也受令牌保护 | `server.on('upgrade')` 里先 `lanGuard`，不通过直接回 401 并断开 | 否则进度/预览通道会成为后门 |
| 反代只转发 `content-type` | `comfy.proxy()` 构造上游请求时**只带** `content-type`；响应只回 `content-type`/`content-length` | 浏览器的 Cookie、Referer、Authorization 等一律不带给 ComfyUI（继承插件版的隐私边界） |
| WS 握手只保留 6 个头 | 白名单 `upgrade/connection/sec-websocket-key/sec-websocket-version/sec-websocket-extensions/sec-websocket-protocol` | 同上：Cookie 不透传 |
| WS 必须改写 `Host`/`Origin` | 手写握手行改成 `127.0.0.1:<comfy.port>` | ComfyUI 0.37 的 `create_origin_only_middleware` 比对 Host/Origin 的 netloc，不改写一律 403（不是绕过鉴权，而是让**同机**流量通过它自己的同源检查） |
| 图片不直连 8188 | 面板 `<img>` 走 `/comfy-panel/api/view` | 少开一个未鉴权的直连面；面板只与后端通信 |
| 生成图不带工作流 | ComfyUI 启动参数固定含 `--disable-metadata` | PNG 里不写提示词/工作流元数据，避免把提示词随图外发 |
| 交付物零机器路径 | 源码/脚本/文档全部从 `__dirname`/`$PSScriptRoot` 推导，占位符写文档；`build-core.ps1` 有隐私扫描 | 迁移约束 + 公开仓库不得泄露作者环境 |
| 外部路径只落在 `data/` | `comfy.dir` 只写 `data/settings.json`，`data/` 不入库 | 见 §5.3 |
| **外接 API Key 只落在 `data/`** | `llm.api.apiKey` 只写 `data/settings.json`；`/app/llm/status` 只回 `hasKey: true/false`，接口与日志都不回显明文；设置页用 `type=password` | 密钥既不该进仓库，也不该进日志与交付文档（本轮新增边界） |
| **角色词表数据只落在 `data/`** | `data/characters/`（CSV + 元数据）与 `data/character-aliases.json` 均不入库、不进 `release/core` | 词表是运行时下载的第三方数据（MIT），别名含用户自己的叫法 |
| 静态资源禁用缓存 | `cache-control: no-store, must-revalidate` | 前端改动刷新即生效，同时避免旧版本前端缓存导致的接口不匹配 |

**如实说明一处例外（避免误以为日志也被脱敏）**：运行期日志（`logs/`）**会**记录本机诊断信息，
包括项目根目录、生效的 ComfyUI 目录（外接模式下即用户自己的路径）、ComfyUI 子进程的 `cwd`、llama-server 的命令行。
处理方式：① `logs/` 在 `.gitignore` 里，不进仓库、不进 `release/core`；② 迁移/分享前可直接删 `logs/`；
③ 交付物（源码、脚本、文档、`installer/models.json`）内不含任何机器路径——这是 `build-core.ps1` 的强制扫描项。

---

## 10. 常见问题（FAQ）

> 排障入口速查：后端日志 `logs/server.log`；ComfyUI 子进程输出 `logs/comfyui.log`；
> llama-server 输出 `logs/llama-server.log`；长任务逐步日志 `logs/jobs/<kind>-<id>.log`；自检 `GET /app/selfcheck`。

1. **后端起不来（双击 `start.cmd` 一闪/报错）**
   `start.cmd` 会把非 0 退出保留在窗口里并 `pause`。看它打印的最后 15 行（来自 `logs/server-console.out.log` / `.err.log`）。
   最常见原因：没有网络导致便携 Node 未下载（先手动 `pwsh -File .\scripts\bootstrap.ps1`）、端口被占且自增 **2 次**（v1.2.2 上限）仍失败、`server\index.js` 被移动。
   也可前台运行看实时输出：`pwsh -File .\scripts\start.ps1 -Foreground`。

2. **端口被占（v1.2.2：最多自增 2 次，不再写回）**
   `server/index.js` 的 `listen()` 遇 `EADDRINUSE` 会 `port+1` 重试，**最多 2 次**且每次 WARN（`… 尝试 N（第 x/2 次自增）`）；仍占用则 `log.error` + 提示用 `DCP_PORT` 指定其它端口 + `exit 1`。
   成功后**不写回** `data/settings.json`：`listen.port` 永远是配置值，实际端口从 `/app/state` 顶层 `port`、启动日志「打开：」或 `DCP_READY` 读取（三处一致）。
   启动器按 `base..base+20` 逐个探测 `/app/state` 判断就绪，所以页面地址可能比设置里的端口大几号——以启动日志打印的地址为准。
   若 2 次都失败：看是谁占着（`Get-NetTCPConnection -LocalPort <端口> -State Listen`）或直接在设置页换一个端口。

3. **网页 404**
   - 访问的是 `/` 却 404：`web/index.html` 缺失（项目没拷全）。
   - 某个 JS/CSS 404：`web/` 子目录缺失，或手动访问了不存在的 `/static/...`（静态目录只服务 `web/` 下真实文件）。
   - `/app/xxx` 404 且响应体是 `{"error":"未知接口：..."}`：路径拼错或该接口不存在（对照 §8 与契约 §4）。
   - 端口对了但页面是旧的：静态响应是 `no-store`，强刷一次（Ctrl+Shift+R）即可。

4. **ComfyUI 离线（顶栏红点）**
   `/app/state` 里的 `comfy.online` 来自 `GET http://127.0.0.1:<comfy.port>/system_stats`。
   ① 点面板或向导里的「启动 ComfyUI」；② 外接模式确认 `comfy.dir` 与 `comfy.port` 指向真实安装；
   ③ 已在跑但仍显示离线：端口填错，或 ComfyUI 监听的不是回环地址；④ 用 `GET /app/comfy/status` 看 `layout/python/mainPy` 与 `lastError`。

5. **模型下拉为空 / 只有兜底名**
   面板模型清单来自 ComfyUI 的 `/object_info`，**必须在线**且节点已注册；每个在线周期只拉一次，所以：
   ① 确认 ComfyUI 在线；② 点模型区的「↻ 刷新模型」；③ Anima 3.8B v2 需要 `custom_nodes/comfyui-anima-3-8B`
   （向内嵌模式重跑向导的节点步骤，或手动 clone 到 `<comfyDir>/ComfyUI/custom_nodes/`）；④ 权重文件名与目录必须匹配
   （`diffusion_models/`、`text_encoders/`、`vae/`）。

6. **通道数 / 编码器维度报错（崩图或提交被拦）**
   面板有**管线兼容性表 + 提交前硬闸门**：三种管线（`anima` / `animaPlain` / `qwen`）各自的扩散模型、VAE 通道数与编码器维度都被校验。
   - `VAEDecode` 报通道数：VAE 与主模型不是同一条管线（16 通道 vs 64 通道）。
   - 文本编码器维度（如 `normalized_shape=[4096]` 收到 1024 维）：编码器选错——Qwen-Image 2.1 用 4096 维的 `qwen3vl_8b_w4a8`，Anima 用 1024 维的 `qwen_3_06b_base`。
   闸门给的是「点名两个文件 + 原因」的中文提示，照它换下拉项即可；不要绕过闸门（会复现崩图）。

7. **点「启动 ComfyUI」没反应 / 转圈后失败，看哪个日志**
   看 `logs/comfyui.log`（子进程 stdout/stderr 追加），或 `GET /app/comfy/log?tail=300`。
   启动接口本身会返回结构化错误：找不到 `main.py`、找不到 Python 解释器、180 秒未就绪、spawn 异常，都会带中文说明与 `fix` 方向。
   内嵌模式注意：便携包必须带 `python_embeded/python.exe`；`dir` 导入模式必须把 `venv/` 一起导入。

8. **下载太慢 / 想换镜像 / 已自动切了镜像**
   下载策略（F3）是「官方源 → 镜像」：连接超过 `download.officialTimeoutMs`（默认 10 s）或速度持续低于
   `download.slowThresholdKBs`（默认 200 KB/s）超过 `download.slowWindowMs`（默认 30 s）就切；切换时任务日志里会有一条 **warn** 明确说明
   「本次改用镜像来源 xxx —— 可在『设置 → 下载』里调整镜像与阈值」。
   在设置页可改 HuggingFace 镜像与 GitHub 代理列表，并用「测试镜像」按钮（`GET /app/download/probe`）看哪个源可达。

9. **局域网访问要令牌**
   设置页打开「允许局域网访问」后必须重启后端；重启时若没有令牌会自动生成并在启动日志打印带 `?token=` 的局域网地址，设置页也会显示 `token: <值>`。
   打不开时：用带 `?token=` 的完整地址；或让请求带 `X-DCP-Token` 头。401 响应体会直接告诉你缺令牌。

10. **LLM 显存不足（CUDA 版起不来或一跑就 OOM）**
    ① 把 `llm.gpuLayers`（`-ngl`）调小（例如 20）或设 0 走纯 CPU；② 换更小的量化 GGUF（Q4/Q5 而非 Q8）；
    ③ 在「本地 LLM」页改装 **CPU 版运行时**；④ 关掉 ComfyUI 释放显存后再跑；⑤ 降低 `llm.ctxSize`。

11. **llama-server 启动即退出**
    看 `logs/llama-server.log`；`startServer()` 返回的错误里也会带最后 4 行日志。常见原因：
    CUDA 运行库缺失（`cudart64*.dll` 不全）→ 重装运行时并选 CUDA，或改 CPU 版；
    参数不兼容（老版本没有 `--no-webui`）→ 后端会自动换一组参数重试，仍失败就看日志里的参数报错；
    模型文件损坏/不完整 → 换一个 GGUF 或重新下载。

12. **画师清单不可用**
    面板提示「画师清单不可用：assets/artists/ 下缺少清单 txt」（本次生成不注入画师，但**生成照常可用**）。
    ① 确认 `assets/artists/` 下有两份 txt；② 或把它们放到 `<comfyDir>/model-notes/`；
    ③ 向导「画师」步骤会复制到这两处并**刷新缓存**（不需要重启，与插件版不同）；④ 自定义画师输入不受清单影响，仍可直接用。

13. **外接路径失效（换了机器/盘符/挪了目录）**
    自检会给出 error 级 `comfy-dir-missing`（「外接 ComfyUI 目录不存在（多半是整体拷贝到别的电脑/盘符后路径失效）」），
    外壳顶部出现红条。修法三选一：① 设置页「ComfyUI 目录」重新指向本机目录；② 改成内嵌模式并由向导安装；
    ③ 重跑向导的外接模式。改完点「重新自检」确认零 error。

14. **迁移后自检报错**
    逐条对照 `GET /app/selfcheck` 的 `code`：`comfy-dir-missing`（改目录）、`comfy-embedded-missing`（跑向导）、
    `llm-runtime-missing`（装运行时）、`llm-model-missing`（重设默认模型）、`artists-missing` / `system-prompt-missing`（文件没拷全，恢复即可）。
    warn 不阻断使用，error 需要处理。详见 `MIGRATION.md`。

15. **怎么卸载？**
    **删除项目文件夹即可**：不写注册表、不写系统目录、不装服务、不留后台进程（托盘助手在后端退出时**自己退出并销毁图标**；见决策 ④/⑰）。
    唯一例外是**你自己选择的外接 ComfyUI 目录**或你自己放模型的位置——那属于你自己的既有安装，删不删由你决定。
    中止运行：右键托盘「关闭控制台并停止后端」（**v1.2.2：会先请后端优雅退出**，连带停掉本程序拉起的 ComfyUI 与本地 LLM），或关闭启动器窗口 / 在其控制台按 Ctrl+C（走同一套收尾）。

16. **面板整块不显示 / 提示「面板组件未加载」**
    `web/panel.js` 没加载成功（404 或语法错误）。看浏览器控制台；确认用 `node --check web/panel.js` 能通过；
    确认页面地址来自本后端（`/static/panel.js` 与页面同源）。

17. **任务卡住不动 / 进度条停了**
    SSE 断开不会失败任务：`job-view.js` 会用 `GET /app/jobs/{id}` 兜底一次。若仍显示 running，说明任务体真的在跑
    （大包解压、大模型下载都会长时间无事件但每 1.5 s 会有进度帧）。可直接读 `logs/jobs/<kind>-<id>.log` 看最后一行。
    长任务没有取消按钮——要中止只能停后端进程（下轮工作建议里列了改进方向）。

18. **英文界面下有些面板文案没变**
    `panel` 词典是**精确匹配**，上游文案一改就失配；带插值的动态消息靠 `panelRules`，规则没覆盖就保持中文。
    修法：在 `web/i18n/en.json` 的 `panel` 里加/改键（键 = 面板里的中文原文），或补一条 `panelRules` 规则；改完刷新页面即可（无需重启）。

19. **`npm run check` 能不能用**
    能。`scripts/check.js` 已补齐，`node scripts/check.js`（或 `npm run check`）做五类自检：语法（后端 + 面板两半 + 前端 ES 模块）、
    JSON 可解析、中英词典键集一致且英文无汉字残留、`.ps1` 必须是 UTF-8 with BOM + CRLF、交付物脱敏扫描；任一项失败即以非零码退出。
    交付前还可跑 `pwsh -File .\scripts\build-core.ps1` 生成核心版并做「隐私 / 权重 / GPL / 文档齐全」四项扫描。
    （早期草稿曾把这一项写成"历史遗留死脚本"，现已补齐。）

20. **`data/settings.json` 手改后没生效**
    `config.load()` 有进程内缓存，`save()` 会把缓存写回磁盘。手改 JSON 前先停后端，改完再启动；
    或直接调用 `PUT /app/settings`（部分更新、深合并），它会经过 `normalize()` 把你的值夹紧到合法区间。

21. **外接 API 报 401 / 404（`provider='api'`）**
    `chat()` 会按状态码给中文提示：`401/403` = API Key 无效或没权限；`404` = baseUrl 或模型名不对（**多数服务要把 baseUrl 写到 `/v1` 这一层**）；
    `429` = 触发限流。先用设置页「测试连接」→ `POST /app/llm/api/test`（先 `/models` 再一条 `max_tokens:8` 的非流式对话），
    返回的 `ms` / `model` / `models` 能区分「地址通但模型名错」与「地址不通」。`apiReady()` 只要求 `baseUrl` 与 `model`，所以 Key 为空也能先测本机端点。

22. **角色补全没触发 / 补错了**
    先看 `GET /app/characters/status` 的 `installed` 与 `characters`（应为 40,931）。补全流程是 `resolveFromText(userContent)` → `repairAnswer()`，
    因此**只在用户那句话里能解析出角色名时才会补**（英文名要求 `count >= 20`，中文名要求命中别名表）。
    补错了就用 `GET|POST /app/characters/aliases` 修正别名（用户项覆盖内置项），或直接在 `data/character-aliases.json` 里改（改完**重启后端**才重新读）；
    想验证解析结果可以直接打 `POST /app/characters/resolve {"text":"画一下蕾姆站在雨里"}`，或 `GET /app/characters/search?q=rem`。

23. **托盘图标不见了 / 关不掉**
    看 `logs/tray.log`：有「托盘已就绪」说明托盘进程起过；「后端已退出，托盘关闭」说明它按设计自行退出（**不留幽灵图标**）。
    `-NoTray` 或 `-Foreground` 启动时**本来就没有**托盘。WinForms 不可用时托盘进程会 `exit 2`，启动器会打印警告并保持控制台可见。
    托盘关不掉后端时（极端情况）：托盘先请求 `POST /app/quit` 优雅退出，失败再回退 —— 按 `BackendPid`（`/T /F`）或按端口反查监听进程；两条路径最后都按 `data/run` 归属记录清一次本程序拉起的 ComfyUI；仍失败就手动结束 `node.exe`（下次启动会自动清孤儿）。

24. **下载一直失败 / 想确认到底试了哪些源**
    任务日志（`logs/jobs/<kind>-<id>.log`，界面进度弹窗同源）**开头**有一行 `候选来源 N 个：官方源 → hf-mirror → modelscope → …`；
    失败时结尾逐条列出 `来源#轮次: 原因`。想缩小范围：设置页「一键填入国内优选源」（hf-mirror + ModelScope + 四个代理 + `stallKBs=30`）。
    注意 ModelScope 只对**确实有同字节镜像**的文件有效（`installer/llm-models.json` 的 `modelscope` 字段），没有就 404 后自动跳到下一个候选。

---

## 11. 与早期插件形态的差异对照

| 维度 | 早期插件形态 | 独立版（本项目） | 说明 |
|---|---|---|---|
| 宿主依赖 | 必须运行在宿主应用里，注册到 `shell.overlay` 插槽；宿主半（host）由宿主加载 | **零宿主依赖**：自带 Node 后端 + 静态页面，任何浏览器打开 `http://127.0.0.1:<port>/` 即可 | 面板半（`lib/client.js`）被原样复用，靠 `panel-host.js` 适配 |
| 鉴权 | 宿主每次重启作废签名 Cookie；`/comfy-panel/*` 未带有效 token 全 401 | 默认回环无鉴权；**只**在开启 LAN 时要求 `X-DCP-Token`/`?token=` | 本机场景少了「重启就失效」的摩擦 |
| 前端生效方式 | 走宿主的 `?rev=` 快照机制（改代码要重新构建/换 rev） | 静态托管 + `cache-control: no-store`，**改前端代码刷新即生效** | 面板 `BUILD_TAG` 仍在头部自证版本 |
| 收藏持久化 | 浏览器 `localStorage['dcp-artist-favs']` | 服务端 `data/artists.json`（随项目迁移走）；`localStorage` 仅作一次性导入源 | 面板的 `artistStore/persistArtists` 改读 `window.__DCP_ARTISTS__`、写 `window.__DCP_SAVE_ARTISTS__` |
| 画师自定义与黑名单 | 红线：「只允许清单内画师」，指定模式只能从列表点选；无黑名单 | **有意放宽**：自定义画师自由输入即可用（做格式规范化）；新增黑名单（三档随机剔除，指定模式仍可搜到并标注）；收藏/黑名单**互斥、后执行覆盖** | 放宽的是产品策略，不是安全边界；见决策 ⑤ |
| LLM 提示词能力 | 无 | 新增本地 LLM 页：llama.cpp 运行时安装、模型管理、abliterated 检索、会话式生成正负提示词、一键填回面板；**推荐模型目录**一键下载；「提示词工具」**填入 + 复制** | 系统提示词仍用 `assets/templates/anima-system-prompt.txt` 原文 |
| **推理来源** | 无（LLM 功能本身不存在） | **本地模型（llama.cpp）或外接 API（OpenAI 兼容）二选一**；外接模式只需 baseUrl / Key / 模型名，**只做纯聊天内核** | 见决策 ⑮；Key 只落 `data/settings.json` |
| **角色识别** | 无 | Danbooru 角色词表（40,931 条角色 tag）+ 563 条内置中文别名 + 用户别名；模型漏角色时**补进正向提示词并显式告知** | 见决策 ⑭ |
| 下载镜像策略 | 安装器为 PowerShell 脚本，镜像逻辑内嵌在脚本里 | 统一在 `download.js`：官方源优先 → 按 URL 主机自动推导镜像（hf-mirror / **ModelScope** / GitHub 代理）；超时 / 慢速 / **停滞**阈值**全部可在设置里调** | 见决策 ⑫/⑯ |
| 进程/托盘 | 依附宿主进程，不管理 ComfyUI 之外的东西 | 后端自己拉起/停止 ComfyUI 与 llama-server，**启动器侧另起独立托盘进程**（打开 UI / 复制地址 / 打开日志 / 关闭并停止后端）并把控制台最小化到任务栏；**页面侧仍不提供窗口开关** | 见决策 ④（页面）与 ⑰（启动器） |
| 数据位置 | 收藏在浏览器；安装状态在插件目录 | 全部在项目内 `data/`（设置/收藏/LLM 清单与会话/向导状态/**角色词表与别名**）与 `logs/` | 迁移即拷贝，见 `MIGRATION.md` |
| 安装方式 | 由 早期插件形态机制安装/更新 | 解压即用；`start.cmd` 启动；首次运行走向导；`scripts/build-core.ps1` 产出可上传的核心版 | 运行时与权重全部由向导获取 |

---

## 12. 决策记录（Decision log）

> 每条格式：**决定** / **理由** / **被放弃的方案**。理由均可在代码或本文档其它章节找到对应证据。

### ① 后端用 Node 标准库、零 npm 依赖
- **决定**：`server/` 只 `require('node:*')` 与相对路径；`package.json` 的 `dependencies`/`devDependencies` 为空。
- **理由**：迁移 = 拷贝文件夹，**不需要 `npm i`**（内网/离线机器可用）；没有 `node_modules` 就不存在依赖漂移与供应链风险；
  `scripts/build-core.ps1` 也因此可以把「核心版」直接当仓库根。
- **被放弃**：Express（路由/中间件省不了几个字，却要装依赖）、`ws`（本项目只需要一个握手改写 + 裸 TCP 中继，`net` 更直接）、
  `node-fetch`（Node 18+ 自带 `fetch`）、解压库（ZIP 只需 store/deflate，`zlib.inflateRawSync` 足够）。

### ② 前端复用插件版面板，而不是重写
- **决定**：`web/panel.js` 保留插件的 `window.__ModuleLoader__.load({factory})` 包装与全部 UI/图构建器逻辑，
  由 `web/panel-host.js` 提供 `require('react')` 与 `ctx.slots.*` 替身。
- **理由**：面板是 2000+ 行、经真实出图实测的 UI 与图构建器（含 v0.4–v0.9 的崩图修复、管线兼容性表、逐张生成、参考图等）；
  重写意味着把这些坑再踩一遍。
- **代价**：必须保留插件式模块包装（看起来像无用样板）、少量锚点改造（§4.6 十项），以及上游文案残留（§4.6 末尾已列明）；
  改面板时要同时维护「与上游可比对」这条约束。

### ③ 面板 i18n 用 DOM 词典 + 正则规则
- **决定**：面板文案不改源码，由 `web/i18n.js` 在 DOM 层翻译（精确词典 + `panelRules` 正则 + MutationObserver）。
- **理由**：保住与上游 `lib/client.js` 的**逐行可比对性**（决策 ② 的直接推论）；如果给 317 条文案一个个换成 `t("...")`，diff 会失控，
  以后上游修 bug 也无法机械合并。
- **代价**：动态文案（带数字/文件名插值的）必须靠规则覆盖，当前只有 4 条规则；
  上游改文案会让词典失配（表现为「英文界面下少数句子仍是中文」）。`zh.json` 把中文映射到自身以便覆盖率校验。

### ④ 不提供托盘/关闭按钮行为（**仅指页面侧**）
- **决定**：设置页的「窗口」卡片只显示一条说明，不提供「关闭按钮行为」「启动后最小化到托盘」两项。
- **理由**：独立版的**浏览器页面**没有任何托盘/窗口进程可配置；提供无效果的开关比不提供更糟。
  页面上明确写出原因（`settings.window.noTray.detail`：「独立版是纯浏览器页面（后端进程 + 静态页面），没有托盘进程……
  要退出请关闭启动器窗口或在窗口里按 Ctrl+C」）。
- **被放弃**：为了「和插件版设置项对齐」而放两个假开关；引入 Electron/Tauri 做托盘（与「零依赖、拷贝即迁移」冲突）。
- **第二轮补充（重要，别把这条读成"本项目没有托盘"）**：**启动器侧**现在确实有托盘图标与控制台最小化 —— 那是 `scripts/start.ps1` + `scripts/tray.ps1` 的行为，
  与浏览器页面无关，用 `-NoTray` 关闭。见决策 ⑰ 与 §3.12。**页面侧的结论没变**：不提供那两个假开关。

### ⑤ 自定义画师自由输入（有意放宽）+「收藏/黑名单互斥、后执行覆盖」
- **决定**：
  - 指定画师模式下除「从清单/收藏点选」外，允许**自定义画师自由输入**（`normalizeCustomArtist`：去 `@`、下划线转空格、只留 Danbooru tag 允许字符），
    不弹「清单外」警告、不做二次确认；自定义画师不进默认随机池，但可被收藏，"仅收藏"检索与 ★随机收藏自然覆盖它。
  - 收藏与黑名单**互斥**：加入一个列表即从另一个列表移除（后执行的操作覆盖）。服务端 `store.toggleArtist()` 与面板
    `toggleFavExclusive/toggleBlacklistExclusive` 实现同一语义。
- **理由**：插件版的红线（只允许清单内画师）是**产品策略**而非安全约束；清单来自固定训练快照，用户手上的新画师/自训风格根本不在里面，
  硬拦只会逼用户绕路。互斥则是为了避免「既收藏又拉黑」这种自相矛盾状态导致的随机结果不可预期。
- **被放弃**：给清单外输入弹警告/二次确认；允许同一 tag 同时存在于收藏与黑名单（那会让「随机收藏」与「黑名单剔除」互相打架）。

### ⑥ 小模型输出规范化，而不是往系统提示词里追加内容
- **决定**：`llm.normalizeAnswer()` 对**模型输出**做兜底（多围栏取第一个、同行去重、冗余截断并明确提示）；
  系统提示词始终是 `assets/templates/anima-system-prompt.txt` 的**逐字节原文**（`systemPrompt()` 只读文件）。
- **理由**：系统提示词是与模型行为绑定的资产，往里追加「请只输出一个围栏」「不要把负向写进正向」之类的补丁会：
  ① 破坏与上游提示词的逐字节一致性（实测项之一）；② 让「模型不遵守提示词」的问题被掩盖而不被发现。
  规范化在**输出侧**做，且只在能识别出正/负向标签时改写，识别不出就原样返回（绝不伪造内容）。
- **被放弃**：在系统提示词后追加约束段；用另一个模型「洗」输出。

### ⑦ 关闭思考链 + 设 `max_tokens` + DRY/repeat_penalty
- **决定**：请求体固定 `chat_template_kwargs:{enable_thinking:false}`、`max_tokens = settings.llm.maxTokens || 512`、
  `repeat_penalty 1.1`、`repeat_last_n 256`、`dry_multiplier 0.8`、`dry_base 1.75`、`dry_allowed_length 2`、`dry_penalty_last_n 512`，
  以及低温采样（`temperature 0.6 / top_p 0.9 / top_k 40 / min_p 0.05`）。
- **理由**：实测不设上限时，一次回答可以写到 **7390 token**，直接顶满 8192 上下文被截断——既慢又吃掉历史；
  实测不加 DRY/repeat_penalty 时，负向提示词会退化成「一长串近义词词汤」（不是字面重复，纯 `repeat_penalty` 压不住）。
  提示词生成要的是「一个代码围栏」，不需要思维过程，所以关思考链。
- **被放弃**：依赖模型默认参数；用更大的 `ctxSize` 换取思考空间（8 GB 显存下不划算，且上下文越长越慢）。

### ⑧ 画师清单优先项目内，回落到 ComfyUI 目录；清单变更不需要重启
- **决定**：`comfy.artistDirs()` 的候选顺序是 **`assets/artists/` → `<comfyDir>/model-notes/` → `<comfyDir>/ComfyUI/model-notes/`**；
  缓存懒加载但**成功才缓存**；向导复制完清单后调 `resetArtistsCache()` 立即生效。
- **理由**：迁移后**不依赖外部安装**也能用画师（清单是 MIT 文本、随项目走）；同时兼容「插件版时代已经把清单装进 ComfyUI 目录」的老用户。
  插件版有「清单变更需重启宿主」的毛病，本版改成可刷新缓存，少一次重启。
- **被放弃**：只读 `<comfyDir>/model-notes/`（迁移后清单丢失导致随机画师降级）；启动时一次性读入不刷新（向导刚装完还得重启）。

### ⑨ `dir` 导入模式保留 `venv/` 并优先硬链接
- **决定**：从已有 ComfyUI 目录导入时，`fsx.copyTree` 用 `link:true`（同卷硬链接，失败自动回落复制）；
  跳过集合仅为 `__pycache__ .git output temp input user`——**`venv/` 必须导入**；另外单独导入根层 `python_embeded/`。
- **理由**：内嵌模式**必须有解释器**（`launch()` 找不到 python 就直接报错并让你去向导），只导代码等于导了个不能跑的壳；
  同卷硬链接零成本（瞬时、不额外占空间），跨卷自动回落复制，行为可预期。
- **被放弃**：默认整目录复制（几十 GB 的 `venv` 白拷一遍）；只导代码不导解释器（内嵌模式必然起不来）。

### ⑩ 局域网默认关闭、开启时必须带令牌
- **决定**：`listen.lan` 默认 `false`；为 `true` 时监听 `0.0.0.0`，且 `lanGuard()` 强制校验令牌（`X-DCP-Token` 或 `?token=`），
  令牌在开启时自动生成（24 位十六进制）并落盘。
- **理由**：本工具能驱动本机 GPU、读写权重目录，默认暴露到局域网是不可接受的风险；令牌是「必须显式开启 + 必须显式携带」的最小门槛，
  且不引入账号体系（与「零依赖」一致）。
- **被放弃**：默认监听 `0.0.0.0`；开启 LAN 但不鉴权（同网段任何人都能提交生图任务、读你的图片）。

### ⑪ 端口占用自动 +1 并写回设置（**v1.2.2 已被 ㉞ 取代**）
- **决定**：`listen(port, host, attempt)` 遇 `EADDRINUSE` 就 `port+1` 重试，最多 20 次；成功后把实际端口写回 `listen.port`。
  启动器同步按 `base..base+20` 探测就绪。
- **理由**：本地开发机上 8788/8188/8199 都可能在用；自动让位比「启动失败让用户改配置」体验好得多，而且写回设置后下次启动仍是稳定端口。
- **被放弃**：直接报错退出；随机挑一个空闲端口（每次启动地址都变，书签/脚本失效）。
- **事后修正（v1.2.2）**：写回设置是本条最大的失误 —— 它把"实际端口"变成了下一个"配置端口"，停在旧端口的标签页永远打不到后端，满屏 `Failed to fetch`；且自增上限 20 会让端口一路漂走。现在改为**上限 2 + 不回写 + 实际端口由 `/app/state` 顶层 `port` 自证**，理由见 ㉞。

### ⑫ GitHub 直连不可达时的镜像/代理列表可配置
- **决定**：`download.githubProxies`（数组，按顺序尝试）与 `download.hfMirror` 放进设置，设置页可编辑；
  `download.buildCandidates()` 只对 `github.com`/`githubusercontent.com`/`codeload.github.com` 与 `huggingface.co`/`hf.co` 应用镜像规则。
- **理由**：镜像可用性随地区/时间变化，写死在代码里等于把「官方源直连是否可用」变成一个必须发版的 bug；
  超时/慢速阈值同样可调（`officialTimeoutMs`/`slowThresholdKBs`/`slowWindowMs`），排障时不必改代码。
- **被放弃**：硬编码单一镜像；给所有域名都套代理（会污染非 GitHub/HF 的下载源，例如 7-zip.org）。

### ⑬ 三栏工作台（生图 / 本地 LLM / 画师同屏）
- **决定**：把三个独立页面合并成 `web/pages/workbench.js` 的**三栏并排**（`.wb-gen` / `.wb-llm` / `.wb-art`），每栏**独立滚动 + 可折叠**；顶部提供「三栏 / 两栏 / 仅生图」切换（`localStorage` 的 `dcp-workbench-layout`）；窄窗口用**纯 CSS 断点**降级（<1560px 收画师栏、<1180px 单列）；左侧导航收敛为**工作台 / 设置 / 向导**。
- **理由**：用户要求"写提示词与出图同屏" —— 原来「LLM 生成 → 填入 → 切页看结果」每轮都要来回跳页；同屏后一轮对话到出图不再离开页面。
  每栏独立滚动/折叠是为了在有限宽度里让用户自己决定"这一屏要什么"；断点降级交给 CSS 而不是 JS，缩放窗口即时生效、不产生布局抖动。
- **被放弃**：把三栏做成可拖拽分隔条（要处理拖拽状态与最小宽度冲突，收益低）；把布局存进 `data/settings.json`（纯界面偏好不该进服务端配置）；
  重写一个"总控页面"（会让面板/LLM/画师三个页面各自维护两份渲染路径）。

### ⑭ 角色识别用「更大模型 + 确定性词表 + 中文别名」，而不是宣称某个模型全能
- **决定**：不宣称任何 8 GB 可跑的模型能认角色；改用 ① 更大的通用模型（9B，`installer/llm-models.json` 默认推荐）② `server/characters.js` 的**确定性角色词表兜底** ③ **中文别名**（563 条内置 + 用户可扩展）。
- **别名表补强（本轮第二次修订）**：内置别名从 101 条扩到 563 条，覆盖 Re:Zero / FGO / 东方 / VOCALOID / 原神 / 星穹铁道 / 绝区零 / 鸣潮 / 明日方舟 / Blue Archive / 赛马娘 / hololive / nijisanji / 火影 / 海贼 / 龙珠 / 美少女战士 / 魔卡少女樱 / P5 / 赛博朋克 / 守望先锋 / LOL 等。做法：先写 583 条候选 → **用真实 `danbooru.csv` 逐条解析**（501 精确命中、43 解析到别的规范 tag、39 词表里没有）→ 43 条采纳词表给出的规范 tag（`亚丝娜 → asuna_(sao)`、`黄昏 → twilight_(spy_x_family)`…）→ 不存在的删掉 → 再删 12 条"本身是常用中文词"的别名 → **563/563 精确命中**。同时新增 `llm.characterRepair` 开关（默认开），让误命中可一键关闭。
- **理由（实测依据）**：
  - 唯一的 NL→Danbooru 模型 **BooruNL-0.8B** 在模型卡里明确写"**不输出角色 / 画师 tag**"（它只做外观 tag）；
  - 唯一的 Danbooru tag 模型 **DanTagGen-delta-rev2** 是"**tag 进 → tag 出**"，需要你先给出 characters 字段；
  - 明确声明用 **DanbooruTags 微调的权重是 27B**，最小量化也放不进 8 GB。
  换句话说，"端到端把「蕾姆」翻成 `rem_(re:zero)`"这件事在 8 GB 档位上**没有现成模型**，只能把确定性的那一半（词表 + 别名 + 校验/补全）做进程序。
- **被放弃**：把 27B 权重列进推荐目录（下不下来、跑不起来，属于虚假承诺）；在系统提示词里塞"请输出规范角色 tag"的空头约束（决策 ⑥ 已排除往提示词里补丁）；
  静默改写模型输出（改为**显式告知**：回一帧 `charactersAdded` + 界面提示"已按角色词表补全角色 tag：…"）。

### ⑮ 外接 API 只做纯聊天内核
- **决定**：`llm.provider = 'api'` 时只发"一段系统提示词（仍是 `assets/templates/anima-system-prompt.txt` 原文）+ 最近 N 条对话"到 `/chat/completions`，**不挂工具、不挂检索、不挂推理内核**。
- **理由**：用户明确要求"最简便的聊天内核"。挂工具/检索会让"这个提示词是谁写的"变得不可解释，也会引入与本项目无关的失败点；
  外接模式的价值在于**没有 8 GB 显存也能用**（或直接用更强的远端模型），而不是把本工具变成一个 agent 框架。
  `apiReady()` 只强制 `baseUrl` + `model`，`testApi()` 先 `/models` 再一条极短对话，都是为了让"配置对不对"能在 10 秒内自证。
- **被放弃**：在外接路径上加 function calling / 联网检索（超出"提示词生成"的范围）；把 Key 写进别处或加密存储（`data/settings.json` 已 gitignore，且**不进日志与交付文档**；
  引入自定义加密只会制造"密钥文件丢了怎么办"的新问题）。

### ⑯ 镜像优先 + ModelScope + 停顿/均速双阈值
- **决定**：`buildCandidates()` 增加 **ModelScope** 层（HF `/resolve/` 直链改写，`main` 同时试 `master`）；慢速判定改为**窗口均速**；新增**停滞阈值 `stallKBs`（默认 30 KB/s）**，**最后一个候选只按停滞阈值判**；请求固定带 `User-Agent` 与 `Range`；无数据 20–60 s 判死；候选来源列表打进任务日志。
- **理由**：
  - 国内网络下**官方源多不可达**（实测本机 `huggingface.co` / `github.com` 直连都不通），ModelScope 常常是唯一跑得动的源；
  - 严格按 `slowThresholdKBs = 200 KB/s` 换源会把**本来能下完**的文件掐掉 —— 实测国内镜像窗口均速常年只有 **1–2 MB/s 甚至一百多 KB/s**，且呈"停顿几秒再冲一段"的突发形态，瞬时采样会误判；
  - "最后一个候选只按停滞阈值判"是这条策略的关键：前面几个候选按 200 KB/s 竞争换源（挑更快的），最后一个只要还在动就下完（保证成功率）。
- **被放弃**：把所有源都按 200 KB/s 一路掐掉（实测会把 5 GB 级的 9B 文件反复掐死）；用瞬时速度判定（决策记录里 §附录 E 第 4 条是同一问题的第一轮修法）；
  只在官方源与 hf-mirror 之间切换（缺 ModelScope 时国内经常一个都下不动）。

### ⑰ 托盘用独立 PowerShell 进程 + `SW_MINIMIZE`
- **决定**：托盘助手是 `scripts/tray.ps1`，由启动器用 `powershell -WindowStyle Hidden` **另起一个进程**；控制台随后用 `user32!ShowWindow(hwnd, 6)`（`SW_MINIMIZE`）最小化到任务栏。
- **理由**：
  - Windows PowerShell 的 `NotifyIcon` **需要消息循环**（`Application::Run()`），放在启动器里会**挡住启动流程**（启动器还等着跟随后端进程）；
  - 托盘只取系统图标、只用系统程序集，**不引入第三方依赖、不落资源文件、不写注册表** —— 与"零依赖、拷贝即迁移、卸载=删目录"的既有约束一致；
  - 用**最小化**而不是隐藏：用户还能从任务栏找回控制台看输出（隐藏会让排障变成猜谜）；
  - 托盘进程每 3 s 看护后端，后端退出即销毁图标 —— 避免留下点不动的幽灵图标。
- **被放弃**：在启动器进程内建托盘（阻塞启动流程）；用隐藏窗口代替最小化（用户找不到控制台）；引入第三方托盘库或注册表开机自启。

### ⑱ `parseFence` 的围栏 bug 与修法
- **决定**：只收**有内容**的围栏；未闭合围栏**只有**在反引号数量为**奇数**（确实未闭合）**且**尾巴有内容时才当候选。
- **理由（真实缺陷）**：回复以闭合的 ``` 结尾时，旧正则 `[\s\S]*?` 会在末尾再匹配出一个"**结尾之后的空串**"围栏，而解析取的是**最后一个**围栏 → 正/负向永远解析为空 →「填入 / 复制」按钮**全部置灰**。
  症状是"明明回复里有 Positive/Negative prompt，按钮却是灰的"，属于用户能直接撞上的功能失效。
- **被放弃**：改成取**第一个**围栏（流式截断时第一个可能是半截的）；只认闭合围栏（会丢流式截断场景，那是这条兜底存在的理由）。

### ⑲ 启动器路径引号 bug 与修法
- **决定**：`Start-Process` 的**所有**路径参数一律加引号（后端脚本、托盘脚本、`-Url`、`-Root`）。
- **理由（真实缺陷）**：`-ArgumentList` 是**按空格拼命令行**的；项目路径含空格时（例如 `<盘符>:\...\COMFY UI\...`）不加引号会被拆成两个参数，node 只拿到前半截并以
  `Cannot find module '<盘符>:\...\<项目根前半截>'` 报错，**启动器直接失败**。
- **被放弃**：要求用户"把项目放到没有空格的路径"（与 §10.1 的可迁移性承诺和既有文档的"中文/空格路径可用"相矛盾）；改用 `--%` 或 `cmd /c` 拼串（引号规则更难维护）。

### ⑳ 中文别名表按真实词表逐条校验，并排除常用词
- **决定**：内置别名表扩到 **563 条**，**每一条都必须解析到 `danbooru.csv` 里真实存在的角色 tag**（不靠模型猜、不靠前缀猜）；同时把「时 / 天天 / 天使 / 真理 / 琴 / 小美 / 白露 / 悠悠 / 陈 / 玛丽 / 吉尔 / 忧」这 12 条**本身是常用中文词**的别名**删掉**，并给补全加了开关 `llm.characterRepair`（默认开）。
- **理由（实测依据）**：
  - 手工写别名最大的风险不是"漏"，而是"错" —— 写了一个词表里不存在的 tag，`resolveFromText` 会把它原样塞进提示词，产出一张永远对不上的图；
  - 另一类风险是**误命中**：`时`（时候/时间）、`天天`、`天使`、`真理` 这类词在中文句子里出现频率极高，一旦进别名表，普通描述也会被补上一个角色 tag；
  - 563 条里 43 条原先"看着对"的写法其实是**词表里的另一个 tag**（`亚丝娜 → asuna_(sao)` 而非 `yuuki_asuna`、`我爱罗 → gaara_(naruto)`、`克林 → kuririn`），只有拿词表逐条解析才能发现。
- **被放弃**：把别名表做成"越大越好"（未校验的长表必然混入不存在的 tag）；引入 CJK→tag 的第三方映射数据（社区没有可用映射：14 万行 `danbooru.csv` 里只有 **3 行**含汉字）；靠模型自己"记住"角色 tag（决策 ⑭ 已排除）。

### ㉑ 外接 API 必须"关思考 + 留足 token + 空闲看门狗"，否则思考型模型等于接不通
- **决定**：`apiRequestBody()` 在 `llm.api.thinking = 'disabled'`（默认）时**同时**下发 `thinking:{type:'disabled'}`（DeepSeek/Anthropic 姿势）与 `chat_template_kwargs:{enable_thinking:false}`（llama.cpp/Qwen 姿势）；外接 `max_tokens` 默认 **4096**；流式改由**空闲看门狗**（默认 90 s 无数据）判卡死；429/5xx 退避重试；`testApi()` 在"只有 `reasoning_content`、没有 `content`"时**当作失败**并给出下一步。
- **理由（实测依据）**：`deepseek-flash` 默认是思考型 —— 同一句"画一下蕾姆站在雨里"，`max_tokens=256` 时 `usage.completion_tokens_details.reasoning_tokens` 把预算吃满、`content` 为 **0 字**（`finish_reason=length`），
  界面上就是"接口 200 但什么都没有"。实测 `thinking:{type:'disabled'}` 后 `reasoning_tokens` 归零、1.3 s 拿到 602 字正文；而 `reasoning_effort`/`effort`/`chat_template_kwargs` 单独下发**都压不住**思考（仍占满预算）。
- **被放弃**：只把 `max_tokens` 调大（思考会照吃 3–4 千 token，慢且贵）；只在 UI 上解释"模型在思考"（用户要的是正文）；
  把 `/models` 拉不到就判失败（很多兼容服务没有该接口，不该因此拒绝可用的服务）。

### ㉒ 工作台三栏 1:1:2 + 画师 UI 独立成页
- **决定**：面板主体用 CSS Grid 排成 **生图设置 1 : 提示词 1 : 图片 2**（DOM 顺序保持"图片→提示词→设置"不变，用 `order` 摆正视觉顺序）；本地 LLM 用 `ReactDOM.createPortal` 挂进提示词栏的 `.dcp-slot`；画师收藏/黑名单/检索/自定义输入整体搬到独立「画师」页，面板只留模式 + 本次指定 + 计数 + 跳转入口。
- **理由**：用户要求"画师 UI 分开、腾出的空间给图片、图片与模型选择分开"。图片是结果、模型选择是输入，两者挤在一栏时图片永远被压成小图；
  而画师管理是低频操作，留在生成主路径上只会占宽度。三栏比例 1:1:2 是"图片占两倍"的最小改动（只改样式，不搬 JSX）。
- **被放弃**：让工作台自己排三栏（面板内部还有自己的一套布局，会出现两层栅格互相打架）；把 LLM 挪回独立页（第二轮的"同屏写提示词→出图"要求会倒退）；
  用 JS 计算列宽（缩放窗口会抖，CSS 断点即时生效）。

### ㉓ 默认生图模型 = anima-turbo-v1.1；本地模型只留 4B，推荐模型只给链接
- **决定**：面板初始管线改为 `animaPlain`（turbo 属于"Anima 通用"路线），并按 turbo 的推荐参数初始化（10 步 / CFG 1）；`llm.provider` 默认 `api`；
  本地只保留 `Qwen3.5-4B-UD-Q4_K_XL.gguf`（从原模型目录**迁移**进 `models/llm/`，sha256 与 hf-mirror 一致），9B/2B/DanTagGen 卸载；
  `installer/llm-models.json` 收敛为 9B/4B/2B 三条推荐，**只给来源页与镜像直链**，本机不再自动下载。
- **理由**：用户明确要求。turbo 权重是 8 GB 显存下"快且够看"的档位；外接 API 默认可用后，本地模型从"必需品"变成"可选项"，
  4B 是"想离线也能跑"的最小代价（2.71 GiB）。9B 效果最好但 5.56 GiB，属于"想要再自己下"，不该强制。
- **被放弃**：把 9B 留作默认（占 5.56 GiB 且首次要下载十几分钟）；三份权重全留着（合计 7.76 GiB，用户明确要求卸载）；
  在推荐卡片上直接一键下载大文件（用户要求"只给出链接"）。

### ㉔ 推理挡位用 `reasoning_effort`（四挡），上下文默认不外发
- **决定**：外接 API 暴露 **off / low / high / max** 四挡；off 走"关思考"双写法，其余走 `reasoning_effort`。同时把上下文策略独立出来：`llm.sendContext` 默认 **false**（界面留历史、模型只看当前这句），`llm.keepMessages` 默认 40 管本地留存。
- **理由（实测依据）**：同一句"画一下蕾姆站在雨里"（`max_tokens=4096`）——
  `thinking:{type:'disabled'}` → reasoning **0**、1.9 s、正文 760 字；
  不传参数 → reasoning 807 token；`reasoning_effort=low/high/max` → **620 / 635 / 1459**（单调可见）；
  而 `effort=low|max` → 861 / 909（与默认无异）→ **字段名必须是 `reasoning_effort`**。
  项目内实测：off 0.9 s、0 个思考帧；max 3.2 s、**430 个思考进度帧**（前端显示"模型正在思考…"），正文 455 字。
- **被放弃**：把四挡做成"越深越好"的默认（默认 off 更适合提示词生成：快、稳、便宜）；
  把上下文策略塞进"上下文条数=0"（那样界面历史也会被裁掉，和"保留历史可复制"矛盾）。

### ㉕ 工作台按"操作动线"重排 + 画师作品看本机 output
- **决定**：中间栏只放 **LLM（对话在最上）+ 提示词工具**；**提示词与参考图搬到左栏最上方**；主图压到 40vh、历史缩略图改成网格并独立滚动；图片栏加「跳转到图片文件夹」。画师页新增「本机作品」，直接扫本机 output 目录（文件名即画师 tag，与面板同一口径），支持搜索、一键收藏、空态明确写「本地没有产品」。切模型/切管线**不再重置正负向提示词**。
- **理由**：用户的操作动线是"写提示词 → 生成 → 看/挑图"，而"对话"和"提示词工具"是最常点的两个入口 ——
  把 LLM 放到栏首、提示词放到左栏首，六个关键按钮才能一屏可达（实测已一屏可达）；
  图片是结果，压小主图、放大历史，才能"生成完一批马上挑图"。
- **被放弃**：让用户自己拖分隔条（要处理拖拽状态与最小宽度冲突）；把历史图做成弹窗（多一次点击，
  而"挑图"本身就是高频操作）；用 ComfyUI `/history` 拉作品列表（离线就拿不到，且历史会被清）。

### ㉖ 批处理入口必须"纯 ASCII + CRLF"：cmd.exe 不按 UTF-8 读 `.cmd`
- **决定**：`start.cmd` 一律**纯 ASCII + CRLF**，中文提示全部由 `scripts\start.ps1`（UTF-8 with BOM）打印；`scripts/check.js` 增加 **[4b]** 红线：`.cmd/.bat` 必须 CRLF + 纯 ASCII（且无 BOM）。
- **理由（真实缺陷 + 实测证据）**：
  - 交付包里的 `start.cmd` 曾是 **CRLF=0 / 裸 LF=22 / 非 ASCII 字节=168 / 汉字=47**；本机控制台代码页 = **936**；
  - 双击（`Start-Process start.cmd`）实测：cmd 报 `'…' 不是内部或外部命令`、**EXIT=9009**，窗口一闪而过，后端完全没起；
  - 抓到的错误片段是注释与下一行被拼在一起（`'…可用…setlocal'`、`'ps1" ('`、`'ecutionPolicy'`）—— 正是"UTF-8 汉字被按 GBK 读、行尾被吃掉"的典型症状；
  - 同一份包里的 `scripts\start.ps1`（BOM + 209 个 CRLF）**一直正常**，所以问题只在"双击 `.cmd`"这条入口上。
- **为什么漏了**：自动化验证全部直接调用 `start.ps1`（或 `node server/index.js`），**双击 `start.cmd` 这条最常用的用户路径从未被自动覆盖**。现已改为用 `Start-Process <包>\start.cmd` 做验收。
- **被放弃**：把 `.cmd` 存成 GBK（只对中文 Windows 有效，换台英文系统又是乱码）；给 `.cmd` 加 UTF-8 BOM（老版本 cmd 会把 BOM 当命令的一部分，风险更高）；只靠 `.gitattributes` 的 `eol=crlf`（git 不会改写已存在的工作区文件，内容本身必须写对）。

### ㉗ 最小下载挡位改成「刚好能跑默认模型」：`anima-turbo-v1.1`
- **决定**：`installer/models.json` 的档位重排 —— `anima-turbo-v1.1.safetensors` 由 `standard` 提到 **`minimal`**；`Anima-3.8B-v1.1.safetensors`（8.81 GB）与 `qwen35_4b.safetensors`（4.78 GB）由 `minimal` 降到 `standard`。最小挡位因此 = **turbo + qwen_3_06b_base + qwen_image_vae ≈ 5.24 GiB**；standard / full 的**总量与内容不变**（25.69 / 47.27 GiB）。
- **理由**：面板默认生图模型早就换成了 `anima-turbo-v1.1`（决策 ㉓），但最小挡位当时给的还是 8.81 GB 的 Anima-3.8B 加它专用的 4.78 GB 语义编码器 —— 用户点了"最小下载"要下 **14.00 GiB**，却**拿不到默认模型**（面板只能回落到别的权重）。
  改成 turbo 之后，最小挡位 5.24 GiB 就是"面板默认配置开箱能出图"的精确最小集：UNETLoader(turbo) + CLIPLoader(qwen_3_06b_base, type=stable_diffusion) + VAELoader(qwen_image_vae) + 通用 Anima 采样器（er_sde/simple）。首下体积降到原来的 **37%**。
- **验证**：`GET /app/setup/plan?mode=embedded&sel=minimal` 返回 `tiers={minimal:5.24GiB, standard:25.69GiB, full:47.27GiB}`，minimal 选中恰好这 3 个文件；`Anima-3.8B-v1.1` 与 `qwen35_4b` 出现在 standard。
- **被放弃**：把 3.8B 直接删掉（它是质量更高的一档，只是不该压在"最小"里）；把 turbo 同时留在 minimal 与 standard 两档（档位是包含关系 `minimal ⊂ standard ⊂ full`，重复声明会让"总大小"算两遍）。

### ㉘ 镜像梯队必须是"数据"，不能是代码

- **决定**：`server/download.js` 的 `buildCandidates()` 只负责**展开模板**，具体镜像全部来自设置：`download.hfMirrors` / `nodeMirrors` / `jsdelivrMirrors` / `githubProxies` / `extraMirrors`。模板占位符：`{url} {repo} {owner} {name} {rev} {path} {file} {ver} {host}`。设置项为空数组时，`normalize()` 用基地址（`modelscope` / `aifasthub` / `hfMirror`）组合出默认梯队。GitHub 代理同时支持两种写法：前缀式 `https://gh-proxy.com/`（自动补 `{url}`）、查询式 `https://down.npee.cn/?{url}` 与换主机式 `https://kkgithub.com/{repo}/releases/download/{ver}/{file}`。
- **理由**：上一版把 hf-mirror 和 ModelScope 的改写规则硬编码在 `if/else` 里，本轮实测发现"哪个源快"**随时段剧烈变化**（同一台机器、同一条链接：ModelScope 74–95 MB/s → 2–7 MB/s，aifasthub 86–109 → 1.2–2.2），而且新源（gitee / gitcode / aihub）不断出现。硬编码意味着换源要改代码、用户在自己网络里遇到问题无解。
- **代价**：模板写错时错误更隐蔽 —— 所以 `buildCandidates` 对每个模板都做 `new URL()` 校验，且任务日志会打印"候选来源 N 个：官方源 → modelscope.cn → …"，排障时一眼看出到底试了哪些源。

### ㉙ 「10 秒内没有进展就换源」与「停滞判定」分开，且都比"慢速阈值"硬

- **决定**：三条规则并存 —— ① `startDeadlineMs`（默认 10 s，从**发出请求**计时）：连接已建立但累计收到 < 64 KiB 就换源；② `stallDeadlineMs`（默认 15 s）：下载中途连续这么久没有新字节就换源，**对所有候选生效（含最后一个）**；③ 原来的窗口均速规则保留，但只用来在候选之间"挑更快的"，**最后一个候选只按停滞判**。
- **理由**：旧实现只按"30 s 窗口均速 < 200 KB/s"判慢，遇到"连上但不吐数据"（实测 ModelScope 的 CDN 在不带 UA 时就是这样）要干等半分钟；用户明确要求 10 秒无进展就换。而"完全没有新字节"与"只是慢"是两件事：国内镜像常年只有一两百 KB/s，若最后一个源也按"慢"掐，就会出现"所有源都慢 → 全部被掐 → 明明能下完却失败"。
- **为什么用 64 KiB 而不是"收到第一个字节"**：实测有些站会先回一个几百字节的 JS 验证页/错误页（中科大 `mirrors.ustc.edu.cn` 的 895 B 验证页、ghps.cc 的 4 KB 人机校验页），那不算"开始下载"。
- **验证**：`round5-mirrors.cjs` 里用产品代码对每个源真下 100 MiB；`DCP_DL_DEBUG=1` 可打印每秒采样的字节数。

### ㉚ 进度/速度恒为 0 的根因是"计数从来没接上"，不是前端

- **决定**：把字节计数挂到 `pipeline` 的 `Transform` 上（`transform(c,_e,cb){ got += c.length; cb(null,c) }`），**不用** `'data'` 监听。
- **理由**：旧代码 `let got = startAt;` 之后没有任何一处 `got += …`，于是：进度恒 0%、速度恒 0、ETA 恒空；最严重的是 `if (got <= startAt) die(…)` 的看门狗**永远成立**，会把正常下载在 20–60 s 处掐死。用 `'data'` 监听虽然也能计数，但会把流切到 flowing 模式、绕过 `pipeline` 的背压（大文件下载时容易把内存堆起来）。
- **为什么长期没发现**：只看结果是对的（文件确实下下来了），过程指标全错只有用户盯着进度条才会察觉 —— 用户就是这么报上来的（"无论真实下载速度怎么样，面板显示下载速度都为 0"）。

### ㉛ `save()` 不写派生值：否则默认梯队会被第一次保存永久钉住

- **决定**：`config.save(patch)` 写盘前删掉 `download` 里的派生键（`hfMirrors` / `nodeMirrors` / `jsdelivrMirrors` / `extraMirrors`），除非**用户显式设置过**（patch 或当前文件里存在该键）。
- **理由**：`save()` 写的是"归一化后的完整对象"，而镜像梯队是 `normalize()` 派生出来的。于是任何一个 `PUT /app/settings`（例如"测试连接"按钮内部就要先存一次配置）都会把**当时那版默认梯队**固化进 `data/settings.json`。实测踩到：本轮先后两次升级默认梯队，本机 `settings.json` 里却被钉着 4 条旧值，导致"代码改了、运行时没变"，排查了十几分钟。
- **附带收益**：把项目拷到别的机器时，`settings.json` 里只有用户真正设过的值，新环境会用当前版本的默认梯队。

### ㉜ 角色 tag 要"规范化"，不只是"补全"

- **决定**：`characters.repairAnswer()` 除了"缺就补"，还负责"写法不规范就地改成规范写法"：`rem (re:zero)`、`rem(re:zero)`、`rem re:zero`、以及外接模型在代码围栏里产生的 Markdown 转义 `rem \(re:zero\)` → 统一改成 Danbooru 规范写法 `rem_(re:zero)`；改动通过 `charactersFixed` 帧如实报告（前端显示"已把角色 tag 改成规范写法：X → Y"）。`normalizeKey()` 也增加了"去反斜杠"。
- **理由**：实测 `deepseek-flash` 会把 `rem_(re:zero)` 写成 `rem (re:zero)`，甚至 `rem \(re:zero\)`。旧逻辑只做"宽松匹配判断已存在"，于是**留着不规范写法**（用户复制进 ComfyUI 拿到的不是规范 tag）；更糟的是转义写法既没被识别为"已存在"、又被 bare 判断拦住，导致同一个角色以两种写法出现两次（实测抓到）。
- **被放弃**：直接把模型输出里的括号转义全部去掉（会误伤负向提示词里的 `\(` 之类）；用 Danbooru 词表做全量文本替换（40,931 条 tag 的回溯匹配太慢，且会误改普通英文词组）。

### ㉝ 项目改名与"低门槛"叙事

- **决定**：项目名统一为**「超低门槛 ComfyUI 工作流集成应用」**（`package.json` 的 `displayName`/`description`、`web/index.html` 标题、面板头部徽标、托盘脚本、四份文档），README 开头新增"为什么说超低门槛"对照表（传统 ComfyUI 门槛 → 这个应用怎么拿掉），强调**下载完成即可使用**。
- **理由**：用户明确要求突出"低门槛、易上手、下载完成即可使用"。名字里带"工作流集成应用"而不是"面板"，因为它的主体是"一条能出图的完整链路"（运行时 + 权重 + 提示词 + 画师 + 面板），不是单纯的 UI 皮肤。
- **一致性**：`scripts/check.js` 已覆盖 `.cmd` 编码、脱敏、i18n 键集一致性；改名涉及的字符串都在文档与少量源码里，改动后 17/17 自检通过。

### ㉞ 退出必须连带停止"本程序拉起的" ComfyUI（v1.2.2，取代决策 ⑪ 的端口部分）

- **决定**：① 新增 `POST /app/quit` 做优雅退出，托盘退出**先礼后兵**；② 进程归属走 `data/run/comfy-owner-<pid>.json` + 五条谓词，只清自己拉起的；③ 端口 `EADDRINUSE` 最多自增 **2** 次，**不回写**设置，实际端口由 `/app/state` 顶层 `port` 下发。
- **理由**：Windows 上 `taskkill /F` = `TerminateProcess`，实测不给 node 任何执行机会（`SIGTERM`/`SIGINT`/`SIGBREAK`/`exit` 处理器一个都不跑），所以"退出页面/关托盘"这种外部动作**没法**让后端自己收尾 —— 必须先请求 `/app/quit`，再由"托盘按记录兜底 + 下次启动清孤儿"覆盖硬杀路径。
  至于"按端口找监听者再杀"（旧 `stop()`）必须删掉：用户完全可能自己在别处起 ComfyUI，那种实例没有任何归属记录，唯一安全的判据是"我写过记录 + 命令行确实是记录里的那个 `main.py`"。
- **被放弃**：把归属记录存进 `settings.json`（会把机器专属的 pid/路径写进用户配置，且每次启动都在动设置文件）；用"最近启动的 ComfyUI"启发式猜（会误杀）；只靠 `/T` 强杀（硬杀路径下清理逻辑根本没机会跑）。
- **边界**：直接对后端进程 `taskkill /F` 时进程内兜底必然不执行（Windows 硬边界），由四层防护覆盖；`scripts/start.ps1` 的 `$proc.Kill()` 仍是单进程杀（不在本轮范围），后果由"下次启动 `cleanupOrphans`"兜住。详见第十一轮附录与 `docs/ROUND11-VERIFY.md`。

---

## 13. 验证记录

> 说明：本节只记录**真正跑过**的项，并明确区分「实测通过」与「未端到端实测」。
> 未实测项**不代表有问题**，只代表本次没有条件覆盖。

### 13.1 已实测项

| # | 项 | 结果 |
|---|---|---|
| 1 | **真实出图**（经本项目后端反代提交 ComfyUI） | ComfyUI **0.37.0** + **RTX 5060 Laptop 8GB**，512×512 / 8 步 / `anima-turbo-v1.1` + `qwen_3_06b_base` + `qwen_image_vae`：**8.3 秒**返回有效 PNG，落盘 `anima-turbo-v1.1/dairi_1_00001_.png`（253,327 B） |
| 2 | **面板纯函数与图构建器回归** | **32/32 通过**；且三个图构建器（`animaGraph` / `animaPlainGraph` / `qwenGraph`）在不传 `savePrefix` / `refImage` 时与插件版 `lib/client.js` **逐字节等价**（含 `ImageScaleToTotalPixels.resolution_steps = 1` —— 这是 v0.7 的 blocker，不可回退） |
| 3 | **本地 LLM 运行时** | llama.cpp **b11177 CUDA 版**安装成功；`llama-server` **3 秒就绪**；默认 GGUF 加载成功 |
| 4 | **本地 LLM 对话** | 连续 7 轮对话中上下文**恒为最近 5 条**；`新开对话` 后为 **0 条**；发给模型的系统提示词与 `assets/templates/anima-system-prompt.txt` **逐字节一致**；输出为**单个代码围栏**且含 `Positive prompt:` / `Negative prompt:` |
| 5 | **F3 下载策略** | 官方源 **10 秒超时** → 自动切到 `hf-mirror`，并在任务日志里明确提示；文件下载完成 |
| 6 | **前端渲染** | 无头 Edge 渲染 `http://127.0.0.1:8788/` 得到完整 DOM（外壳导航 + 面板头部 `🎨 超低门槛 ComfyUI 工作流集成应用 v1.0.0` + 图片窗口/提示词/画师/参数分区），**无 JS 报错** |
| 7 | **脚本规范化** | 三个 `.ps1` 均为 **UTF-8 with BOM + CRLF**，PowerShell 解析错误 **0**；`installer/models.json` 保持 BOM |
| 8 | **下载引擎字节计数（第七轮修复）** | 用产品路径 `dl.download()` 重下 `qwen_image_vae.safetensors`（253,806,246 B）：进度 **0% → 100%**、速度帧有真实数值（2.18 MB/s）、`sha256` 校验通过、文件落位。修复前同一路径的 `got` 恒为初值（进度/速度恒 0，看门狗会误杀） |
| 9 | **镜像梯队结构（第七轮）** | `buildCandidates()` 展开结果：HF 权重 **7 个候选**（官方 → ModelScope master/main → aifasthub → hf-api.gitee.com → ai.gitcode.com → hf-mirror）；Node **5 个**；GitHub Release **5 个**（官方 → gh-proxy → down.npee.cn → ghproxy.net → ghfast.top）；jsDelivr **6 个**。`round5-mirrors.cjs` 的 11 项结构/声明断言全绿 |
| 10 | **每组件 ≥3 个镜像来源（第七轮）** | 按**主机去重**的实测可用来源：`qwen_3_06b_base` **3 个**（ModelScope 2.54 / aifasthub 0.23 / hf-api.gitee 1.10 MB/s）、`qwen_image_vae` **3 个**（ModelScope 2.62 / aifasthub 0.25 / hf-api.gitee 4.92 MB/s）、Node 便携包 **3+ 个**（清华 TUNA 可用，官方/华为云/npmmirror 在本轮时段性变慢）。**`anima-turbo-v1.1`（3.90 GiB）只有 2 个**（ModelScope 3.67 MB/s + aifasthub 0.23 MB/s），见 §13.2 |
| 11 | **向导进度不丢 + 全局任务条（第七轮）** | `GET /app/jobs?kind=setup` 能列出正在跑的安装任务；无头 Edge 实测：起一个真实 setup 任务 → 顶栏出现 `⏳` chip → 向导页显示进度与"已下载 X / Y" → 切到画师页再切回 → **进度块仍在且百分比不回退** |
| 12 | **角色 tag 规范化（第七轮）** | 单元测试 **10/10**：`rem (re:zero)`、`rem \(re:zero\)`（Markdown 转义）都被就地改成 `rem_(re:zero)` 并如实报告；已是规范写法时一个字都不动；外接 API 端到端 13/13（正文里出现规范写法） |
| 13 | **镜像测速（第七轮）** | `GET /app/download/speedtest` 对每个候选来源真下 N MiB 并返回 `{firstByteMs,gotBytes,mbps,ok,partial}`；设置页表格渲染正常（无头 Edge 实测出现 `ok-row`） |
| 14 | **便携包完整性（第七轮）** | `api.github.com` 可直连，官方 v0.37.0 资产的 `size` + `sha256`（`7805f634…7d65`）已写进代码作为校验基准；`hf-mirror` 上 v0.3.59 的转存包 sha256 与 GitHub API 一致（`a1cf7b10…9c1a`），作为"官方旧版兜底"并带哈希校验 |

### 13.2 未端到端实测项（如实列出）

| # | 项 | 说明 |
|---|---|---|
| 1 | ComfyUI 便携包从 GitHub 的**完整下载 + 解压链路** | 在本机网络条件下的成功率未验证（官方源不可达，只能走代理/镜像；大包解压耗时也未计时） |
| 2 | 官方 `huggingface.co` **直连** | 本机不可达，因此全部走镜像；「官方源直连成功」这条分支未经实测（代码里它是候选列表第一项） |
| 3 | CUDA 版 llama.cpp 在**非 Blackwell 显卡**上的表现 | 只在 RTX 5060 Laptop（Blackwell）上实测；`cudart64_13` 与老驱动/老卡的兼容性未知 |
| 4 | **非 Windows 平台** | 代码含非 win32 分支（`taskkill`/`process.kill` 兜底、`which`），但从未在 Linux/macOS 上运行；启动脚本与向导面向 Windows |
| 5 | `git` 模式的 ComfyUI 安装（clone + venv + pip） | 未实测（推荐路径是便携包） |
| 6 | 局域网模式的实际多机访问 | 令牌校验逻辑可由代码与接口验证，但未做跨机端到端测试 |
| 7 | 模型 sha256 校验的**失败路径** | 下载成功路径已被大小校验覆盖，sha256 不符（文件损坏）场景未构造 |
| 8 | ~~9B 默认推荐模型的下载完成 + 加载运行~~ | **已补齐（本轮末）**：ModelScope 下完 5,966,095,584 B，sha256 与远端 LFS 一致；8 GB 显存 + ComfyUI 在线的条件下 `-ngl 99` 全量上卡，**12.3 s 就绪**，英文/中文/角色识别三题均正常，见附录 I |
| 9 | ModelScope 层在**非 GitHub/HF 来源**与**无镜像仓库**时的行为 | 只实测了"hf-mirror 不可达时由 ModelScope 下完"这条正向路径；仓库不存在的 404 跳转是代码保证、未单独构造 |
| 10 | 角色词表对**冷门角色 / 日文假名 / 罗马字变体**的召回率 | 内置 563 条别名**逐条核对**过词表（终检脚本 563/563 精确命中；运行时 `aliasMisses=0`），接口级回归 9/9 通过 —— 但这是**正确性**而非**召回率**：`レム` 这类假名写法与冷门角色仍未覆盖，靠 `data/character-aliases.json` 补 |
| 11 | `anima-turbo-v1.1` 的**第 3 个镜像来源** | **本环境做不到，原因已查明**：能给出快照级镜像的三家（ai.gitcode.com / hf-api.gitee.com / aihub.caict.ac.cn）镜像的都是 **2026-02/03 的旧快照**，`split_files/diffusion_models/` 里只有 `anima-preview.safetensors`，而 turbo 是 2026-08-24 之后才上传的。目前该文件实际只有 ModelScope（快）+ aifasthub（很慢）+ hf-mirror（限速且本轮首字节超时）三个候选，`installer/models.json` 里声明了这 3 条。**未解决**：如果 ModelScope 也不可用，3.9 GiB 只能靠很慢的 aifasthub 或等镜像同步 |
| 12 | 镜像速度的**绝对值** | 同一台机器、同一条 ModelScope 链接在不同时段实测 74–95 MB/s → 1.9–7.5 MB/s（约 30 倍波动）。因此产品判定"可用"的口径是**有没有进展**（10 s/15 s 规则），不设绝对速度门槛；文档里的速度数字必须带测量时间才有意义 |
| 13 | `down.npee.cn` 的**长期稳定性** | 本轮 4/4 通过（4.07–24.92 MB/s），但它与 gh-proxy 一样是社区代理，无法保证长期可用；产品已把它放在 gh-proxy 之后作为第二个快源，失败会自动继续往下试 |

---

## 14. 后续工作建议（按价值排序）

1. ~~完成 9B 默认模型的下载与加载验证~~（已在附录 I 补齐）：把 5.56 GiB 的权重下完（可先手动下载再「添加本地路径」），
   在 8 GB 显存下记录"能否加载、需要把 `llm.gpuLayers` 调到多少、首 token 延迟与显存占用"，然后把结论回填到 §13.1/§13.2、`README.md` 的已知限制与 FAQ 第 14 条。
2. ~~**向导的便携包下载做成可续传 + 校验**~~（**第七轮已完成**）：`download()` 支持 `.part` 续传；便携包现在从 `api.github.com` 的 `digest` 取 **sha256 + size** 做校验（本环境该 API 可直连），钉住版本的资产还有一张内置的 `size/sha256` 兜底表；
   官方渠道全不通时回落到**哈希校验通过的官方旧版**（v0.3.59），再不行才是明确标注的第三方构建。仍未做的是"下载到一半断网后的一键继续"这类交互体验（引擎层已支持续传）。
3. **给面板加「仅收藏」快捷入口**：`/app/artists/search?source=favs` 与面板 `artistFavOnly` 都已存在，
   缺的是面板主界面（非指定模式）直接进入「随机收藏」的显眼入口；改动限定在 `web/panel.js` 的画师分区锚点内。
4. **`data/` 的加密与备份**：`data/` 目前是明文 JSON（含 `comfy.dir` 外部路径与 **`llm.api.apiKey`**）。建议加一个「导出/导入设置包」
   （导出前可选择是否脱敏外部路径与 Key），并说明备份策略；顺带把收藏/黑名单做成可导入导出的小文件。
5. ~~修掉 `package.json` 里失效的 `check` 脚本~~（**已完成**：`scripts/check.js` 覆盖语法 / JSON / 词典一致性 / `.ps1` 编码（BOM+CRLF）/ 脱敏五类自检，`node scripts/check.js` 当前全绿）。
6. ~~让 `comfy.autoStart` 真正生效~~（**已完成**：`main()` 在端口就绪后按该值后台调用 `comfy.launch()`，未配置目录时只记一条 warn，不阻断启动）。
7. **长任务可取消**：`jobs.js` 目前只有「创建/查询/流」，没有取消。建议加 `POST /app/jobs/{id}/cancel`
   （置 `job.cancelled`，下载循环与安装循环检查该标志），并在 `job-view.js` 的进度弹窗上加取消按钮。
   对 5 GB 级的 9B 下载尤其有用（当前只能停后端）。
8. **i18n 覆盖率自动校验**：加一个开发期脚本，断言 `zh.json` 的 `ui` 键集合与代码里出现的 `t("...")` 键集合一致，
   并扫描 `panel.js` 里的中文字符串出现在 `zh.panel` 里（或明确列入白名单），防止上游文案改动后静默漏译。
9. **给 LLM 加 GBNF 语法强约束**：llama.cpp 支持 `grammar`，可以直接约束输出为
   ```` ```\nPositive prompt: ...\n\nNegative prompt: ...\n``` ```` 的形状，从根上解决小模型不遵守围栏的问题
   （比 `normalizeAnswer()` 的输出侧兜底更彻底，且不触碰系统提示词原文——与决策 ⑥ 不冲突）。
   落地建议：把语法放进 `assets/templates/` 并在 `data/settings.json` 加开关，默认关闭以便对照实测。
10. **继续扩展角色别名的覆盖率**：内置 563 条已 100% 校验指向真实角色 tag，但仍以高频角色为主（冷门角色、`レム` 这类日文假名写法未覆盖）。建议 ① 支持从文件批量导入别名（现在只能一条条填）；
    ② 在检索结果里给出"这个 tag 的 post 计数"，让用户判断该不该加；③ 记录"哪些名字被解析成空"用于补别名。
11. **补 `download.officialFirst` 的真实语义**：它目前只是设置页上的一个开关，`DEFAULTS`/`normalize()` 里没有这个键，
    因此不会持久化，也不会影响候选顺序。要么实现它（决定官方源是否排到镜像之后），要么从设置页移除，别留一个"看起来有用"的空开关。
12. **补充非 Windows 与旧显卡的实测记录**：把 §13.2 的未实测项逐条验证后回填到本文档，并在 `README.md` 里如实标注支持范围。

---

## 文档版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0.0 首次编写 | — | 与 `comfy-panel-standalone v1.0.0` 同步；覆盖架构、后端逐模块、前端与面板改造锚点、数据、安装向导、配置、接口、安全边界、FAQ、与早期插件形态差异、决策记录、验证记录与后续建议 |
| v1.0.0（第二轮） | 本轮追加 | 交付物清单补 `server/characters.js`、`installer/llm-models.json`、`web/pages/workbench.js`、`web/styles/workbench.css`、`scripts/tray.ps1`；后端补 characters 词表模块与 `llm.js` 的 `provider` 分支、下载的 ModelScope / 停滞双阈值 / UA+Range+看门狗与 `normalizeDownloadUrl`；前端补**工作台布局**（§4.8）与 i18n 现状（333 / 317 / 4）；数据表补 `data/characters/` 与 `data/character-aliases.json`；接口补 7 个新端点；配置表补 `llm.provider`/`llm.api.*`/`download.modelscope`/`useModelScope`/`stallKBs`；决策记录**追加 ⑬–⑲**；验证记录补 3 条未实测项并新写 **附录 H（第二轮改动实测）**。**如实标注**：9B 默认模型的下载与加载运行验证尚未完成 |
| v1.0.0（第二轮补强） | 本轮追加 | 内置中文别名从 101 条扩到 **563 条**（覆盖 Re:Zero / FGO / 东方 / VOCALOID / 原神 / 星穹铁道 / 绝区零 / 鸣潮 / 明日方舟 / Blue Archive / 赛马娘 / hololive / nijisanji / 火影 / 海贼 / 龙珠 / 美少女战士 / 魔卡少女樱 / P5 / 赛博朋克 / 守望先锋 / LOL 等主流作品），**每一条都用 `danbooru.csv` 逐条核对**（583 条候选 → 删 20 条 → **563/563 精确命中**，运行时自检 `aliasMisses=0`）；刻意排除「时 / 天天 / 天使 / 真理 / 琴 / 小美 / 白露 / 悠悠 / 陈 / 玛丽 / 吉尔 / 忧」等常用中文词；新增设置项 `llm.characterRepair`（角色词表补全开关，默认开）。 |
| v1.0.0（第三轮） | 本轮追加 | §3.7 外接 API 补 `apiRequestBody()`（关思考双写法）/ `listApiModels()` / `normalizeApiBase()` / 空闲看门狗 / 退避重试与新的 api 配置键（`thinking`/`retries`/`idleMs`/`maxTokens`）；§8.3 补 `POST /app/llm/api/models`；§4.8 改写为"面板内三栏 1:1:2 + 画师独立页 + LLM portal 插槽"；决策记录追加 **㉑（关思考）㉒（三栏与画师页）㉓（turbo 默认 / 4B 迁移 / 推荐只给链接）**；验证记录补 DeepSeek 12/12、工作台 16/16、round2-ui 23/23；新增 **附录 K**。 |
| v1.0.0（第四轮） | 本轮追加 | 回车发送；外接 API **推理四挡**（`reasoning_effort`，实测 off/low/high/max；旧 `thinking` 自动迁移）；`sendContext`/`keepMessages` 上下文策略（界面留历史、默认不外发）；工作台重排（LLM 栏首、提示词工具第二、提示词与参考图进左栏、主图变小/历史变大、跳转图片文件夹）；默认画师 **大随机**；切模型不再清空提示词；新增 **`server/works.js`** 与本机作品接口（`/app/artists/works`、`/app/output/file`、`/app/open-folder`）；决策追加 **㉔㉕**；验证补 round4 30/30、round2-ui 23/23、round3-api 13/13、llm-test LLM_OK；新增 **附录 L** |
| v1.0.0（第五轮） | 本轮修复 | **修复"双击 start.cmd 启动失败"的真实缺陷**：`.cmd` 由 LF+UTF-8 中文改为 **纯 ASCII + CRLF**（cmd.exe 按 OEM 代码页读批处理，中文注释会把行尾吃掉 → exit 9009）；`check.js` 新增 **[4b] 批处理编码红线**（自检 16 → **17 项**）；用 `Start-Process <包>\start.cmd`（等价双击）补上验收缺口；决策追加 **㉖**、新增 **附录 M**。 |
| v1.0.0（第六轮） | 本轮调整 | **最小下载挡位改为 `anima-turbo-v1.1.safetensors`**：`installer/models.json` 里 turbo 由 standard 提到 minimal，Anima-3.8B-v1.1 与 qwen35_4b 降到 standard → minimal **14.00 GiB → 5.24 GiB**（standard 25.69 / full 47.27 不变）；决策追加 **㉗**；向导/计划接口实测 `tiers={5.24, 25.69, 47.27}`。 |
| **v1.2.2**（第十一轮） | 本轮修复 | ①**退出即停**（§3.1/§3.5/§8.1/§8.2）：新增 `POST /app/quit`，收尾 = 停本程序拉起的 ComfyUI（`comfy.stopOwned`）→ 停 LLM → 关 HTTP → 落盘 → `exit 0`；`SIGINT/SIGTERM/SIGBREAK` 走同一套；`process.on('exit')` 加**纯同步**兜底 `comfy.killOwnedSync()`（只用 `spawnSync`，因为 `/F` 打死进程时唯一的执行机会是"此刻正在跑的同步代码"）；托盘 `scripts/tray.ps1` 改**先礼后兵**（先 `POST /app/quit`，6 s 请求超时 + 最多等 8 s，判据是"进程真的消失"，失败才回退 `/T /F`；两条路径最后都按归属记录再清一次，日志用 `graceful`/`forced`/`already-stopped` 区分）。②**归属记录与五条谓词**（§3.5）：`data/run/comfy-owner-<pid>.json`（`launch()` 成功即写、子进程 `exit` 即删）+ `verifyOwnership()`（记录可解析 → 进程存活 → 命令行含 `main.py` → 命令行反推入口目录 == 记录 `codeDir`（或含记录 `mainPy`）→ pid ≠ 自身）；任一条不满足**只记 WARN、绝不动手**。`cleanupOrphans()` 只在启动时清**自己写过记录**的孤儿；`ownedTargets()` 两来源（内存 `state.pid` = 亲自 spawn 的直接证据；落盘记录 = 跨进程孤儿的唯一识别方式）；`stopOwned()` 不再以"端口是否在线"为条件（自己拉起的实例可能已离线但进程仍在）。**删除**旧 `stop()` 的 `pidListeningOn(port)` 兜底 —— 那会杀掉用户自己启动的实例。③**端口**（§3.1/§7/§10）：`MAX_PORT_BUMP=2` + 每次 WARN + 超限 `log.error`/`DCP_PORT` 建议/`exit 1`；**取消 `save({listen:{port:actual}})` 回写**，实际端口只存内存（`actualPort`/`listenPort()`）；`/app/state` 顶层新增 `port`（决策 ⑪ 被 ㉞ 取代）。④**前端**（§4/§8.1）：顶栏「服务地址」徽标（`data-dcp-service-port`；取值链 顶层 `port` → `listen.port` 兜底换 tooltip → 不渲染；非法值一律当缺失）；断连只在"连通→断连"跳变画**一条**可操作 banner（`linkState.lost` 兼作闩，`count` 只累加不进 DOM；恢复即消失）；首帧连不上改 5 s 轻探自愈；同文案 error toast **30 s 节流**（`suppressedToasts` 只读可见）；`__DCP_SAVE_ARTISTS__` 单飞 + 按 key 合并 + **只在真变更时广播**（断开"广播→setState→保存→广播"回声，实测空闲请求 3659 → 5 / 22 s）。⑤版本号三处 → `v1.2.2`。⑥验证记录见**第十一轮附录**。 |
| **v1.2.1**（第十轮） | 本轮修复+新增 | ①**常驻标签页**：导航改成 `.tab-panes > .tab-pane`，切页只隐藏不卸载 —— 修掉"切到设置就失去提示词与 LLM 历史"（两个根因：切页即卸载；`renderPage` 的 key 掺了 `renderKey`，按需加载完成时把刚挂载的页面整体重建）。后台标签页跳过 5 秒轮询；幂等 GET 加瞬时失败重试（`fetchRetry`）。②**画师分组入口补齐**：收藏与黑名单 chip 加「＋分组」，分组卡片可展开成员、逐个移出、重命名；**面板内**新增 🗂 加组入口（下拉行 / 已选 chip / 分组随机块）；`persistArtists`/`__DCP_SAVE_ARTISTS__` 改按 key 传与按 key 写，新增 `POST /app/artists/groups/replace`。③**思考过程可见 + 复制可靠**：`reasoning_content` 逐帧以独立字段 `reasoning` 下发（`thinking` 长度字段保留），前端渲染成正文之前的「🧠 思考过程」块；"只有思考没正文"时不再重复发一遍文本；前端 `setLast` 改为按"最后一条 assistant 消息"定位（旧写法打在 system 说明帧上 → 助手气泡恒空、复制按钮全灰），并用 `authoritative` 标记避免流式累积值覆盖服务端规范化后的正文。④**历史永久保留**：`POST /app/llm/session/new` 改为**只开新会话不删旧**（新增 `llm.openSession`，旧语义移到 `/app/llm/session/discard`），新增 `GET /app/llm/sessions`（只给摘要）、`DELETE /app/llm/session/:id`（唯一真删除入口）、`sessions.json` 的 `lastSessionId`（自动接回上一次对话）与侧栏「历史对话（永久保留）」卡片；`llm.keepMessages` 上限 200 → 2000。⑤**版本号 → `v1.2.1`**（`config.js` / `package.json` / 面板 `BUILD_TAG`），`scripts/check.js` 新增 **[5b] 版本号一致性**（自检 17 → **19 项**）。⑥验证记录见第十轮附录。 |
| **v1.2.0**（第九轮） | 本轮修复+新增 | ①**输出目录不再写死**（§3.5/§3.10 与 §8.1 的 `/app/comfy/outputdir`、§9 新增边界行）：新增设置 `comfy.outputDir` 覆盖，留空时按「本程序拉起的实例 → 监听端口进程的命令行反推其入口目录 → 按模式推导」三级解析（`works.outputInfo()`，缓存 10 s）。修掉用户实测的严重问题：他自己在别处起 ComfyUI 时，本程序把「图片文件夹」与「本机作品」指向项目内的空目录，生成的照片"根本不出现在图片文件夹里"（本机实测真实出图在外部实例的 `output\<模型>\` 下，共 470 张）。②**删除历史照片**（§4.4 锚点 + `/app/output/delete`）：面板图片栏（缩略图 / 当前图）与画师页「本机作品」都能删；**两步确认**且确认按钮写明文件名（`deleteArm` 绑定"被武装的那张图"，不随 `current` 漂移）；后端只允许删 output 目录内的图片（越界/非图片 404），删空的模型子目录一并移除，并清掉 ComfyUI 历史里那条（尽力而为）。③**画师分组（最多 50 组，`store.MAX_GROUPS`）**：`data/artists.json` 新增 `groups`，新接口 `/app/artists/groups{,/create,/rename,/delete,/add,/remove}`；画师页新增分组卡片与行内「＋分组」菜单；面板新增 `randomGroup` 模式 + 具体组下拉（`artistGroups`/`artistGroupPick`）。**顺带修掉一个数据流缺陷**：面板 `persistArtists()` 写回 `window.__DCP_ARTISTS__` 时丢掉了 `groups`（面板一挂载就写一次），导致"分组随机"恒为 0 组。④**API Key 改成只写字段**（§3.1 `/app/settings` + §3.2 `save()`）：下发一律 `apiKey: ''` + `hasKey`，保存时空串 = "不改"，清空须 `llm.api.clearKey=true`；设置页显示"已配置/未配置"并加「清除 Key」。修掉"切一下思考挡位就得重新输入 API Key"（实测复现：设置页形状的保存把已存 Key 抹成空）。⑤**下载前逐源测速再固定用最快源**（§3.4）：`pickFastest()`/`probeSpeed()`，每源探 1 MiB 或最多 6 s，按实测 MB/s 排序，同一"来源家族"（host + 目录前缀）10 分钟内沿用最快源、不再重复测速；原有三条换源规则保留为兜底。⑥版本号 → `v1.2.0`；⑦验证记录见附录 P（UI 27/27、下载选源 11/11、B5 4/4）。 |
| **v1.1.0**（第八轮） | 本轮修复+新增 | ①**逐条核对 `BUGS-AND-FIXES.md` 并修复**（B6/B7/B8/B9 在本仓库确实存在，B5 也确是缺陷）：§3.1 的 `/app/state` 补 `llm.provider`/`llm.api`/`listen`（B6/B7），§4.4/§4.3 的前端就绪度与顶栏徽标改按来源判定（B6）；`web/app-shell.js` 的 `api()` 对纯对象 body 自动 `JSON.stringify`（B8）；§3.2 自检按 `llm.provider` 条件化（B9）；§3.6 向导 `setup.json` 的 `models` 合并 `installed + skipped`（B5）；§9 新增**回环来源豁免**的边界说明（B7 的第三层缺口：本机页面与 `start.ps1` 探活都不该被令牌挡下）。②**恢复面板「🔍 指定画师」的搜索框与下拉**（§4.6 锚点：v1.0.1 迁移画师管理到独立页时误删了渲染块，`artistQuery`/`artistDropOpen`/`artistFavOnly`/`artistCustom`/`useCustomArtist` 全部成为死代码），并按需求提供**收藏画师搜索**（仅收藏范围点开即列全部收藏、子串过滤、点选即用）。③新增 i18n 键 `settings.listen.lanEnabled`。④验证记录见 §13.1 与附录 O（本轮 UI 验收 23/23、B5 4/4）；⑤新增 **`AI-DECLARATION.md`**（AI 生成声明：本项目自身全部代码与文档由 AI 生成 + 第三方边界 + 免责 + "以实测记录为准"的指引），并加入 `scripts/build-core.ps1` 的 `$IncludeFiles` 白名单与"交付文档齐全"检查（附录 O.5）。 |
| v1.0.0（第七轮） | 本轮修复+新增 | ①新增 `GET /app/jobs`（列表 + running），向导按 `kind=setup` 重挂运行中任务，顶栏加全局任务条；②**下载引擎字节计数从未生效**（`got` 恒为初值）—— 进度/速度恒 0、停滞看门狗误杀正常下载，计数器改挂 `pipeline` 的 `Transform`；③**改名之前校验完整性**（实测 ModelScope 会把 242 MB 下成 126/121/112/3 MB 而流"正常结束"，旧代码会静默接受损坏文件）；④**`force` 一路传到下载引擎**（否则"重新下载"2.5 秒就"完成"）；⑤镜像梯队全面数据化（`hfMirrors`/`nodeMirrors`/`jsdelivrMirrors`/`githubProxies`/`extraMirrors` + 9 个占位符），并落地「10 s 无进展换源」+「15 s 无新字节判停滞」+「远慢于已见最佳源即换源」；⑥新增 `GET /app/download/speedtest`（每源真下 100 MiB）与设置页测速表；⑦角色 tag 规范化（含 Markdown 转义 `rem \(re:zero\)`），新增 `charactersFixed` 帧与 i18n 键；⑧`save()` 不再把派生梯队/等于默认值的 `githubProxies` 写进 `settings.json`；⑨项目改名「超低门槛 ComfyUI 工作流集成应用」；⑩新增 **`docs/HANDOVER.md` 项目交接文档**。决策追加 **㉘–㉝**，新增 **附录 N（镜像实测全表）**。**如实标注**：GitHub 系资源只有 gh-proxy.com 与 down.npee.cn 两个快源；`anima-turbo-v1.1`（4.2 GB）只有 ModelScope 是快源。 |

---

## 附：本轮端到端实测补充（发布前最后一遍实跑）

以下结果全部来自真实运行（不是静态检查），步骤可复现。

### A. 从零首次运行向导 + 内嵌模式出图（14/14 通过）

在一份**只有代码**的副本上（`runtime/`、`models/`、`data/` 全空）：

1. `scripts/bootstrap.ps1` 从官方源 `nodejs.org` 取回便携 Node **v22.14.0** 到 `runtime/node`（证明"新机零依赖"）；
2. 启动后端（端口 8791）→ 自检正确报出 `comfy-embedded-missing`；
3. 走完整向导：7-Zip 解压工具引导 → **从本机已有 ComfyUI 目录导入本体**（硬链接）→ 权重硬链接落地（`anima-turbo-v1.1` + `qwen_3_06b_base` + `qwen_image_vae`）→ 画师清单与许可落盘；
4. 布局探测到内嵌解释器；`/app/comfy/launch` 在 **180 秒**内就绪；
5. 经该项目自己的反代真机出图，产物 `embedded-smoke/noartist_1_00001_.png`；
6. `/app/comfy/stop` 一键停止成功。

### B. 迁移测试（换路径 + 换盘符，9/9 通过）

把整个项目目录复制到另一路径后，再用 `subst` 换一个盘符启动（`<盘符>:\comfy-panel-standalone`），删除 `logs/` 后：

- `/app/state` 的 `root` 指向新路径；自检 0 个 error；
- 画师清单（59,676 / 200）可读、收藏与黑名单随 `data/` 一起搬走；
- 首页静态资源、本地 LLM 运行时与模型、系统提示词文件全部可用；
- 经副本自己的反代真机出图成功（10 秒，产物 `migration-test/noartist_1_00001_.png`，150 KB PNG，`/view` 取回校验通过）。

### C. 浏览器端验收（真实 CDP 驱动无头 Edge，25/25 通过）

外壳与生图面板渲染、四个页面（本地 LLM / 画师 / 设置 / 首次运行向导）全部可打开、面板头部徽标 `🎨 超低门槛 ComfyUI 工作流集成应用 v1.0.0`、
模型下拉有内容（连通硬指标）、「一键填入」把提示词写进面板 **React state**（`readPrompts()` 与 DOM 双证）、
中英切换即时生效且**不丢已填提示词**（面板不重挂载：DOM 层先还原原文再按新词典重翻）、
画师指定模式下的「自定义画师」用**真实键盘事件**输入后规范成 `@my custom artist` 并可一键选为画师（全程无"清单外"警告）。

英文界面残留中文文本节点：**1 条**（语言切换按钮上的「中文」自身，属有意保留）。

### D. F3 下载策略（真实网络）

- HuggingFace：官方源 10 秒连接超时 → 自动切 `hf-mirror` → 文件下载成功，任务日志含「官方源不可用（已重试），本次改用镜像来源 hf-mirror」；
- GitHub（ComfyUI 便携包 1.79 GB）：官方源超时 → `gh-proxy.com`（中途速度跌破阈值被掐）→ `ghproxy.net`（连接超时）→ `ghfast.top`，逐个尝试并在日志里逐条给出失败原因；
- llama.cpp 运行时：经 `gh-proxy.com` 成功获取 **b11177 CUDA 13.4** 包（143 MB）+ `cudart`（404 MB），解压、`--version` 自检、CUDA 就绪、默认 GGUF 加载并对话成功。

### E. 本轮发现并修复的真实缺陷（都是"跑起来才暴露"的）

1. **导入过滤器按名字在任意深度跳过目录**：把 `comfy_api/input/` 一起跳掉了，ComfyUI 启动即报
   `ImportError: cannot import name 'CurvePoint' from 'comfy_api.input'`。
   修法：`output/temp/input/user` 只在**顶层**跳过，`__pycache__/.git` 才任意深度跳过。
2. **面板「一键填入」只改显示不改 React state**：直接写 DOM 的 `value` 会被 React 的 value tracker 吞掉，
   提交时用的仍是旧值（用"真实键盘事件 vs DOM 赋值"对比实测出来）。
   修法：面板通过 `window.__DCP_PANEL_API__.setPrompts()` 暴露真正的 `setState` 通道，外壳优先走它，DOM 赋值只作兜底。
3. **`job.phase` 既是方法又被当成当前阶段名写入**，第二次调用即 `job.phase is not a function`（改为 `job.phaseName`）。
4. **下载慢速判定用瞬时采样**会把"停顿几秒再冲一段"的镜像误判为低速并掐断（改为**窗口均速**判定）。
5. **启动等待 90 秒不够**（冷启动 + 抢显存），放宽到 180 秒。

### F. 未实测 / 受限项（如实说明）

1. **ComfyUI 便携包 1.79 GB 在本机网络下未下完**：官方源与三个 GitHub 代理的窗口均速都低于阈值（最快约 200 KB/s，全程多次跌破），
   脚本按策略逐源重试并最终**明确报错**（不是静默失败），同时提示可手动下载后用「本地归档」指定。
   因此"便携包下载 → 解压 → 出图"这条链路在本机只验证到「下载与切换策略」为止；
   **内嵌模式的出图链路是用「从本地已有 ComfyUI 目录导入」这条路径端到端验证的**（见 A）。
2. 官方 `huggingface.co` 直连在本机不可达（走 `hf-mirror`）；`github.com` 直连同样不可达（走代理列表）。
3. CUDA 版 llama.cpp 只在 RTX 5060 Laptop（Blackwell，驱动 616.92）上验证；CPU 版仅验证到「可下载 / 可解压 / 参数自检」。
4. 非 Windows 平台未测（`bootstrap.ps1` / `build-core.ps1` 按 Windows 编写）。

### G. 完全通过浏览器 UI 的端到端（13/13 通过）

不调用任何后端接口"代跑"，全程用真实浏览器点击/输入（CDP 驱动无头 Edge）：

1. 用「一键填入」把提示词写进面板（校验它进了 **React state**，不是只改 DOM 显示）；
2. 主模型改选 `anima-turbo-v1.1.safetensors`（这台机器的 `Anima38BV2Loader` 因 metadata 扫描失败退化成兜底名 ——
   上游既有现象，面板按规矩禁用生成并提示，按提示点「↻ 刷新模型」后手动改选即恢复）；
3. 画师档选「🎲 小随机」，点「生成 1 张（逐张）」→ 面板里出现成图；
4. 图上出现 **⭐ 收藏 / 🎯 选为画师 / 🚫 拉黑** 三个按钮，并显示该图使用的画师 tag；
5. 点 ⭐ → 收藏写入服务端 `data/artists.json`；点 🚫 → **从收藏移出并进入黑名单**（互斥验证）；再点 ⭐ → 又从黑名单移出；
6. `GET /app/artists/search?source=favs` 能查到该画师（"仅收藏"检索）；
7. 手输自定义画师 `custom_artist_probe` → 规范成 `@custom artist probe` → 一键设为画师 → 收藏 → 出现在"仅收藏"检索里。

### H. 第二轮改动实测

> 本节与 A–G 同一体例：只写**真正跑过**的项，并明确区分「实测通过」与「未完成」。数字都是本轮实跑结果，不是估算。

#### H.1 三栏工作台（布局 / 折叠 / 切换，**27/27 通过**）

| 组 | 检查项 | 结果 |
|---|---|---|
| 默认状态 | 首屏落在 `workbench`、三栏同时存在（`.wb-gen` / `.wb-llm` / `.wb-art`）、生图面板渲染成功 | ✅ |
| 布局切换 | 三栏 → 两栏 → 仅生图 的栏数、栅格列数、按钮高亮状态 | ✅ |
| 持久化 | 切到「两栏」后刷新页面，仍为两栏（`localStorage['dcp-workbench-layout']`） | ✅ |
| 折叠 | 三栏各自的 ▾/▸ 折叠与展开、折叠后只剩标题条、其它栏占满剩余空间 | ✅ |
| 断点降级 | 把视口宽度调整到 < 1560px（画师栏收起）与 < 1180px（单列 / 两栏时收起 LLM 栏） | ✅ |
| 导航 | 左侧导航只有 工作台 / 设置 / 向导 三项，默认页是工作台 | ✅ |
| 独立滚动 | 生图栏滚动的是面板自身 `.dcp-body`；LLM / 画师栏滚的是各自 `.wb-body` | ✅ |

合计 **27 项全部通过**。

#### H.2 提示词工具：填入与复制（真实点击 + 劫持剪贴板捕获）

- **「⬅ 填入」**：点按钮后，面板的 `window.__DCP_PANEL_API__` 暴露的 `readPrompts()` 与 DOM 输入框**双双**显示新提示词 ——
  证明它进的是**面板 React state**，不是只改显示（这是决策 ② 与第一轮 §附录 E 第 2 条那个缺陷的回归验证）。
  「填正负」同样两段都进。
- **「📋 复制正+负」**：在页面里**劫持 `navigator.clipboard.writeText`** 捕获写入内容，得到
  `Positive prompt: …` ＋空行＋`Negative prompt: …` 的完整两段，与解析结果逐字符一致（不是"点了没报错"这种弱验证）。
- **`parseFence` 回归**：构造"回复以闭合 ``` 结尾"的输入，旧写法解析出空串、新写法正确解析出正/负向，按钮可点 —— 决策 ⑱ 的修复被这条用例钉住。

#### H.3 角色词表与输出补全

| 项 | 实测结果 |
|---|---|
| 词表落盘 | `data/characters/danbooru.csv` = **3,518,020 B**、**140,782 行**；`index.json` 记录 `characters: 40931` |
| 角色条数 | 解析后 `GET /app/characters/status` 的 `characters` = **40,931**（即 `category=4` 的角色 tag 数） |
| 检索 | `GET /app/characters/search?q=rem` 命中规范 tag **`rem_(re:zero)`**（归一小写、下划线→空格） |
| 中文别名 | 内置 **101** 条生效：`蕾姆` / `雷姆` 都解析到 `rem (re:zero)` |
| 端到端补全 | 用**预置 2B 模型**发「画一下蕾姆站在雨里」：回复里出现了规范角色 tag，并且界面多了一条系统提示「**已按角色词表补全角色 tag：rem (re:zero)**」—— 是**显式告知**，不是静默改内容 |

> 说明：这条实测同时印证了决策 ⑭ 的结论 —— **2B 模型自己不会写规范角色 tag**，是词表兜底补上的。这也是要把词表做进程序的原因。

#### H.4 外接 API（用本机 `llama-server` 当 OpenAI 兼容端点）

- 设置页把「推理来源」切到**外接 API**，`baseUrl = http://127.0.0.1:8199/v1`、模型名填本机加载的模型；
- `POST /app/llm/api/test` **成功**（先 `/models` 探到模型列表，再那条 `max_tokens:8` 的极短对话返回正文）；
- `POST /app/llm/chat` 走**外接路径**返回**流式正文**，结束帧 `provider: "api"`；
- 外接路径同样触发了输出规范化与角色补全（与本地路径共用同一段代码）。

#### H.5 ModelScope 下载层

把 `download.hfMirror` **指成不可达地址**后重跑下载：文件确实**由 ModelScope 下完**，任务日志里能读到
候选来源列表（`官方源 → hf-mirror → modelscope`）与"当前来源 modelscope"的进度帧 —— 这条实测证明 ModelScope 层真的在承担下载，而不是只存在于代码里。

#### H.6 托盘与启动器

- 启动后**确实存在**独立的 `powershell` 托盘进程（能按进程树找到），并且 `logs/tray.log` 里写入了
  「托盘已就绪：Url=… BackendPid=… Port=…」；
- 就绪后控制台被最小化到任务栏（`ShowWindow(...,6)` 的返回值为真），从任务栏可以还原；
- 后端退出后托盘进程自行结束、图标消失（不留幽灵图标）。

#### H.7 **未完成 / 如实说明**

1. **9B 默认模型（`Qwen3.5-9B-UD-Q4_K_XL.gguf`，5,966,095,584 B ≈ 5.56 GiB）已在附录 I 补齐验证**（此前记为未完成的原因保留在此，作为"字节数对不代表文件对"的证据）：
   本机网络下**多次中断** —— 官方源连接超时、镜像（hf-mirror / ModelScope）窗口均速只有 **1–2 MB/s** 且频繁跌破停滞阈值，
   重试仍在同一位置断掉。因此截至本轮结束，**没有完成下载，也就没有做加载与推理验证**。
   结论只能到这一步：「**目录登记 + 一键下载可用**」（字节数与许可经双向核对；断点续传与候选切换都实测工作），
   后续用 ModelScope 重新完整下载（不走断点续传）后，**sha256 与远端 LFS 一致，模型随即正常工作**（见附录 I）——
   所以那次"跑出全 `?`"的根因是**文件损坏**，不是显存不够，也不是运行时不支持该模型。
2. 本轮没有做**多机局域网**、**非 Windows 平台**、**CPU 版 llama.cpp 的实际推理速度**验证（与 §13.2 一致）。
3. ModelScope 层只验证了"有同字节镜像"的正向路径；**仓库不存在**时的 404 跳转是代码保证，未单独构造用例。
4. 角色别名的**召回率**未做系统评测：只验证了内置表已覆盖的样例（蕾姆 / rem 等），冷门角色的表现未量化（详见 §I）。

---

### I. 角色别名表补强实测（563/563 精确命中）

第二轮补充：内置中文别名从 101 条扩到 **563 条**，做法与结果全程可复现（脚本留在开发用的临时目录里，不随交付物发布）。

1. **候选 583 条**：按作品人工整理（Re:Zero / FGO / 东方 / VOCALOID / 原神 / 星穹铁道 / 绝区零 / 鸣潮 / 明日方舟 / Blue Archive / 赛马娘 / hololive / nijisanji / 火影 / 海贼 / 龙珠 / 美少女战士 / 魔卡少女樱 / 犬夜叉 / 死亡笔记 / P5 / 赛博朋克 / 守望先锋 / LOL …）。
2. **用真实 `danbooru.csv`（40,931 条角色 tag）逐条解析**：精确命中 **501**、解析到**另一个规范 tag 43**、词表里**找不到 39**。
3. **43 条"解析不同"逐条人工复核**，采纳词表给出的规范 tag（`亚丝娜 → asuna_(sao)`、`桐人 → kirito`、`玛奇玛 → makima_(chainsaw_man)`、`黄昏 → twilight_(spy_x_family)`、`我爱罗 → gaara_(naruto)`、`克林 → kuririn` …）—— 这些写法**只有拿词表解析才能发现**。
4. **39 条里能修的改成词表真实存在的 tag**（`罗兹瓦尔 → roswaal_l._mathers`、`癒月巧可 → yuzuki_choco`、`小小兔 → chibi_usa`、`天王遥 → ten'ou_haruka`、`露西 → lucy_(cyberpunk)`、`陈 → ch'en_(arknights)` …）；确实不存在的（`奥托`/`言和`/`缇宝`/`海瑟音`/`卡提希娅`/`禅院真希`）与不可靠的（`猫娘`/`阿尔托莉雅alter`）**直接删掉**。
5. **再删 12 条"本身是常用中文词"的别名**：`时` / `天天` / `天使` / `真理` / `琴` / `小美` / `白露` / `悠悠` / `陈` / `玛丽` / `吉尔` / `忧` —— 这些会让普通句子（"**时**候"、"**天天**"）被误读出角色 tag。
6. **终检脚本：563/563 全部精确命中**（不接受靠前缀"猜"出来的 tag）；运行期 `buildIndex()` 还会自检一次，把未命中条数写进日志与 `/app/characters/status.aliasMisses`（当前 **0**）。
7. **接口级回归 `round2b-alias.cjs`：9/9 通过** —— 别名条数 563（接口与状态一致）、抽查 18 个中文名（`蕾姆`/`初音未来`/`钟离`/`胡桃`/`流萤`/`博丽灵梦`/`阿库娅`/`阿尔托莉雅`/`玛奇玛`/`阿尼亚`/`后藤一里`/`白上吹雪`/`阿米娅`/`星见雅`/`漩涡鸣人`/`月野兔`/`蒂法`/`猫又`）全部落到规范 tag、一句话多角色（"画一下蕾姆和钟离站在一起，时间是黄昏"）同时命中 `rem_(re:zero)` + `zhongli_(genshin_impact)` **且不再误命中**已剔除的常用词角色、设置接口把 `llm.characterRepair` 关/开都正确落盘。

> 诚实边界：以上证明的是**别名表的正确性**（每条都指向真实角色 tag），不是**召回率**。`レム` 这类日文假名写法、冷门角色仍未覆盖，需要用户用 `data/character-aliases.json` 自行补充。

---

### J. 9B 默认模型实测（下载 → 校验 → 加载 → 推理）与 sha256 完整性校验

**为什么会有这一节**：本轮下载 5.56 GiB 权重时，中途网络反复中断，靠"断点续传"补完后**字节数与目录登记完全一致**，
但模型加载后每次回答都是几百个 `?`（`content` 十六进制确认就是 `3f`）。重新完整下载后 sha256 与远端一致，
同一个模型、同一套参数立刻正常 —— 说明**"字节数对"根本不等于"文件对"**，于是本轮把 sha256 校验做进了下载路径。

#### J.1 损坏文件 vs 完好文件（同一路径、同参数）

| | 损坏文件（断点续传补出来的） | 完好文件（完整重下） |
|---|---|---|
| 字节数 | 5,966,095,584（与目录一致） | 5,966,095,584（与目录一致） |
| 本地 sha256 | `f55e6003e836…` | `6f5d30666c2d…` |
| 远端 LFS sha256 | `6f5d30666c2d…` | `6f5d30666c2d…` |
| 英文提问 "Count from 1 to 5" | 48 个 `?`（hex `3f`） | `1, 2, 3, 4, 5`（finish=stop） |
| 角色提问（蕾姆的 Danbooru tag） | 全是 `?` | `rem` |
| 经 `/app/llm/chat` 生成提示词 | 无正文 | 正常围栏 + 正/负向提示词 |

#### J.2 完好文件的实测数据（RTX 5060 Laptop 8 GB，ComfyUI 同时在线）

- 启动：`-ngl 99`（**全量上卡**，未降层），`waitedMs` 9.0 s，`/health` 通过，**12.3 s 就绪**；
- 英文计数题：1.4 s 返回 `1, 2, 3, 4, 5`；
- 角色识别（"只回答一个英文 Danbooru 角色 tag：蕾姆（Re:Zero 的女仆）"）：0.5 s 返回 **`rem`**（认对人）；
- 经项目接口的完整提示词生成（"画一下蕾姆站在雨里，撑着透明雨伞"）：13.4 s、392 字符，模型自己就写对了 `rem_(re:zero)`：
  ```
  Positive prompt: masterpiece, best quality, safe, 1girl, sol, Rem from ReZero, blue hair, orange eyes, white coat, holding transparent umbrella, standing in rain, ... , rem_(re:zero)
  Negative prompt: worst quality, low quality, worst details, jpeg artifacts, blurry, chromatic aberration, bad anatomy, extra fingers
  ```
- 角色补全帧：`charactersAdded = ["rem_(re:zero)"]`（模型已写对时不会重复补）。

> 结论：**默认推荐的 9B 在 8 GB 显存上能正常加载和推理**（本轮条件是 ComfyUI 同时在线；生成图片前可先释放显存，见 §8.6/README §11.14）。
> 但机型/驱动组合不同，`llm.gpuLayers` 该降到多少仍建议用「设置 → 本地 LLM」逐档试。

#### J.3 新增：sha256 完整性校验（下载后自动 + 手动可查）

- `installer/llm-models.json` 的 7 条记录**全部补上远端 sha256**（与 hf-mirror 的 LFS `sha256` 逐条核对）；
- `llm.downloadModel()` 下载完成后**流式计算 sha256**（8 MiB 分块，不整块读内存），一致才算成功；
  **不一致则删除文件并以明确错误结束任务**（"文件已删除，请重试（换个镜像源）"）——不让坏文件留在磁盘上等着下次踩坑；
- 目录里没有 sha256 的文件（例如从本地路径导入的）会**如实记一条 warn**："已跳过完整性校验（只校验字节数）"，不假装通过；
- 新增 `POST /app/llm/models/verify`：给任何本地 GGUF 算哈希，默认对照推荐目录里的期望值，也支持传入任意期望值自检
  （返回 `{file, bytes, sha256, expected, known, ok, ms}`；`known=false` 表示没有可对照的期望值，不判定）；
- 推荐模型卡片上装了以后多一个「校验完整性」按钮，走同一个 job，日志里逐行给出文件、本地哈希与判定结果。
- 接口级回归 `round2c-hash.cjs` **5/5 通过**：目录每条都带 sha256、错哈希判不一致、真哈希判一致、文件不存在明确失败、目录条目可不带参数直接校验。

#### J.4 应用自身下载路径的实测（不是手动 curl）

用推荐目录里的 `ggml-model-Q6_K.gguf`（DanTagGen-delta-rev2，323,077,792 B，CC-BY-SA-4.0）走
`POST /app/llm/models/download`（带 sha256 与字节数），任务日志逐步给出：

```
候选来源 4 个：官方源 → hf-mirror → modelscope → modelscope
官方源 失败（第 1 次）：连接超时（10 s）
官方源 失败（第 2 次）：连接超时（10 s）
官方源不可用（已重试），本次改用镜像来源 hf-mirror —— 可在「设置 → 下载」里调整镜像与阈值
… 进度帧 …
校验 sha256：ggml-model-Q6_K.gguf
ggml-model-Q6_K.gguf 下载完成：308.1 MB（镜像 hf-mirror，用时 27.3 s）
sha256 校验通过：c6df783ee792f6da…
```

`result` 里带回 `{source:'mirror', via:'hf-mirror', bytes:323077792, sha256:'c6df78…', verified:true}`；
模型出现在「模型管理」里。**关于默认模型**：下载器只在「当前还没有默认模型」时才会把新下载的模型设为默认；本轮测试期间 9B 曾被删掉重下，默认一时为空，于是这个 0.3 GB 的小模型临时成了默认（随后已显式设回 9B）。日常使用中若已有默认模型，下载新模型**不会**动它。

**另一条如实记录（失败也是结论）**：`cooperdk/BooruNL-0.8B-Q6_K.gguf`（629,743,872 B，Apache-2.0，目录里标 `modelscope:false`）
在本机网络下**没能下下来**：官方源两次 10 s 超时、hf-mirror 一度建立连接后 30 s 无数据、ModelScope 侧该仓库不存在（404）。
任务以失败结束，并**逐条列出每个来源的失败原因**。据此本轮顺手做了个小改进：
目录里 `modelscope:false` 的条目不再去尝试 ModelScope 候选（省掉一串无意义的 404，错误报告也干净了）。
这也再次说明"镜像优先"只是提高成功率，不保证每个第三方仓库都能在国内网络下拿到。

#### J.5 与"字节数相符"陷阱相关的边界

- 已存在同尺寸文件时**不会盲信**：目录里有 sha256 就先验一遍，坏文件删除重下（日志会写明"本地文件 sha256 不一致…删除后重新下载"）；
- 目录里没有 sha256 的（例如从本机路径导入的 GGUF）如实提示"按字节数相符复用（不做内容校验）"，不假装校验过。

---

### K. 第三轮实测（外接 API / 工作台改版 / 模型策略）

#### K.1 外接 API：DeepSeek `deepseek-flash`（真实 Key，仅本地测试用）

| 步骤 | 结果 |
|---|---|
| `GET https://api.deepseek.com/models` | 200，返回 `deepseek-flash`（`DeepSeek-V4.1-Flash`，context 1,048,576，`effort.supported_levels=[low,high,max]`） |
| 直接复现"接不通" | `max_tokens=256` 时 `reasoning_tokens=256`、`content=""`、`finish_reason=length` —— **思考把预算吃光了** |
| 参数对照 | `reasoning_effort=low` / `effort=low` / `chat_template_kwargs.enable_thinking=false` **都压不住**（reasoning_tokens 仍 256）；`thinking:{type:'disabled'}` → reasoning **0**、1.3 s 拿到 602 字正文 |
| 项目自检 `POST /app/llm/api/test` | `{ok:true, ms:776, model:'deepseek-flash', modelKnown:true, thinking:'disabled', sample:'可以'}` |
| 项目对话 `POST /app/llm/chat` | HTTP 200、**1.2 s**、流式 SSE；正文是规范围栏 + Positive/Negative；"初音未来"识别为 `hatsune_miku`；角色补全帧 `rem_(re:zero)` |
| 错误路径 | 错 Key：`/app/llm/api/test` 返回 401 可读提示，且**响应里不出现 Key 本身** |
| 接口级回归 `round3-api.cjs` | **12/12 通过** |

#### K.2 工作台改版（面板内三栏 1:1:2 + 画师独立页）

`round3-ui.cjs` **16/16 通过**（视口 1920×1080）：

- 三栏宽度实测：设置 **664 px**、提示词 **664 px**、图片 **1338 px** → 恰好 1:1:2；
- 视觉顺序：设置(左 103) → 提示词(左 785) → 图片；DOM 顺序仍是"图片→提示词→设置"，靠 `order` 摆正；
- 本地 LLM 确实挂在提示词栏插槽里（`.dcp-slot .llm-main` 存在）；
- 工作台里**没有**画师下拉 / 自定义输入 / "仅收藏"池切换；保留了画师模式、计数与「→ 去「画师」页管理」；
- 导航 = 工作台 / 画师 / 设置 / 向导；点面板入口可切到画师页（`dcp-go-tab` 事件）；
- 布局切换：两栏收掉设置栏、仅图片收掉设置+提示词、切回三栏正常；
- 窄屏（1280 宽）：降级为两栏且**图片整行**（宽度 > 设置栏 1.8 倍且换行）；
- 默认模型下拉 = `anima-turbo-v1.1.safetensors`，管线 = **Anima 通用**。

`round2-ui.cjs` 同步更新为新结构后 **23/23 通过**；`round2-i18n.cjs` **7/7**（新文案已进中英词典，英文界面残留中文 < 8）；`check.js` **17/17**。

#### K.3 模型策略

| 动作 | 证据 |
|---|---|
| 4B 迁移进项目 | `models/llm/Qwen3.5-4B-UD-Q4_K_XL.gguf` = 2,912,109,728 B；sha256 `b252c561…bc961bc7` 与 hf-mirror 的 LFS 值一致；源目录里的同名文件已删 |
| 卸载其它本地模型 | 9B（5.97 GB）/ 2B（1.47 GB）/ DanTagGen（0.32 GB）经 `/app/llm/models/remove` 删除；残留 `.part` 一并清理 |
| 本机 4B 本地路径实测 | `llama-server` **3.2 s 就绪**；中文题 **2.2 s** 出 319 字规范围栏；模型把蕾姆写成了 `Reimu Hakurei`，**由角色词表补成 `rem_(re:zero)`**（这正是"确定性兜底"存在的意义，也如实说明 4B 仍会认错角色） |
| 推荐模型只给链接 | `installer/llm-models.json` = 9B / 4B / 2B 三条，含字节数、sha256、许可、`page`（来源页）与 `mirror`（hf-mirror 直链）；UI 上是「来源页 ↗ / 镜像直链 ↗」两个按钮 + 本机已装标记，本机不再自动下载 |

#### K.4 仍未做 / 注意事项

1. 外接 API 只实测了 **DeepSeek**（以及本机 `llama-server` 当 OpenAI 兼容端点）；SiliconFlow / DashScope / OpenAI 只给了预设按钮，**未逐一实测**。
2. 思考开关的两种写法对**不认识的第三方服务**是"多送两个字段"，理论上会被忽略；但若某服务对未知字段严格报 400，请把「思考模式」切成"交给服务端默认"。
3. 4B 会把角色认错（见 K.3）；角色正确性仍依赖词表 + 别名，不是模型能力。
4. 工作台窄屏降级后图片整行，属于有意设计，不是布局故障。

---

### L. 第四轮实测（回车 / 四挡 / 重排 / 上下文 / 画师作品）

接口级 + 浏览器级回归 `round4-ui.cjs` **30/30 通过**：

| # | 验收点 | 证据 |
|---|---|---|
| 1 | 回车直接发送 | 派发 `keydown Enter` 后 `defaultPrevented=true`（未插入换行），随后的 SSE 回复正常落进对话 |
| 2 | 四挡推理 | 四挡逐一写入设置并 `POST /app/llm/api/test` 全通过；`status` 回报当前挡位；对话实测 off 0.9 s/0 思考帧 vs max 3.2 s/**430 思考帧** |
| 3 | 工作台重排 | 中间栏标题 = `💬 LLM`；卡片顺序 = 对话 → 提示词工具 → 系统提示词；左栏 = 生图设置（提示词/参考图在最上）；图片栏仍是设置栏的 2 倍宽；中间栏没有提示词输入框 |
| 4 | 一屏可点 | 生成 / 发送 / 填正 / 填负 / 填正负 / 跳转图片文件夹 **全部在视口内**（`getBoundingClientRect` 判定） |
| 5 | 上下文策略 | `contextSent=false`、`contextUsed=1`（恒为当前这句）；本地 `keptTotal` 持续增长；打开后 `contextSent=true` 且 `contextUsed>1`；会话接口能取回两问两答 |
| 6 | 逐条/整段复制 | 每条消息有复制按钮，底部有「复制整段对话」 |
| 7 | 默认大随机 + 不清提示词 | 画师模式初始 = `randomBig`；改主模型后正向 `model-switch-marker`、负向 `neg-marker`、画师模式全部保留 |
| 8 | 画师本机作品 | 作品卡有缩略图网格、chip 上有一键收藏；搜 `@__no_such_artist__` 显示「本地没有产品」 |

服务端：`GET /app/artists/works` 实测扫到 **35 张 / 30 位画师**；`GET /app/output/file` 取回 1,446,442 B 的 PNG（`image/png`）；
带 `sub=` 的子目录文件正确命中；`name=..%2F..%2Fdata%2Fsettings.json` 被拒（404，目录穿越防护生效）。

其它回归：`round2-ui` **23/23**、`round3-ui` **16/16**、`round3-api` **13/13**、`round2-i18n` **7/7**、
`panel-test` **32/32**、`llm-test` **LLM_OK**（新增上下文策略断言：关=每轮 1 条、开=最近 5 条、新开对话=0）、`check.js` **17/17**。

**如实说明**：① 四挡只在 **DeepSeek** 上实测过，别的服务是否认 `reasoning_effort` 未知（不认就当普通请求）；
② 本机作品索引只按**文件名**认画师（面板同一口径），改名后的历史图会落到"无画师"；
③ 历史图只做缩略图 + 原图跳转，没有做"删除/收藏图片"（用户没要求，避免误删）。

---

### M. 第五轮：`start.cmd` 双击启动失败的完整排查

**用户报障**：「`<交付目录>\COMFY UI\start.cmd` 在本机无法正常使用」，并问是**已有 ComfyUI 干扰**还是**程序本身问题**。

#### M.1 先排除"环境干扰"（结论：无干扰）

| 检查 | 结果 |
|---|---|
| 端口 8188 / 8788 / 8789 / 8199 | **全部空闲**，没有任何进程监听 |
| 本机已有 ComfyUI | 在 `<项目根>\runtime\comfyui\ComfyUI`（另一个目录），新包在 `<交付目录>\COMFY UI` —— **目录独立，无文件级冲突** |
| python/ComfyUI 进程 | 无 |
| Node 运行时 | 系统 PATH 里有 `node`（v26.8.1）；包内没有 `runtime/node`（设计如此，首次启动会引导下载） |

#### M.2 真正的根因（程序缺陷）

`start.cmd` 的字节级体检（交付包 / 发布源 / 工程三份**完全一致**）：

| 文件 | 字节 | CRLF | 裸 LF | BOM | 汉字 | 非 ASCII 字节 |
|---|---|---|---|---|---|---|
| `start.cmd`（修复前） | 666 | **0** | **22** | 否 | **47** | **168** |
| `scripts\start.ps1`（对照） | 9832 | 209 | 0 | **是** | 683 | 3257 |

本机控制台代码页 = **936（GBK）**。cmd.exe 按 OEM 代码页逐行读 `.cmd`：UTF-8 汉字被解成乱码字节，其中一些字节序列把**行尾一起吃掉**，于是注释与下一条语句被拼成一条命令。实测（`Start-Process start.cmd`，等价双击）拿到的输出：

```
'…抓下来（路径无空格，避免命令行转义干扰…setlocal' 不是内部或外部命令
'…可用…setlocal' 不是内部或外部命令
'ps1" (' 不是内部或外部命令
'ecutionPolicy' 不是内部或外部命令
'nPolicy' 不是内部或外部命令
==== EXIT=9009 ====
```

窗口一闪即关、后端完全没起。**同一份包里的 `start.ps1` 一直正常**，所以问题只出在"双击 `.cmd`"这条入口 ——
而这恰好是文档里写给用户的第一条启动方式。

#### M.3 修复与验证

1. `start.cmd` 重写为 **纯 ASCII + CRLF**（1190 字节 / 34 行 CRLF / 0 非 ASCII / 无 BOM），中文提示全部由 `start.ps1` 打印；
   顺带补了"找不到 `scripts\start.ps1`"的兜底提示。
2. `scripts/check.js` 增加 **[4b] 批处理编码红线**：`.cmd/.bat` 必须 **CRLF + 纯 ASCII + 无 BOM**（自检 16 → **17** 项）。
3. `.gitattributes` 里 `*.cmd text eol=crlf` 保留（对新克隆有效），但**文件内容本身**已写对，不再依赖 git 转换。
4. **补上验收缺口**：以 `Start-Process "<包>\start.cmd"` 作为双击等价验收（之前只测 `start.ps1`）。

修复后实测（干净的交付包，双击等价启动）：后端监听 **8788**、`GET /` = **200**、`root` 正确解析为 `<交付目录>\COMFY UI`、
托盘日志 `托盘已就绪：Url=… BackendPid=…`、`logs\server.log` 记下启动与两条首启提示（缺 ComfyUI / 缺 llama.cpp 运行时，属正常引导）；
交付包与发布源**逐文件哈希一致**（62/62，内容不同 0），`check.js` **17/17**，脱敏扫描 CLEAN（并拿本机真实 API Key 逐文件比对，零命中）。

#### M.4 复盘：为什么一直没发现

- 全部自动化都走 `node server/index.js` 或 `scripts\start.ps1`，**没有一条用例点过 `start.cmd`**；
- `check.js` 此前只守 `.ps1` 的"BOM + CRLF"，**没守 `.cmd`**；
- `build-core.ps1` 是逐字节拷贝，不会修正换行/编码 —— 源文件错，包里就错。

> 教训写进红线：**用户第一条会点的东西，必须有一条自动化用例去点它。**

### N. 第七轮：镜像实测全表（本机，2026-09-25）

> **重要前提**：本机网络对同一链接的实测速度**随时段剧烈波动**。下表的"第一轮"（约 14:05）与"第二轮"（约 14:40）
> 是同一条 ModelScope 链接、同一台机器：`74–95 MB/s` → `1.9–2.9 MB/s`。所以"哪个源稳定可用"要按**能不能下完**
> 判断，而不是按某一时刻的绝对速度；程序里也是这个口径（10 s 无进展/15 s 无新字节才换源，不看绝对速度）。

#### N.1 模型权重（`circlestone-labs/Anima`，`split_files/`）

| 文件 | 源 | 第一轮 | 第二轮 | 结论 |
|---|---|---|---|---|
| anima-turbo-v1.1（3.90 GiB） | modelscope.cn `resolve/master` | 74.7 MB/s | 1.9–7.5 MB/s | ✅ 主力源（**默认分支是 master**） |
| | aifasthub.com | 85.8 MB/s | 2.19 MB/s | ✅ 备源（时段性变慢，会 302 到海外 CDN） |
| | hf-mirror.com | 9.7 MB/s | 1.79 MB/s | ⚠️ 能下完但被限速，只作兜底 |
| | aihub / gitcode / gitee | — | 文件不存在 | ❌ 三家都是**旧快照**（2026-02/03），目录里只有 `anima-preview` |
| | aliendao.cn / wisemodel.cn | — | 未托管 | ❌ |
| qwen_3_06b_base（1.11 GiB） | ai.gitcode.com | 20.4 MB/s | — | ✅ 新增（快照里有该文件） |
| | aihub.caict.ac.cn | 15.5 MB/s | — | ✅ 新增（需两步 LFS batch，见 N.4） |
| | modelscope.cn | 14.99 MB/s | — | ✅ |
| | hf-api.gitee.com | 5.79 MB/s | — | ✅ 新增 |
| | aifasthub.com | 1.18 MB/s | — | ⚠️ 兜底 |
| qwen_image_vae（242 MiB） | ai.gitcode.com | 17.27 MB/s | — | ✅ 新增，**全量下载后 sha256 一致** |
| | modelscope.cn / www.modelscope.cn | 16.04 / 14.58 MB/s | — | ✅ 同一后端 CDN |
| | aihub.caict.ac.cn | 14.11 MB/s | — | ✅ 新增，sha256 一致 |
| | hf-api.gitee.com | 7.0 MB/s | — | ✅ 新增，sha256 一致 |
| | aifasthub.com / hf-mirror.com | 1.73 / 1.2 MB/s | — | ⚠️ 兜底 |

#### N.2 运行时与工具

| 组件 | 源 | 实测 | 结论 |
|---|---|---|---|
| Node v22.14.0 便携包（33.3 MB） | mirrors.tuna.tsinghua.edu.cn | 29.58 MB/s | ✅ 首选 |
| | nodejs.org（官方） | 17.15 MB/s | ✅ 官方在国内也不慢 |
| | mirrors.huaweicloud.com | 9.75 MB/s | ✅ |
| | cdn.npmmirror.com / registry.npmmirror.com | 9.21 / 8.16 MB/s | ✅（后者 302 到前者，同后端） |
| | mirrors.ustc.edu.cn | 41.1 MB/s | ⚠️ **需先带 JS 验证 Cookie**（`addr=<出口IP>`），否则只回 895 B 验证页 → 不收录，判定不可用 |
| 7-Zip（`7zr.exe` / `7z-extra.7z`） | GitHub `ip7z/7zip` 经 gh-proxy | 1.8 MB/s（26.03） | ✅ 首选（版本 26.03） |
| | www.7-zip.org 直连 | 17–25 KB/s | ⚠️ 1.76 MB 的 extra 包 45 s 都收不完 → 只作兜底（`7zr.exe` 0.6 MB 能收全但需 7–18 s） |
| | 清华 / 中科大 / 南大 / cernet 镜像 | 404 / 302 自环 | ❌ 都不镜像 7-Zip |
| 角色词表 `danbooru.csv`（3,518,020 B） | cdn.jsdelivr.net | 0.9 s 收全 | ✅ 首选 |
| | raw.githubusercontent 经 gh-proxy | 1.4 s 收全 | ✅ |
| | ghfast.top | 17.0 s 收全 | ✅ 慢但完整 |
| | raw.githubusercontent 直连 | 5 次 2 次可用 | ⚠️ flaky |
| pip（git 模式） | pypi.tuna.tsinghua.edu.cn | 正常 | ✅ 首选 |
| | mirrors.aliyun.com / pypi.org | 正常 | ✅ |
| | repo.huaweicloud.com 索引页 | HTTP 429 | ❌ 索引被拒（按包名解析或仍可用） |

#### N.3 GitHub 系资源（ComfyUI 便携包 1.8 GiB / llama.cpp 143 MB）

**两轮独立探测了 20+ 个 GitHub 代理 + 3 个换主机型代理，只有两个是快源。**

| 代理 | 实测 | 判定 |
|---|---|---|
| gh-proxy.com | 230 MB / 15 s ≈ 15 MB/s；另测 ComfyUI 100 MiB/6.5 s = 16.2 MB/s、4.43/9.89/16.02 MB/s | ✅ **快源 1** |
| down.npee.cn（`?<原链接>`） | 官方 v0.37.0 资产 4/4 通过：首字节 450–1137 ms，4.07 / 5.42 / 6.26 / **24.92 MB/s** | ✅ **快源 2**（第二轮探测才找到） |
| ghproxy.net | 0.22–0.30 MB/s（45 s 只收 10.8–13.6 MB） | ⚠️ 限速，兜底 |
| ghfast.top | 0.10–0.37 MB/s | ⚠️ 限速，兜底 |
| ghfile.geekertao.top | 1 MiB 探测 11.2 MB/s，**真实 45 s 只有 0.054 MB/s** | ❌ 峰值假象（教训：1 MiB 探测会骗人） |
| ghps.cc | 全站 404（连它自己根路径也 404） | ❌ 服务已死 |
| cors.isteed.cc / gh.monlor.com / gh.nxnow.top / ghproxy.cn / gh-proxy.net / ghproxy.link / gh.ddlc.top / gh.h233.eu.org / ghproxy.homeboyc.cn | 0.13–0.93 MB/s / 200 但只有几 KB 页面 / 302 / 401 / 403 / 429 | ❌ |
| hub.gitmirror.com / github.moeyy.xyz / cdn.moran.eu.org / gh.7sdream.com / ghp.ci / gh-proxy.cc / gitdl.cn 等约 20 个 | DNS 解析失败 | ❌ |
| gh.llkk.cc / gh-proxy.ygxz.in / mirror.ghproxy.com / bgithub.xyz / hub.nuaa.cf | 连接超时 | ❌ |
| gh.jasonzeng.dev / ghproxy.cc / cf.ghproxy.cc / gh.api.99988866.xyz / kkgithub.com | TLS 失败 / 证书过期 / 证书 CN 不匹配 | ❌ |
| github.com 直连 | 302 → `release-assets.githubusercontent.com`，跟随即 `Connection reset` | ❌ 被墙 |

**官方 v0.37.0 便携包的"非代理"镜像**：不存在。逐个核对了字节数/sha256（`api.github.com` 在本环境可**直连**，596 ms）：gitee `gitee.com/mirrors/comfyui` 存在但 `/releases` 为空；GitCode `gh_mirrors/co/ComfyUI` 两个 API 都 404；ModelScope 上没有任何官方 ComfyUI 便携包仓库（`Comfy-Org/ComfyUI`、`Comfy-Org/ComfyUI_Windows_Portable`、`AI-ModelScope/ComfyUI` 全部 `record not found`）。能拿到的非代理来源只有两类：

1. **哈希校验通过的官方旧版**：`hf-mirror.com/StabooruJeffrey/ComfyUI_v0.3.59_72212fe/.../ComfyUI_windows_portable_nvidia.7z` = 2,086,957,962 B，其 LFS oid `a1cf7b103c…9c1a` 与 GitHub API 给出的 v0.3.59 资产 sha256 **完全一致** → 密码学上就是官方二进制（只是版本旧，实测 1.10 MB/s）。代码里已作为"官方旧版兜底"收录，并带 `sha256` 校验。
2. **第三方构建**（明确标注非官方）：ModelScope 上 licyk 的 `comfyui_cuda-licyk-windows-20260921-nightly.7z`（3.17 GiB，9.5–11.2 MB/s，最快）、hf-mirror 上 `sofianedrz/mythria-comfyui-portable`（4.17 MB/s）、`marduk191`（0.94 MB/s）等。代码里收录了两个 hf-mirror 的作为最后兜底并**强制打印"非官方包"提示**；licyk 那个虽然最快，但它是"all-in-one"整合包，目录结构未必符合 `comfy.detectLayout()` 的预期，故只记录不自动使用。

→ ComfyUI 便携包现在的获取顺序是：**官方 v0.37.0（gh-proxy / down.npee.cn，带 API 下发的 sha256 校验）→ 官方 latest 路径 → 哈希校验通过的官方旧版 → 第三方构建（强制提示）→ 本地归档 → git 模式 → 外接已有目录**。

#### N.4 未在代码里实现但已验证的额外源（如实记录）

**aihub.caict.ac.cn（鲸智社区）**：对 `qwen_3_06b_base` / `qwen_image_vae` 实测 14–15 MB/s、sha256 一致，但它的直链是**两步**的 ——

```
POST https://aihub.caict.ac.cn/models/CircleStone-Labs/Anima.git/info/lfs/objects/batch
body: {"operation":"download","transfers":["basic"],"objects":[{"oid":"<sha256>","size":<bytes>}]}
→ objects[].actions.download.href   # 阿里云 OSS 签名直链，X-Amz-Expires=259200（72 h），支持 206
```

`solve` 端点只返回 134 字节的 LFS 指针文本，`/api/v1/models/.../download/...` 需要登录（401）。
**没有实现的原因**：它**没有** `anima-turbo-v1.1`（快照 2026-03-17），也就是帮不到那个 3.9 GiB 的主力文件；而另外两个文件已经有 gitcode/gitee 这类"一条 URL 模板就能用"的快源覆盖。为一个用不上的场景引入 POST 握手 + 签名 URL 生命周期管理，性价比不成立。若将来 aihub 同步了 turbo，可按上面的协议补一个候选类型。

**ModelScope 的两种直链等价**：`/models/<o>/<r>/resolve/master/<path>` 与旧式 `/models/<o>/<r>?Revision=master&FilePath=<path>` 都 302 到同一个 `cdn-lfs-cn-1.modelscope.cn` 对象（`www.modelscope.cn` 与 `modelscope.cn` 同后端）—— 所以设置里 `modelscope` 基地址填哪个都行。

#### N.5 本轮新增的"能自己验一遍"的能力

设置页 →「下载源 → **镜像测速**」：粘贴任意直链（默认就是最小档主权重），选 5/20/100 MiB，点「开始测速」，
用**真实下载路径**把每个候选来源各下一段，列出首字节耗时、实际速度与判定；不落盘、同一时刻只跑一个任务。
`GET /app/download/speedtest?url=<直链>&mib=100` 是它的接口。
命令行侧的等价物是 `.scratch/round5-mirrors.cjs`（结构自检 + 每组件逐源实测，直到凑够 3 个可用源）。

---

## 附：第八轮实测补充（对照 `BUGS-AND-FIXES.md` 核修 + 画师搜索恢复）

### O.1 对照结论（逐条核对，不照抄对方结论）

用户提交的 `BUGS-AND-FIXES.md` 里 4 条"已修"与 1 条"观察项"，**在本仓库中全部复现**（说明那份修复只落在别人机器上，没有回流到本仓库）：

| 条目 | 本仓库是否存在 | 复现方式（修复前） |
|---|---|---|
| B6 就绪度写死本地来源 / `/app/state` 不下发 `provider`/`api` | **存在** | 真实 `/app/state` 的 `llm` 只有 `runtime/model/modelCount/server/...`；`web/pages/llm.js` 的 `notReady` 只看 `runtime.runtime.ok` |
| B7 `/app/state` 不下发 `listen` | **存在** | 真实 `/app/state` 无 `listen` 字段；`web/pages/settings.js` 的令牌行回退读 `state.listen.token` 恒为 `''` |
| B8 `api()` 不序列化对象 body | **存在** | `fetch(url,{body:{...}})` → 后端 400 `请求体不是合法 JSON："[object Object]" is not valid JSON`（实测复现） |
| B9 自检无条件报 `llm-runtime-missing` | **存在** | `provider=api`（默认）时 `/app/state` 与 `/app/selfcheck` 仍常驻该告警 |
| B5 `setup.json` 的 `models` 只记 `installed`、丢 `skipped` | **存在** | 用外接目录 + 字节数吻合的假权重跑 `runSetup`：`installModels` 返回 `{installed:[],skipped:[id]}`，落库得到 `models: []` |

### O.2 本轮修复与验证（都是实跑，不是读代码）

| 验证 | 方式 | 结果 |
|---|---|---|
| B6① `/app/state` 字段 | 真实 HTTP | `llm.provider="api"`、`llm.api={ok:true,baseUrl,model,hasKey,missing}` |
| B6② 对话就绪度 | 无头 Edge 点「发送」 | 出现「…还缺 API Key…」的可操作提示；**不再**出现「本地 LLM 未就绪」 |
| B6③ 顶栏徽标 | 无头 Edge 读 `.topbar .badge` | 显示实际来源 `deepseek-flash`（旧实现恒读本地运行时） |
| B7① `/app/state` 补 `listen` | 真实 HTTP | `{lan:false,port,token:""}` / 开启后为 24 位 hex |
| B7② 保存后令牌可见 | 无头 Edge：勾选→保存→读页面 | 令牌行立即出现（取自 PUT 响应），无需刷新 |
| B7③ 回环豁免 | Node 分别打回环与非回环 | 回环 `/app/state` **200**；非回环无令牌 **401**、带正确令牌 **200**、带错令牌 **401** |
| B8 | 无头 Edge 点「从浏览器旧数据导入」 | `POST /app/artists/import` **200**（修复前 400），页面无「不是合法 JSON」 |
| B9 | 真实 HTTP | 自检只剩 `comfy-embedded-missing`（本机未装 ComfyUI），`llm-runtime-missing` 消失 |
| B5 | `.scratch/b5-setup-models.cjs`（造一个字节数吻合的假权重 + 全 skip 跑 `runSetup`） | **4/4**；`setup.json.models` 含该 id，测试后自动还原 `setup.json` |
| 画师搜索（用户报障） | `.scratch/round8-ui.cjs`（无头 Edge 真实点击，**23/23**） | 指定模式下搜索框/范围切换存在；「仅收藏」点开列出全部 3 位收藏 → 输入 `w` 只剩 `@wlop` → 点选后固定为 `@wlop` 且搜索框清空、下拉收起；「全部清单」范围可搜到 `@dairi` 并点选成功 |
| 回归基线 | `scripts/check.js` + 3 个纯函数脚本 | `check` **17/17**；`panel-test` **32/32**；`round2b-alias` **9/9**；`round5-chars` **10/10**；`round5-partial` **8/8**（后两者需 `data/characters/danbooru.csv`，缺词表时会各少 1 项，属环境项） |

### O.3 修复 B7 时顺带发现的两个连带故障（都属真实可用性问题）

1. **开启局域网后本机页面整体失效**：`lanGuard` 对所有来源要求令牌，而设置页保存后只刷新 `/app/state` → 该请求 401 → 外壳把整页替换成「后端 API 不可用：…」，**令牌行因此永远看不到**（这正是用户报的症状的真正根因）。
2. **下次双击 `start.cmd` 起不来**：`scripts/start.ps1` 的就绪探活用 `http://127.0.0.1:<端口>/app/state` 且不带令牌；`lan=true` 一旦落盘，探活恒 401 → 等满 60 秒后打印"后端在 60 秒内没有就绪"并 `exit 1`（还会把后端进程杀掉）。

两者的共同根因是"把本机也当成局域网设备"，与 README §9.2 的口径（"局域网内**其它设备**必须带上令牌"）不符，故按回环豁免修复。

### O.4 一处如实标注的遗留（本轮**未**改）

`web/pages/settings.js` 的保存负载里**总是**回传 `download.hfMirrors / nodeMirrors / jsdelivrMirrors`（值来自 `GET /app/settings`，即后端派生出来的默认梯队），
而 `server/config.js` 的 `save()` 只在"patch 里没显式给这个键"时才跳过落盘 —— 于是**任何一次保存都会把当时的默认梯队固化进 `data/settings.json`**，
这正是 §12 决策 ㉛/HANDOVER §5 记录过的那个坑，只是入口从"接口调用"变成了"设置页保存"（实测：本轮保存一次后，`settings.json` 里出现了 6 条 `hfMirrors`）。
本轮**未改动**（改动会涉及"用户是否编辑过镜像文本框"的判定，属行为变更），建议下一轮按"仅当与装载值不同才回传"的口径修掉。

### O.5 AI 生成声明（本轮新增的交付物）

新增根目录文档 **`AI-DECLARATION.md`**，内容与边界：

| 项 | 说明 |
|---|---|
| 声明 | 本项目**自身**的全部代码与文档（`server/`、`web/`、`scripts/`、`installer/`、`assets/` 内清单文本、全部 Markdown）**由 AI 生成**；人类一方负责提出需求、验收行为、决定发布，未逐行重写代码 |
| 明确排除 | 标准 MIT 许可原文（`LICENSE`）、随包携带的上游原件（`web/vendor/react*.js`、`assets/artists/*.txt`）、以及不随包分发的外部组件与权重（ComfyUI / Anima / Qwen / llama.cpp / 7-Zip / 角色词表）—— 这些各有上游许可，声明不改变其义务（指向 `THIRD_PARTY.md`、`LICENSES/`） |
| 免责 | 按 MIT 的 "AS IS" 提供，**不因"由 AI 生成"而获得额外保证或额外免责**；生产/再分发/商用前请自行审查 |
| 可靠性口径 | 明确要求**以实测记录为准**（§13 验证记录与各轮附录、`HANDOVER.md` §10 已知限制），不得仅凭声明判断可靠性 |
| 落地 | 加入 `scripts/build-core.ps1` 的 `$IncludeFiles`（随核心版交付），并把"交付文档齐全"检查从 4 份扩到 7 项（四份交付文档 + `HANDOVER.md` + `INTERNAL-CONTRACT.md` + `AI-DECLARATION.md`） |
| 验证 | `node scripts/check.js` 仍 **17/17**（含 `.ps1` BOM/CRLF 红线：改 `build-core.ps1` 后由 `scripts/normalize-ps1.cjs` 重新规范化为 BOM+CRLF，PowerShell 解析 **errors=0**）；`build-core.ps1` 实跑见下 |

**`build-core.ps1` 实跑结果**（本轮真实跑过一遍，确认新文档真的进包、三项扫描仍全绿）：

```
[打包] 已拷贝：AI-DECLARATION.md
[打包] 核心版文件数：64
[打包][OK] 隐私扫描：零命中
[打包][OK] 权重与压缩包扫描：零命中
[打包][OK] Python 源文件扫描：零命中（ComfyUI 不随包分发）
[打包][OK] GPL 代码内联扫描：零命中（注释里引用 ComfyUI 源码路径作为证据不算内联）
[打包][OK] 交付文档齐全（含 AI-DECLARATION.md）
[打包][OK] 核心版语法自检通过（server 与面板半）
exit 0
```

（跑完后 `release/core` 属构建产物，未留在开发副本里；下次打包会先清空再生成。）

---

## 附：第十轮实测补充（v1.2.1：切页保留 / 分组入口 / 思考过程 / 历史永久保留）

> 本轮同样在**装有真实 ComfyUI 与权重的开发机**上做端到端验证，但**换用「日常使用版」那份安装与权重**
> （`<日常使用版>\runtime\comfyui`：`anima-turbo-v1.1.safetensors` + `qwen_3_06b_base.safetensors` + `qwen_image_vae.safetensors`），
> 验证完把 `comfy` 段还原为内嵌模式并删除测试输出。**不验收"没跑过的路径"**。

### Q.1 本轮的两个根因（实测定位，不是猜的）

| 现象（用户报告） | 根因 | 证据 / 修法 |
|---|---|---|
| **"从控制台切到设置就失去控制台的提示词和 LLM 历史"** | ① 外壳按 tab 条件渲染，切页 = **卸载**工作台 → 面板与 LLM 的 `useState` 全部重置；② 更隐蔽：`renderPage` 的 `key = tab + '-' + renderKey`，而 `renderKey` 在按需加载完成时自增 → **刚挂载的页面被整体重建**，等于白改 | 浏览器实测（Edge CDP）：修复前切到设置再切回，`__DCP_PANEL_API__.getPrompts()` 为空、`.chat-log .msg` 为 0；修复后同样的动作提示词与消息原样保留（见 Q.2） |
| **"无法将画师设置为自定义分组／图片部分根本不存在对应 ui 按钮"** | ① 面板**完全没有加组 UI**（分组只能在画师页对着搜索结果点）；② 数据流：面板挂载时会 `saveFavorites()` 一次，而旧 `persistArtists()` 把 favs/blacklist/groups **整份**交回外壳、`__DCP_SAVE_ARTISTS__` 又无条件 PUT favs+blacklist → 用户刚建的分组被这次"顺手写回"抹成空 | 面板侧新增 🗂 入口（下拉行 / 已选 chip / 分组随机块）；`persistArtists` 与 `__DCP_SAVE_ARTISTS__` 改为**按 key 传、按 key 写**，分组走新增的 `POST /app/artists/groups/replace`（服务端仍做 50 组归一化） |

### Q.2 验收结果（都是实跑）

| 用例 | 覆盖 | 结果 |
|---|---|---|
| `scripts/check.js` | 语法 / JSON / 中英词典 / `.ps1` 与 `.cmd` 编码 / 脱敏 / **版本号一致性（本轮新增）** | **19/19** |
| 服务端新接口（curl 实测） | `GET /app/llm/sessions`、`POST /app/llm/session/new`（确认**不删**旧会话）、`DELETE /app/llm/session/:id`、`GET /app/llm/session/new`（必须 400）、`POST /app/artists/groups/replace` | 全通过 |
| 外接 API（真实 DeepSeek Key） | `reasoning=off`：`reasoning_content` 长度 0、正文干净、`replace` 帧给出规范化正文；`reasoning=low`：**314 个 `reasoning` 帧**（只带思考文本）+ 65 个 `delta` 帧（只带正文）+ 1 个 `replace` 帧 → 思考与正文彻底分离 | 全通过 |
| 真实出图（日常使用版权重） | 1024×1024 PNG、1.4 MB、28.3 s（10 步 / CFG 1 / er_sde+simple），`detectLayout` 报 `portable`，输出落在 `output/v121-accept/noartist_1_00001_.png`；测后停实例、删测试输出、还原 `settings.json` | 成功 |
| Edge CDP 页内断言 | 常驻标签页、切设置后工作台仍在 DOM 且隐藏、切回提示词原样、`.session-row` 历史列表与自动接回、画师页分组卡片与展开/重命名入口、分组桥写回 | **16/18**（两条为脚本时序断言，见 `docs/HANDOVER.md` §13.1 的如实记录） |

### Q.3 本轮新增/变更的接口与设置（同步 `docs/INTERNAL-CONTRACT.md`）

| 项 | 位置 |
|---|---|
| 新增接口 | `GET /app/llm/sessions`（历史摘要）、`DELETE /app/llm/session/:id`（唯一真删除）、`POST /app/artists/groups/replace` |
| 语义变更 | `POST /app/llm/session/new` = **只开新会话、不删旧会话**（丢弃上下文的旧语义移到 `POST /app/llm/session/discard`）；`GET /app/llm/session/:id` 对 `new`/`discard` 返回 400 |
| 帧协议变更 | `/app/llm/chat` 的 SSE 新增 `data: {"reasoning":"<本帧思考文本>"}`（与 `delta` 分离；`thinking` 长度字段保留）；"只有思考没有正文"时不再重复发一遍 `delta` |
| 数据文件 | `data/llm/sessions.json` 增加顶层 `lastSessionId`；每会话条数上限 `llm.keepMessages` 由 200 → **2000**（默认仍 40） |
| 前端契约 | 常驻标签页 `.tab-panes > .tab-pane`（页面 key 只用 tab id）；`window.__DCP_SHELL__` 排障钩子；新增桥 `__DCP_ARTIST_GROUP__` / `__DCP_CREATE_GROUP__`，`__DCP_SAVE_ARTISTS__` 改为按 key 写 |
| 新增 i18n 键 | `llm.thinking.*`、`llm.sessions.*`、`artists.groups.{members,rename,renamed,renamePlaceholder,removeMember,membersHint,expand,panelAdd,panelHint,fromWorks}`、`settings.llm.keepMessages.hint` |

---

## 附：第九轮实测补充（v1.2.0：分组 / 删除 / 输出目录 / Key 只写 / 下载选源）

> 本轮全程在一台**装有真实 ComfyUI 与权重的开发机**上做端到端验证（ComfyUI 0.37.0 跑在 8188，
> 权重 anima-turbo-v1.1 + qwen_3_06b_base + qwen_image_vae，输出目录里已有 470 张历史作品）。
> 覆盖脚本：`.scratch/round9-ui.cjs`（无头 Edge 真实点击 + 真实出图）、`.scratch/r9-download.cjs`（离线镜像限速）、
> `.scratch/api-key-reasoning.cjs`（真实 DeepSeek 外接 API）、`.scratch/b5-setup-models.cjs`。

### P.1 三处根因（都不是"猜"出来的，是实测定位的）

| 现象（用户报告） | 根因 | 证据 |
|---|---|---|
| **"生成的照片根本不会出现在对应的图片文件夹中"**（第 4 项） | 应用把"图片文件夹"解析成**按 `comfy.mode` 推导的目录**。用户实测环境是**自己在别处起的 ComfyUI**（外部安装），真实出图在**那个实例**的 `output\<模型>\` 下；而应用指的是项目内 `runtime\comfyui\ComfyUI\output` —— 那里只有一个占位文件。所以「本机作品」= 0 张、「📂 跳转到图片文件夹」打开空目录 | 修复前：`/app/comfy/outputdir` 解析为项目内目录、`count=0`；`D:\...\runtime\comfyui\ComfyUI\output` 递归只有 `_output_images_are_put_here`。修复后：`source=running:running-process`、指向外部实例的 output、`count=468~470`、151 位画师。另：真实出图的命名规范**本来就是对的**（`anima-turbo-v1.1\<画师>_<序号>_00001_.png`），问题只在"看哪里" |
| **"切一下思考挡位就得重新输入 API Key"**（第 3 项） | 设置页保存时会把**整份 `llm.api` 回传**（含 `apiKey`），而页面手里的 Key 常常是空的（`/app/settings` 曾经回显明文 Key，但页面副本可能早于粘贴动作）→ 后端 `save()` 把空串当新值写入 → **已存 Key 被抹掉**。抹掉后任何"思考挡位"当然都用不了 | 复现脚本 `api-key-reasoning.cjs` 的 `[3]`：用设置页形状的 body（`apiKey: ''`）PUT 一次 → `hasKey=false`、`/app/llm/api/test` 失败。修复后同一步 `hasKey=true` 且连接仍通；`clearKey: true` 仍能真正清空 |
| **"选了指定位却搜不了"**（第八轮遗留、本轮确认） | 面板 `persistArtists()` 写回 `window.__DCP_ARTISTS__` 时只带 favs/blacklist —— 而面板一挂载就会 `saveFavorites()` 一次，于是 `groups` 被抹掉；"分组随机"恒为 0 组（同类写回缺陷在第八轮造成的是"指定画师搜索框被整体删除"） | 修复前 `window.__DCP_ARTISTS__ = {"favs":[],"blacklist":[]}`、分组下拉不出现；修复后带 `groups`，下拉显示 `组名（N 位）` |

### P.2 验收结果（都是实跑）

| 用例 | 覆盖 | 结果 |
|---|---|---|
| `.scratch/round9-ui.cjs` | #4 输出目录解析（4 项）· #2 分组建/加/移出/面板分组随机（7 项）· #1 画师页删除（6 项，含两步确认与空目录清理）· #4/#1 端到端**真出一张图**（落在 `anima-turbo-v1.1\wlop_1_00001_.png`，面板显示、按组随机确实注入了组内画师 `@wlop`）并用**面板自己的 🗑** 删掉（6 项） | **27/27** |
| `.scratch/r9-download.cjs` | 本机两台限速镜像（300 KB/s vs 4 MB/s）：逐源测速表、选最快、慢源只被探一次、**同族下一个文件不重复测速** | **11/11** |
| `.scratch/api-key-reasoning.cjs` | 写入/局部改挡位/设置页形状保存/显式清除/重新填入 + `reasoning=low` 与 `off` 的真实对话出正文 | **17/17** |
| `.scratch/b5-setup-models.cjs` | 向导 `setup.json` 记全 `installed + skipped` | **4/4** |
| 回归 | `scripts/check.js` **17/17** · `panel-test` **32/32** · `round5-partial`（下载防线）**8/8** · `round2b-alias` **9/9** · `round5-chars` **10/10**（后两者需 `data/characters/danbooru.csv`，缺词表时各少 1 项，属环境项） · `round8-ui`（第八轮 23 项） | 全绿 |
| 打包 | `scripts/build-core.ps1` 实跑：核心版文件数、隐私/权重/Python/GPL 四项扫描零命中、交付文档齐全、语法自检通过 | exit 0 |

### P.3 如实说明：本轮发生的一次人为数据损失

写第 3 项"删除本机作品"的验收脚本时，**第一次版本用错了选择器**（把作品卡片的搜索框与画师检索框混了），
导致脚本在"未按关键词过滤"的列表上删掉了**列表第一张**——那是用户的真实作品
`<output>\anima-turbo-v1.1\arere (k1m6wv)_9_00001_.png`（1,178,197 B，2026-09-26 02:56:57 生成）。

- **已尝试的恢复手段**：① 全盘搜同名文件（无）；② Windows 回收站（`fs.rmSync` 不进回收站，无）；
  ③ 从 ComfyUI 历史里取回原始 graph 重跑同一 seed —— **该版本 `/history` 的 `prompt` 字段是"执行顺序"而不是图**，
  `/internal` 相关端点与 `user\comfyui.db` 里都没有存图本身，故**无法按原参数还原**。
- **结论**：该图**不可恢复**。已如实告知使用者，并把验收脚本改成**任何删除动作都必须先正向识别目标**
  （只允许删自己造的 `keep_1_*` 副本或本次刚生成的那张），该闸门已写进脚本与本文档。
- 教训（值得留给后续轮次）：**凡是对真实数据有破坏性的用例，先用"正样本识别"把目标钉死，再动手**；
  这一步比任何事后校验都重要。

### P.4 新增/变更的接口与设置（同步 `docs/INTERNAL-CONTRACT.md`）

| 项 | 位置 |
|---|---|
| 新增设置 | `comfy.outputDir`（图片文件夹可选覆盖；空 = 自动判定） |
| 新增接口 | `GET /app/comfy/outputdir`、`GET /app/artists/groups`、`POST /app/artists/groups/{create,rename,delete,add,remove}`、`POST /app/output/delete` |
| 变更接口 | `GET/PUT /app/settings`：`llm.api.apiKey` 一律下发 `''` 并附 `hasKey`；`PATCH` 语义上"空串 = 不改"，清空须 `llm.api.clearKey=true` |
| 变更接口 | `GET /app/artists/lists` 增加 `groups`；`GET /app/state` 的 `comfy` 增加 `outputDir/outputSource/outputOverride` |
| 数据文件 | `data/artists.json` 增加 `groups: [{name, items:[tag]}]`（最多 50 组，`store.MAX_GROUPS`） |
| 新增 i18n 键 | `settings.llm.apiKey.{stored,empty,storedHint,emptyHint,willSave,clear,clearConfirm,cleared}`、`artists.groups.*`、`artists.works.delete*` |
| 下载行为 | `download()` 新增前置步骤"逐源测速"（`pickFastest`/`probeSpeed`），并提供 `noProbe: true` 关闭 |

### P.5 去历史宿主名与 i18n 补齐（同一轮内的收尾）

- **介绍与文档**：项目已与任何插件宿主无关，故 `README.md` / `README.en.md` 的定位句改为"独立运行、开箱即用…不需要任何插件宿主或外部平台"；
  `FEATURES.md`、`FULL-REFERENCE.md`（§11 与 §4.6 对照表）、`HANDOVER.md`、`MIGRATION.md` 里的旧宿主名统一改为中性说法
  （"早期插件形态"/"宿主应用"）；`THIRD_PARTY.md` 删除"旧宿主本体"组件行与"不分发"清单项，并把 React 一行改为
  "随本仓库携带 `web/vendor/`（18.3.1 UMD）"（原写法还停留在"由宿主提供"，与事实不符）。
- **AI 声明**：`AI-DECLARATION.md` 里"某具体助手平台会话"改为"对话式编码智能体"（声明本身不变：全部代码由 AI 生成）。
- **代码注释**：`server/comfy.js`、`web/app-shell.js`、`web/panel-host.js`、`web/panel.js` 共 39 处旧宿主名改为中性说法。
- **词典残留**：`web/i18n/{zh,en}.json` 的 `panel` 段删除 6 条宿主时代文案（面板源码中已不存在这些原文），键集仍 100% 一致。
- **i18n 补齐（本轮新发现的真问题）**：英文界面曾残留 8 条中文（面板标题、分组随机、删除按钮等），原因是本轮新增面板文案没进词典、
  且面板标题的正则规则还是改名前的旧写法。已补 4 条 `panel` 词条 + 5 条 `en.panelPhrases` 规则，并把分组下拉选项改成
  `名称 (N)`（不再拼中文量词）。回归：`.scratch/round2-i18n.cjs` **7/7**（该脚本已加入本树 `.scratch`）。
- **刻意保留**：`web/panel.js` 的三处 `SaveImage` 兜底前缀 `DSH_Panel/Anima|AnimaPlain|Qwen` **未改** —— `panel-test.cjs` 的红线是
  "不传 `savePrefix`/`refImage` 时三条管线的图与上游插件版**逐字节等价**"，改名会让该断言失败；而面板**始终**会传 `savePrefix`，
  这三处在正常路径上永不生效、用户看不到。若要清零，需把等价比对改为"除该字段外一致"（会削弱这道保护）。

---

## 附：第十一轮实测补充（v1.2.2：退出连带停止 / 孤儿只清自己的 / 端口不漂移 / 断连不刷屏）

> 本节记录第十一轮修复的**实测**依据。裁决证据来自**独立复核**（`docs/ROUND11-VERIFY.md`，复核者自建 harness，不复用实现者的脚本）。

### R11.1 根因：孤儿不是"detached 逃逸"，而是父链断裂

- **对照实验**：对**还活着**的父进程执行 `taskkill /PID <父> /T /F`，detached 子进程会**一起被收**（实测输出 `SUCCESS: The process with PID … (child process of PID …) has been terminated`），
  `Get-CimInstance Win32_Process -Filter "ParentProcessId=<父>"` 也仍能列出它 —— 所以 `server/comfy.js` 的 `detached: true`（`:117`）+ `child.unref()`（`:121`）**不是**孤儿成因。
- **真因**：**父链断裂**。`scripts/start.ps1` 的 `$proc.Kill()`（`:141`/`:206`）是**单进程杀**（不带 `/T`）；控制台窗口被强杀、启动器被结束时，中间那层 node 先死，而 ComfyUI 作为 detached 子进程活着 —— 此后父链已断，`/T` 永远够不着它。
  这类孤儿在内存里没有任何痕迹（`state.pid` 为空），所以只能靠**落盘的归属记录**识别。
- **放大器（本轮一并修掉）**：旧 `listen()` 在每次 `EADDRINUSE` 自增时都**重新注册一次就绪回调**，成功绑定后就绪逻辑连跑多遍 —— `autoStart=true` 时会一次拉起 3 个 ComfyUI，而内存只记住最后一个 pid，当场产生两个新孤儿。现在自增上限改为 2 且只走一条就绪路径。

### R11.2 四层防护（逐层实测）

| 层 | 机制 | 实测结果 |
|---|---|---|
| ① 托盘优雅退出 | `scripts/tray.ps1` 先 `POST /app/quit`（6 s 请求超时 + 最多等 8 s，判据是"后端进程真的消失"） | 托盘退出码 0、后端**自行** `exit 0`（不是被强杀）、替身被终止且记录被删；`tray.log` 写 `优雅退出成功：…`，后端 `server.log` 写 `收到退出请求（POST /app/quit）`，**没有**"回退到强制终止" |
| ② 托盘强杀后按记录清理 | `scripts/tray.ps1` 的 `Stop-OwnedComfyUI`，无论哪条路径都执行 | 顽固后端（`/app/quit` 一律 500）→ 8 s 后回退 `/T /F`；**孤儿替身仍被按记录终止**、记录被删；无记录的替身全程存活 |
| ③ 下次启动清孤儿 | `server/index.js` → `comfy.cleanupOrphans()` | 见下面的硬边界链路 |
| ④ 进程内同步兜底 | `server/index.js` 的 `process.on('exit')` → `comfy.killOwnedSync()` | 只留内存 pid、只留记录两种来源都被清干净；日志 `退出同步兜底（process-exit）` |

**硬边界链路实测**：`autoStart` 拉起替身并落盘记录 → 对**后端本进程**执行 `taskkill /PID <后端> /F`（**不带 `/T`**，即真正的 `TerminateProcess`）→ 后端已死、**替身仍存活且已成孤儿**（其 `ppid` 进程已不存在，证明第 ④ 层确实跑不到）→ 重启后端 → 替身被终止、记录被删，日志 `清理上一次遗留的 ComfyUI 孤儿：pid=…（…）→ 已终止进程树`。

### R11.3 安全边界（"只清自己的"，六条反例 + 两条红线）

`verifyOwnership()` 五条谓词任一不满足 → **只记 WARN、绝不动手**。实测反例：无归属记录的用户实例（`/app/comfy/stop` 与 `/app/quit` 之后都仍然活着，且不会被写入记录）、`codeDir` 与记录不符、命令行里没有 `main.py`、`schema` 未知、记录是坏 JSON、pid 已死、读不到命令行（PATH 里塞假的 `powershell`）—— 全部不清理。

### R11.4 端口：上限、不回写、可发现

| 断言 | 实测 |
|---|---|
| 自增上限 2 | 占住 18960/18961 → 恰好 2 条 WARN（`… 尝试 18961（第 1/2 次自增）`、`… 18962（第 2/2 次自增）`）→ 绑定 18962 |
| 超限快速失败 | 占满 3 个端口 → 2 条 WARN 后 `端口 … 仍被占用：已连续自增 2 次仍未找到可用端口，放弃启动（不再继续漂移）。` + `DCP_PORT` 建议 + `exit 1`；**不输出假就绪**（无 `DCP_READY`） |
| 不回写设置 | 磁盘 `data/settings.json` **字节级未变**（`listen.port` 仍是配置值） |
| 实际端口可发现 | `/app/state` 顶层 `port` == 「打开：」日志 == `DCP_READY.port` == 实际在监听的端口，四处一致 |

### R11.5 前端：一条可操作的提示，而不是刷屏

- **服务地址徽标**：真后端场景（配置 19160、实际 19162）→ 徽标显示 `http://127.0.0.1:19162`，`data-dcp-service-port=19162`；桩后端逐变体：`18999→18999`、缺 `port`/`'abc'`/`70000`→ 回落配置值（tooltip 说明"这是配置值"）、缺 `listen`→ 整块不渲染，**全程没有 `undefined`/`NaN`**。
- **断连节流**：连续 33.6 s / 7 个失败轮询周期内，提示条恒为 **1**、toast 恒为 **0**，而 `__DCP_LINK__.count` 从 1 递增到 7（提示本身不重画）；恢复连通后提示自行消失、`lost=false`。
- **重试契约未动**：`fetchRetry` 仍是"只对 GET、只在网络层 reject 时重试 3 次"（实测每个失败周期页面侧恰好 3 次 fetch、组间约 150/300 ms）。
- **两个真实刷屏源**：同文案 error toast 30 s 节流（25 次同文案失败 → 1 条 toast + `suppressedToasts=24`）；`__DCP_SAVE_ARTISTS__` 单飞 + 按 key 合并 + 只在真变更时广播（同一 22 s 窗口：艺术家保存请求 3659 → 5、总请求 3699 → 41；A/B 对照证明"广播闸门不能单独去掉"）。

### R11.6 口径与边界

- **口径**：`node scripts/check.js` **pass=19 fail=0**；后端 harness **105/105**（10 块）；前端无头 Edge **45/45**。（实现者自建 harness 的断言数不作为裁决证据。）
- **已知边界**（本轮不修，原因见 `docs/HANDOVER.md` §13.2）：A 面板侧回声写法仍在；B 面板 `system` 缺失时会渲染「内存 NaN」（既有行为）；C `scripts/start.ps1` 的 `$proc.Kill()` 仍是单进程杀；D 硬杀后端时进程内兜底无法执行（Windows 硬边界）；E 绕过共享存储直接调外壳写入口会按旧快照回写（属 A 的另一种表现）。
- **开发机避让**：本轮所有实测都在 `%TEMP%` 沙箱里跑（拷 `server/ web/ installer/ package.json`），**没有**碰开发副本正在运行的实例与 `data/settings.json`；替身一律用 `node.exe`（`powershell.exe` 被 detached 拉起后会立刻退出，会造成假的"清理成功"）。