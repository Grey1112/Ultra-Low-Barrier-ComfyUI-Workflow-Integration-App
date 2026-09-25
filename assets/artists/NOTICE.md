# data/artists/ — 画师清单数据

## 内容

- `Anima2B_Artist_Index_59k.txt`：**59,676** 条 Danbooru 画师 tag（Anima 2B 训练快照索引），按训练样本量从多到少排序，保留原项目的说明头。
- `Anima2B_Artist_top200.txt`：上述清单中**前 200** 条高频画师 tag（无说明头）。

## 来源与许可

- 来源项目：**ThetaCursed/Anima-Style-Explorer** — https://github.com/ThetaCursed/Anima-Style-Explorer
- 许可：**MIT**（Copyright (c) 2026 ThetaCursed）
- 许可全文：`LICENSES/ThetaCursed-MIT.txt`

## 用途

面板「随机画师」与画师搜索的数据源：

- 「🎲 大随机」从 59k 全量清单随机；「🎲 小随机」从前 200 随机；「🔍 指定画师」在大池中做子串搜索后**点选**。
- 安装器会把这两份 `.txt` 复制到 `<ComfyDir>\model-notes\`；宿主半的 `GET /comfy-panel/artists` 只读该目录下的这两份文件（懒加载缓存），读取失败时面板降级为「不注入画师标签」并给出提示，**不会阻塞生成**。

## 明确声明

- 本目录**只含文本清单**，**不包含任何画师作品图片**、缩略图或画风预览图。
- 清单内容是 Danbooru 社区画师 tag 文本；tag 仅能保证对 **Anima 系列模型**有效（该模型训练时收录过），**不代表**对任何画师作品的授权、许可或再分发。
- 二次分发本仓库时，请保留本文件与 `LICENSES/ThetaCursed-MIT.txt`。
