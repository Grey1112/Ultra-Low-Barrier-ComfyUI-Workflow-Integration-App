# 项目交接文档（HANDOVER）

> **给接手人**：这份文档假设你**没有参与过开发**，但需要在半天内能改代码、能发布、能判断"哪里不能碰"。
> 其余四份文档的分工是：`README.md` 面向使用者、`FEATURES.md` 面向功能核对、`MIGRATION.md` 面向搬迁到别的机器、
> `docs/FULL-REFERENCE.md` 是逐文件/逐接口/逐决策的完整参考。**本文件只讲"交接"**：谁负责什么、怎么验、怎么发、坑在哪。
>
> 版本：**v1.0.0**｜项目名：**超低门槛 ComfyUI 工作流集成应用**（包名 `comfy-panel-standalone`）｜最后更新：第七轮末
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
| 这是什么 | 一个**不依赖 DSH** 的本地 ComfyUI 工作流集成应用：自带 Node 后端 + 浏览器 UI，**零 npm 依赖**（只用 Node 标准库），**拷贝文件夹即完成迁移** |
| 代码在哪 | 开发副本 `<开发副本>\`；可上传 GitHub 的干净拷贝在 `<开发副本>\release\core\`（由脚本生成，**不要手改**） |
| 怎么起 | 双击 `start.cmd`（纯 ASCII + CRLF，内部调 `scripts\start.ps1`）→ 浏览器自动开 `http://127.0.0.1:8788/` |
| 技术栈 | 后端 Node ≥18 CommonJS；前端**无构建步骤**：vendored React 18.3.1 UMD + 原生 ES 模块页面，不用 JSX（`React.createElement`） |
| 总量 | 后端 13 个文件约 4,300 行；前端 16 个文件约 5,300 行；文档 5 份；核心版 **62 个文件** |
| 自检一条命令 | `<开发副本>\runtime\node\node.exe scripts\check.js` → 期望 **17/17** |
| 最大风险 | ① 交付物里出现真实机器路径/用户名/API Key；② `.cmd` 写成非 ASCII 或裸 LF（双击必挂）；③ 破坏"可迁移性"（写死绝对路径） |
| 未完成的事 | 见 §10（`anima-turbo` 第 3 个镜像源、跨平台、跨机局域网实测等） |

---

## 1. 交接物清单

| 交付物 | 位置 | 说明 |
|---|---|---|
| 开发副本（含运行期数据） | `<开发副本>\` | 完整项目：源码 + `runtime\`（便携 Node / 内嵌 ComfyUI / llama.cpp）+ `models\` + `data\` + `logs\`。**不要直接打包这个目录** |
| GitHub 发布版 | `<开发副本>\release\core\` | 脚本生成的干净拷贝（62 文件，含 `.git`），**只包含源码/脚本/文档/画师清单/许可** |
| 交付拷贝 | `<交付目录>\` | `release\core` 的镜像拷贝 + `.git`，供直接上手/上传 |
| 交接与验收脚本 | `<验收脚本目录>\*.cjs` | 22 个验收/诊断脚本。**不属于交付物**（`build-core.ps1` 会排除该目录），但接手人必需，见 §7 |
| 网络探测原始数据 | `<验收脚本目录>\probe-{A..F}.{txt,json}`、`round5-mirrors.txt` | 镜像探测的逐条原始记录（含失败原因），排障时比结论更有用 |

> `.scratch` 类目录**不随包发布**是有意的：里面含真实机器路径与探测脚本。但它也**必须交接**，否则接手人无法复现"哪条结论是怎么测出来的"。

---

## 2. 立即上手（10 分钟）

```powershell
# ① 自检（不联网、不改文件）
cd <开发副本>
.\runtime\node\node.exe scripts\check.js          # 期望：结果：pass=17 fail=0

# ② 起服务（自带便携 Node；不打开浏览器）
$env:DCP_NO_OPEN='1'; .\runtime\node\node.exe server\index.js

# ③ 另开一个窗口验证
curl.exe -s http://127.0.0.1:8788/app/state        # 返回 JSON，comfy.online 视 ComfyUI 是否在跑
```

- 端口：后端 **8788**（被占用会自动 +1），内嵌 ComfyUI **8188**，本地 llama-server **8199**。
  环境变量 `DCP_PORT` / `DCP_HOST` 可覆盖，`DCP_NO_OPEN=1` 表示不自动开浏览器。
- 想跑通生图还需要：内嵌 ComfyUI 已安装（`runtime\comfyui\`）且**正在运行**（面板/向导里的「启动」按钮，或 `POST /app/comfy/launch`）。
- **重要**：ComfyUI 是后端拉起的子进程。**强杀后端进程树会把 ComfyUI 一起带走**（验收时踩过：面板显示离线 → 模型下拉为空，
  被误判成代码回归）。杀后端之后请重新 `POST /app/comfy/launch`。

---

## 3. 架构地图

### 3.1 后端（`server/`，CommonJS，零依赖）

| 文件 | 行数 | 职责 | 改动风险 |
|---|---|---|---|
| `index.js` | ~572 | HTTP 路由与所有 `/app/*`、`/comfy-panel/*` 接口；面板反代；SSE 任务流 | 中（接口契约，改完要同步 `docs/INTERNAL-CONTRACT.md`） |
| `config.js` | ~295 | 路径推导、设置默认值/夹紧/落盘、自检 | **高**（`paths` 与 `DEFAULTS` 是全项目的根） |
| `download.js` | ~506 | 下载引擎：镜像梯队展开、三条换源规则、断点续传、sha256、完整性防线、镜像测速 | **最高**（所有安装路径都走它） |
| `comfy-install.js` | ~648 | 向导主流程：7-Zip、ComfyUI 本体、自定义节点、权重、画师清单、许可 | 高 |
| `comfy.js` | ~314 | ComfyUI 进程管理与布局探测（`detectLayout`）、artists 清单 | 中 |
| `llm.js` | ~900 | llama.cpp 运行时与模型管理、本地/外接两条推理路径、SSE、角色补全接线 | 高 |
| `characters.js` | ~449 | Danbooru 角色词表 + 563 条中文别名 + 输出补全/规范化 | 中 |
| `works.js` | ~129 | 扫描 ComfyUI `output` 目录（本机作品） | 低 |
| `jobs.js` | ~194 | 长任务（下载/安装）的事件、列表、SSE 广播 | 中 |
| `store.js` | ~146 | `data/` 下的 JSON 读写（画师、LLM 模型、会话、setup） | 低 |
| `util/fsx.js` | ~141 | 文件/哈希/格式化工具 | 低 |
| `util/zip.js` | ~128 | 7-Zip 定位与解压、zip 解压、单根提升 | 低 |
| `util/log.js` | ~49 | 日志 | 低 |

### 3.2 前端（`web/`，无构建步骤）

| 文件 | 行数 | 职责 |
|---|---|---|
| `index.html` | 23 | 唯一页面：挂载点 + 引入 vendored React/ReactDOM + `app-shell.js` |
| `app-shell.js` | ~310 | 外壳：顶栏（品牌/后台任务条/日志/语言）、4 个导航页（工作台/画师/设置/向导）、全局 toast |
| `panel.js` | ~1932 | **生图面板**（从 DSH 插件 `lib/client.js` 移植 + 锚点补丁）：三栏 1:1:2、图构建器、画师、参数 |
| `panel-host.js` | 60 | 给 `panel.js` 提供 `require("react")` 之类的垫片 |
| `job-view.js` | 142 | 长任务视图：`JobProgress`（进度/速度/ETA/来源）、`openJobModal`、`BackgroundJobs`（顶栏任务条） |
| `i18n.js` | 257 | DOM 翻译器：`ui` 词典 + 面板 `panel` 词典 + 短语规则；中英切换 |
| `pages/workbench.js` | 60 | 工作台：单面板 + layout 切换 + 把 LLM 页 portal 进提示词栏 |
| `pages/llm.js` | ~903 | LLM 页：对话（SSE）、推荐目录、模型管理、外接 API 设置、角色词表 |
| `pages/artists.js` | ~264 | 画师页：收藏/黑名单/自定义、本机作品网格、搜索 |
| `pages/settings.js` | ~416 | 设置页：ComfyUI 内外接、监听、**下载源与镜像梯队 + 镜像测速**、LLM 配置 |
| `pages/wizard.js` | ~185 | 首次运行向导：档位选择、安装进度（含"切走再切回重挂任务"） |
| `styles/shell.css`、`pages/pages.css`、`styles/workbench.css` | 255/122/188 | 样式（**新增类名必须写进这三个文件之一**） |
| `i18n/zh.json`、`i18n/en.json` | 780/1009 | 词典（**键集必须完全一致**，由 `check.js` 强制） |
| `vendor/react*.js` | — | React 18.3.1 UMD（不联网、不构建） |

### 3.3 其它

| 目录/文件 | 内容 |
|---|---|
| `installer/models.json` | 12 个权重的目录：`id/file/dest/bytes/sha256/tier/license/officialUrl/mirrors/fastMirrors/verified` |
| `installer/llm-models.json` | 3 个推荐 GGUF（4B/9B/2B）+ 镜像 + sha256（**只给链接，不自动下载**） |
| `scripts/start.ps1` | 启动器：找/下载便携 Node → 起后端 → 探活 → 开浏览器 → 托盘 |
| `scripts/bootstrap.ps1` | 便携 Node 引导（**独立实现同一套镜像梯队 + 10 s 无进展换源**，因为此时还没有 Node 可跑） |
| `scripts/tray.ps1` | 托盘图标与右键菜单 |
| `scripts/check.js` | 自检（17 项，见 §4） |
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

---

## 5. 数据落盘与"什么不能进交付包"

| 路径 | 内容 | 进交付包？ |
|---|---|---|
| `data/settings.json` | 设置（**唯一可能含用户外部绝对路径**；API Key 也在这） | ❌ 已 gitignore |
| `data/artists.json` | 收藏/黑名单 | ❌ |
| `data/llm/models.json`、`sessions.json` | LLM 模型清单、会话 | ❌ |
| `data/characters/` | 角色词表（3.5 MB，可重下） | ❌ |
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
| `scripts\check.js`（在项目内） | 语法、JSON、词典、`.ps1`/`.cmd` 编码、脱敏 | **17/17** |
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

| 任务 | 步骤 | 坑 |
|---|---|---|
| **改界面文案** | 改 `web/i18n/zh.json` + `en.json` **两份** | 键集必须一致；面板文案走 `panel` 词典或 `panelPhrases` 规则；改完跑 `check.js [3]` |
| **加一个界面字符串** | 两个 json 各加一条，代码里 `t('xxx')` | 别直接写中文字面量 |
| **改默认生图型号/档位** | 改 `installer/models.json` 的 `tier`；默认型号在 `web/panel.js` 的 `INIT_MODEL`/`INIT_ROUTE` | 改完用 `GET /app/setup/plan?sel=minimal` 核对 `tiers` 三个值，并同步 README/FEATURES |
| **加一个权重** | 在 `installer/models.json` 增一条：`id/file/dest/bytes/sha256/tier/license/officialUrl/urls/mirrors/verified/note` | `bytes` 必须精确；`sha256` 必填（下载后校验）；`dest` 只能是 `diffusion_models`/`text_encoders`/`vae` |
| **换/加镜像源** | 改 `server/config.js` 的 `DEFAULTS.download.*`，或直接在设置页改；**先跑镜像测速** | 注意 §5"派生值不落盘"规则；`round5-mirrors.cjs` 可批量验 |
| **加一个 HTTP 接口** | 在 `server/index.js` 对应分支加；同步 `docs/INTERNAL-CONTRACT.md` §4 与 `docs/FULL-REFERENCE.md` §8 | 面板反代路径是 `/comfy-panel/api/*`，不要往那里塞业务接口 |
| **加一个前端页面** | `web/pages/x.js` 导出默认组件 + 在 `app-shell.js` 的两张页面映射表注册 | 契约见 `docs/INTERNAL-CONTRACT.md` §1–2（props 只有 `api/put/post/t/state/settings/refresh/toast`） |
| **改下载行为** | 只动 `download.js`；**不要**在调用方里手搓重试/换源 | 三条规则与阈值都在 `download.*`；改完跑 `round5-partial.cjs` + `round5-mirrors.cjs` |
| **改提示词** | `assets/templates/anima-system-prompt.txt` | 与发给模型的必须逐字节一致（`llm-test.cjs` 会核） |
| **改本地模型** | 放到 `models\llm\`，在 LLM 页「添加本机文件」或改 `data/llm/models.json` | 推荐目录 `installer/llm-models.json` **只给链接**，不自动下载 |
| **改启动器** | `scripts/start.ps1`（UTF-8 BOM + CRLF），改完跑 `normalize-ps1.cjs` | 双击入口 `start.cmd` 是纯 ASCII + CRLF，**不要**往里加中文 |
| **重新发布** | 见 §9 | `release\core` 里**不要手改**任何文件 |

---

## 9. 发布流程（每次改完代码都要走）

```powershell
cd <开发副本>

# ① 自检
.\runtime\node\node.exe scripts\check.js                      # 期望 17/17

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
- `build-core.ps1` 会**先删掉整个 `release\core`**（含 `.git`），所以想保留历史必须用 `-GitInit` 重建，或先备份 `.git`。
- 交付目录里**不允许**出现 `runtime/ models/ data/ logs/`：跑过 `start.cmd` 就会生成它们，发布前清掉。
- 四份文档的文末版本表要**同时**加一行：`README.md` §14、`FEATURES.md`、`MIGRATION.md`、`docs/FULL-REFERENCE.md`。

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
| 再分发义务 | 若把本项目与权重一起分发，必须同时带上 `LICENSES/` 与 `THIRD_PARTY.md`；README §12 有分区表与要点 |

---

## 13. 七轮变更摘要（从哪来的、为什么长这样）

| 轮次 | 主题 |
|---|---|
| 1 | 从 DSH 插件派生出独立项目：零依赖后端、静态前端、可拷贝迁移、向导、F1–F5 功能、四份文档、核心版打包 |
| 2 | 三合一工作台、角色词表 + 563 条中文别名、外接 API（纯聊天内核）、ModelScope/国内优选源、托盘 |
| 3 | 外接 API 修复（思考型模型吃光 token → 关思考）、工作台 1:1:2、**画师 UI 独立成页**、默认模型改 `anima-turbo-v1.1`、本地模型只留 4B |
| 4 | 回车即发送、四挡推理、上下文只留本地不外发、工作台重排、默认画师大随机、切模型不清提示词、画师页本机作品 |
| 5 | **`start.cmd` 双击失败**（LF + UTF-8 中文 → cmd.exe CP936 解析崩）修复 + 新增批处理编码红线（自检 16→17） |
| 6 | 最小下载档位改成"刚好能跑默认模型"（turbo + 编码器 + VAE = **5.24 GiB**，原 14.00 GiB） |
| 7 | 向导进度不再丢（`/app/jobs` + 顶栏任务条）、**下载字节计数根因修复**、镜像体系数据化 + 三条换源规则 + 镜像测速、**截断下载防线**、`force` 修复、派生值不落盘、角色 tag 规范化、项目改名「超低门槛 ComfyUI 工作流集成应用」 |

---

## 14. 名词表

| 词 | 含义 |
|---|---|
| 档位 / tier | 权重选择档：`minimal`（5.24 GiB）⊂ `standard`（25.69 GiB）⊂ `full`（47.27 GiB） |
| 三件套 | 一次出图必需的三个文件：主权重（`diffusion_models`）+ 文本编码器（`text_encoders`）+ VAE |
| 管线 / route | 面板支持的图构建器：`animaPlain`（Anima 通用）、`anima`（Anima 3.8B v2）、`qwen`（Qwen-Image 2.1） |
| 候选来源 / candidates | 一条直链展开出的"官方源 + 各镜像"的有序列表 |
| 主源 / 兜底源 | 梯队前面的快源 / 最后只按"停滞"判的源 |
| job | 服务端长任务（下载/安装），有 id、事件流与状态，切页面不中断 |
| 面板半 / panel.js | 从 DSH 插件移植的生图面板（含图构建器），前端最大单文件 |
| 红线 | §4 的 10 条不可违反的约定 |
| 验收脚本目录 | 存放 `round*.cjs` / `probe-*` 的目录，不随包发布但必须交接 |
