# comfy-panel-standalone 迁移指南（v1.0.0）

> **本文档面向谁**：要把这套「超低门槛 ComfyUI 工作流集成应用」从一台 Windows 电脑搬到另一台（或换盘符、改目录名、给朋友拷一份）的使用者与维护者。
> **一句话作用**：告诉你**带什么、不带什么、到新机器上怎么启动、出问题怎么修**，并给出可照抄的自测步骤。
>
> 需要整体架构与接口细节时看 `docs/FULL-REFERENCE.md`；契约细节看 `docs/INTERNAL-CONTRACT.md`。
> **脱敏约定**：本文档不出现任何真实机器路径，示例统一用 `<项目根>`、`<你的ComfyUI目录>`、`%USERPROFILE%`、`<盘符>`。

---

## 1. 一句话：迁移 = 把整个项目文件夹拷到新电脑

**不需要安装任何环境**（不需要装 Node、Python、7-Zip、ComfyUI 或 git）。
把 `<项目根>` 这个文件夹整体拷到新机器（或拷贝压缩包后解压），双击 `start.cmd` 即可。
本项目自带便携 Node（缺失时会自动下载到 `runtime\node\`），ComfyUI 与模型权重要么一起拷过去，要么到新机器上重跑一次首次运行向导重新获取。

> 唯一的例外：如果你用的是**外接模式**（ComfyUI 装在别的地方，不属于本项目），那个目录的路径在设置里是记着的——
> 换机器后它可能不存在，此时按 §6 处理即可。

---

## 2. 迁移前检查清单

先决定「带什么」和「不带什么」，其余都是可再生的。

| 目录/文件 | 建议 | 原因与体积量级 |
|---|---|---|
| `server\`、`web\`、`scripts\`、`docs\`、`assets\`、`installer\`、`LICENSES\` | ✅ **必须带** | 代码、前端、画师清单、模型目录表与许可；合计只有几 MB |
| `start.cmd`、`package.json`、`.gitignore`、`LICENSE`、`THIRD_PARTY.md`、`README.md`、`FEATURES.md`、`MIGRATION.md` | ✅ **必须带** | 启动与文档 |
| `data\` | ✅ **建议带**（体积极小，几 KB；**角色词表约 3.5 MB**） | 设置（含外接目录、端口、镜像配置、**外接 API 的 baseUrl / Key / 模型名**）、收藏与黑名单、LLM 模型清单与会话、向导完成状态、**角色词表（`data\characters\`）与用户别名（`data\character-aliases.json`）**。不带 = 到新机器一切从头配 |
| `models\llm\*.gguf` | ⚠️ **看情况** | 单个 GGUF 从几百 MB 到几 GB；带了就不用重下。**注意许可**：模型权重多为非商业许可，拷给他人前先确认是否符合其条款 |
| `models\diffusion_models\`、`text_encoders\`、`vae\` | ⚠️ **看情况** | 按 `installer/models.json` 的档位：minimal ≈ **5.24 GB**（默认档 = `anima-turbo-v1.1` + `qwen_3_06b_base` + `qwen_image_vae`）、standard ≈ **25.69 GB**、full ≈ **47.27 GB**（三者是包含关系，详见 §3.2）。动辄几十 GB，跨机器拷贝建议用移动硬盘/局域网，并核对拷贝完整性 |
| `runtime\` | ⚠️ **可重新获取** | 含便携 Node、7-Zip、llama.cpp、内嵌 ComfyUI、下载暂存。**拷过去最省事，但最容易拷坏**（大量小文件 + 可执行文件）。重新获取只需联网走一次向导/按钮 |
| `logs\` | ❌ **可以丢** | 只是运行日志；还可能含旧机器路径，删掉更干净（删除后会自动重建） |
| `release\`、`dist\` | ❌ **可以丢** | 打包产物，可重建 |
| `node_modules\` | ❌ **不存在才对** | 本项目零 npm 依赖；如果它出现了，说明有人跑过 `npm i`，删掉即可 |

**其他检查**：

- 迁移前**先正常退出**（右键托盘图标 →「关闭控制台并停止后端」，或关闭启动器窗口 / 在其控制台按 `Ctrl+C`）—— 直接拔盘/强杀可能留下半个下载文件（`*.part`）或未写完的日志（JSON 数据是原子写的，不受影响）。
- 确认新机器的**目标盘符剩余空间**：至少 ① 代码 + data（几 MB）；② 若要整体拷贝，等于源目录大小 + 20% 余量。
- 记录源机器上的关键设置（可选）：后端端口、ComfyUI 是内嵌还是外接、外接目录、LLM 上下文条数/端口 —— 迁移后可在设置页核对。
- 如果要把项目拷给别人：**先确认许可**（`THIRD_PARTY.md`、`LICENSES\README.md`）——权重与 ComfyUI 不应随包分发。

---

## 3. 两种迁移方式

### 方式 ①：完整拷贝（含 `runtime\`、`models\`、`data\`）—— 拷完即用

- **做法**：整个 `<项目根>` 复制到新机器（推荐先打包成压缩包再拷，避免小文件丢失/损坏）。
- **适合**：新机器**没有网络**，或模型文件很大不想重下，或希望完全离线可用。
- **拷贝后**：解压到**任意路径**（中文/空格路径可用，见 §10 第 8 条），双击 `start.cmd`。
- **排除建议**（可安全删除后再拷，省时间也少出错）：
  `logs\`（含 `logs\jobs\` 与几个 `.log`，包括 `logs\tray.log`）、`release\`、`dist\`、`runtime\_dl\`（下载暂存，含便携包与 llama.cpp 的 zip）；
  如果你不想带内嵌 ComfyUI，也可以删掉 `runtime\comfyui\`（到新机器用向导重装或改外接模式）；
  **`data\characters\`（角色词表，约 3.5 MB）也可以删** —— 首次用到角色功能时在「工作台 → 本地 LLM → 角色词表」点一次「下载/更新词表」即可重新获取（它是运行时下载的第三方数据，MIT）。
- **不要**在拷贝时排除 `runtime\node\`（便携 Node），否则新机器没网就起不来（有网时 `scripts\bootstrap.ps1` 会自动补上）。
- **体积量级**（源目录）= 代码(几 MB) + `data\`(几 KB) + `models\`(按档位 14 / 25.7 / 47.3 GB) + `runtime\`(见下) + `logs\`(可忽略)。

### 方式 ②：轻量拷贝（只带代码 + `data\`）—— 到新机器重新获取运行时与模型

- **做法**：只拷下面这些，其余在新机器上由向导/按钮重新获取：

  ```
  <项目根>\
    server\  web\  scripts\  docs\  assets\  installer\  LICENSES\
    data\                      ← 强烈建议带（设置 / 收藏 / 角色词表与用户别名）
    start.cmd  package.json  .gitignore  LICENSE  THIRD_PARTY.md
    README.md  FEATURES.md  MIGRATION.md
  ```

> 两条关于**角色功能**的迁移说明：① 角色词表（`data\characters\danbooru.csv`，约 **3.5 MB**）与用户别名（`data\character-aliases.json`）都在 `data\` 下，
> **随文件夹一起迁移**，到新机器不用重下；② 不想带 `data\characters\` 也没关系 —— 它是可再生的，首次用角色功能时点一次「下载/更新词表」即可（用户别名文件很小，建议保留）。

- **适合**：新机器网络良好；想避免「拷坏运行时」这类问题；模型想按新机器的显存重新选档位。
- **新机器上要做的**：
  1. 双击 `start.cmd` —— 若没有 `runtime\node\node.exe`，启动器会自动调用 `scripts\bootstrap.ps1`
     从官方源（失败则 npmmirror 镜像）下载便携 Node 到 `runtime\node\`；
  2. 打开「向导」页：选内嵌模式 → 选 ComfyUI 来源（推荐便携版）→ 选模型档位 → 开始安装；
  3. 打开「本地 LLM」页点「安装运行时」（需要本地 LLM 时）；
  4. 打开「设置」页看自检是否零 error。
- **体积量级**：拷贝本身只有**几 MB**；新机器上重新生成的体积 ≈ 方式 ① 去掉 `logs\` 后的量级（模型按你选的档位）。

### 3.1 `runtime\` 里都有什么（决定要不要带）

| 路径 | 内容 | 量级 | 不带会怎样 |
|---|---|---|---|
| `runtime\node\node.exe` | 便携 Node 运行时 | 百 MB 量级 | 有网时自动下载（`scripts\bootstrap.ps1`，默认 `v22.14.0`）；也能用系统 Node 18+ 顶替 |
| `runtime\bin\7zr.exe` / `7za.exe` | 7-Zip 精简版 / 完整版（用于解压便携包） | 1 MB 上下（7za 稍大） | 向导「运行时」步骤会重新引导获取；系统装了 7-Zip 也能顶替 |
| `runtime\bin\llama\` | llama.cpp 运行时（CUDA 或 CPU 包 + `llama-server.exe`） | 数百 MB 量级（CUDA 版更大，含 `cudart64*.dll`、多个 `ggml-cpu-*.dll`） | 在「本地 LLM」页点「安装运行时」重新获取；也可手动放 `llama-server.exe` |
| `runtime\comfyui\` | 内嵌模式的 ComfyUI 本体（便携包解压结果，含 `python_embeded\`） | 数 GB 量级 | 向导「ComfyUI」步骤重新获取（联网 + 数分钟解压） |
| `runtime\_dl\` | 下载暂存（便携包、llama.cpp 包、7z-extra 等 zip/7z） | 视情况数 GB | 可以删（下次下载会重建）；删了能省很多拷贝时间 |

### 3.2 `models\` 的档位与体积（按 `installer/models.json`）

| 档位 | 包含 | 合计（十进制换算前 ≈ GB） |
|---|---|---|
| `minimal`（默认档） | `anima-turbo-v1.1`、`qwen_3_06b_base`、`qwen_image_vae` | **≈ 5.24 GB** |
| `standard`（含 minimal） | 再加 `Anima-3.8B-v1.1`、`qwen35_4b`、`anima-base-v1.0`、`anima-aesthetic-v1.1` | **≈ 25.69 GB** |
| `full`（全部 12 个文件） | 再加 `Anima-2.9B-preview-v1`、`..._int8_convrot`、`qwen_image_2.1_int8_convrot`、`qwen3vl_8b_w4a8`、`qwen_image_2.1_vae_bf16` | **≈ 47.27 GB** |

（另有 `models\llm\*.gguf` 按你实际下载的量化档位单独计算，几百 MB 到几 GB 不等。）

---

## 4. 新机依赖清单：原则上为零

**必须的**：Windows + 一块能跑 ComfyUI 的 GPU（或可接受的 CPU 速度）+ 磁盘空间。其余都在项目内。

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| 便携 Node | ❌ 不需要你装 | 随项目携带于 `runtime\node\node.exe`；**缺失时 `scripts\bootstrap.ps1` 会自动从官方源/镜像下载**到该目录（默认 `v22.14.0`，可用 `-Version` 覆盖）。系统若已装 Node 18+ 也会被启动器采用 |
| 7-Zip | ❌ 不需要你装 | 项目会自己引导 `7zr.exe → 7z-extra.7z → x64 7za.exe`；只有这条引导链全失败时才会回落到**系统已安装的 7-Zip** |
| git | ❌ 可选 | 只有「向导里用 git 模式获取 ComfyUI」以及克隆自定义节点时才需要；**缺失时自动走 codeload ZIP**（节点安装），而 ComfyUI 本体的 git 模式没有 git 会直接报错并建议改用便携包 |
| Python | ❌ 可选 | 只有 git 模式的 ComfyUI 需要系统 Python 来建 `venv`；便携包自带 `python_embeded`，内嵌模式不需要系统 Python |
| GPU 驱动 | ✅ 需要 | ComfyUI 走 PyTorch（CUDA），llama.cpp 的 CUDA 版也需要 `nvidia-smi` 可见的 NVIDIA 驱动；没有 N 卡就用 CPU 版 LLM 运行时（或把「推理来源」切成**外接 API**，那就不需要本地 GPU 推理） |
| 网络 | ⚠️ 视方案 | 方式 ①（完整拷贝）可离线；方式 ② 需要网络下载 Node/便携包/模型 |

> **本轮新增的两件事都不增加依赖**：① **托盘图标 + 控制台最小化**只用 Windows 自带的 PowerShell 5.1 与系统程序集（`System.Windows.Forms` / `System.Drawing`），
> **不引入第三方依赖、不写注册表**，因此新机依赖清单**仍然是零**；② **角色词表**是运行时下载的数据文件（MIT），不需要额外运行时。
> 而且因为 `scripts\start.ps1` / `scripts\tray.ps1` 全部从 `$PSScriptRoot` 推导相对路径、不加引号的地方已全部修掉（含空格路径也能起），
> **换机器后托盘与控制台最小化同样有效**，不需要任何手工调整。

---

## 5. 启动与自检

### 5.1 启动

```bat
:: 双击（最简单）
start.cmd

:: 或命令行（可选参数）
pwsh -File .\scripts\start.ps1
pwsh -File .\scripts\start.ps1 -Port 9000        # 指定后端端口
pwsh -File .\scripts\start.ps1 -Lan              # 本次以局域网模式监听（等于打开设置里的局域网开关）
pwsh -File .\scripts\start.ps1 -NoBrowser        # 不自动开浏览器
pwsh -File .\scripts\start.ps1 -NoTray           # 不装托盘图标，也不最小化控制台
pwsh -File .\scripts\start.ps1 -Foreground       # 前台运行，日志直接打在控制台
```

启动器做的事（顺序）：从**脚本自身位置**推导项目根 → 找 Node（`runtime\node\node.exe` → PATH 里的 Node 18+ → `bootstrap.ps1` 下载）→
创建 `logs\`、`data\`、`logs\jobs\` → 后台起 `server\index.js` → 最多等 **60 秒**（端口被占时后端会自动 +1，启动器按 `base..base+20` 探测 `/app/state`）→
打开浏览器（除非 `-NoBrowser`）→ 拉起**托盘助手**（`scripts\tray.ps1`，独立进程）→ **把控制台最小化到任务栏** → 跟着后端进程，直到你退出。

**退出方式**：右键系统托盘图标 →「**关闭控制台并停止后端**」（推荐），或把控制台从任务栏还原后按 `Ctrl+C`，或直接关闭窗口。
托盘菜单还有：打开 Web UI（双击图标同效）、复制访问地址、打开日志文件夹；托盘自己的日志在 `logs\tray.log`。后端退出后托盘图标会**自动消失**（不留幽灵图标）。

**启动时会做路径自检**：后端把自检结果打进 stdout（`logs\server-console.out.log`）与 `logs\server.log`，每一条都带「问题 → 怎么改」：

```
[启动器] 项目根目录：<项目根>
[启动器][警告] 自检：外接 ComfyUI 目录不存在（多半是整体拷贝到别的电脑/盘符后路径失效） → 打开「设置 → ComfyUI」重新指向本机的 ComfyUI 目录，或改用「内嵌模式」由向导安装。
```

也就是说：**报错信息里会直接告诉你改哪里**。要退出：右键托盘图标 →「关闭控制台并停止后端」，或在本窗口按 `Ctrl+C`，或关闭窗口。

### 5.2 打开「设置」看自检结果

设置页底部「自检发现问题」卡片会列出 `level` 为 `error`/`warn` 的每一条（问题 + 修法）。
顶栏的「重新自检」按钮等价于重新拉一次自检；外壳顶部的红条只会显示 **error** 级问题。

### 5.3 `GET /app/selfcheck` 的字段含义

```jsonc
{
  "ok": true,                       // 仅当 issues 里没有 level === "error" 时为 true（warn 不影响 ok）
  "issues": [
    {
      "code": "comfy-dir-missing",  // 机器可读的问题码（见下表）
      "level": "error",             // error | warn
      "message": "外接 ComfyUI 目录不存在（多半是整体拷贝到别的电脑/盘符后路径失效）",
      "fix": "打开「设置 → ComfyUI」重新指向本机的 ComfyUI 目录，或改用「内嵌模式」由向导安装。",
      "path": "<你的ComfyUI目录>"     // 可选：相关路径（用于显示，帮助定位）
    }
  ],
  "external": [                     // 只在 external 模式下有意义：外接路径是否存在
    { "key": "comfy.dir", "path": "<你的ComfyUI目录>", "exists": false }
  ],
  "host": "<本机主机名>",            // 诊断用
  "root": "<项目根>"                 // 诊断用（项目自身的绝对路径）
}
```

已实现的 `code` 全表（改代码时同步此表）：

| `code` | level | 含义 | 修法 |
|---|---|---|---|
| `comfy-dir-missing` | **error** | 外接模式下 `comfy.dir` 为空或不是目录 | 设置页改指向本机 ComfyUI 目录 / 改用内嵌模式 / 重跑向导 |
| `comfy-embedded-missing` | warn | 内嵌模式尚未安装 ComfyUI 本体 | 向导「ComfyUI」步骤获取 |
| `system-prompt-missing` | warn | `assets\templates\anima-system-prompt.txt` 缺失 | 从源码包恢复该文件 |
| `artists-missing` | warn | `assets\artists\Anima2B_Artist_Index_59k.txt` 缺失 | 恢复两份画师清单 txt |
| `llm-runtime-missing` | warn | `runtime\bin\llama\llama-server.exe` 不存在 | 「本地 LLM」页点「安装运行时」 |
| `llm-model-missing` | warn | 设置里的默认 LLM 模型文件不存在 | 在「本地 LLM → 模型管理」重新指定默认模型 |

> 另外三个有用的诊断接口：`GET /app/state`（一次性看 ComfyUI/LLM/向导/自检全景）、`GET /app/comfy/status`（布局、解释器、端口、`lastError`）、
> `GET /app/logs?tail=300`（后端日志尾部）。

---

## 6. 路径失效怎么办（换机器后外接模式必读）

**表现**：外壳顶部出现红条、设置页自检出现 **error** 级 `comfy-dir-missing`：

```
外接 ComfyUI 目录不存在（多半是整体拷贝到别的电脑/盘符后路径失效）
→ 打开「设置 → ComfyUI」重新指向本机的 ComfyUI 目录，或改用「内嵌模式」由向导安装。
```

**原理**：外接模式把用户填的**绝对路径**记在 `data\settings.json` 的 `comfy.dir` 里。换机器/换盘符/挪目录后这个路径就不再存在。
此时：后端**照常启动**（自检只报告不阻断），面板会提示 ComfyUI 离线，生图不可用，但设置/画师/LLM 等功能都能用。

**三种修法（任选其一）**：

| 修法 | 步骤 | 适用 |
|---|---|---|
| ① 改指本机目录 | 「设置 → ComfyUI」→ 模式保持「外接」→ 填本机 ComfyUI 根目录（含 `main.py`）→ 点「检测」确认布局 → 保存 → 「重新自检」 | 新机器上已经装了 ComfyUI |
| ② 改为内嵌模式 | 「设置 → ComfyUI」→ 切到「内嵌模式」→ 打开「向导」用便携包安装一次（或把已有 ComfyUI 导入到项目内） | 想让项目自包含、以后随便挪 |
| ③ 用向导重新装 | 「向导」→ 选内嵌 → 选来源（便携版/压缩包/已有目录/跳过）→ 安装 | 同上，或想顺带换 ComfyUI 版本 |

**改完一定要点「重新自检」**确认零 error，再试生成 1 张图。

---

## 7. 数据位置对照表

### 7.1 在项目里的数据

| 数据 | 文件 | 内容/字段 | 迁移建议 |
|---|---|---|---|
| 设置 | `data\settings.json` | 语言、监听（端口/局域网/令牌）、ComfyUI（模式/目录/端口/额外参数）、下载（镜像/**ModelScope**/代理/超时阈值/**停滞阈值**/pip 源）、本地 LLM（**推理来源**/**外接 API 的 baseUrl 与 Key 与模型名**/上下文条数/默认模型/端口/上下文长度/GPU 层数） | **建议带**。注意它**可能含源机器的外部绝对路径**（`comfy.dir`）**与外接 API 的 Key**（`llm.api.apiKey`），到新机器按 §6 改路径；不打算继续用外接 API 就把 Key 清掉 |
| 收藏与黑名单 | `data\artists.json` | `{favs:[...], blacklist:[...], updatedAt}` | **建议带**（自测步骤里会验证它还在） |
| 角色词表 | `data\characters\danbooru.csv`（+ `index.json`） | Danbooru 角色 tag 索引：**3,518,020 B / 140,782 行**，其中角色 tag **40,931** 条；`index.json` 记条数/来源/时间 | **可带可不带**（约 3.5 MB）。**可删**：首次用角色功能时点「下载/更新词表」重新获取 |
| 用户角色别名 | `data\character-aliases.json` | `{"<中文/日文名>": "<Danbooru tag 名>"}` | **建议带**（体积极小，且是自己攒的，丢了要重填） |
| LLM 模型清单 | `data\llm\models.json` | `{items:{文件名:{file,origin,source,addedAt}}, default}` | 建议带（配合一起带 `models\llm\` 才有意义） |
| LLM 会话 | `data\llm\sessions.json` | `{sessions:{会话id:{messages:[{role,content}], updatedAt}}}` | 可带可不带（只保留最近 N 条） |
| 向导完成状态 | `data\setup.json` | `{completed, mode, comfySource, comfyDir, modelsDir, models[], artists, licenses, llm, updatedAt}` | 建议带（否则会一直提示「请先完成向导」） |
| 后端日志 | `logs\server.log`（超 5 MB 滚动为 `server.1.log`） | 运行日志 | 可不带 |
| ComfyUI 子进程日志 | `logs\comfyui.log` | 启动 ComfyUI 的 stdout/stderr | 可不带 |
| llama-server 日志 | `logs\llama-server.log` | LLM 子进程输出 | 可不带 |
| 托盘日志 | `logs\tray.log` | 托盘助手的就绪参数、退出原因、降级原因 | 可不带 |
| 长任务日志 | `logs\jobs\<kind>-<id>.log` | 每个下载/安装任务一行一个 JSON 事件 | 可不带 |
| 启动器输出 | `logs\server-console.out.log` / `.err.log` | 启动器的 stdout/stderr 重定向 | 可不带 |

### 7.2 不在项目里的数据（迁移后不会跟着走）

| 数据 | 在哪 | 说明 |
|---|---|---|
| 浏览器 `localStorage['dcp-artist-favs']` | 旧浏览器的站点存储 | **只有插件版时代用过**。独立版已把收藏/黑名单改为服务端 `data\artists.json`；独立版只在首屏/画师页把它当**一次性导入源**。迁移后如果还想捞回来：在**同一台机器同一个浏览器**打开旧收藏所在的页面导入，或在画师页点「从浏览器旧数据导入」 |
| 浏览器缓存/Cookie | 浏览器自己管理 | **不计入迁移范围**：静态资源响应是 `no-store`，没有要保留的缓存；独立版也不依赖 Cookie 鉴权（只有开启局域网时才用令牌） |
| 你自己选择的外接 ComfyUI 目录 | 你机器上的任意位置 | 不属于本项目，删/留由你决定 |
| 你手动添加的 LLM 模型原始文件 | 你放它的地方 | 「模型管理 → 添加本地路径」用 `link` 模式时是**硬链接**，删掉原文件会让 `models\llm\` 里的链接失效 |
| GPU 驱动 / CUDA | 系统 | 新机器需要装好 |

---

## 8. 卸载 = 删目录

- **不写注册表**、**不写系统目录**、**不安装 Windows 服务**。
- **托盘是启动器进程的一部分行为，不是常驻服务**：`scripts\tray.ps1` 只在你双击 `start.cmd` 后由启动器另起，且它每 3 秒看护后端 ——
  后端退出（或你选「关闭控制台并停止后端」）时它**自己退出并销毁图标**，不会留下开机自启项、注册表项或幽灵图标。
- 卸载步骤：右键托盘 →「关闭控制台并停止后端」（或关闭启动器窗口 / 在其控制台按 `Ctrl+C`）→ 删除 `<项目根>` 整个文件夹。
- 想保留设置/收藏：删之前把 `data\` 另存一份即可（见 §7.1，**含角色词表与用户别名**）。
- **唯一例外**：如果你用的是**外接模式**，那个 ComfyUI 目录是你自己的既有安装，**不属于本项目**——本项目不会去删它；
  同样，你把 LLM 的 GGUF 放在别处、用 `link` 或 `copy` 加进 `models\llm\`，那些原始文件也在你的目录里。
- 本项目也不会去动系统里的 Node / Python / git / 7-Zip；即使向导曾回落到「系统已安装的 7-Zip」，也只是调用它，不修改它。

---

## 9. 迁移自测步骤（可照抄执行）

1. **拷贝文件夹到新路径**（或解压压缩包）。路径可以含中文与空格（见 §10 第 8 条）。
2. **删掉 `logs\`**（可选，推荐）：里面是旧机器的日志，删掉更干净；`logs\` 会自动重建。
3. **双击 `start.cmd`**。等它打印「已就绪」并自动打开浏览器（若没开，按控制台里的地址手动打开）。
   顺带确认两件**本轮新增**的行为：① 控制台被**最小化到任务栏**（不是消失，能从任务栏还原）；② 系统托盘出现图标，右键能看到
   「打开 Web UI / 复制访问地址 / 打开日志文件夹 / 关闭控制台并停止后端」，且 `logs\tray.log` 里有一行「托盘已就绪」。
   如果你更想一直看着控制台，用 `pwsh -File .\scripts\start.ps1 -NoTray` 启动（此时没有托盘、也不最小化）。
4. **打开「设置」页**，点「重新自检」，确认 **零 error**（warn 可以存在，例如还没装本地 LLM 运行时）。
   - 若出现 `comfy-dir-missing`：按 §6 处理后再自检一次。
5. **生成 1 张图**：在**工作台左栏（生图）**点「🧪 测试图」（会填入统一测试提示词并复位推荐参数）→ 点「生成」。
   首次会加载模型，8 GB 显存下 512×512 / 8 步量级通常十几秒内出图；图会落在 ComfyUI 的 `output\<模型文件夹>\` 下，并在面板里显示。
6. **打开工作台的本地 LLM 栏**，发一条消息（例如「一只黑白斑点小狗」），确认：能流式出字、回答是**一个代码围栏**且含 `Positive prompt:` / `Negative prompt:`；
   再点「填正负」确认能写回**同一页面左侧**的生图面板。若提示缺运行时，先点「安装运行时」。
   - 另可顺手验「**提示词工具**」的复制按钮：点「📋 复制正+负」应提示「已复制」。
7. **确认收藏/黑名单还在**：打开工作台右栏（画师），或直接看 `data\artists.json` 的 `favs`/`blacklist` 是否与源机器一致；也可以点「重新自检」看有没有报 `artists-missing`。
8. **确认角色词表与别名随行**（本轮新增）：打开「工作台 → 本地 LLM → 角色词表」，卡片应显示「词表就绪」与「角色条目 40931」；
   在「搜角色」里输入 `rem` 应能命中 `rem_(re:zero)`，输入 `蕾姆` 走内置别名也能解析到它。
   若卡片显示「词表未安装」（你按 §3 的排除建议删了 `data\characters\`），点一次「**下载/更新词表**」（约 3.5 MB）即可。
9. **（可选）确认外接 API 迁移后仍可用**：如果源机器上把「推理来源」设成了外接 API，打开「设置 → 本地 LLM」点「**测试连接**」；
   报 `401/403` 就重贴 Key，报 `404` 就检查 baseUrl（多数服务要写到 `/v1` 这一层）。不想用外接就切回「本地模型」。

---

## 10. 常见迁移问题表

| # | 现象 | 原因 | 处理 |
|---|---|---|---|
| 1 | 顶栏红条 / 自检 error `comfy-dir-missing`，面板显示 ComfyUI 离线 | 外接模式记的是源机器的绝对路径，新机器上不存在 | 按 §6 三选一（改指本机目录 / 改内嵌模式 / 重跑向导），改完「重新自检」 |
| 2 | 页面打不开，启动器说「后端在 60 秒内没有就绪」，最后几行提到 `EADDRINUSE` | 端口被别的东西占着，且自增 20 次都没成功（或设置里的端口被防火墙/其它服务占用） | 用 `-Port 9000` 启动，或在设置页换端口；查占用：`Get-NetTCPConnection -LocalPort <端口> -State Listen` |
| 3 | `runtime\` 拷坏了导致 node 起不来（启动器报找不到可用 Node，或 Node 一启动就崩） | 大量小文件 + 可执行文件在拷贝中损坏/被杀软拦截 | 直接**删掉 `runtime\node\`** 再启动，`scripts\bootstrap.ps1` 会重新下载；`runtime\bin\llama\` 坏了就在「本地 LLM」页重装；`runtime\comfyui\` 坏了就在向导里重装 |
| 4 | 模型文件没拷全 → 向导/下载报「大小不符」或 sha256 校验失败 | 拷贝中断、磁盘满、或目标盘文件系统限制 | 看 `logs\jobs\` 里的具体文件名与错误；重新下载该模型（设置里 `force` 或删掉半成品文件后重跑向导）；注意 `*.part` 残留要清掉 |
| 5 | PowerShell 被拦（脚本「无法加载」「禁止运行脚本」）或杀软报毒 | 执行策略 / 杀软把 `runtime\` 里的可执行文件当可疑程序 | 用 `start.cmd`（它显式带 `-ExecutionPolicy Bypass`）；或手动 `powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1`；把 `<项目根>` 加入杀软白名单/排除目录 |
| 6 | 跨盘符硬链接回落成复制，迁移/导入变得很慢 | `fs.linkSync` 只在**同一卷**有效；跨卷会自动回落 `copyFileSync`（这是设计行为，不是错误） | 把「源 ComfyUI 目录」与 `<项目根>` 放在**同一个盘符**，或接受复制耗时；导入向导里的「复制方式」也可显式选「复制」以便预期一致 |
| 7 | 换机器后显存不足，LLM 起不来 | 新机器显存更小；CUDA 版 + `gpuLayers=99` 装不下 | 「本地 LLM」页改装 **CPU 版运行时**，或在 `data\settings.json` 里把 `llm.gpuLayers` 调小（例如 20）或设 0；也可换更小的量化 GGUF；`llm.ctxSize` 调小也有帮助 |
| 8 | 路径含中文/空格时的注意事项 | 启动器与后端全部用相对推导 + 引号包裹，**一般可用**；但个别外部程序（旧版 git、某些 Python 工具）对中文/空格敏感 | ① 优先选纯英文无空格的路径（例如 `<盘符>:\comfy-panel-standalone\`）；② 如果必须用中文/空格路径，避免在向导里用 **git 模式**装 ComfyUI（便携包/已解压目录最稳）；③ 外接模式指向的 ComfyUI 目录也建议用纯英文路径 |
| 9 | 新机器上「画师随机」不工作、面板提示「画师清单不可用」 | `assets\artists\` 缺失（拷贝时漏了）或清单文件被清空 | 恢复 `assets\artists\Anima2B_Artist_Index_59k.txt` 与 `Anima2B_Artist_top200.txt`；或把它们放进 `<你的ComfyUI目录>\model-notes\`；然后在向导里跑一次「画师」步骤（会刷新缓存，不需要重启） |
| 10 | 迁移后 Llama 模型显示在列表里但启动报「文件不存在」 | `models\llm\` 没一起拷，或用 `link` 模式添加的模型其**原始文件**在新机器上不存在（硬链接不跨机器） | 重新下载/拷贝 GGUF 进 `models\llm\`，或在「模型管理 → 添加本地路径」重新指定新机器上的真实路径 |
| 11 | `data\settings.json` 手改后没生效 | 后端把设置读进内存缓存，运行中改文件会被覆盖 | 改之前先退出后端（右键托盘「关闭控制台并停止后端」/ `Ctrl+C`）；或直接用设置页保存 |
| 12 | 迁移后一定要「删掉 `logs\`」吗？ | 不是必须：`logs\` 只是日志，且不入库、不参与逻辑 | 只是推荐（少带一份可能含旧机器路径的文本），删掉后会自动重建 |
| 13 | 启动后**看不到控制台**了（以为启动失败） | 这是本轮新增行为：就绪后控制台被**最小化到任务栏**（不是隐藏），同时出现托盘图标 | 从**任务栏**把控制台还原即可；或下次用 `pwsh -File .\scripts\start.ps1 -NoTray` 启动（不装托盘、不最小化）；托盘图标右键也有「打开 Web UI」与「打开日志文件夹」 |
| 14 | 托盘图标不见了 / 提示「托盘启动失败」 | ① 用了 `-NoTray` 或 `-Foreground`（本来就没有）；② WinForms 不可用（少见）；③ Windows 11 把图标收进了「隐藏的图标」区域；④ 后端已退出，图标按设计自动消失 | 先看 `logs\tray.log` 的就绪/退出记录；点任务栏 `^` 展开隐藏图标；重新启动项目即可；实在不行就用控制台 `Ctrl+C` 退出（功能不受影响） |
| 15 | 迁移后角色检索为空 / 提示「词表未安装」 | `data\characters\` 没一起拷（或按 §3 建议删掉了） | 打开「工作台 → 本地 LLM → 角色词表」点「**下载/更新词表**」（约 3.5 MB）；内置的 563 条中文别名不依赖词表文件，词表缺失时别名仍能命中 |
| 16 | 迁移后外接 API 报 `401/403/404` | 换机器后 Key 失效，或 baseUrl 指向了源机器上的本机端点（例如源机器是 `http://127.0.0.1:8199/v1` 而现在这台没起 `llama-server`） | 「设置 → 本地 LLM」点「**测试连接**」：`401/403` 重贴 Key，`404` 检查 baseUrl 是否要写到 `/v1`、模型名是否存在；不想用外接就把「推理来源」切回「本地模型」 |
| 17 | 迁移后启动器直接报 `Cannot find module '<某截断路径>'` | 这是**第一轮**的老缺陷：`Start-Process -ArgumentList` 没给含空格的项目路径加引号，node 只拿到前半截 | **本版已修**（所有路径参数都加引号，见 `FEATURES.md` F6 §6.4）。若你手上是旧拷贝，把 `scripts\start.ps1` 换成新版即可；也可以先把项目放到无空格路径下应急 |

---


## 11. 本地模型迁移（本轮：4B 已迁入项目）

第二轮结束时本机 `models\llm\` 里有 9B / 2B / DanTagGen 三份权重，项目默认还要下 5.56 GiB 的 9B。
本轮按用户要求收敛成"**本地只留一份 4B + 其余走外接 API**"：

| 动作 | 说明 |
|---|---|
| **迁移** | `<原模型目录>\unsloth\Qwen3.5-4B-GGUF\Qwen3.5-4B-UD-Q4_K_XL.gguf` → **`<项目根>\models\llm\Qwen3.5-4B-UD-Q4_K_XL.gguf`**（2,912,109,728 B）。迁移后按 hf-mirror 的 LFS sha256 校验一致（`b252c561…bc961bc7`），源目录里的该文件已删除（同目录的 `mmproj-F16.gguf` 未动，需要视觉输入时可在「模型管理 → 添加本地路径」自行加入） |
| **卸载** | `Qwen3.5-9B-UD-Q4_K_XL.gguf`（5.97 GB）、`Qwen3.5-2B-UD-Q5_K_XL.gguf`（1.47 GB）、`ggml-model-Q6_K.gguf`（0.32 GB）经 `POST /app/llm/models/remove` 删除，占位与残留 `.part` 一并清掉 |
| **默认** | 提示词生成默认走**外接 API**（DeepSeek 预设）；切回本地时默认模型就是这份 4B |
| **推荐模型** | 9B / 4B / 2B 三条**只给链接**（来源页 + hf-mirror 直链），本机不再自动下载；卡片上会标注"本机已装" |

**换机器时**：`models\llm\` 一起拷过去即可（4B 约 2.7 GB）；不想拷也行 —— 外接 API 模式下一个本地模型都不需要。


## 12. 本机作品索引（第四轮）

画师页的「本机作品」直接读**本机 output 目录**，不依赖 ComfyUI 在线：

| 模式 | 目录 |
|---|---|
| 内嵌（embedded） | `<项目根>\runtime\comfyui\ComfyUI\output` |
| 外部（external） | `<ComfyUI 目录>\output`（探测不到时回落 `<项目根>\output`） |

- 迁移机器时该目录一般**不需要拷**（它是产出，不是配置）；想看历史作品就把整个 output 目录带过去。
- 「📂 跳转到图片文件夹」在面板图片栏与画师页本机作品卡上都有；也可以在托盘菜单里打开日志目录。
- 作品索引只在内存里缓存 15 秒，删图/移图后点「刷新」即可重新扫描。


## 13. 给其他设备的两条硬约束（第五轮新增）

1. **`start.cmd` 必须保持「纯 ASCII + CRLF」**。cmd.exe 用系统 OEM 代码页（中文 Windows = 936/GBK）读批处理文件，
   一旦里面出现 UTF-8 中文或 LF 换行，双击启动会直接失败（exit 9009）。中文提示请写在 `.ps1` 里
   （`.ps1` 必须是 **UTF-8 with BOM + CRLF**）。两条约束都已进 `scripts/check.js` 的自检红线。
2. **新机器首次启动仍需要「网络或自带 Node」**：包内不含 `runtime/node`。
   - 有系统 Node（≥18）→ 直接用，并在启动器里打一条警告；
   - 没有 → 自动跑 `scripts/bootstrap.ps1` 从 nodejs.org 下载便携 Node 到 `runtime\node`（实测可达）；
   - 完全离线时请手动把 `node.exe` 放到 `runtime\node\node.exe`。

> 另外：**本机已有的 ComfyUI 不会与新包冲突**（各自目录独立、端口在启动时才占用）。
> 新包想直接用现成的 ComfyUI，走「首次运行向导 → 从本机已有 ComfyUI 目录导入」（硬链接，不额外占盘）。

## 文档版本记录

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0.0 首次编写 | — | 与 `comfy-panel-standalone v1.0.0` 同步；覆盖迁移清单、两种迁移方式与体积量级、新机依赖、启动与自检字段、路径失效修法、数据位置对照、卸载、可照抄的自测步骤与常见问题 |
| v1.0.0（第二轮） | 本轮补充 | 迁移清单与数据位置表补**角色词表（约 3.5 MB，可删可重下）与用户别名文件**；新机依赖清单**仍为零**，但说明托盘/控制台最小化只用系统自带程序集、且脚本全走相对路径（**换机器后同样有效**）；启动与退出改成"托盘右键 / 控制台最小化"；新增 `-NoTray` 参数；自测步骤补托盘、角色词表、外接 API 三项；常见问题补第 13–17 条（找不到控制台 / 托盘不可见 / 词表缺失 / 外接 API 报错 / 旧版引号缺陷） |
| v1.0.0（第二轮补强） | 本轮追加 | 内置中文别名从 101 条扩到 **563 条**（覆盖 Re:Zero / FGO / 东方 / VOCALOID / 原神 / 星穹铁道 / 绝区零 / 鸣潮 / 明日方舟 / Blue Archive / 赛马娘 / hololive / nijisanji / 火影 / 海贼 / 龙珠 / 美少女战士 / 魔卡少女樱 / P5 / 赛博朋克 / 守望先锋 / LOL 等主流作品），**每一条都用 `danbooru.csv` 逐条核对**（583 条候选 → 删 20 条 → **563/563 精确命中**，运行时自检 `aliasMisses=0`）；刻意排除「时 / 天天 / 天使 / 真理 / 琴 / 小美 / 白露 / 悠悠 / 陈 / 玛丽 / 吉尔 / 忧」等常用中文词；新增设置项 `llm.characterRepair`（角色词表补全开关，默认开）。 |
| v1.0.0（第三轮） | 本轮追加 | 新增 §11「本地模型迁移」：4B 已从原模型目录迁移进 `models\llm\`（2,912,109,728 B，sha256 校验一致），9B/2B/DanTagGen 已卸载；提示词生成默认走**外接 API**（本地模型可为零）；推荐模型（9B/4B/2B）改为**只给链接**、不再自动下载。 |
| v1.0.0（第四轮） | 本轮追加 | 回车即发送；外接 API **四挡推理**（off/low/high/max，实测数据见附录 L）；**上下文只留本地、默认不外发**（历史可整段复制）；工作台重排（LLM 在最上、提示词工具第二、提示词/参考图进左栏、主图变小历史变大、跳转图片文件夹）；默认画师 **大随机**；**切模型不再清空提示词与画师设置**；画师页新增**本机作品**（缩略图 + 一键收藏 + 搜索 + 「本地没有产品」空态）。 |
| v1.0.0（第五轮） | 本轮修复 | 修复**双击 `start.cmd` 启动失败**的真实缺陷：`start.cmd` 由「LF + UTF-8 中文注释」改为**纯 ASCII + CRLF**（cmd.exe 按 OEM 代码页读批处理文件，中文注释会吃掉行尾 → exit 9009）；`scripts/check.js` 新增 **[4b] 批处理编码红线**（自检 16 → **17 项**）；验收补上「双击等价启动」（`Start-Process <包>\start.cmd`）；MIGRATION 新增 §13 给其他设备的两条硬约束。 |
| v1.0.0（第六轮） | 本轮调整 | 最小下载挡位的生图模型改为 **`anima-turbo-v1.1.safetensors`**：`installer/models.json` 里 turbo 由 standard 提到 **minimal**、`Anima-3.8B-v1.1` 与 `qwen35_4b` 降到 standard，最小挡位 **14.00 → 5.24 GB**（正好等于"面板默认配置开箱能出图"的最小集），standard / full 不变。 |
| v1.0.0（第七轮） | 本轮修复+新增 | 迁移相关的四点：①**镜像梯队现在是设置项**（`download.hfMirrors / nodeMirrors / jsdelivrMirrors / githubProxies`），换到别的网络环境可以在设置页整套替换，不用改代码；②`save()` **不再把派生出来的梯队（以及等于默认值的 `githubProxies`）写进 `data\settings.json`** —— 拷到别的机器时，`settings.json` 里只有"用户真正设过的值"，新机器会用当前版本的默认梯队（旧行为会把当时那几台机器的镜像列表固化进文件）；③新增 `GET /app/jobs` 与顶栏全局任务条，换机器后长任务（ComfyUI 便携包 1.8 GB / 权重 3.9 GB）在任何一个页面都能看到进度；④新增 **`docs/HANDOVER.md` 项目交接文档**（含迁移/发布/验证手册），接手人先读它。**如实标注**：该环境实测 GitHub 系资源只有 `gh-proxy.com` 与 `down.npee.cn` 两个快源，到别的网络环境请先用设置页的「镜像测速」验一遍。 |
