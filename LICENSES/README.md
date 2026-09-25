# LICENSES/

本目录存放本仓库涉及的各上游许可全文。**本仓库不是单一许可证项目**：`LICENSE`（MIT）只覆盖本项目自身代码与文档，第三方组件各自的许可如下。

| 文件 | 对应组件 | 是否随本仓库分发 | 说明 |
|---|---|---|---|
| `GPL-3.0.txt` | ComfyUI 本体 | ❌ 不分发（安装脚本从官方源下载） | GNU GPL v3 全文，35823 B，取自上游仓库根目录 `LICENSE`。**仅当你要自行再分发 ComfyUI 二进制/源码时**才需要随包提供本文件与该版本对应源码 |
| `CircleStone-NC-v1.2.md` | Anima 系模型权重（`circlestone-labs/Anima` 基座、`lylogummy/Anima-3.8B`、`Gazingstars123/Anima-2.9B` 及本机量化版） | ❌ 不分发（安装脚本从模型源下载） | CircleStone Labs Non-Commercial License v1.2 全文（含 §3.b 要求的原文 Attribution Notice）。再分发权重时必须连同本文件与 Attribution Notice 一起提供 |
| `Qwen-Research.txt` | **Qwen-Image 2.1 系权重**（`qwen_image_2.1_int8_convrot`、`qwen3vl_8b_w4a8`、`qwen_image_2.1_vae_bf16`，由 `Comfy-Org/Qwen-Image-2.1` 再打包） | ❌ 不分发（安装脚本从模型源下载） | **Qwen Research License Agreement** 全文（7831 B，原文取自 `Qwen/Qwen-Image-2.1` 仓库 `LICENSE`）。要点：仅研究/非商业；商用须单独授权；再分发须附本协议、标注修改并保留指定署名。详见 `THIRD_PARTY.md` §2.3 |
| `Apache-2.0.txt` | Qwen3 系**底模**（Qwen3-0.6B / Qwen3.5-4B / Qwen3-VL-8B-Instruct） | ❌ 不分发 | Apache License 2.0 全文（11357 B，规范文本）。⚠️ 注意：安装器下载的 `qwen_3_06b_base` / `qwen35_4b` / `qwen_image_vae` 虽**内容**源自 Apache-2.0 底模，但**随 Anima 系仓库分发**，另受 CircleStone NC v1.2 约束（取更严格者）。详见 `THIRD_PARTY.md` §2.4 |
| `ThetaCursed-MIT.txt` | `data/artists/` 下的 59k / top200 画师清单 | ✅ **随仓库分发** | 上游 MIT 全文 + 版权行（Copyright (c) 2026 ThetaCursed）+ 来源链接，满足 MIT 的声明保留义务 |
| `comfyui-anima-3-8B-MIT.txt` | ComfyUI 自定义节点 `comfyui-anima-3-8B`（Anima 3.8B v2 bundle 的加载器/提示词节点） | ❌ 不分发（可选运行时依赖，由用户/安装脚本另行获取） | 上游 MIT 全文 + 版权行（Copyright (c) 2026 GumGum10 contributors） |

## 为什么 ComfyUI 是 GPL-3.0 而本插件可以是 MIT

本插件与 ComfyUI 是**两个独立程序**，通过 HTTP 与 WebSocket 通信（本机回环反代），没有 import、链接、复制或共享代码；二者在同一个发布包里属于 GPL-3.0 §5 意义上的「聚合（aggregate）」，不互相传染。因此：

- **本插件自身代码**：MIT。
- **ComfyUI**：仍是 GPL-3.0；你若把 ComfyUI 本体/二进制打进自己的发行包，就必须附带 GPL 全文与对应源码，且**不得**给接收方附加 GPL 之外的额外限制（例如「禁止商用」——GPL 不允许对 GPL 部分加这种限制）。

## 关于 Anima 许可的两个关键点

1. **模型权重只能非商业使用**（个人研究/试验/私人娱乐/非生产环境评估等）；若要商用（含对外提供服务），需向 CircleStone Labs 申请商业许可。
2. **生成出来的图片（Outputs）不受此限制**——许可 §2.e 明确「You may use Outputs for any purpose (including for commercial purposes)」。这与「权重非商业」是两件事，请勿混淆。

## 关于 Qwen 许可的两个关键点

1. **Qwen-Image 2.1 系是 Qwen Research 许可，不是 Apache-2.0**（先前文档写错，2026-09-25 已修正）：该协议第 1.i / 2.a 条仅授予**研究或评估**等非商业用途；第 2.b 条要求商用（含对外提供服务）必须**单独申请商业授权**（`model-business@notice.qwencloud.com`）。该协议也**没有**明文授权输出的商业使用。
2. **Qwen3 系底模才是 Apache-2.0**（Qwen3-0.6B / Qwen3.5-4B / Qwen3-VL-8B-Instruct）；但安装器从 `circlestone-labs/Anima`、`lylogummy/Anima-3.8B` 仓库下载的编码器/VAE 文件，另受这些仓库自身的 CircleStone 非商业许可约束——**两处上游声明都要遵守，取更严格者**。
