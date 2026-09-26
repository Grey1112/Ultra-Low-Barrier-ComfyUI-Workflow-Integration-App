# 项目交接文档（HANDOVER）

> **给接手人**：这份文档假设你**没有参与过开发**，但需要在半天内能改代码、能发布、能判断"哪里不能碰"。
> 其余四份文档的分工是：`README.md` 面向使用者、`FEATURES.md` 面向功能核对、`MIGRATION.md` 面向搬迁到别的机器、
> `docs/FULL-REFERENCE.md` 是逐文件/逐接口/逐决策的完整参考。**本文件只讲"交接"**：谁负责什么、怎么验、怎么发、坑在哪。
>
> 版本：**v1.2.2**｜项目名：**超低门槛 ComfyUI 工作流集成应用**（包名 `comfy-panel-standalone`）｜最后更新：第十一轮末
>
> **三个占位符**（本文件的真实路径不写死，避免交付物里出现机器路径）：
> `<开发副本>` = 你手上的完整项目目录（含 `server\ web\ runtime\ models\ data\`）；
> `<交付目录>` = `release\core` 的镜像拷贝位置（用于直接上手/上传 GitHub）；
> `<验收脚本目录>` = 验收与探测脚本所在目录（**不随包发布**，但要交接）。
> 它们的真实绝对路径请见私有移交记录（`PRIVATE-NOTES`，不进交付包）。

---

## 0. 一页速览

| 问题 | 答案 |
|---|---|
| 这是什么 | 一个**独立运行** 的本地 ComfyUI 工作流集成应用：自带 Node 后端 + 浏览器 UI，**零 npm 依赖**（只用 Node 标准库），**拷贝文件夹即完成迁移** |
| 代码在哪 | 开发副本 `<开发副本>\`；可上传 GitHub 的干净拷贝在 `<开发副本>\release\core\`（由脚本生成，**不要手改**） |
| 怎么起 | 双击 `start.cmd`（纯 ASCII + CRLF，内部调 `scripts\start.ps1`）→ 浏览器自动开 `http://127.0.0.1:8788/` |
| 技术栈 | 后端 Node ≥18 CommonJS；前端**无构建步骤**：vendored React 18.3.1 UMD + 原生 ES 模块页面，不用 JSX（`React.createElement`） |
| 总量 | 后端 13 个文件约 5,200 行；前端 16 个文件（10 个 JS 模块约 5,600 行 + 3 个样式文件 + 2 份词典）；文档 5 份；核心版 **67 个文件**（按 `scripts\build-core.ps1` 白名单口径：7 个目录 + 11 个顶层文件；脚本每次打包会打印「核心版文件数」，以它为最终值） |
| 自检一条命令 | `<开发副本>\runtime\node\node.exe scripts\check.js` → 期望 **19/19** |
| **动手改代码之前先看** | **§4 开头那段「每次改动都必须更新版本号」** —— 这是给后续 Agent 的第一条硬规矩，`check.js` `[5b]` 会强制 |
| 最大风险 | ① 交付物里出现真实机器路径/用户名/API Key；② `.cmd` 写成非 ASCII 或裸 LF（双击必挂）；③ 破坏"可迁移性"（写死绝对路径）；④ 改了代码没推版本号（顶栏徽标与 `check.js` `[5b]` 都会暴露）；⑤ **退了程序却把 ComfyUI 留成孤儿**（v1.2.2 的四层防护不能拆，见 §2 与 §13.2） |
| 未完成的事 | 见 §10（`anima-turbo` 第 3 个镜像源、跨平台、跨机局域网实测等） |

---

## 1. 交接物清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 开发副本（含运行期数据） | `<开发副本>\` | 完整项目：源码 + `runtime\`（便携 Node / 内嵌 ComfyUI / llama.cpp）+ `models\` + `data\` + `logs\`。**不要直接打包这个目录** |
| GitHub 发布版 | `<开发副本>\release\core\` | 脚本生成的干净拷贝（62 文件，含 `.git`），**只包含源码/脚本/文档/画师清单/许可** |
| 交付拷贝 | `<交付目录>\` | `release\core` 的镜像拷贝 + `.git`，供直接上手/上传 |
| **AI 生成声明** | `<开发副本>\AI-DECLARATION.md` | **本项目自身全部代码与文档由 AI 生成**；列明第三方边界与免责。已在 `build-core.ps1` 白名单与文档齐全检查里，会随核心版交付 |
| 交接与验收脚本 | `<验收脚本目录>\*.cjs` | 22 个验收/诊断脚本。**不属于交付物**（`build-core.ps1` 会排除该目录），但接手人必需，见 §7 |
| 网络探测原始数据 | `<验收脚本目录>\probe-{A..F}.{txt,json}`、`round5-mirrors.txt` | 镜像探测的逐条原始记录（含失败原因），排障时比结论更有用 |

> `.scratch` 类目录**不随包发布**是有意的：里面含真实机器路径与探测脚本。但它也**必须交接**，否则接手人无法复现"哪条结论是怎么测出来的"。

---

## 2. 立即上手（10 分钟）

```powershell
# ① 自检（不联网、不改文件）
cd <开发副本>
.\runtime\node\node.exe scripts\check.js          # 期望：结果：pass=19 fail=0

# ② 起服务（自带便携 Node；不打开浏览器）
$env:DCP_NO_OPEN='1'; .\runtime\node\node.exe server\index.js

# ③ 另开一个窗口验证
curl.exe -s http://127.0.0.1:8788/app/state        # 返回 JSON，comfy.online 视 ComfyUI 是否在跑
```

- 端口：后端 **8788**，内嵌 ComfyUI **8188**，本地 llama-server **8199**。
  环境变量 `DCP_PORT` / `DCP_HOST` 可覆盖，`DCP_NO_OPEN=1` 表示不自动开浏览器。
  **v1.2.2 起端口冲突不再静默漂移**：被占用时最多自增 **2** 次（每次 WARN），再占用就快速失败退出并提示用 `DCP_PORT` 指定其它端口；
  **实际端口只存内存、绝不回写** `data/settings.json`（`listen.port` 永远是配置值）。要看真实端口只有三处权威来源：`/app/state` 顶层 `port`、启动日志「打开：`http://127.0.0.1:<port>/`」、stdout 的 `DCP_READY {...}`。
- 想跑通生图还需要：内嵌 ComfyUI 已安装（`runtime\comfyui\`）且**正在运行**（面板/向导里的「启动」按钮，或 `POST /app/comfy/launch`）。
- **ComfyUI 是本程序拉起的子进程，退出时会连带停掉 —— 只清自己拉起的**（v1.2.2）：
  退出请用**托盘右键 →「关闭控制台并停止后端」**，它会先 `POST /app/quit` 请后端优雅退出（后端顺带停掉自己拉起的 ComfyUI），失败才回退 `taskkill /T /F`。
  四层防护：① 托盘优雅退出 → ② 托盘强杀后按 `data/run` 归属记录再清一次 → ③ 下次启动 `cleanupOrphans()` 清孤儿 → ④ 进程内 `process.on('exit')` 的同步兜底 `killOwnedSync`。
  **用户自己启动的 ComfyUI 永远不在候选里**（它没有任何归属记录），`/app/comfy/stop` 对它只回报 `owner=foreign` 并跳过。
  ⚠️ 注意纠正一个常见误解：孤儿**不是**因为"`detached: true` 让 `taskkill /T` 抓不到"——父进程还活着时 `/T /F` 能连 detached 子进程一起收（实测）；
  真因是**父链断裂**：`scripts\start.ps1` 的 `$proc.Kill()` 是**单进程杀**（不带 `/T`），控制台窗口被强杀/启动器被结束时中间那层 node 先死，ComfyUI 以 detached 子进程存活、父链已断，此后 `/T` 再也够不着它，下次启动又会被 `launch()` 的"探测到端口有回应就返回 online:true"认领。
  验收时踩过的坑：这正是"面板显示离线 → 模型下拉为空"的一种成因，别急着判成代码回归 —— 先 `POST /app/comfy/launch`。

---

## 3. 架构地图

### 3.1 后端（`server/`，CommonJS，零依赖）

| 文件 | 行数 | 职责 | 改动风险 |
|---|---|---|---|
| `index.js` | ~756 | HTTP 路由与所有 `/app/*`、`/comfy-panel/*` 接口；面板反代；SSE 任务流；**v1.2.2：`POST /app/quit` 优雅退出、端口自增上限 2 次、`/app/state` 顶层 `port`** | 中（接口契约，改完要同步 `docs/INTERNAL-CONTRACT.md`） |
| `config.js` | ~305 | 路径推导、设置默认值/夹紧/落盘、自检 | **高**（`paths` 与 `DEFAULTS` 是全项目的根） |
| `download.js` | ~609 | 下载引擎：镜像梯队展开、三条换源规则、断点续传、sha256、完整性防线、镜像测速 | **最高**（所有安装路径都走它） |
| `comfy-install.js` | ~650 | 向导主流程：7-Zip、ComfyUI 本体、自定义节点、权重、画师清单、许可 | 高 |
| `comfy.js` | ~576 | ComfyUI 进程管理与布局探测（`detectLayout`）、**v1.2.2 的进程归属记录 / 五条谓词 / `cleanupOrphans` / `stopOwned` / `killOwnedSync`**、artists 清单 | 中（但"只清自己的"是红线，见 §4 红线 14） |
| `llm.js` | ~912 | llama.cpp 运行时与模型管理、本地/外接两条推理路径、SSE、角色补全接线 | 高 |
| `characters.js` | ~449 | Danbooru 角色词表 + 563 条中文别名 + 输出补全/规范化 | 中 |
| `works.js` | ~194 | 扫描 ComfyUI `output` 目录（本机作品）、输出目录三级解析 | 低 |
| `jobs.js` | ~194 | 长任务（下载/安装）的事件、列表、SSE 广播 | 中 |
| `store.js` | ~262 | `data/` 下的 JSON 读写（画师、分组、LLM 模型、会话、setup） | 低 |
| `util/fsx.js` | ~141 | 文件/哈希/格式化工具（含原子写） | 低 |
| `util/zip.js` | ~128 | 7-Zip 定位与解压、zip 解压、单根提升 | 低 |
| `util/log.js` | ~49 | 日志 | 低 |

> 行数为 v1.2.2 末的实测值（`Get-ChildItem server -Recurse -Filter *.js` + 逐文件计数），**每次改动请顺手核对一次**。

### 3.2 前端（`web/`，无构建步骤）

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.html` | 23 | 唯一页面：挂载点 + 引入 vendored React/ReactDOM + `app-shell.js` |
| `app-shell.js` | ~653 | 外壳：**四个常驻标签页**（切页只隐藏不卸载，见 §3.4）、顶栏（品牌/后台任务条/日志/语言/**v1.2.2 的「服务地址」徽标**）、全局 toast（**同文案 30 s 节流**）、**断连 banner 与 `window.__DCP_LINK__`**、画师数据桥（`__DCP_SAVE_ARTISTS__` / `__DCP_ARTIST_GROUP__` / `__DCP_CREATE_GROUP__`）+ 排障钩子 `window.__DCP_SHELL__` |
| `panel.js` | ~2253 | **生图面板**（从早期插件形态 `lib/client.js` 移植 + 锚点补丁）：三栏 1:1:2、图构建器、画师、参数 |
| `panel-host.js` | 60 | 给 `panel.js` 提供 `require("react")` 之类的垫片 |
| `job-view.js` | 142 | 长任务视图：`JobProgress`（进度/速度/ETA/来源）、`openJobModal`、`BackgroundJobs`（顶栏任务条） |
| `i18n.js` | 257 | DOM 翻译器：`ui` 词典 + 面板 `panel` 词典 + 短语规则；中英切换 |
| `pages/workbench.js` | 60 | 工作台：单面板 + layout 切换 + 把 LLM 页 portal 进提示词栏 |
| `pages/llm.js` | ~1101 | LLM 页：对话（SSE + **思考过程块** + **历史会话侧栏**）、推荐目录、模型管理、外接 API 设置、角色词表 |
| `pages/artists.js` | ~464 | 画师页：收藏/黑名单/自定义、分组（建/展开成员/移出/重命名/删）、本机作品网格、搜索 |
| `pages/settings.js` | ~446 | 设置页：ComfyUI 内外接、监听、**下载源与镜像梯队 + 镜像测速**、LLM 配置 |
| `pages/wizard.js` | ~185 | 首次运行向导：档位选择、安装进度（含"切走再切回重挂任务"） |
| `styles/shell.css`、`pages/pages.css`、`styles/workbench.css` | ~261/165/188 | 样式（**新增类名必须写进这三个文件之一**；`.tab-pane` / `.tab-hidden` 在 shell.css，`.thinking-block` / `.session-row` / **v1.2.2 的断连 banner 与「服务地址」徽标**在 pages.css） |
| `i18n/zh.json`、`i18n/en.json` | ~845/1079 | 词典（**键集必须完全一致**，由 `check.js` 强制） |
| `vendor/react*.js` | — | React 18.3.1 UMD（不联网、不构建） |

### 3.3 其它

| 目录/文件 | 内容 |
|---|---|
| `installer/models.json` | 12 个权重的目录：`id/file/dest/bytes/sha256/tier/license/officialUrl/mirrors/fastMirrors/verified` |
| `installer/llm-models.json` | 3 个推荐 GGUF（4B/9B/2B）+ 镜像 + sha256（**只给链接，不自动下载**） |
| `scripts/start.ps1` | 启动器：找/下载便携 Node → 起后端 → 探活 → 开浏览器 → 托盘 |
| `scripts/bootstrap.ps1` | 便携 Node 引导（**独立实现同一套镜像梯队 + 10 s 无进展换源**，因为此时还没有 Node 可跑） |
| `scripts/tray.ps1` | 托盘图标与右键菜单；**v1.2.2：退出改为"先礼后兵"** —— 先 `POST /app/quit`（6 s 超时 + 最多等后端 8 s，判据是"进程真的消失"），失败才回退 `taskkill /T /F`，两条路径最后都按 `data/run` 归属记录再清一次本程序拉起的 ComfyUI；日志用 `graceful` / `forced` / `already-stopped` 互斥文案区分 |
| `scripts/check.js` | 自检（**19 项**，见 §4；v1.2.1 新增 **[5b] 版本号一致性**；v1.2.2 未增删自检项，仍是 19 项） |
| `scripts/build-core.ps1` | 生成 `release\core\` + 三项交付前扫描 + 可选 `git init` |
| `scripts/normalize-ps1.cjs` | 把 `.ps1` 规范成 UTF-8 **BOM** + CRLF 并做 PowerShell 解析校验 |
| `assets/artists/*.txt` | 画师清单（59,676 位 + top200，MIT） |
| `assets/templates/anima-system-prompt.txt` | 提示词生成的系统提示词（**与发给模型的必须逐字节一致**） |
| `LICENSES/`、`THIRD_PARTY.md` | 许可全文与第三方声明（再分发义务见 §12） |
| `docs/INTERNAL-CONTRACT.md` | 前端页面契约 + 接口清单（**改接口要同步这里**） |
| `docs/FULL-REFERENCE.md` | 逐文件/接口/配置/决策/验证记录（**最全**） |
| `docs/HANDOVER.md` | 本文件 |

---

## 4. 必须遵守的红线（改动前先读这一节）

> ## ⚠️ 给后续 Agent 的第一条硬规矩：**每次改动都必须更新版本号**
>
> **任何一次**对代码/行为的改动（修 bug、加功能、改 UI、改接口、改文案导致界面行为变化）都**必须**在同一个回合里把版本号往前推一格，
> 并**同时**改这三处（`check.js` 的 `[5b]` 会强制校验，三处不一致**直接自检失败**）：
>
> | # | 文件 | 要改的东西 |
> |---|---|---|
> | 1 | `server/config.js` | `const VERSION = '1.2.2';`（顶栏/接口 `/app/state` 的 `version`、`buildTag` 都由它派生） |
> | 2 | `package.json` | `"version": "1.2.2"` |
> | 3 | `web/panel.js` | `const BUILD_TAG = "v1.2.2";` ← **最容易漏的一处**：面板头部那个「🎨 … v1.2.2」徽标只读它 |
>
> **为什么必须每次改**：面板是**静态直托管、无 ?rev= 快照**的（改代码刷新即生效），所以版本号是用户与验收者判断
> "页面加载的到底是哪一份代码"的**唯一凭据**；不推版本号就会出现"后端已是新版、顶栏还是旧版""改了但看不出改没改"。
> v1.2.1 发版时真实踩过：只改了前两处，用户顶栏仍显示 1.2.0。
>
> **怎么推**：修复/小改 → 末位 +1（1.2.1 → 1.2.2）；新增功能/行为变更 → 中间位 +1（1.2.x → 1.3.0 或按你的口径）；
> 不兼容变更 → 首位 +1。**不要**回退版本号，也不要为了"过自检"把三处改成同一个旧值。
>
> **同回合还要做的收尾**（属同一件事，别拆开）：
> 1. 跑 `node scripts/check.js`，确认 **19/19**（含 `[5b]` 版本号一致性）；
> 2. 在 `FEATURES.md` 的「文档版本记录」、`README.md` / `README.en.md` 的「文档版本记录」各加一行，写清**改了什么/为什么/边界**；
> 3. 若改的是接口、数据文件或前端契约，同步 `docs/INTERNAL-CONTRACT.md` 与 `docs/FULL-REFERENCE.md` §8（见红线 10）；
> 4. 发布打包时 `scripts/build-core.ps1` 的默认提交信息也带上新版本号（第 4 处，不参与自检）。

| # | 红线 | 为什么 | 由谁强制 |
|---|---|---|---|
| 1 | **零 npm 依赖**：后端只用 Node 标准库 | "解压即用"是产品前提，装依赖=门槛 | 人工；`package.json` 的 `dependencies` 必须保持 `{}` |
| 2 | **零硬编码机器路径**：项目内路径一律从 `__dirname` 推导 | 整个文件夹拷到别的盘/机器后必须照常工作 | `scripts/check.js` [5] 脱敏扫描（盘符、用户目录、真实用户名） |
| 3 | **交付物零 API Key** | Key 一旦进文档或代码就是事故 | `.gitignore` 排除 `data/`；发布前跑 `release-scan.cjs`（会与本机真实 Key 逐文件比对） |
| 4 | **`.ps1` 必须 UTF-8 with BOM + CRLF** | PowerShell 5.1 无 BOM 时按 GBK 解码，中文注释会解析失败 | `check.js` [4] + `normalize-ps1.cjs` |
| 5 | **`.cmd`/`.bat` 必须 CRLF + 纯 ASCII（无 BOM）** | cmd.exe 按 OEM 代码页(936)读文件，非 ASCII/裸 LF 会吃掉行尾 → 双击 exit 9009（真实事故） | `check.js` [4b] |
| 6 | **中英词典键集完全一致、英文值不得留汉字** | 切语言后不能出现空白/夹生 | `check.js` [3] |
| 7 | **不允许静默失败**：任何下载/安装失败都要有可读原因 | 用户排障只能靠日志 | 代码评审；`download.js` 报错会列出**每个来源的失败原因** |
| 8 | **不随包分发权重/二进制/Python 源码** | 许可与体积（ComfyUI 是 GPL-3.0，本项目只调用不内联） | `build-core.ps1` 扫描 + `check.js` |
| 9 | **只把必须的机器路径写进 `data/`**：外接 ComfyUI 目录只存 `data/settings.json` | 迁移时只需关注这一个文件 | 设计约定 |
| 10 | **改接口必须同步 `docs/INTERNAL-CONTRACT.md` + `docs/FULL-REFERENCE.md` §8** | 两份文档是接手人理解系统的入口 | 人工（未进自检，靠纪律） |
| 11 | **每次改动都必须更新版本号**（三处同改，见本节开头）：`server/config.js` 的 `VERSION`、`package.json` 的 `version`、`web/panel.js` 的 `BUILD_TAG` | 面板静态直托管、无快照机制，版本号是"页面加载的是哪一份代码"的唯一凭据；漏改就会出现"后端已是新版、顶栏还显示旧版"（v1.2.1 发版时真实踩过） | `check.js` **[5b]** 强制（三处不一致直接失败）；人工纪律负责"每次改都推一格" |
| 12 | **常驻标签页的 key 必须稳定**：`renderPage` 传给页面的 `key` 只能是 tab id，**不能掺 `renderKey`** | `renderKey` 会在按需加载完成时自增；掺进 key 会把刚挂载的页面整体重建，"切页保留提示词/对话"当场失效 | 人工（`web/app-shell.js` 的注释里写明了原因） |
| 13 | **面板里的 `useState` 只能追加在 hook 链末尾**（"hook 索引只增不移"） | 冒烟测试按数字索引给 `useState` 喂值，插进中间会让后续索引整体错位 | 人工（`web/panel.js` 的【冒烟红线】注释）+ 冒烟脚本 |
| 14 | **只终止本程序拉起的 ComfyUI**（v1.2.2）：退出路径必须连带停掉它（`comfy.stopOwned` / `killOwnedSync`），清理只能依据 `data/run/comfy-owner-<pid>.json` **归属记录 + 五条谓词**（记录可解析 → 进程存活 → 命令行含 `main.py` → 命令行反推入口目录 == 记录 `codeDir`（或命令行含记录 `mainPy`）→ pid ≠ 自身），任一条不满足**只记 WARN、绝不动手**；**绝不允许**按"谁在监听 `comfy.port`"清理 | 用户自己启动的 ComfyUI 没有任何记录，按端口清理会**当场误杀**用户的实例（旧 `stop()` 就是这个行为）；反之漏清只是留一个孤儿，下次启动还能收 —— 宁可漏清，绝不误杀 | 人工 + `comfy.verifyOwnership()`；独立复核 `docs/ROUND11-VERIFY.md` §6（六条反例 + 两条红线全过） |

---

## 5. 数据落盘与"什么不能进交付包"

| 路径 | 内容 | 进交付包？ |
|---|---|---|
| `data/settings.json` | 设置（**唯一可能含用户外部绝对路径**；API Key 也在这） | ❌ 已 gitignore |
| `data/artists.json` | 收藏/黑名单 | ❌ |
| `data/llm/models.json`、`sessions.json` | LLM 模型清单、会话 | ❌ |
| `data/characters/` | 角色词表（3.5 MB，可重下） | ❌ |
| `data/run/comfy-owner-<pid>.json` | **v1.2.2**：ComfyUI 进程归属记录（pid + 本机绝对路径 + 启动时刻），每个本程序拉起的实例一份；退出/子进程退出时删除 | ❌（**含本机路径，别拷别传**） |
| `data/setup.json` | 向导完成状态 | ❌ |
| `logs/` | 服务 / ComfyUI / llama-server / 任务日志 | ❌ |
| `runtime/` | 便携 Node、内嵌 ComfyUI（数 GB）、7-Zip、llama.cpp | ❌ |
| `models/` | 本地 GGUF | ❌ |
| `release/core/` | 生成的干净拷贝 | ❌（是产物，不是源码） |
| 验收脚本目录 | 验收脚本与探测原始数据 | ❌（但**要交接**，见 §1） |

> 第七轮起，`save()` **不把派生出来的镜像梯队写进 `settings.json`**（`hfMirrors`/`nodeMirrors`/`jsdelivrMirrors`/`extraMirrors`），
> 且**等于默认值的 `githubProxies` 也不落盘**。原因：任何一次 `PUT /app/settings` 都会把当时的默认值固化，之后升级默认镜像对老机器失效（真实踩坑）。
> 看到 `settings.json` 里出现这些键 = 用户显式改过，属正常。

---

## 6. 下载与镜像体系（改这里之前务必读完）

### 6.1 一切镜像都是**数据**，不是代码

`server/download.js` 的 `buildCandidates(url, settings)` 只做一件事：**按 URL 家族选一组模板并展开**。
模板来自设置（设置页「下载源」可整段替换）：

| 设置键 | 默认（空数组时自动派生） | 适用 |
|---|---|---|
| `download.hfMirrors` | ModelScope(`master`) → ModelScope(`main`) → aifasthub → `hf-api.gitee.com` → `ai.gitcode.com` → hf-mirror | HuggingFace 系仓库 |
| `download.nodeMirrors` | 清华 TUNA → 官方 → 华为云 → cdn.npmmirror → registry.npmmirror | Node 便携包 |
| `download.jsdelivrMirrors` | fastly → gcore → raw.githubusercontent → gh-proxy(raw) → ghfast(raw) | jsDelivr 的 GitHub 通道（角色词表） |
| `download.githubProxies` | `gh-proxy.com/` → `down.npee.cn/?{url}` → `ghproxy.net/` → `ghfast.top/` | GitHub 资产（ComfyUI 便携包 / llama.cpp / 7-Zip） |
| `download.extraMirrors` | 空 | 任意直链的通用兜底 |

占位符：`{url} {repo} {owner} {name} {rev} {path} {file} {ver} {host}`。
GitHub 代理支持前缀式（`https://gh-proxy.com/`，自动补 `{url}`）、查询式（`https://down.npee.cn/?{url}`）、
换主机式（`https://kkgithub.com/{repo}/releases/download/{ver}/{file}`）。

### 6.2 三条换源规则（都在 `download()` 的 `attempt()` 里）

1. **10 秒内没有正常开始下载**（从"发出请求"计时，累计收到 < 64 KiB）→ 换源。64 KiB 的门槛是为了挡掉"先回一个几百字节校验页"的站。
2. **连续 15 秒没有新字节** → 换源（对所有候选生效，含最后一个）。
3. **远慢于本次见过的好源**（当前窗口均速 < 已见最佳 / 4）→ 换源；另有经典的"整个慢速窗口均速低于 `slowThresholdKBs`"规则，
   但**最后一个候选只看停滞阈值**，避免"所有源都慢时把能下完的文件掐掉"。

阈值全在 `download.*`（`startDeadlineMs` / `stallDeadlineMs` / `minStartBytes` / `slowThresholdKBs` / `slowWindowMs` / `stallKBs`）。

### 6.3 两个必须知道的实现细节

- **字节计数挂在 `pipeline` 的 `Transform` 上**，不能用 `'data'` 监听（会绕过背压）。
  历史上这里漏了计数，导致"进度/速度恒为 0，且看门狗误杀正常下载"——第七轮才修掉。
- **改名之前必须校验完整性**：`if (total > 0 && bytes < total) throw`。实测 ModelScope 的 CDN 会中途断连，
  同一个 242 MB 文件下出 126/121/112/3 MB 四种结果而流"正常结束"；没有这道防线，不带 `expectBytes` 的调用方会**静默接受损坏文件**（红线）。

### 6.4 镜像测速（设置页按钮 / `GET /app/download/speedtest`）

对一条直链的**每个候选来源各真下 N MiB**（默认 100，读满即停、不写盘、同一时刻只允许一个任务），返回
`{firstByteMs, gotBytes, sec, mbps, ok, partial}`。`ok` = 完整读完或 ≥1 MiB；`partial` = 被判失败但已收到 ≥8 MiB（"慢但能下"）。
**这是"某个源到底能不能用"的唯一权威口径**，比任何文档里的数字都新。

### 6.5 已实测结论（开发机，第七轮；速度随时段剧烈波动，只作参考）

| 组件 | 可用来源 |
|---|---|
| `qwen_3_06b_base` / `qwen_image_vae` | ModelScope、ai.gitcode.com、hf-api.gitee.com、aihub.caict.ac.cn（需两步 LFS batch，**未实现**）、aifasthub、hf-mirror → **≥3 可用** |
| `anima-turbo-v1.1`（3.9 GiB） | 实际只有 ModelScope（快）+ aifasthub（很慢）+ hf-mirror（限速）→ **≥3 未达成**，原因见 §10 |
| Node 便携包 | 清华 29.6 / 官方 17.2 / 华为云 9.8 / npmmirror 9.2 MB/s → **5 个可用** |
| 角色词表 `danbooru.csv` | jsDelivr、gh-proxy、down.npee.cn、ghfast.top → **≥3 可用** |
| 7-Zip | GitHub `ip7z/7zip` 经 gh-proxy（1.8 MB/s）、down.npee.cn、ghfast.top、官方 7-zip.org（很慢）→ **4 个可用** |
| ComfyUI 便携包 | **快源只有 gh-proxy.com 与 down.npee.cn**；另备：哈希校验通过的官方旧版（v0.3.59）、hf-mirror 第三方构建（强制提示非官方）、`git` 模式、本地归档、外接已有目录 |
| llama.cpp（可选） | 同上两个快源；且**外接 API 是默认推理来源**，本地运行时可以完全不装 |

> 探测过但**不可用**的（别重复试）：`ghps.cc`（全站 404）、`ghfile.geekertao.top`（1 MiB 探测 11 MB/s 是假象，实测 0.05 MB/s）、
> `hub.gitmirror.com` / `github.moeyy.xyz` / `ghp.ci` 等约 20 个（DNS 已失效）、`kkgithub.com` / `bgithub.xyz`（证书不匹配）、
> `aliendao.cn`（只服务已缓存仓库）、`wisemodel.cn`（未托管）、`mirrors.ustc.edu.cn`（需 JS 验证 Cookie）。
> 完整原始记录见 §1 的 `probe-*.txt`。

---

## 7. 验证手册（接手第一件事：把基线跑一遍）

所有脚本在**验收脚本目录**，一律用项目自带的便携 Node 跑：
`<开发副本>\runtime\node\node.exe <脚本>`

### 7.1 不需要服务的（纯静态 / 纯函数）

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `scripts\check.js`（在项目内） | 语法、JSON、词典、`.ps1`/`.cmd` 编码、脱敏、**版本号一致性（`[5b]`）** | **19/19** |
| `panel-test.cjs` | 面板纯函数与图构建器（与插件版逐字节等价） | **32/32** |
| `round2b-alias.cjs` | 角色别名与开关 | **9/9** |
| `round5-chars.cjs` | 角色 tag 补全 + **规范化**（含 `rem \(re:zero\)` 转义写法） | **10/10** |
| `round5-partial.cjs` | 截断下载防线（本地构造"少发数据"的服务端） | **8/8** |

### 7.2 需要后端／浏览器的（先起服务；UI 类会自己拉无头 Edge）

| 脚本 | 覆盖 | 基线 |
|---|---|---|
| `round2c-hash.cjs` | sha256 校验路径（含失败路径） | **6/6** |
| `round2-ui.cjs` | 三栏工作台、画师工具、提示词工具 | **23/23** |
| `round2-i18n.cjs` | 中英切换、面板词典、无中文残留 | **7/7** |
| `round3-api.cjs` | 外接 API：模型列表、自检、SSE 正文、角色规范写法、错 Key 提示、Key 不外泄 | **13/13** |
| `round3-ui.cjs` | 三栏比例、窄屏降级、默认模型/管线 | **16/16**（**ComfyUI 必须在线**，否则模型下拉为空） |
| `round4-ui.cjs` | 四挡推理、上下文策略、布局、默认画师、切模型不清提示词、本机作品 | **30/30** |
| `round5-ui.cjs` | **第七轮四项需求**：改名、向导进度重挂、顶栏任务条、速度非 0、镜像测速表、最小档组件真下载 | **21/21** |
| `round5-mirrors.cjs` | 镜像梯队结构 + 每组件逐源实测 100 MiB（**耗时 10–20 分钟**） | 结构 11 项全过；逐源结果见 `round5-mirrors.txt` |
| `gen-test.cjs` | **端到端出图**：面板图构建器 → 反代 → ComfyUI → 取图 | `SMOKE_OK`（开发机 5.0 s / 253,327 B PNG） |
| `llm-test.cjs` | 本地 llama.cpp 对话（需已装运行时与 GGUF） | `LLM_OK` |
| `zero-wizard-test.cjs` / `migration-test.cjs` / `ui-e2e.cjs` | 从零向导、迁移、外壳端到端 | 早期轮次基线 |
| `consistency-check.cjs` | 源工程 ↔ `release\core` ↔ 交付拷贝 三方一致 + git 状态 + 包内自检 | 发布前必须全绿 |
| `release-scan.cjs` | 交付包密钥/路径扫描（含与真实 Key 逐文件比对） | `CLEAN` |

### 7.3 一次性诊断工具（排障用）

`dbg-*.cjs`（面板 DOM、SSE 帧、i18n 缺口、冷启动等）、`hash-*.cjs`（算权重哈希）、`probe-*.cjs`（网络探测）。
`cdp.cjs` 是所有 UI 测试的底座（用 Node 自带 WebSocket 直连无头 Edge 的 DevTools），要写新 UI 测试就从它开始。

---

## 8. 常见维护任务手册

> **第 0 步（对所有任务都一样，别跳过）**：先按 §4 开头那段推版本号（`server/config.js` 的 `VERSION`、`package.json` 的 `version`、`web/panel.js` 的 `BUILD_TAG` 三处），
> 并在 `FEATURES.md` / `README.md` / `README.en.md` 的「文档版本记录」各加一行写清改了什么。收尾跑 `check.js`（19/19，`[5b]` 会核版本号）。

| 任务 | 步骤 | 坑 |
|---|---|---|
| **改界面文案** | 改 `web/i18n/zh.json` + `en.json` **两份** | 键集必须一致；面板文案走 `panel` 词典或 `panelPhrases` 规则；改完跑 `check.js [3]` |
| **加一个界面字符串** | 两个 json 各加一条，代码里 `t('xxx')` | 别直接写中文字面量 |
| **改默认生图型号/档位** | 改 `installer/models.json` 的 `tier`；默认型号在 `web/panel.js` 的 `INIT_MODEL`/`INIT_ROUTE` | 改完用 `GET /app/setup/plan?sel=minimal` 核对 `tiers` 三个值，并同步 README/FEATURES |
| **加一个权重** | 在 `installer/models.json` 增一条：`id/file/dest/bytes/sha256/tier/license/officialUrl/urls/mirrors/verified/note` | `bytes` 必须精确；`sha256` 必填（下载后校验）；`dest` 只能是 `diffusion_models`/`text_encoders`/`vae` |
| **换/加镜像源** | 改 `server/config.js` 的 `DEFAULTS.download.*`，或直接在设置页改；**先跑镜像测速** | 注意 §5"派生值不落盘"规则；`round5-mirrors.cjs` 可批量验 |
| **加一个 HTTP 接口** | 在 `server/index.js` 对应分支加；同步 `docs/INTERNAL-CONTRACT.md` §4 与 `docs/FULL-REFERENCE.md` 48 | 面板反代路径是 `/comfy-panel/api/*`，不要往那里塞业务接口 |
| **加一个前端页面** | `web/pages/x.js` 导出默认组件 + 在 `app-shell.js` 的两张页面映射表注册 | 契约见 `docs/INTERNAL-CONTRACT.md` §1–2（props 只有 `api/put/post/t/state/settings/refresh/toast`） |
| **改下载行为** | 只动 `download.js`；**不要**在调用方里手搓重试/换源 | 三条规则与阈值都在 `download.*`；改完跑 `round5-partial.cjs` + `round5-mirrors.cjs` |
| **改提示词** | `assets/templates/anima-system-prompt.txt` | 与发给模型的必须逐字节一致（`llm-test.cjs` 会核） |
| **改本地模型** | 放到 `models\llm\`，在 LLM 页「添加本机文件」或改 `data/llm/models.json` | 推荐目录 `installer/llm-models.json` **只给链接**，不自动下载 |
| **改启动器** | `scripts/start.ps1`（UTF-8 BOM + CRLF），改完跑 `normalize-ps1.cjs` | 双击入口 `start.cmd` 是纯 ASCII + CRLF，**不要**往里加中文 |
| **改 ComfyUI 进程 / 退出行为**（v1.2.2 新增条目） | 先读 §4 红线 14 与 `docs/INTERNAL-CONTRACT.md` §0/§4；改动点集中在 `server/comfy.js`（归属记录、五条谓词、`stopOwned` / `killOwnedSync` / `cleanupOrphans`）与 `server/index.js`（`/app/quit`、`beginQuit` / `finishQuit`、`process.on('exit')`）；托盘侧在 `scripts/tray.ps1` 的 `Stop-Backend` / `Stop-OwnedComfyUI` | ① 别把"按端口找监听进程再杀"加回来（会误杀用户实例）；② 别删/别忘删 `data/run` 归属记录；③ 改完必须实测两条路径：**优雅退出**（`POST /app/quit`）与**硬杀后重启清孤儿**（`docs/ROUND11-VERIFY.md` §5/§7 有可照抄的场景）；④ 替身请用 `node.exe`，**别用 `powershell.exe`**（它被 detached 拉起后会立刻退出，会造成假的"清理成功"） |
| **改端口绑定行为**（v1.2.2 新增条目） | `server/index.js` 的 `listen()` / `MAX_PORT_BUMP` / `listenPort()`；实际端口只存内存 | ① 别恢复 `save({listen:{port:actual}})` 回写 —— 那正是 v1.2.2 修的"静默漂移"；② `/app/state` 顶层 `port` 必须与实际监听、与「打开：」日志、与 `DCP_READY` 四处一致；③ 启动器 `scripts/start.ps1` 的就绪探测窗口是 `base..base+20`，自增上限收紧到 2 后它仍成立，**不要**顺手去改启动器（不在本轮范围） |
| **重新发布** | 见 §9 | `release\core` 里**不要手改**任何文件 |

---

## 9. 发布流程（每次改完代码都要走）

```powershell
cd <开发副本>

# ① 自检
.\runtime\node\node.exe scripts\check.js                      # 期望 19/19（含 [5b] 版本号一致性）

# ② 生成干净拷贝 + 三项扫描（隐私/权重/GPL）+ 可选 git 提交
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-core.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-core.ps1 -GitInit   # 需要提交时

# ③ 镜像到交付目录（/MIR 会删掉目标里的多余文件）
robocopy .\release\core <交付目录> /MIR /NFL /NDL /NJH /NJS /NP
Copy-Item -Recurse -Force .\release\core\.git <交付目录>\.git

# ④ 三方一致性 + 密钥扫描（发布前红线）
cd <验收脚本目录的上一级>
<开发副本>\runtime\node\node.exe <验收脚本目录>\consistency-check.cjs
<开发副本>\runtime\node\node.exe <验收脚本目录>\release-scan.cjs

# ⑤ 打包（只用正斜杠条目；历史上用反斜杠导致跨平台解压异常）
```

注意：
- **发布前必须已经推过版本号**（§4 开头那段：`server/config.js` / `package.json` / `web/panel.js` 三处 +
  `build-core.ps1` 里的默认提交信息）。别等打包时再补 —— 那正是 v1.2.1 漏掉面板 `BUILD_TAG` 的成因。
- `build-core.ps1` 会**先删掉整个 `release\core`**（含 `.git`），所以想保留历史必须用 `-GitInit` 重建，或先备份 `.git`。
- 交付目录里**不允许**出现 `runtime/ models/ data/ logs/`：跑过 `start.cmd` 就会生成它们，发布前清掉。
- 文档文末的版本表要**同时**加一行：`README.md`、`README.en.md`、`FEATURES.md`、`MIGRATION.md`、`docs/FULL-REFERENCE.md`（`docs/HANDOVER.md` 的 §13 变更摘要也顺手加一条）。

---

## 10. 已知限制与未完成事项（诚实清单）

| # | 事项 | 现状与原因 |
|---|---|---|
| 1 | `anima-turbo-v1.1`（3.9 GiB）第 3 个可用镜像源 | **做不到**：ai.gitcode.com / hf-api.gitee.com / aihub.caict.ac.cn 镜像的都是 2026-02/03 的旧快照，`split_files/diffusion_models/` 里只有 `anima-preview`，而 turbo 是 2026-08-24 之后才上传的。aihub 的 `/download/` 端点存在但需登录（401）。目前是 ModelScope（快）+ aifasthub（很慢）+ hf-mirror（限速）。**用户已确认"这些源够了"**，故冻结 |
| 2 | ComfyUI 便携包 / llama.cpp 的镜像数量 | GitHub 系资产在该环境**只有 2 个快代理**（gh-proxy.com、down.npee.cn），其余 20+ 个实测限速或已死。已用"哈希校验通过的官方旧版 + 第三方构建（强制提示）+ git 模式 + 本地归档 + 外接目录"兜底 |
| 3 | 非 Windows 平台 | 代码里有非 win32 分支（`taskkill`/`process.kill` 兜底、`which`），但**从未在 Linux/macOS 跑过**；启动脚本与向导面向 Windows |
| 4 | 局域网多机访问 | 令牌校验可由接口验证，但**未做过跨机端到端测试**；`listen.lan=true` 会监听 `0.0.0.0` 并要求令牌 |
| 5 | `git` 模式的 ComfyUI 安装 | 代码完备（clone → venv → pip 走清华源），**未实测**（推荐路径是便携包） |
| 6 | 官方 `huggingface.co` / `github.com` 直连分支 | 该环境被墙，"官方源直连成功"这条分支从未真实走通（代码里它是候选列表第一项） |
| 7 | 角色词表召回率 | 40,931 条 Danbooru 角色 tag + 563 条中文别名（563/563 精确命中，`aliasMisses=0`）；但 `レム` 这类假名写法与冷门角色仍未覆盖，靠 `data/character-aliases.json` 补 |
| 8 | 镜像速度的绝对值 | 同机同时段波动可达 30 倍（74–95 MB/s ↔ 1.9–7.5 MB/s）。产品判定只看"有没有进展"，文档里的速度数字必须带测量时间才有意义 |
| 9 | CUDA 版 llama.cpp 在老显卡 | 只在 RTX 5060 Laptop（Blackwell）上验证过 |
| 10 | **输出目录的"自动判定"依赖进程命令行**（v1.2.0 新增能力） | 判定的第一手依据是"监听 `comfy.port` 的那个进程的 `CommandLine`"（Windows 用 PowerShell CIM 读，实测 ~150 ms，结果缓存 60 s）。因此：① 非 Windows 平台取不到命令行 → 回落到"按 `comfy.mode/dir` 推导"（与旧行为一致）；② 拉不起 PowerShell / 权限受限的环境同理；③ 这些情况都可以在**设置页直接填「输出目录」**覆盖，界面会显示当前解析结果、来源与图片数（`source` 字段写明是设置/运行中实例/按模式推导） |
| 11 | **下载前的逐源测速会先花一点时间**（v1.2.0 新增行为） | 用户明确要求"每个源都尝试一次，测出最快的再稳定用"。代价是：文件 ≥ 8 MiB 且候选 ≥ 2 时，正式下载前会先给每个候选各探一段（**每个源最多 1 MiB / 6 s**，全部并发度为 1，即串行）。以 5 个候选为例，最坏多花约 30 s，换来的是"不在慢源上反复切换"。**文件 < 8 MiB 会自动跳过测速**；同一来源家族 10 分钟内只测一次。若某个环境里这层开销不可接受，可在调用处传 `noProbe: true` 关掉（`download()` 的入参） |
| 12 | **删除作品是不可撤销的硬删除**（v1.2.0 新增功能） | 按用户要求"web UI 与图片文件夹都删掉"，`/app/output/delete` 直接 `fs.rmSync`（不进回收站）、被删空的模型子目录也一并移除。界面做了**两步确认**并且确认按钮上写明文件名；但**没有回收站/撤销**。若以后想要"删到 `.trash` 子目录、可恢复"，需要产品侧先改口径 |
| 10 | 9B 推荐模型 | 已实测下载→校验→加载→12.3 s 就绪，但**未随包提供**（按要求只给链接） |

---

## 11. 开发机环境事实（只供排障参考，且已去标识化）

- 操作系统：Windows（中文），PowerShell **只有 5.1**（没有 `pwsh`）——这是"`.ps1` 必须 BOM+CRLF、`.cmd` 必须纯 ASCII"两条红线的根因。
- 内嵌 ComfyUI：**0.37.0**（`runtime\comfyui\ComfyUI`），输出目录 `runtime\comfyui\ComfyUI\output`（约 35 张图 / 30 位画师）。
- 本地 llama.cpp：**b11177 CUDA**（`runtime\bin\llama\llama-server.exe`）；本地 GGUF 只有 **Qwen3.5-4B-UD-Q4_K_XL.gguf**
  （2,912,109,728 B，sha256 `b252c561…bc961bc7`）；9B / 2B / DanTagGen 已卸载。
- 显卡：RTX 5060 Laptop 8 GB；512×512 / 8 步出图约 **5.0–8.3 s**。
- 网络事实：`huggingface.co`、`github.com`、`raw.githubusercontent.com` **被墙**；`api.github.com` **可直连**（用于取便携包 sha256）；
  可达：`modelscope.cn`、`aifasthub.com`、`cdn.jsdelivr.net`、`registry.npmmirror.com`、清华/华为镜像、`gh-proxy.com`、`down.npee.cn`。
- 端口：8788（后端）、8188（ComfyUI）、8199（llama-server）。
- 外接 API：开发机 `data/settings.json` 里配了 DeepSeek 的**测试用** Key（`provider=api`、`model=deepseek-flash`、`reasoning=off`、`sendContext=false`）。
  该 Key 仅用于测试，**绝不能出现在任何交付物/文档/日志里**（发布前用 `release-scan.cjs` 校验）。
- 真实绝对路径（开发副本 / 交付目录 / 验收脚本目录）见**私有移交记录**，故意不写进本文件。

---

## 12. 许可与合规边界

| 项 | 结论 |
|---|---|
| 本项目代码 | **MIT**（`LICENSE`） |
| ComfyUI 本体 | **GPL-3.0**。本项目**只调用不内联**：不随包分发其源码，只在用户机器上按其官方发布方式获取与解压（`build-core.ps1` 有"零 Python 源文件"扫描） |
| Anima 权重 / Anima 3.8B 节点 | `CircleStone-NC-1.2`（**非商业**）/ 节点 MIT。面板与向导都显示许可与来源 |
| Qwen-Image 2.1 系 | `Qwen-Research`（仅研究/非商业，商用需单独授权） |
| 画师清单 | MIT（见 `assets/artists/NOTICE.md`） |
| LLM 推荐模型 | Apache-2.0（可商用）。**只给链接，不随包分发** |
| 再分发义务 | 若把本项目与权重一起分发，必须同时带上 `LICENSES/` 与 `THIRD_PARTY.md`；README 412 有分区表与要点 |

---

## 13. 历轮变更摘要（从哪来的、为什么长这样）

| 轮次 | 主题 |
|---|---|
| 11 | **v1.2.2（第十一轮）**：①**退出即停**：新增 `POST /app/quit`（停本程序拉起的 ComfyUI → 停 LLM → 关 HTTP → 落盘 → 退出，重复/并发调用只收尾一次），`SIGINT/SIGTERM/SIGBREAK` 走同一套，`process.on('exit')` 加**纯同步**兜底 `killOwnedSync`；托盘退出改"先礼后兵"（先 `POST /app/quit`，6 s 超时 + 最多等 8 s，失败才回退 `taskkill /T /F`，两条路径最后都按归属记录再清一次）。②**只清自己的**：新增进程归属记录 `data/run/comfy-owner-<pid>.json`（launch 成功即写、子进程退出即删）+ 五条谓词；启动时 `cleanupOrphans()` 只清自己写过的记录；删除旧 `stop()` 里"按 `comfy.port` 找监听者"的兜底（它会误杀用户自己启动的实例），非本程序拉起的实例改为回报 `owner=foreign` 并跳过。③**孤儿真因（实测纠正）**：孤儿不是 detached 逃逸 —— 父进程还活着时 `taskkill /T` 能连 detached 子进程一起收；真因是**父链断裂**（`scripts/start.ps1` 的 `$proc.Kill()` 是单进程杀，控制台被强杀时中间那层 node 先死），外加旧 `listen()` 在 EADDRINUSE 自增时**重复注册就绪回调**导致 `autoStart` 一次拉起 3 个 ComfyUI 而内存只记住最后一个 pid（本轮一并修掉）。④**端口不漂移**：`MAX_PORT_BUMP=2`、每次 WARN、超限 `log.error` + `DCP_PORT` 建议 + `exit 1`；**取消**端口回写，实际端口只存内存并由 `/app/state` 顶层 `port` 自证。⑤**前端不刷屏**：顶栏「服务地址」徽标（取值链 顶层 `port` → `listen.port` 兜底 → 不渲染；非法值一律当缺失）；断连只在"连通→断连"跳变画**一条**可操作 banner，恢复即消失，首帧连不上改为 5 s 轻探自愈；同文案 error toast 30 s 节流；`__DCP_SAVE_ARTISTS__` 单飞+按 key 合并、只在真变更时广播（空闲自我回声实测从约 166 次/秒降到 0~1 次/22 s）。⑥版本号三处 → `v1.2.2`。**独立复核**：`check.js` pass=19 fail=0、后端 harness 105/105、前端无头 Edge 45/45（`docs/ROUND11-VERIFY.md`）。 |
| 10 | **v1.2.1（第十轮）**：①**切页保留状态** —— 导航改成四个常驻标签页，工作台切走时只隐藏不卸载（修掉"切到设置就失去提示词与 LLM 历史"；根因是页面 key 掺了 `renderKey`，按需加载完成时把刚挂载的页面整体重建），后台标签页跳过轮询 + 幂等 GET 瞬时失败重试；②**画师分组补齐** —— 收藏/黑名单 chip 与**生图面板内**（下拉行 / 已选 chip / 分组随机块）都能加组，分组卡片可展开成员、移出成员、重命名；按 key 传/按 key 写修掉"面板挂载清空分组"，新增 `POST /app/artists/groups/replace`；③**外接 API 思考过程可见 + 复制可靠** —— 新增 `reasoning` 帧与「🧠 思考过程」块（与正文分离、可折叠可单独复制），复制按钮不再依赖解析成功，修掉 `setLast` 打在 system 帧上导致助手气泡恒空；④**历史永久保留** —— `新建会话` 不再删会话、新增 `GET /app/llm/sessions` + `DELETE /app/llm/session/:id` + `lastSessionId` 自动接回，`keepMessages` 上限 200 → 2000；⑤版本号 → `v1.2.1`（`server/config.js` 的 `VERSION` 与 `package.json`）。 |
| 1 | 从早期插件形态派生出独立项目：零依赖后端、静态前端、可拷贝迁移、向导、F1–F5 功能、四份文档、核心版打包 |
| 2 | 三合一工作台、角色词表 + 563 条中文别名、外接 API（纯聊天内核）、ModelScope/国内优选源、托盘 |
| 3 | 外接 API 修复（思考型模型吃光 token → 关思考）、工作台 1:1:2、**画师 UI 独立成页**、默认模型改 `anima-turbo-v1.1`、本地模型只留 4B |
| 4 | 回车即发送、四挡推理、上下文只留本地不外发、工作台重排、默认画师大随机、切模型不清提示词、画师页本机作品 |
| 5 | **`start.cmd` 双击失败**（LF + UTF-8 中文 → cmd.exe CP936 解析崩）修复 + 新增批处理编码红线（自检 16→17） |
| 6 | 最小下载档位改成"刚好能跑默认模型"（turbo + 编码器 + VAE = **5.24 GiB**，原 14.00 GiB） |
| 7 | 向导进度不再丢（`/app/jobs` + 顶栏任务条）、**下载字节计数根因修复**、镜像体系数据化 + 三条换源规则 + 镜像测速、**截断下载防线**、`force` 修复、派生值不落盘、角色 tag 规范化、项目改名「超低门槛 ComfyUI 工作流集成应用」 |
| 9 | **v1.2.0**：①**输出目录（图片文件夹）跟随实际在跑的 ComfyUI**（`comfy.outputDir` 覆盖 + 进程命令行反推 + 按模式回落）—— 修掉"生成的照片根本不出现在图片文件夹里"；②**删除历史照片**（面板图片栏 + 画师页「本机作品」，两步确认且写明文件名，web UI 与磁盘一起删、空模型目录一并收掉）；③**画师分组**（最多 50 组；画师行「＋分组」选组加入/移出/就地新建；工作台「🎲 分组随机」+ 具体组下拉）；④**API Key 改成只写字段**（不再回显、留空保存不清 Key、显式清除）—— 修掉"切一下思考挡位就得重新输入 API"；⑤**下载前逐源测速再固定用最快源**；⑥版本号 → `v1.2.0` |
| 8 | **v1.1.0**：对照用户提交的 `BUGS-AND-FIXES.md` 逐条核修（**B6** `/app/state` 补 `llm.provider`/`llm.api` + 就绪度按来源判定；**B7** `/app/state` 补 `listen` + 设置页就地取令牌 + **`lanGuard` 回环豁免**（连带修掉"开启局域网后本机页面全 401 / `start.cmd` 探活超时杀进程"）；**B8** `api()` 纯对象 body 自动序列化；**B9** 自检按 `provider` 条件化；**B5** `setup.json` 补记 `skipped`）；**恢复面板「指定画师」搜索框与下拉**（v1.0.1 迁移画师管理时误删，仅剩死代码 —— 用户报"选择画师搜索后无法搜索"的根因）并按需求新增**收藏画师搜索**（仅收藏范围点开即列全部收藏、子串过滤、点选即用）；新增 **`AI-DECLARATION.md`**（AI 生成声明，进交付白名单） |

---

## 13.1 v1.2.1 的验收方式与已知边界（如实记录）

**怎么验的**

- **服务端**：起一个临时实例（`node server/index.js`，会占用下一个空闲端口，例如 8791→8794），逐条打接口：`GET /app/llm/sessions`、`POST /app/llm/session/new`（验证**不删**旧会话）、`DELETE /app/llm/session/:id`、`GET /app/llm/session/new`（必须 400）、`POST /app/artists/groups/replace`；外接 API 用测试 Key 实测 `reasoning=off` 与 `reasoning=low` 两种挡位，确认 `reasoning` 帧只带思考文本、`delta` 帧只带正文。
- **真实出图**：把 `comfy.mode=external` / `comfy.dir` 临时指向 `D:\FFOutput\COMFY UI 日常使用版\COMFY UI\runtime\comfyui`（`detectLayout` 报 `portable`），用该目录的 `anima-turbo-v1.1.safetensors` + `qwen_3_06b_base.safetensors` + `qwen_image_vae.safetensors` 出图：**成功**，1024×1024 PNG、1.4 MB、28.3 s（10 步 / CFG 1 / er_sde+simple），落在日常版的 `output/v121-accept/`。测完 `POST /app/comfy/stop`、删掉测试输出目录、把 `comfy` 段还原成 `embedded` + 空 `dir`。**日常版目录除那一个测试输出子目录（已删）外零改动。**
- **前端**：Edge（`--headless=new` + CDP）跑页内断言：`.tab-panes` 常驻、切设置后工作台仍在 DOM 且被隐藏、切回来提示词原样、`.session-row` 历史列表与自动接回、画师页分组卡片与展开/重命名入口、分组桥写回。

**已知边界（如实在此记录）**

- 自动化脚本偶发两条不稳定断言（`画师页正常挂载` / `分组条目可展开`）：第一次切到「画师」时，浏览器对 `import('./pages/artists.js')` 的**去重 promise** 偶尔长时间不 settle，界面停在「加载中…」；再切一次即正常（多次复现均为**第二次访问必成功**）。同一个浏览器会话里对同一 URL 用 `import(..., {})` 显式重新请求也能立刻成功 —— 属于 Chromium 侧的动态导入去重行为，不是本项目的逻辑缺陷；实现侧已把按需加载显式去重（`pageInflight`）并在排障钩子 `window.__DCP_SHELL__` 里暴露 `inflight`/`cached`/`bootSeq`/`trail`，便于以后一眼确认。
- 该脚本还会偶发一次 `TypeError: Failed to fetch`（真机空载时从未复现，出现在 4 个 Node 实例 + WebSocket 3000 ms 重连 + CDP 高频求值的压力环境下）。为此加了 `fetchRetry`（幂等 GET 重试 3 次）与对话 POST 的单次发送重试；服务端日志同期**没有任何 ERROR**。

---

## 13.2 v1.2.2 的验收方式与已知边界（如实记录）

**怎么验的**（全部由**独立复核者**自建 harness 实测，见 `docs/ROUND11-VERIFY.md`，不用实现者的脚本）

- **沙箱法**：把 `server/ web/ installer/ package.json` 拷到 `%TEMP%` 下的临时目录跑，`data/` 与 `logs/` 现建 —— **不碰开发副本正在运行的实例与 `data/settings.json`**（本轮开发机上有一个常驻后端，端口与设置文件都不能被劫持）。
- **端口**：占住 18960/18961 → 恰好 2 条 WARN（`… 尝试 18961（第 1/2 次自增）`）→ 绑定 18962；`/app/state` 顶层 `port` == 「打开：」== `DCP_READY` == 实际监听（四处一致），且磁盘 `settings.json` **字节级未变**；占满 3 个端口 → 2 条 WARN 后明确报错 + `exit 1`，不输出假就绪。
- **退出入口**：`POST /app/quit` 连续两次、并发三次全部 `200 / ok=true`，`first` 只有一个 `true`，随后进程 `exit 0` + 端口释放 + 日志落盘「退出收尾完成」。
- **退出连带停止**：真实 `launch()` 拉起的替身，且刻意做成"**活着但离线**"（不监听端口）—— 旧实现会 early-return，现在照样被终止、记录被删。
- **跨进程孤儿**：短命 helper 用 detached 拉起替身后退出（实测该 pid 的 `ppid` 进程已不存在，**父链真断**）→ 启动后端时被 `cleanupOrphans` 带走并删记录，日志点名 pid。
- **硬边界三层**（逐层实测）：① 托盘优雅退出（后端自行 `exit 0`）；② 托盘强杀后按归属记录清理（顽固后端 `/app/quit` 返 500 → 8 s 后回退 `/T /F`，记录里的替身仍被清掉）；③ 下次启动清孤儿。另实测"**不带 `/T`** 直接对后端本进程 `taskkill /F`" → 替身存活（证明进程内兜底确实跑不到）→ 重启后被清且日志点名该 pid。
- **安全边界**：六条反例 + 两条红线全过 —— 无归属记录的用户实例（`/app/comfy/stop` 与 `/app/quit` 之后都仍然活着，且不被写入记录）、`codeDir` 不符、命令行没有 `main.py`、`schema` 未知、坏 JSON、死 pid、读不到命令行（PATH 里塞假的 `powershell`）→ **全部不清理并留 WARN**。
- **前端**：无头 Edge + 真后端/桩后端；断连期间提示条恒 1、toast 恒 0、`__DCP_LINK__.count` 递增而 DOM 不重画，恢复后自行消失；同文案失败 25 次 → 1 条 toast + `suppressedToasts=24`；`fetchRetry` 的 GET 3 次重试与页面 key 契约未动。
- **口径**：`node scripts/check.js` → **pass=19 fail=0**；后端 harness **105/105**（10 块）；前端无头 Edge **45/45**。（实现者自建 harness 的断言数不作为裁决证据。）

**已知边界（本轮不修，如实记录）**

- **A) 面板侧回声写法仍在**：`web/panel.js` 的 `[state]` 保存 effect 与 `onChanged` 造新数组这两处仍在，本轮只从**外壳侧**（`__DCP_SAVE_ARTISTS__` 单飞 + 只在真变更时广播）断开回声；面板侧加固留待后续轮次。
- **B) 面板 NaN 渲染**：`/system_stats` 缺 `system` 时面板会渲染「内存 NaN / ? GB」，属**既有行为**、非本轮引入，本轮不修。
- **C) `scripts/start.ps1:141 / :206` 的 `$proc.Kill()` 仍是单进程杀**：控制台窗口被强杀时可能遗留后端与 ComfyUI；本轮不修启动器，后果由"下次启动 `cleanupOrphans`"兜住（已实测有效）。
- **D) 直接对后端本进程 `taskkill /F` 时进程内兜底无法执行**：这是 Windows 硬边界（`/F` = `TerminateProcess`，不给 node 任何执行机会），不是缺陷；由四层防护覆盖。
- **E) 绕过共享存储直接调外壳写入口时**，面板会按旧快照回写覆盖改动；真实 UI 路径都会先同步 `window.__DCP_ARTISTS__`，故不是缺陷，属 A 的另一种表现。

## 14. 名词表

| 词 | 含义 |
|---|---|
| 档位 / tier | 权重选择档：`minimal`（5.24 GiB）⊂ `standard`（25.69 GiB）⊂ `full`（47.27 GiB） |
| 三件套 | 一次出图必需的三个文件：主权重（`diffusion_models`）+ 文本编码器（`text_encoders`）+ VAE |
| 管线 / route | 面板支持的图构建器：`animaPlain`（Anima 通用）、`anima`（Anima 3.8B v2）、`qwen`（Qwen-Image 2.1） |
| 候选来源 / candidates | 一条直链展开出的"官方源 + 各镜像"的有序列表 |
| 主源 / 兜底源 | 梯队前面的快源 / 最后只按"停滞"判的源 |
| job | 服务端长任务（下载/安装），有 id、事件流与状态，切页面不中断 |
| 面板半 / panel.js | 从早期插件形态移植的生图面板（含图构建器），前端最大单文件 |
| 红线 | §4 的 14 条不可违反的约定 |
| 归属记录 / owner record | `data/run/comfy-owner-<pid>.json`：本程序给"自己拉起的 ComfyUI"写的身份证（pid + 入口目录 + 启动时刻）。清理只能依据它 + 五条谓词；用户自己启动的实例没有它，永远不在候选里 |
| 孤儿 / orphan | 本程序拉起过、但父链已断（中间那层 node 先死）而活到现在的 ComfyUI。识别它的唯一依据是归属记录；`state.pid` 对跨进程孤儿永远是空的 |
| 优雅退出 / 先礼后兵 | 托盘退出时先 `POST /app/quit` 让后端自己停 ComfyUI 与 LLM、关 HTTP、落盘后退出；失败才回退 `taskkill /T /F`。为什么不能只强杀：`/F` 不给 node 任何执行机会 |
| 验收脚本目录 | 存放 `round*.cjs` / `probe-*` 的目录，不随包发布但必须交接 |