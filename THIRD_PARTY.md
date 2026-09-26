# 第三方组件与许可（THIRD_PARTY）

本项目（dsh-comfy-panel）**自身代码与文档**以 MIT 许可发布（见 `LICENSE`）。
本文件逐组件说明本项目使用、依赖或引用的第三方内容、各自许可、**是否随本仓库分发**以及相应义务。

**一句话原则**：代码自研、**ComfyUI 与模型权重都不自带**——安装脚本从各官方源下载它们，因此本仓库不承担 GPL 二进制分发与非商业权重再分发的义务；唯一随仓库分发的第三方内容是 MIT 许可的画师清单（`data/artists/`）。

> **2026-09-25 许可修正（重要）**：先前本文档把 Qwen 系一律写作 Apache-2.0，**已核实为错误**。Qwen-Image 2.1 系（含 `Comfy-Org/Qwen-Image-2.1` 再打包的文本编码器与 VAE）为 **Qwen Research 许可（仅研究/非商业）**；只有 Qwen3 系底模（Qwen3-0.6B / Qwen3.5-4B / Qwen3-VL-8B-Instruct）才是 Apache-2.0。详见 §2.3 / §2.4。

## 1. 组件清单

| 组件 | 版本 / 来源 | 许可 | 随仓库分发 | 本项目如何使用 |
|---|---|---|---|---|
| **ComfyUI** | https://github.com/comfyanonymous/ComfyUI（安装脚本按需获取；建议记录安装时的 commit） | **GPL-3.0** | ❌ 否 | 宿主半在本机反代其 HTTP API 与 WebSocket；生成工作流由插件构造 JSON 提交 |
| **comfyui-anima-3-8B**（自定义节点） | `custom_nodes/comfyui-anima-3-8B`，Copyright (c) 2026 GumGum10 contributors | **MIT** | ❌ 否（可选运行时依赖） | Anima 3.8B v2 bundle 所需节点：`Anima38BV2Loader` / `Anima38BV2Prompt` / `AnimaQwen35Loader` |
| **Anima 系模型权重** | `circlestone-labs/Anima`（基座）、`lylogummy/Anima-3.8B`、`Gazingstars123/Anima-2.9B`（含 int8 量化版）；各上游模型卡 | **CircleStone Labs Non-Commercial License v1.2** | ❌ 否 | 面板「Anima 3.8B」「Anima 通用」两条管线所用扩散权重 |
| **Qwen-Image 2.1 系权重** | `Comfy-Org/Qwen-Image-2.1`（再打包仓库）：扩散模型 `qwen_image_2.1_int8_convrot`、文本编码器 `qwen3vl_8b_w4a8`、VAE `qwen_image_2.1_vae_bf16`；base_model = `Qwen/Qwen-Image-2.1` | **Qwen Research 许可**（模型卡 `license: other` / `license_name: qwen-research`） | ❌ 否 | 「Qwen-Image 2.1」管线（扩散模型 + 4096 维编码器 + 64 通道 VAE） |
| **Qwen3 系底模（编码器 / VAE 的实际内容）** | `qwen_3_06b_base`（Qwen3-0.6B，随 `circlestone-labs/Anima` 分发）、`qwen35_4b`（Qwen3.5-4B，随 `lylogummy/Anima-3.8B` 分发）、`qwen_image_vae`（Qwen-Image，随 `circlestone-labs/Anima` 分发） | 底模 **Apache-2.0**；但随 Anima 系仓库分发的文件**另受 CircleStone NC v1.2 约束**（取更严格者） | ❌ 否 | Anima 的文本编码器与 16 通道 VAE |
| **画师清单** `Anima2B_Artist_Index_59k.txt` / `Anima2B_Artist_top200.txt` | https://github.com/ThetaCursed/Anima-Style-Explorer，Copyright (c) 2026 ThetaCursed | **MIT** | ✅ **是**（`data/artists/`） | 面板「随机画师」大池（59,676 条）/ 小池（前 200 条）与画师搜索的数据源 |
| **宿主应用** | 用户自备（本项目不分发、不下载） | 依其自身许可（本机安装包声明 MIT，此处仅作说明） | ❌ 否 | 插件宿主环境；面板注册在 `shell.overlay` 插槽 |
| **React** | 随本仓库携带：`web/vendor/react.production.min.js`、`react-dom.production.min.js`（React 18.3.1 UMD） | MIT | ✅ 是 | 浏览器半 UI 的唯一运行时依赖（不联网、不构建） |

## 2. 各组件义务

### 2.1 ComfyUI（GPL-3.0）— 本项目不分发，故无分发义务
本项目不包含、不修改 ComfyUI 源码，也不把其二进制打进发布包；安装脚本从上游获取。因此本仓库只需指向其许可（全文见 `LICENSES/GPL-3.0.txt`）。

> ⚠️ 若**你**决定把 ComfyUI 本体或便携包与自己的发行版一起打包，则必须自行满足 GPL-3.0：
> 附 GPL 全文、提供**对应源码**（同版本源码包或书面要约/同址托管）、保留全部版权与许可声明（包括其依赖组件的许可，如 Python 的 PSF、PyTorch 的 BSD 等）、标注你的修改，
> 并且**不得对 GPL 部分附加额外限制**（例如「禁止商用」——GPL 不允许对 GPL 代码加这种限制；你自己不盈利是你的选择，但接收方仍获得完整 GPL 权利）。

### 2.2 Anima 系权重（CircleStone 非商业许可 v1.2）— 本项目不分发权重
本项目仅通过安装脚本从模型源下载权重，不随仓库、不随 Release 附件分发。若**你**要再分发权重，必须遵守该许可 §3：

- 附带许可全文（本仓库已备 `LICENSES/CircleStone-NC-v1.2.md`）；
- **显著展示**下述**原文** Attribution Notice；
- 说明接收方的使用权由 CircleStone Labs **直接授予**（你不是再授权方）；
- 若分发的是衍生物（微调 / LoRA / 量化合并等），须声明「已修改」，且不得暗示官方背书。

原文 Attribution Notice（照抄，请勿改写）：

> The CircleStone Model is licensed by CircleStone Labs LLC under the CircleStone Non-Commercial License. Copyright CircleStone Labs LLC.
> IN NO EVENT SHALL CIRCLESTONE LABS LLC BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.

补充要点：

- 权重仅限**非商业、非生产**用途（个人研究/试验/私人娱乐/非生产环境评估等）；商用（含对外提供服务）需向 CircleStone Labs 申请商业许可。
- **生成图片（Outputs）不受此限，可商用**——许可 §2.e：「You may use Outputs for any purpose (including for commercial purposes)」。请勿把「权重非商业」与「输出可商用」混为一谈。
- `lylogummy/Anima-3.8B` 上游模型卡未见许可元数据，本仓库按 Anima 衍生品（非商业许可）对待；**最终以该模型卡/仓库声明为准**。

### 2.3 Qwen-Image 2.1 系权重（Qwen Research 许可）— 本项目不分发
`qwen_image_2.1_int8_convrot`、`qwen3vl_8b_w4a8`、`qwen_image_2.1_vae_bf16` 三者由 `Comfy-Org/Qwen-Image-2.1` 再打包分发，该仓库模型卡为 `license: other` / `license_name: qwen-research`（base_model = `Qwen/Qwen-Image-2.1`，其卡片同为 `qwen-research`）。全文已备于 `LICENSES/Qwen-Research.txt`。

义务与要点（条款号为该协议原文）：

- **仅非商业**：第 1.i 条把 "Non-Commercial" 定义为「for research or evaluation purposes only」，第 2.a 条仅授予非商业用途的使用/复制/分发/修改权。
- **商用须单独授权**：第 2.b 条明确「You shall not use the Materials for any commercial purpose without obtaining a separate commercial license from us」，申请邮箱 `model-business@notice.qwencloud.com`。
- **再分发条件**（第 3 条）：附本协议全文（3.a）；修改过的文件须带显著改动声明（3.b）；并在随附的 "Notice" 文本中保留原文署名 —— `Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved.`（3.c）。
- **命名与标注**（第 4 条）：不得把 "Qwen" 作为衍生产品的主名称（4.c）；若用材料或其**输出**去创建/训练/微调/改进对外提供的 AI 模型，须在产品文档显著标注 "Built with Qwen" 或 "Improved using Qwen"（4.b）。
- **输出（Outputs）**：本协议**未就输出的商用与否作出明确授权**（与 CircleStone 明确允许输出商用不同）。若要用其输出营利，建议先取得授权。
- 管辖：中国法律，杭州法院专属管辖（第 8 条）。

### 2.4 Qwen3 系底模（Apache-2.0）与「随 Anima 仓库分发」的叠加约束
`qwen_3_06b_base`、`qwen35_4b`、`qwen_image_vae` 的**内容**分别源自 Qwen3-0.6B、Qwen3.5-4B、Qwen-Image（上游模型卡均为 `license: apache-2.0`，全文见 `LICENSES/Apache-2.0.txt`）。但本安装器实际从 Anima 系仓库下载它们，因此叠加了仓库自身的 CircleStone NC v1.2 约束：

| 文件 | 下载来源仓库 | 上游内容许可（证据） | 分发仓库许可 | 本项目标注（取更严格者） |
|---|---|---|---|---|
| `qwen_3_06b_base` | `circlestone-labs/Anima`（`split_files/text_encoders/`） | Apache-2.0（[Qwen3-0.6B](https://hf-mirror.com/Qwen/Qwen3-0.6B)） | CircleStone NC v1.2（整仓） | **CircleStone-NC-1.2** |
| `qwen35_4b` | `lylogummy/Anima-3.8B` | Apache-2.0（[Qwen3.5-4B](https://hf-mirror.com/Qwen/Qwen3.5-4B)） | 仓库**未声明** license 元数据（Anima 衍生品） | **CircleStone-NC-1.2**（保守） |
| `qwen_image_vae` | `circlestone-labs/Anima`（`split_files/vae/`） | Apache-2.0（[Qwen-Image](https://hf-mirror.com/Qwen/Qwen-Image)） | CircleStone NC v1.2（整仓） | **CircleStone-NC-1.2** |
| `qwen3vl_8b_w4a8` | `Comfy-Org/Qwen-Image-2.1` | Apache-2.0（[Qwen3-VL-8B-Instruct](https://hf-mirror.com/Qwen/Qwen3-VL-8B-Instruct)） | Qwen Research | **Qwen-Research** |

两处上游声明都需要遵守，**请以更严格者为准**。`installer/models.json` 的 `license` / `licenseName` / `licenseNote` 字段逐项记录了上述标注与证据来源（模型卡 URL）。

### 2.5 画师清单（MIT）— 本项目**随仓库分发**，须保留声明
`data/artists/` 下两份清单来自 ThetaCursed/Anima-Style-Explorer（MIT）。本仓库已附上游 MIT 全文与版权行（`LICENSES/ThetaCursed-MIT.txt`），并在 `data/artists/NOTICE.md` 说明来源与用途。任何人再分发本仓库时，请一并保留这两处声明。

### 2.6 comfyui-anima-3-8B（MIT）— 本项目不分发
Anima 3.8B v2 路线的可选运行时依赖。若**你**要随包分发该节点，请附其 MIT 全文与版权行（已备 `LICENSES/comfyui-anima-3-8B-MIT.txt`）。

## 3. 本仓库明确**不**分发的内容

- ❌ 任何模型权重（`*.safetensors` / `*.ckpt` / `*.pt` / `*.pth` / `*.onnx` / `*.gguf`）
- ❌ ComfyUI 本体、便携包、`venv/`、`python_embeded/`
- ❌ 任何画师作品图片（画师图片子目录已在 `.gitignore` 中排除；`data/artists/` 只有两份 `.txt` 文本清单）
- ❌ 宿主应用 本体或其配置
- ❌ 生成结果图片与运行日志

## 4. 不确定点（发布前建议二次核对）

1. **`lylogummy/Anima-3.8B` 的许可声明**：上游模型卡无许可元数据，本仓库按 Anima 衍生品（CircleStone 非商业许可）保守处理；最终以该仓库声明为准。
2. **`qwen35_4b` 的来源仓库许可**：`lylogummy/Anima-3.8B` 未声明 license 元数据，本仓库按 CircleStone NC 保守标注（其内容上游 Qwen3.5-4B 为 Apache-2.0）。
3. **Qwen Research 的输出商用边界**：该协议未明文授权输出的商业使用；涉及商用输出请先向 Qwen 取得授权。（先前文档「Qwen 系 = Apache-2.0」的说法已作废。）
4. **ComfyUI 具体版本/commit**：本仓库不记录固定 commit；安装脚本应记录并展示它实际安装的版本，以便使用者履行 GPL 的「对应源码」义务（前提是使用者要再分发 ComfyUI）。
