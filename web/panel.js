// dsh-comfy-panel — client 半：ComfyUI 生图控制台浮动面板。
// 注册在 shell.overlay（叠加层，additive，不替换任何产品 UI）。
// 数据通路（全部经 DSH 鉴权，同源，见 host 半“隐私边界”）：
//   HTTP → /comfy-panel/api/*（host 半反代 ComfyUI，绕过 CORS，需 GUI 签名 cookie）
//   进度 → 同源 ws://<GUI 主机>/comfy-panel/ws?clientId=...（host 半裸 TCP 反代到
//          ComfyUI 的 /ws）。**不再**直连 127.0.0.1:8188/ws：ComfyUI 0.37 的
//          create_origin_only_middleware 会比对 Host 与 Origin 的 netloc，
//          面板来源 127.0.0.1:43120 ≠ 8188，直连握手一律 403（进度条/计时/
//          实时预览因此全哑）。host 半转发时把 Origin 改写成 ComfyUI 自己的来源，
//          围栏才过得去。
//   预览 → 同一 WS 的二进制帧（PREVIEW_IMAGE_WITH_METADATA）：需先声明
//          supports_preview_metadata 特性，并按任务传 extra_data.preview_method
//   图片 → <img> 走 /comfy-panel/api/view（DSH 鉴权代理，不直连 8188）
//
// v0.4 改版要点（修真实崩图：模型 / VAE 潜空间通道数不匹配）：
//   * 新增管线兼容性表（见 MODEL_FAMILIES / VAE_FAMILIES / PIPELINE_RULES）：模型下拉
//     只列当前管线的扩散模型，VAE 下拉只列通道数匹配的那一支；pixel_space 两边都不出现；
//     Qwen-Image 2.1 管线再也选不到 Anima 模型，Anima 管线再也选不到 64 通道的 2.1 VAE；
//   * 自动吸附：state 里的模型/VAE 被当前管线规则拒绝时（首次装载、object_info 刷新、
//     切换管线）改回默认值并在面板里说明改了什么、为什么；
//   * 提交前硬闸门：不兼容组合不再静默 POST，直接给出点名两个文件与通道数原因的错误；
//   * VAEDecode 通道数报错追加人话提示（原文保留），崩了也能看懂；
//   * Anima38BV2Loader 因系统提交内存不足退化成兜底名 Anima-3.8B-v2.safetensors 时，
//     面板判定「Anima 模型未就绪」，禁用生成并给出可操作提示。
//
// v0.5 改版要点（补上「文本编码器」这一层：与模型/VAE 同一类「配错就崩、报错看不懂」的缺陷）：
//   * 编码器纳入管线兼容性表（新增 ENCODER_FAMILIES + PIPELINE_RULES.encoderPattern）：
//     两条管线的 CLIPLoader.clip_name 是同一份全量清单，所以只能按管线规则分开 ——
//     Qwen-Image 2.1 管线的「文本编码器」只列 4096 维的 qwen3vl_8b_w4a8.safetensors，
//     Anima 管线的「原生编码器」只列 1024 维的 qwen_3_06b_base.safetensors；
//   * 编码器复用模型/VAE 的三件套：下拉过滤、自动吸附（首次装载 / object_info 刷新 /
//     切换管线，改了什么、为什么都写进 note）、提交前硬闸门；
//   * 崩图提示新增文本编码器维度错误（normalized_shape=[4096] 收到 1024 维输入）的人话解释，
//     报错原文一字不改；
//   * 模型区标题行加「↻ 刷新模型」：/object_info 每个在线周期只拉一次，Anima 兜底名的
//     内存压力闪烁过去后，不必重开面板就能重新读取清单并重放吸附。
//
// v0.6 改版要点（修「模型看得见却用不了」：模型才是主选择器，编码器/VAE/条件节点全部由它派生）：
//   缘起：v0.5 的两条管线各自把「扩散模型」下拉过滤成一份——Anima 3.8B 管线只列
//   Anima38BV2Loader 扫出来的 v2 bundle（本机只有 Anima-3.8B-v1.1.safetensors 一份），
//   Qwen-Image 2.1 管线只列文件名匹配 qwen-image 的那一份。于是 diffusion_models 里
//   另外三份权重（anima-turbo-v1.1 / Anima-2.9B-preview-v1 / ..._int8_convrot）
//   在面板上根本没有入口 —— 用户的原话是「保证模型都可以使用」。三份都用官方图实测跑通：
//     UNETLoader + CLIPLoader(qwen_3_06b_base, type=stable_diffusion) + CLIPTextEncode
//     + EmptyLatentImage + KSampler(er_sde/simple) + VAELoader(qwen_image_vae) + VAEDecode
//   判据不是文件名，而是 ComfyUI 自己的 detect_unet_config：四份 Anima 权重（含 turbo 与
//   2.9B）都判成 image_model='anima' → supported_models.Anima → latent_format=Wan21
//   （16 通道潜空间 / 空间 //8），所以都配 qwen_image_vae.safetensors + EmptyLatentImage。
//   * 新增「通用 Anima」管线（animaPlain）：上面那张官方图，turbo 默认 CFG 1 / 10 步，
//     2.9B 默认 CFG 4 / 30 步；
//   * 模型改为唯一主选择器：一个下拉列出两份 loader 里全部扩散模型，改它即重新派生
//     管线（routeFor）、编码器、CLIPLoader.type、条件节点、VAE 与采样默认值，并写明「配了什么、为什么」；
//   * Qwen-Image 2.1 的空潜空间维持原样（EmptyLatentImage）—— 实测它是对的：EmptyLatentImage
//     返回 {"samples": …, "downscale_ratio_spacial": 8}，comfy/sample.py:45 fix_empty_latent_channels
//     会按模型的 latent_format 把 [1,4,H/8,W/8] 适配成 QwenImage21 的 64 通道 / 空间 //16。
//     本次两种写法（EmptyLatentImage 与 TextEncodeQwenImage21 的 latent 输出）都实测跑通且出图非退化，
//     所以保持不变（EmptyLatentImage 还额外支持非正方形）。
//   * 闸门只拦「实证不兼容」的组合：三条管线各自的模型/VAE/通道数与编码器维度规则；
//     任何一份实测跑通的权重都必须在闸门上放行。AnimaQwen35UnifiedPrompt 那条路需要的
//     qwen35_expanded_adapter.safetensors 盘上不存在（见 MISSING_ADAPTER_REASON），
//     本面板五份权重都不需要它，所以它被明确排除并写明缺哪个文件。
//
// v0.7 改版要点（功能①底层一半：参考图 img2img）：
//   * 新增纯函数 refSupport(oi, vaeFile)：object_info 缺 LoadImage/VAEEncode 节点或未选 VAE 时
//     supported=false，reason 点名缺什么并注明「参考图将自动无效，按纯文生图生成」；
//   * 三个图构建器入参 p 新增可选 refImage / denoise / refScale：有 refImage 时注入 LoadImage
//     （refScale 为真再加 ImageScaleToTotalPixels）与 VAEEncode 节点，latent 改接 VAEEncode、
//     采样 denoise 生效；未传 refImage 时零新增节点、零接线改动（与 v0.6 行为逐字节等价）。
//   * UI 半：面板新增「参考图」分区（选择/清除/预览缩略图/重绘幅度），generate() 按
//     refSupport 闸门决定是否携带参考图，当前模型/管线不支持时自动忽略并提示。
//   * 功能②：单次出图上限提升至 20 张（张数下拉同步新增 10/12/16/20 档，画廊容量
//     跟着放宽）；8GB 显存下大 batch（如 20×1024²）可能 OOM，OOM 时建议降低张数或分辨率。
//   * 功能③：提示词区「📋 一键替换」：读取剪贴板，按 Positive prompt: / Negative prompt:
//     关键词自动区分并替换正/负向提示词；剪贴板不可用（无权限/非安全上下文）时
//     降级为面板内粘贴框 + 「使用该内容」。
//
// v0.8 改版要点（随机画师纯函数地基）：
//   * 新增画师纯函数层（filterArtists / pickRandomArtist / withArtistTag / savePrefixFor 等）：
//     画师 tag 原始形态带 @ 前缀与 \( \) 转义——注入提示词用原始 tag，进文件名必须去反斜杠；
//     全部导出到 exports.__test，供 agent 侧冒烟直接断言。
//   * 统一测试提示词口径：v0.8 起三管线共用同一句英文提示词（草地上的黑白色斑点小狗）。
//   * Panel 半：画师五模式（关闭/大随机/小随机/随机收藏/指定）+ 收藏列表(localStorage)
//     + 多张逐张生成（每张独立画师与种子、模型文件夹/画师_序号 落盘、中止随时停）。
//
// v0.9 改版要点（发布版）：
//   * 脱敏：注释与默认值不再出现本机绝对路径/用户名（画师清单目录写 <ComfyDir>\model-notes\）。
//   * 构建徽标 BUILD_TAG 升到 v0.9.0，面板头部自证「页面加载的是哪一版 bundle」。
//   * 配套 host 半：默认 ComfyUI 目录支持 config → COMFYUI_DIR → ~/ComfyUI 回落；
//     /launch 兼容便携版 python_embeded\python.exe 与 venv\Scripts\python.exe 两种布局。
//
// v0.9.2 改版要点（真实机器安装测试后的现场修复）：
//   * host 半 /launch：入口 main.py 同样候选探测（<ComfyDir>\main.py → <ComfyDir>\ComfyUI\main.py，
//     后者是官方 Windows 便携包的真实布局），cwd 改用入口脚本所在目录，spawn 异常兜底为 500，
//     日志句柄在所有路径上关闭——修掉「点『启动 ComfyUI』完全没反应」（入口不存在时 spawn
//     同步抛异常，sendJson 执行不到，请求直接断开且用户看不到任何错误）。
//   * client 半 api()：空响应体按 undefined 处理——ComfyUI 的 /free 与 /interrupt 成功时返回
//     空体，旧实现无条件 r.json() 抛 "Unexpected end of JSON input"，把成功显示成失败
//     （「释放显存」其实一直成功）；/interrupt 一并受益。
//   * 鉴权可诊断性：DSH 每次重启都作废旧签名 cookie，页面停在旧 token 标签时 /comfy-panel/*
//     全返回 401，而 config 拉取与画师清单拉取的失败原本是静默的（模型下拉空、生成按钮置灰、
//     点击无反应）。现在 401/403 显式提示「用启动日志里最新的带 token 地址重开页面」。
//
// v0.3 改版要点：
//   * 修掉实时预览链路：WS 改走面板同源的 /comfy-panel/ws（host 半反代），
//     不再直连 8188 被 origin 围栏 403；连不上时给一条克制的诊断提示，
//     连上即清除（不刷屏、不影响重连）；
//   * 修掉数值输入塌陷：步数/CFG/宽/高/种子清空时不再把 Number("") 变 0
//     显示出来——输入期间保留原始文本，只在失焦与生成时收敛/夹紧；
//   * 测试口径不变：🧪 测试图 仍填入 TEST_PROMPTS（黑白色斑点小狗 + 草地背景）
//     并复位推荐参数，与 agent 侧冒烟测试同一份提示词。
//
// v0.2 改版要点：
//   * 字体颜色全面提亮（深底正文 #e9e9ef、标签 #c4c4cf、分区标题浅蓝 #8fb4ff、
//     错误/提示带浅色底），深色背景下所有文字对比度可读；
//   * 图片窗口置顶：实时预览第一时间可见；生成参数两列紧凑排布；模型区可折叠
//     ——界面更简洁，功能一个不少（模型/双管线、正负提示词、分辨率预设、宽高、
//     步数、CFG、张数、种子、显存/内存、实时预览、缩略图、中止、释放显存、启动）；
//   * 头部新增「跳转 ComfyUI ↗」：新标签页打开 ComfyUI 原生界面；
//   * 新增「🧪 测试图」：一键填入统一生图测试提示词（黑白色斑点小狗 + 草地背景）
//     并复位推荐参数，冒烟测试口径统一；
//   * 修复：复选框被 width:100% 拉伸、WS 结束但 history 未就绪的收图竞态（丢图）、
//     execution_error 后进度/节点残留、生成中可切换管线/换模型（触发卸载冲突）、
//     数值输入 NaN/越界直接提交、面板关闭/刷新期间生成完成的图不会回填。
window.__ModuleLoader__.load({
	id: "dsh-comfy-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const h = react.createElement;
		const { useState, useEffect, useRef } = react;

		const CLIENT_ID = "dsh-panel-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

		// v1.0.0（独立版）：把"写入提示词 / 触发生成"这类跨页面动作暴露给外壳。
		// 为什么不用 DOM 赋值：React 的受控输入有 value tracker，直接改 DOM 的 value
		// 只改显示、不改 React state（提交时会用旧值）。这里走真正的 setState。
		const PANEL_API = { current: null };

		// v1.0.0（独立版）：构建标识。面板头部据此自证"页面加载的是哪一版"。
		// 与插件版不同：独立版静态直接托管、**没有 ?rev= 快照机制**，改代码刷新即生效。
		const BUILD_TAG = "v1.0.0";

		// 实时通道地址：永远走面板自己的来源（同源 relay），不直连 8188。
		// 纯函数，便于 node 侧冒烟测试直接断言。
		const wsUrlFor = (origin, clientId) =>
			origin.replace(/^http/, "ws") + "/comfy-panel/ws?clientId=" + clientId;

		const SIZE_PRESETS = {
			anima: [
				["832×1216 竖版", 832, 1216],
				["1216×832 横版", 1216, 832],
				["1024×1024 方形", 1024, 1024],
			],
			// 通用 Anima 官方推荐分辨率 512²–1536²（circlestone-labs/Anima README）
			animaPlain: [
				["1024×1024 方形", 1024, 1024],
				["832×1216 竖版", 832, 1216],
				["1216×832 横版", 1216, 832],
				["1536×1536 上限", 1536, 1536],
			],
			qwen: [
				["1024×1024 (1MP)", 1024, 1024],
				["1328×1328", 1328, 1328],
				["2048×2048 (原生2K)", 2048, 2048],
			],
		};
		const PIPE_DEFAULTS = {
			anima: { steps: 40, cfg: 6, size: [832, 1216], neg: "score_1, score_2, score_3, worst quality, fat, lowres, worst quality, bad quality, very displeasing, displeasing, jpeg artifacts, blurry, artist name, signature, watermark, " },
			// 通用 Anima 官方推荐：30–50 步、CFG 4–5、er_sde + simple
			animaPlain: { steps: 30, cfg: 4, size: [1024, 1024], neg: "worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration" },
			qwen: { steps: 25, cfg: 1, size: [1024, 1024], neg: "" },
		};
		// 逐权重覆盖：同一管线里 turbo 权重的推荐值与底座不同（官方 README：Anima-Turbo 用 CFG 1、8–12 步）。
		const MODEL_DEFAULT_OVERRIDES = [
			{ pattern: /turbo/i, steps: 10, cfg: 1, why: "Turbo 蒸馏权重：CFG 1 / 8–12 步" },
		];
		// defaultsFor：管线默认值 + 该权重的覆盖值（模型是主选择器，参数默认值也跟着模型走）
		function defaultsFor(route, model) {
			const base = PIPE_DEFAULTS[route] ?? PIPE_DEFAULTS.anima;
			const over = MODEL_DEFAULT_OVERRIDES.find((o) => o.pattern.test(String(model ?? "")));
			return {
				steps: over?.steps ?? base.steps,
				cfg: over?.cfg ?? base.cfg,
				size: base.size,
				neg: base.neg,
				why: over?.why ?? "",
			};
		}
		// 统一生图测试提示词（v0.8 起三管线共用同一句英文）：草地上的黑白色斑点小狗。
		// 「🧪 测试图」按钮与 agent 侧冒烟测试共用同一口径，结果可互相核对。
		const TEST_PROMPTS = {
			anima: "a cute small puppy with black and white spotted fur, dalmatian puppy, sitting on lush green grass, sunny meadow, soft blurred grass background, detailed fluffy fur, bright natural daylight, high quality, masterpiece",
			qwen: "a cute small puppy with black and white spotted fur, dalmatian puppy, sitting on lush green grass, sunny meadow, soft blurred grass background, detailed fluffy fur, bright natural daylight, high quality, masterpiece",
		};
		// 通用 Anima 与 Anima 3.8B 共用同一份英语口径的测试提示词（同一张图便于横向比对）
		TEST_PROMPTS.animaPlain = TEST_PROMPTS.anima;
		const NODE_NAMES = {
			"1": "加载主模型", "4": "加载编码器", "5": "加载 Qwen3.5", "10": "加载 VAE",
			"2": "正向编码", "3": "负向编码", "13": "CFG", "14": "采样", "15": "VAE 解码",
			"a": "加载主模型", "b": "加载编码器", "c": "加载 VAE", "d": "编码提示词",
			"e": "空潜空间", "f": "采样", "g": "VAE 解码",
			// v0.6 通用 Anima 管线
			"m1": "加载主模型", "m2": "加载编码器", "m3": "正向编码", "m4": "负向编码",
			"m5": "空潜空间", "m6": "采样", "m7": "加载 VAE", "m8": "VAE 解码", "m9": "保存",
		};

		const gb = (n) => (n == null ? "?" : (n / 1073741824).toFixed(1));

		// 数值输入兜底：NaN/越界一律收敛，避免把非法值提交给 ComfyUI
		const clampInt = (v, lo, hi, dflt) => {
			const n = Math.round(Number(v));
			return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
		};
		const clampFloat = (v, lo, hi, dflt) => {
			const n = Number(v);
			return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
		};
		// 分辨率对齐到 8 的倍数（Latent 尺寸要求），并夹紧到 64–4096
		const snapSize = (w, hgt) => [
			clampInt(Math.round((Number(w) || 0) / 8) * 8, 64, 4096, 832),
			clampInt(Math.round((Number(hgt) || 0) / 8) * 8, 64, 4096, 1216),
		];
		// 数值输入“原始文本”策略：onChange 只存文本，失焦/生成时才收敛夹紧。
		// 否则 Number("") === 0 会把正在清空的输入框当场显示成 0。
		const textOf = (v) => (v == null ? "" : String(v));
		const commitNum = (raw, lo, hi, dflt, integer) => {
			const t = textOf(raw).trim();
			if (t === "") return integer ? clampInt(dflt, lo, hi, dflt) : clampFloat(dflt, lo, hi, dflt);
			return integer ? clampInt(t, lo, hi, dflt) : clampFloat(t, lo, hi, dflt);
		};
		// 宽/高：先按对 8 取整再夹紧（失焦时用），空串落回默认尺寸。
		const commitSize = (raw, dflt) => {
			const t = textOf(raw).trim();
			if (t === "") return dflt;
			return clampInt(Math.round(Number(t) / 8) * 8, 64, 4096, dflt);
		};

		// v0.7 功能③：剪贴板提示词解析纯函数（与 scratch\parse-prompt-clipboard.cjs 逐条等价）。
		// 关键词大小写不敏感、允许全角冒号、冒号前允许空白；双命中按两个关键词出现的先后关系
		// 切分；单命中仅替换对应字段（另一字段 null 表示保持不变）；无关键字整段作正向并在
		// summary 注明；空串/全空白返回 null。
		const POSITIVE_PROMPT_RE = /positive\s*prompt\s*[:：]/i;
		const NEGATIVE_PROMPT_RE = /negative\s*prompt\s*[:：]/i;
		const parsePromptClipboard = (text) => {
			if (typeof text !== "string") return null;
			const whole = text.trim();
			if (whole === "") return null;
			const posMatch = POSITIVE_PROMPT_RE.exec(text);
			const negMatch = NEGATIVE_PROMPT_RE.exec(text);
			let positive = null;
			let negative = null;
			const replaced = [];
			let summary;
			if (posMatch && negMatch) {
				const posEnd = posMatch.index + posMatch[0].length;
				const negEnd = negMatch.index + negMatch[0].length;
				if (negMatch.index < posMatch.index) {
					// 倒序：negative 关键词在 positive 关键词之前，按各自先后关系正确切分
					negative = text.slice(negEnd, posMatch.index).trim();
					positive = text.slice(posEnd).trim();
				} else {
					// 正序：positive 关键词在前
					positive = text.slice(posEnd, negMatch.index).trim();
					negative = text.slice(negEnd).trim();
				}
				replaced.push("positive", "negative");
				summary = `已替换正向（${positive.length} 字）与负向（${negative.length} 字）`;
			} else if (posMatch) {
				positive = text.slice(posMatch.index + posMatch[0].length).trim();
				replaced.push("positive");
				summary = `已替换正向（${positive.length} 字），负向保持不变`;
			} else if (negMatch) {
				negative = text.slice(negMatch.index + negMatch[0].length).trim();
				replaced.push("negative");
				summary = `已替换负向（${negative.length} 字），正向保持不变`;
			} else {
				positive = whole;
				summary = `未识别到关键字，已整体作为正向提示词（${whole.length} 字）`;
			}
			return { positive, negative, replaced, summary };
		};

		// v0.8：画师纯函数层。画师 tag 来自 host 半 /comfy-panel/artists（<ComfyDir>\model-notes\
		// 下的两份清单），原始形态：@开头 + \( \) 转义 + 空格分隔。
		// 注入提示词用原始 tag（Danbooru 体系 @ 与转义缺一不可）；文件名里反斜杠非法，必须清洗。
		// 只用于比较的归一化：去掉转义反斜杠 + 小写。
		const normalizeTag = (s) => String(s ?? "").replace(/\\/g, "").trim().toLowerCase();
		// 搜索过滤：归一化后子串匹配，保持清单原顺序（频率序）；query 为空返回清单前 cap 个。
		const filterArtists = (tags, query, cap) => {
			const list = (tags ?? []).map(String);
			const q = normalizeTag(query);
			const hit = q === "" ? list : list.filter((t) => normalizeTag(t).includes(q));
			return hit.slice(0, cap ?? 50);
		};
		// 随机画师：空池返回 null。
		const pickRandomArtist = (tags) => {
			const list = (tags ?? []).map(String);
			return list.length ? list[Math.floor(Math.random() * list.length)] : null;
		};
		// 文件名安全段：去 @ 前缀、去反斜杠与 Windows 非法字符 <>:"/\|?*、压缩空白；空则兜底。
		const sanitizeFilePart = (s, dflt) => {
			const t = String(s ?? "").replace(/^@/, "").replace(/[\\<>:"/|?*]/g, "").replace(/\s+/g, " ").trim();
			return t || dflt;
		};
		// 画师 → 文件名段（不含 @，去转义）
		const artistFileNamePart = (tag) => sanitizeFilePart(tag, "artist");
		// 模型文件 → 子文件夹名：去掉 .safetensors 后再清洗（模型名不会含路径分隔符，仍兜一道）
		const modelFolderName = (modelFile) =>
			sanitizeFilePart(String(modelFile ?? "").replace(/\.safetensors$/i, ""), "model");
		// SaveImage 的 filename_prefix："模型文件夹/画师_序号"；无画师时 "模型文件夹/noartist_序号"。
		const savePrefixFor = (modelFile, artistTag, index) =>
			modelFolderName(modelFile) + "/" + (artistTag ? artistFileNamePart(artistTag) : "noartist") + "_" + Math.max(1, Math.round(Number(index) || 1));
		// 画师注入：tag 为空原样返回；正向里已含该 tag（归一化后 includes）不重复注入；
		// 否则把原始 tag 前置为 "@tag, " + 提示词。
		const withArtistTag = (positive, tag) => {
			const p = String(positive ?? "");
			if (!tag) return { text: p, injected: false };
			if (normalizeTag(p).includes(normalizeTag(tag))) return { text: p, injected: false };
			return { text: String(tag) + ", " + p, injected: true };
		};
		// 面板警示文案（仅对 Anima 系有效）
		const ARTIST_NOTE = "画师标签仅对 Anima 系列模型（Anima 3.8B / Anima 通用）有效：Qwen-Image 2.1 没有内置画师库，不会注入画师标签。画师 tag 必须带 @ 才生效；清单来自 Anima 2B 训练快照（59,676 个，前 200 为高频大画师）。";

		// v1.0.0（独立版）：收藏与黑名单改为**服务端 JSON**（<项目根>\\data\\artists.json），
		// 不再依赖浏览器 localStorage —— 迁移时随项目文件夹一起走。
		// localStorage（key 仍为 dcp-artist-favs）只作为一次性导入来源（外壳里有导入按钮）。
		const FAV_STORAGE_KEY = "dcp-artist-favs";
		// 外壳在挂载面板前把服务端数据放进 window.__DCP_ARTISTS__；省缺时退化为空列表。
		const artistStore = () => {
			const st = (typeof window !== "undefined" && window.__DCP_ARTISTS__) || {};
			return {
				favs: Array.isArray(st.favs) ? st.favs.map(String) : [],
				blacklist: Array.isArray(st.blacklist) ? st.blacklist.map(String) : [],
			};
		};
		const loadFavorites = () => artistStore().favs;
		const loadBlacklist = () => artistStore().blacklist;
		// 乐观更新 + 交给外壳持久化（外壳提供 window.__DCP_SAVE_ARTISTS__，内部走服务端接口）。
		const persistArtists = (next) => {
			const cur = artistStore();
			const merged = {
				favs: [...new Set((next.favs ?? cur.favs).map(String).filter(Boolean))],
				blacklist: [...new Set((next.blacklist ?? cur.blacklist).map(String).filter(Boolean))],
			};
			if (typeof window !== "undefined") {
				window.__DCP_ARTISTS__ = merged;
				if (typeof window.__DCP_SAVE_ARTISTS__ === "function") window.__DCP_SAVE_ARTISTS__(merged);
			}
			return merged;
		};
		const saveFavorites = (list) => persistArtists({ favs: list ?? [] });
		const saveBlacklist = (list) => persistArtists({ blacklist: list ?? [] });
		const toggleArtist = (list, tag) => (list ?? []).includes(tag) ? list.filter((t) => t !== tag) : [...(list ?? []), tag];
		// 收藏与黑名单互斥：加入一个列表即从另一个列表移除（后执行的操作覆盖）。
		const toggleFavExclusive = (tag) => {
			const cur = artistStore();
			const removing = cur.favs.includes(tag);
			return persistArtists({
				favs: removing ? cur.favs.filter((t) => t !== tag) : [tag, ...cur.favs.filter((t) => t !== tag)],
				blacklist: removing ? cur.blacklist : cur.blacklist.filter((t) => t !== tag),
			});
		};
		const toggleBlacklistExclusive = (tag) => {
			const cur = artistStore();
			const removing = cur.blacklist.includes(tag);
			return persistArtists({
				blacklist: removing ? cur.blacklist.filter((t) => t !== tag) : [tag, ...cur.blacklist.filter((t) => t !== tag)],
				favs: removing ? cur.favs : cur.favs.filter((t) => t !== tag),
			});
		};
		// 黑名单在所有随机档（大随机/小随机/随机收藏）里剔除；指定模式仍可搜到并标注「已拉黑」。
		const withoutBlacklisted = (tags) => {
			const black = new Set(artistStore().blacklist);
			return (tags ?? []).map(String).filter((t) => !black.has(t));
		};
		// 自定义画师（独立版**有意放宽**插件版「只允许清单内画师」的红线）：完全手动输入即可用，
		// 不弹"清单外"警告、不做二次确认；只做格式规范 —— 转成 `@名字`、用空格不用下划线、
		// 仅保留 Danbooru tag 允许的字符。自定义画师不进默认随机池（两档随机池来自固定清单），
		// 但可被收藏，收藏后进入收藏列表，"仅收藏"检索与 ★随机收藏 自然覆盖它。
		const CUSTOM_TAG_RE = /[^A-Za-z0-9()\-.'\s]/g;
		const normalizeCustomArtist = (raw) => {
			let s = String(raw ?? "")
				.replace(/\\/g, "")
				.replace(/_/g, " ")
				.replace(CUSTOM_TAG_RE, " ")
				.replace(/\s+/g, " ")
				.trim()
				.replace(/^@+/, "");
			if (!s) return null;
			return "@" + s;
		};

		async function api(path, opts) {
			const r = await fetch("/comfy-panel/api" + path, opts);
			if (!r.ok) {
				let msg = "HTTP " + r.status;
				try { msg = (await r.json()).error ?? msg; } catch {}
				// v1.0.0（独立版）：鉴权不再来自 DSH 签名 cookie；本机回环直连时不会 401。
				// 开启局域网监听后，请求需带令牌（?token= 或 X-DCP-Token）——仍然显式提示，不静默。
				if (r.status === 401 || r.status === 403) {
					throw new Error("鉴权失败（HTTP " + r.status + "）：局域网模式需要令牌，请用带 ?token= 的地址打开页面（附注：" + msg + "）");
				}
				throw new Error(msg);
			}
			// v0.9.2：ComfyUI 的 /free 与 /interrupt 成功时返回**空响应体**，无条件 r.json() 会抛
			// "Unexpected end of JSON input"，把成功显示成失败（「释放显存」其实一直成功）。
			// 空体按 undefined 处理。注意不要改用 r.text()+JSON.parse —— 那会丢掉 r.json()
			// 自带的 BOM 剥离行为，可能把合法 JSON 静默变成 undefined。
			try { return await r.json(); } catch { return undefined; }
		}

		// object_info 里取某节点类的第一个 combo 输入：{key, values} 或 null
		function comboOf(oi, cls) {
			const def = oi && oi[cls];
			if (!def) return null;
			for (const g of [def.input && def.input.required, def.input && def.input.optional]) {
				if (!g) continue;
				for (const k of Object.keys(g)) {
					const v = g[k];
					if (Array.isArray(v) && Array.isArray(v[0])) return { key: k, values: v[0].map(String) };
				}
			}
			return null;
		}

		function pick(list, wanted) {
			if (list && list.includes(wanted)) return wanted;
			return (list && list[0]) ?? "";
		}

		// ── 管线兼容性表：扩散模型 ⇄ VAE ⇄ 潜空间通道数 ─────────────────────────
		// 缘起：面板曾把 UNETLoader 的每一项都摆进 Qwen 管线、把 VAELoader 的每一项都摆进
		// 两条管线，于是「Anima 模型 + Qwen-Image 2.1 VAE」这种组合随手可选，而它必然在
		// VAEDecode 深处崩掉，报错完全看不出原因：
		//   Given groups=1, weight of size [64, 64, 1, 1, 1],
		//   expected input[1, 16, 1, 135, 240] to have 64 channels, but got 16 channels instead
		//
		// 通道数量自本机 models/vae/*.safetensors 的头部（只读 safetensors header JSON，
		// 不加载权重）：conv2.weight 是 VAE 作用于潜空间的第一个 1×1 卷积，它的输入通道数
		// 就是该 VAE 能解码的潜空间通道数。实测（ComfyUI 0.37.0，本机）：
		//   qwen_image_vae.safetensors           conv2.weight [16,16,1,1,1] → 16 通道（配 Anima 系）
		//   qwen_image_2.1_vae_bf16.safetensors  conv2.weight [64,64,1,1,1] → 64 通道（配 Qwen-Image 2.1）
		// 判据与验证：.../models/diffusion_models 里 anima-turbo-v1.1.safetensors 与
		// qwen_image_2.1_int8_convrot.safetensors 分别产 16 / 64 通道 latent，配错 VAE 即在
		// VAEDecode 报上面的错（prompt ccedae62-bf9b-4aa0-9430-d4398e9dea05 即此例）。
		const MODEL_FAMILIES = [
			{ name: "Qwen-Image 2.1", pattern: /qwen[-_]?image/i, channels: 64 },
			{ name: "Anima", pattern: /anima/i, channels: 16 },
		];
		const VAE_FAMILIES = [
			{ name: "Qwen-Image 2.1 VAE", pattern: /qwen_image_2\.1_vae/i, channels: 64 },
			{ name: "Anima(Qwen-Image) VAE", pattern: /qwen_image_vae/i, channels: 16 },
			// pixel_space 不是潜空间解码器（只做像素空间的图像编解码），channels:null
			// 表示「没有可解码的潜空间」，两条管线都不该出现它。
			{ name: "像素空间 VAE", pattern: /^pixel_space$/i, channels: null },
		];
		// ── 文本编码器家族：按「输出 token 的嵌入维度」区分 ──────────────────────
		// 缘起：两条管线的 CLIPLoader.clip_name 是同一份全量清单，而 Anima 的原生 1024 维编码器
		// 与 Qwen-Image 2.1 的 4096 维编码器可以随手互换，配错不会在提交时被拦，而是在编码阶段
		// 深处炸出一句完全看不出原因的报错（实测 comfyui-launch.log）：
		//   RuntimeError: Given normalized_shape=[4096], expected input with shape [*4096],
		//   but got input of size[1, 35, 1024]
		//
		// 维度取自本机 models/text_encoders/*.safetensors 的头部（只读 safetensors header JSON，
		// 不加载权重）：embed_tokens.weight 的最后一维就是该编码器的 hidden size。实测：
		//   qwen3vl_8b_w4a8.safetensors  [151936, 4096] → 4096 维（Qwen-Image 2.1 文本编码器）
		//   qwen_3_06b_base.safetensors  [151936, 1024] → 1024 维（Anima 原生 Qwen3 0.6B 编码器）
		// 崩溃点：comfy/ldm/qwen_image21/model.py:201 的 TextProjection(context_in_dim=4096) 会在
		// rms_norm 要求 [*,4096]；Anima 侧 v2.py:206 则硬性要求 native_clip 最后一维 == 1024。
		// 所以配错一定死在文本编码器，而不是死在 VAEDecode —— 提示语里要把这层说清楚。
		const ENCODER_FAMILIES = [
			{ name: "Qwen-Image 2.1 文本编码器", pattern: /qwen3vl_8b/i, dim: 4096 },
			{ name: "Anima 原生编码器（Qwen3 0.6B）", pattern: /qwen_3_06b_base/i, dim: 1024 },
		];
		const PIPELINE_RULES = {
			anima: {
				label: "Anima 3.8B", latentChannels: 16,
				// 模型来自 Anima38BV2Loader，那个 combo 本身就是 Anima 专用，这里再兜一道文件名
				modelPattern: /anima/i,
				vaePattern: /^qwen_image_vae\.safetensors$/i,
				// 原生编码器（CLIPLoader type=stable_diffusion）：Anima 只吃 1024 维的 Qwen3 0.6B
				encoderPattern: /^qwen_3_06b_base\.safetensors$/i,
				encoderLabel: "原生编码器",
				encoderDim: 1024,
				encoderSite: "Anima38BV2Prompt 要求 native_clip 最后一维为 1024",
				defaultModel: "Anima-3.8B-v1.1.safetensors",
				defaultVae: "qwen_image_vae.safetensors",
				defaultEncoder: "qwen_3_06b_base.safetensors",
			},
			qwen: {
				label: "Qwen-Image 2.1", latentChannels: 64,
				// UNETLoader 的列表里混着 Anima 模型，必须按文件名挑出 2.1
				modelPattern: /qwen[-_]?image/i,
				vaePattern: /^qwen_image_2\.1_vae_bf16\.safetensors$/i,
				// 文本编码器（CLIPLoader type=qwen_image）：2.1 的文本投影只吃 4096 维
				encoderPattern: /^qwen3vl_8b_w4a8\.safetensors$/i,
				encoderLabel: "文本编码器",
				encoderDim: 4096,
				encoderSite: "TextEncodeQwenImage21 的文本投影 txt_in 要求 [*,4096]",
				defaultModel: "qwen_image_2.1_int8_convrot.safetensors",
				defaultVae: "qwen_image_2.1_vae_bf16.safetensors",
				defaultEncoder: "qwen3vl_8b_w4a8.safetensors",
			},
			// 通用 Anima（circlestone / HEIXUN 系的普通 Anima 权重）。判据是 ComfyUI 自己的
			// detect_unet_config：这些权重都判成 image_model='anima' → supported_models.Anima
			// → latent_format=Wan21（16 通道潜空间 / 空间 //8），与 Anima 3.8B 同族，
			// 所以 VAE / 编码器 / 维度与 anima 管线完全一致，只有「条件节点 + 采样器」不同：
			// 官方图用 CLIPTextEncode（不是 Anima38BV2Prompt）+ KSampler(er_sde/simple)。
			animaPlain: {
				label: "Anima（通用）", latentChannels: 16,
				modelPattern: /anima/i,
				vaePattern: /^qwen_image_vae\.safetensors$/i,
				// qwen_3_06b_base 在 comfy/sd.py:1971 被 te_model==QWEN3_06B 分支接成
				// comfy.text_encoders.anima.*，与 CLIPLoader.type 取值无关（官方图写 stable_diffusion）。
				encoderPattern: /^qwen_3_06b_base\.safetensors$/i,
				encoderLabel: "原生编码器",
				encoderDim: 1024,
				encoderSite: "Anima 的文本编码器是 1024 维的 Qwen3 0.6B（CLIPLoader type=stable_diffusion）",
				defaultModel: "anima-turbo-v1.1.safetensors",
				defaultVae: "qwen_image_vae.safetensors",
				defaultEncoder: "qwen_3_06b_base.safetensors",
			},
		};
		const ruleFor = (pipeline) => PIPELINE_RULES[pipeline] ?? PIPELINE_RULES.anima;
		const familyOf = (table, file) => table.find((f) => !!file && f.pattern.test(String(file))) ?? null;
		const chanText = (fam) => (fam.channels == null ? "像素空间" : fam.channels + " 通道潜空间");

		// ── 路由层：以「扩散模型文件」为主键，派生编码器 / CLIPLoader.type / 条件节点 / VAE ──
		// 缘起：v0.5 的模型下拉按管线过滤，于是每条管线只看得见一份权重；本机 5 份权重里有 3 份
		// 在两条管线上都没有入口（用户原话「保证模型都可以使用」）。改成「模型是主选择器」后，
		// 管线由模型反推。
		//
		// 派生依据（全部实证）：
		//   * Anima38BV2Loader 的 combo 是它自己 mmap 扫 diffusion_models/*.safetensors 的
		//     safetensors metadata（v2.py:24-42，architecture == anima_3_8b_semantic_connector_v2_bundle）
		//     得来的 —— 「某文件出现在这个 combo 里」本身就是一条 safetensors 级判据，
		//     不是靠文件名猜的。这是 v2 bundle 路线的唯一依据。
		//   * 其余权重：文件名含 qwen-image → Qwen-Image 2.1 路线；含 anima → 通用 Anima 路线。
		//     这条文件名判据有 ComfyUI 自己的 detect_unet_config 背书：本机四份 Anima 权重
		//     （Anima-3.8B-v1.1 / Anima-2.9B-preview-v1 / 它的 int8 / anima-turbo-v1.1）
		//     全部判成 image_model='anima' → supported_models.Anima → latent_format=Wan21。
		const ROUTE_MODEL_KEY = { anima: "animaModel", animaPlain: "plainModel", qwen: "qwenUnet" };
		const ROUTE_CLIP_KEY = { anima: "nativeClip", animaPlain: "plainClip", qwen: "qwenClip" };
		const ROUTE_VAE_KEY = { anima: "animaVae", animaPlain: "plainVae", qwen: "qwenVae" };
		// 每条路线的图形态：条件节点 / CLIPLoader.type / 采样器 / 空潜空间来源
		const ROUTE_SHAPE = {
			anima: {
				conditioning: "Anima38BV2Prompt", clipType: "stable_diffusion",
				sampler: "res_multistep", scheduler: "beta", latentNode: "EmptySD3LatentImage",
				why: "v2 bundle 必须走 Anima38BV2Loader + Anima38BV2Prompt（后者要求模型带 anima_v2_connector）",
			},
			animaPlain: {
				conditioning: "CLIPTextEncode", clipType: "stable_diffusion",
				sampler: "er_sde", scheduler: "simple", latentNode: "EmptyLatentImage",
				why: "普通 Anima 权重走官方 circlestone 图：CLIPTextEncode + EmptyLatentImage + er_sde/simple",
			},
			qwen: {
				conditioning: "TextEncodeQwenImage21", clipType: "qwen_image",
				sampler: "euler", scheduler: "simple", latentNode: "EmptyLatentImage",
				why: "2.1 的 latent_format 是 QwenImage21（64 通道 / 空间 //16），"
					+ "EmptyLatentImage 带 downscale_ratio_spacial=8，comfy/sample.py:45 fix_empty_latent_channels "
					+ "会按模型 latent_format 适配成 64 通道 / //16（本机实测出图）",
			},
		};
		// lylogummy v2 bundle 的文件名惯例。只在「Anima38BV2Loader 此刻没扫出它」时起作用：
		// 那时按通用 Anima 路线提交 v2 bundle 并未被证明可行，所以保守留在 v2 路线，
		// 由就绪度闸门给出可操作提示，而不是悄悄换一张没验证过的图。
		const V2_BUNDLE_PATTERN = /^anima-3\.8b/i;
		function routeFor(model, animaValues) {
			const f = String(model ?? "");
			if (!f) return "anima";
			if ((animaValues ?? []).map(String).includes(f)) return "anima";   // loader 的 metadata 扫描背书
			if (V2_BUNDLE_PATTERN.test(f)) return "anima";                     // v2 名字但此刻没被扫到 → 仍留 v2 路线（会被拦）
			if (/qwen[-_]?image/i.test(f)) return "qwen";
			return "animaPlain";
		}
		// 主选择器候选集：两份 loader 的并集（同一文件出现在两边时去重），顺序稳定。
		function modelCatalog(animaValues, unetValues) {
			const out = [];
			for (const v of [...(animaValues ?? []), ...(unetValues ?? [])]) {
				const s = String(v);
				if (s && !out.includes(s)) out.push(s);
			}
			return out;
		}

		// 兼容性判定（纯函数）：null = 这一对可以提交；否则返回可直接展示的中文原因。
		// model / vae 里任一为空也返回原因（此时根本没有可提交的组合）。
		function incompatibility(pipeline, model, vae) {
			const rule = ruleFor(pipeline);
			const mFam = familyOf(MODEL_FAMILIES, model);
			const vFam = familyOf(VAE_FAMILIES, vae);
			const bad = [];
			if (!model || !rule.modelPattern.test(String(model))) {
				if (mFam && mFam.channels !== rule.latentChannels) {
					bad.push(rule.label + " 管线不能使用 " + model + "：它是 " + chanText(mFam) + "的 "
						+ mFam.name + " 模型，本管线 VAE 需要 " + rule.latentChannels + " 通道，会在 VAEDecode 报通道数错误");
				} else {
					bad.push(rule.label + " 管线不能使用 " + (model || "（空）") + "：它不是本管线的扩散模型（文件名需匹配 "
						+ rule.modelPattern.source + "），与本管线 " + rule.latentChannels + " 通道潜空间不兼容");
				}
			}
			if (!vae || !rule.vaePattern.test(String(vae))) {
				if (vFam && vFam.channels == null) {
					bad.push(rule.label + " 管线不能使用 VAE " + vae + "：它不是潜空间 VAE，VAEDecode 无法用它解码潜空间");
				} else if (vFam && vFam.channels !== rule.latentChannels) {
					bad.push(rule.label + " 管线不能使用 VAE " + vae + "：它是 " + chanText(vFam) + " VAE，本管线潜空间是 "
						+ rule.latentChannels + " 通道，会在 VAEDecode 报通道数错误");
				} else {
					bad.push(rule.label + " 管线不能使用 VAE " + (vae || "（空）") + "：它不是本管线的 VAE（文件名需匹配 "
						+ rule.vaePattern.source + "）");
				}
			}
			return bad.length ? bad.join("；") : null;
		}

		// 编码器判定（纯函数）：null = 这一项可以提交；否则返回可直接展示的中文原因。
		// 编码器的失败点是「文本编码器的嵌入维度」，与模型/VAE 的潜空间通道数是两回事，
		// 所以单独一个判据、单独一套原因文案（提示语里点名它会死在文本编码器而不是 VAEDecode）。
		function encoderIncompatibility(pipeline, clip) {
			const rule = ruleFor(pipeline);
			const file = clip == null ? "" : String(clip);
			if (file && rule.encoderPattern.test(file)) return null;
			const fam = familyOf(ENCODER_FAMILIES, file);
			if (fam && fam.dim !== rule.encoderDim) {
				return rule.label + " 管线不能使用" + rule.encoderLabel + " " + file + "：它是 " + fam.dim + " 维的 "
					+ fam.name + "，而本管线需要 " + rule.encoderDim + " 维文本嵌入（" + rule.encoderSite
					+ "），配错会在文本编码器报维度错误，而不是在 VAEDecode；请改选 " + rule.defaultEncoder;
			}
			return rule.label + " 管线不能使用" + rule.encoderLabel + " " + (file || "（空）") + "：它不是本管线的文本编码器（文件名需匹配 "
				+ rule.encoderPattern.source + "）";
		}

		// 下拉候选过滤（纯函数）：按当前管线规则筛。筛完为空则回退到原始列表——宁可让用户
		// 看到全部（提交前还有硬闸门兜着并说明原因），也不要把下拉框变成空的、把 UI 卡死。
		function choiceList(pipeline, field, values) {
			const rule = ruleFor(pipeline);
			const list = (values ?? []).map(String);
			const pattern = field === "vae" ? rule.vaePattern
				: field === "clip" ? rule.encoderPattern
					: rule.modelPattern;
			const hit = list.filter((v) => pattern.test(v));
			return hit.length ? hit : list;
		}

		// 自动吸附（纯函数）：state 里的值被当前管线规则拒绝时改到该管线默认值，并给出
		// 「改了什么、为什么」。current 为空表示首次装载，没有“被改掉”的旧值，只取默认值。
		function snapChoice(pipeline, field, values, current) {
			const rule = ruleFor(pipeline);
			const list = choiceList(pipeline, field, values);
			const cur = current == null ? "" : String(current);
			const wanted = field === "vae" ? rule.defaultVae
				: field === "clip" ? rule.defaultEncoder
					: rule.defaultModel;
			const fallback = list.includes(wanted) ? wanted : (list[0] ?? "");
			if (!cur) return { value: fallback, snapped: false, note: "" };
			if (list.includes(cur)) return { value: cur, snapped: false, note: "" };
			const why = field === "vae"
				? "它不是本管线 " + rule.latentChannels + " 通道潜空间能用的 VAE"
				: field === "clip"
					? "它不是本管线要的 " + rule.encoderDim + " 维文本编码器"
					: "它不是本管线的扩散模型";
			const fieldLabel = field === "vae" ? "VAE" : field === "clip" ? rule.encoderLabel : "主模型";
			return {
				value: fallback, snapped: true,
				note: rule.label + " 管线已把 " + fieldLabel + " 从 " + cur + " 改回 " + fallback + "：" + why,
			};
		}

		// Anima 3.8B 的 diffusion 下拉由 Anima38BV2Loader 现场扫描得到：它 mmap 每一份
		// diffusion_models/*.safetensors 的 metadata，只留 architecture == v2 bundle 的文件
		// （custom_nodes/comfyui-anima-3-8B/v2.py:24-42）。系统提交内存吃紧时那次 mmap 会抛
		// OSError 1455（page file too small）并被 except 吞掉，函数于是返回硬编码兜底名
		// 「Anima-3.8B-v2.safetensors」——盘上并没有这个文件，工作流一提交就必挂。
		// 注意这是「随内存压力闪烁」的状态，不是「Anima 永远不可用」：内存一松，同一份 combo
		// 就会重新列出真实 bundle（实测 Anima 走 relay 全链路跑得通）。所以这里只判「此刻是否
		// 只剩兜底名」，并把重新拉清单的入口交给模型区的「↻ 刷新模型」。
		// 浏览器看不到磁盘，只能按「combo 只剩这一个已知兜底名」判定 Anima 未就绪。
		// 误报面：真有用户盘上只有这一个同名文件——但该文件此刻并不存在，所以口径安全。
		const ANIMA_FALLBACK_MODEL = "Anima-3.8B-v2.safetensors";
		const ANIMA_NOT_READY_MSG = "Anima 模型未就绪：Anima38BV2Loader 只给出了兜底文件名 " + ANIMA_FALLBACK_MODEL
			+ "（盘上不存在这个文件）。这通常是系统提交内存不足、它扫描权重 metadata 失败所致 —— 可先点「释放显存」，"
			+ "或重启 ComfyUI 后重新打开本面板。";
		// v0.6：AnimaQwen35UnifiedPrompt 这条路要用一个独立的 expanded adapter 权重，
		// 它要求的文件名就写在节点自己的 INPUT_TYPES 里（prompt.py:53 的字面兜底）。
		// 本机 models/text_encoders 递归查找无此文件（只有 qwen35_4b / qwen3vl_8b_w4a8 /
		// qwen_3_06b_base），所以该节点此刻不可用。本面板 5 份扩散权重都不需要它 ——
		// Anima 3.8B v2 路线走的是 Anima38BV2Prompt（只要 native_clip + qwen35_clip，无 adapter）。
		// 这条说明写在模型区，绝不静默隐藏。
		const MISSING_ADAPTER_FILE = "qwen35_expanded_adapter.safetensors";
		const MISSING_ADAPTER_REASON = "本面板不走 AnimaQwen35UnifiedPrompt：它要求的 "
			+ MISSING_ADAPTER_FILE + " 在 models/text_encoders 里不存在（该节点 INPUT_TYPES 里的是字面兜底名）。"
			+ "Anima 3.8B v2 路线用 Anima38BV2Prompt，不需要这个文件。";
		function animaModelsReady(values) {
			const list = (values ?? []).map(String).filter(Boolean);
			return list.length !== 1 || list[0] !== ANIMA_FALLBACK_MODEL;
		}

		// v0.6：「确实不可用」的显式理由（空串 = 此刻可用）。唯一一份是 Anima38BV2Loader
		// 在扫描失败时给出的字面兜底名 Anima-3.8B-v2.safetensors —— 盘上并不存在这个文件
		// （v2.py:42）。这种权重必须留在模型列表里并点名缺哪个文件，绝不静默隐藏。
		function unusableReason(model, animaValues, unetValues) {
			const f = String(model ?? "");
			if (!f) return "模型文件为空。";
			if (f === ANIMA_FALLBACK_MODEL) return ANIMA_NOT_READY_MSG;
			const known = [...(animaValues ?? []), ...(unetValues ?? [])].map(String);
			if (!known.includes(f)) {
				return "模型清单里没有 " + f + "：UNETLoader 与 Anima38BV2Loader 此刻都没登记它（文件可能已被移走或改名）。";
			}
			return "";
		}

		// v0.6：模型 → 管线/编码器/条件节点/VAE 的自动配对说明。纯函数，便于 node 侧断言。
		function pairingNote(route, model) {
			const shape = ROUTE_SHAPE[route] ?? ROUTE_SHAPE.anima;
			const rule = ruleFor(route);
			const d = defaultsFor(route, model);
			return "已按 " + model + " 配对「" + rule.label + "」管线：编码器 " + rule.defaultEncoder
				+ "（" + rule.encoderDim + " 维，CLIPLoader type=" + shape.clipType + "）+ 条件节点 " + shape.conditioning
				+ " + VAE " + rule.defaultVae + "（" + rule.latentChannels + " 通道潜空间）；" + shape.why
				+ "。推荐 " + d.steps + " 步 / CFG " + d.cfg + (d.why ? "（" + d.why + "）" : "") + "。";
		}

		// v0.6：一份权重被选中后，该管线要写回的三个槽位值（模型/编码器/VAE）。
		function pairingFor(route, model) {
			const rule = ruleFor(route);
			return {
				[ROUTE_MODEL_KEY[route]]: model,
				[ROUTE_CLIP_KEY[route]]: rule.defaultEncoder,
				[ROUTE_VAE_KEY[route]]: rule.defaultVae,
			};
		}

		// 提交前阻断原因（纯函数）：null = 可以提交。只覆盖模型/VAE/编码器组合与 Anima 就绪度，
		// 提示词为空、离线等由调用方各自判断。
		// clip === undefined 表示「本次调用不校验编码器」（旧调用方/旧测试的签名语义不变）；
		// 传 null / "" 表示确实要提交这个（空）编码器 —— 那也要拦。
		function preSubmitBlock(pipeline, model, vae, animaValues, clip) {
			const bad = incompatibility(pipeline, model, vae);
			if (bad) return bad;
			if (clip !== undefined) {
				const badClip = encoderIncompatibility(pipeline, clip);
				if (badClip) return badClip;
			}
			if (pipeline === "anima" && !animaModelsReady(animaValues)) return ANIMA_NOT_READY_MSG;
			return null;
		}

		// incompatibility() 正文只点出错的那一个文件；阻断提示里再把当前选中的文件都摆出来，
		// 用户一眼能对上是哪一组。编码器只在传入时才出现在这一行里。纯函数，便于测试。
		const selectionLine = (model, vae, clip) => "当前选择：模型 " + (model || "（空）") + " + VAE " + (vae || "（空）")
			+ (clip === undefined ? "" : " + 文本编码器 " + (clip || "（空）"));

		// 通道数不匹配的崩图报错原文（实测自 /history）：
		//   Given groups=1, weight of size [64, 64, 1, 1, 1], expected input[1, 16, 1, 135, 240]
		//   to have 64 channels, but got 16 channels instead
		// 单看这句话猜不到是「模型潜空间通道数 ≠ VAE 通道数」。这里只在原文之后追加一段人话
		// 提示，原文一字不改（不替换、不截断）。
		const CHANNEL_HINT = "\n\n提示：这通常是扩散模型的潜空间通道数与 VAE 不匹配 —— 本机实测 Anima 系模型是 16 通道潜空间，"
			+ "要配 qwen_image_vae.safetensors；Qwen-Image 2.1 是 64 通道，要配 qwen_image_2.1_vae_bf16.safetensors。"
			+ "请在「模型」区确认为当前管线选了配套的模型与 VAE（面板已按管线过滤下拉，正常不会选错）。";
		// 文本编码器维度不匹配的崩图报错原文（实测自 comfyui-launch.log）：
		//   RuntimeError: Given normalized_shape=[4096], expected input with shape [*4096],
		//   but got input of size[1, 35, 1024]
		// 崩溃点是 Qwen-Image 2.1 的文本投影（txt_in → rms_norm 要求 [*,4096]），喂进去的却是
		// Anima 原生编码器的 1024 维输出。这句话同样看不出「文本编码器选错了」，所以照样只在
		// 原文之后追加人话，原文一字不改。
		const ENCODER_HINT = "\n\n提示：这通常是「文本编码器」选错了 —— 报错里的 normalized_shape=[4096] 是 Qwen-Image 2.1 "
			+ "文本投影要求的 4096 维输入，而实际送进去的是 1024 维：Anima 的原生编码器 qwen_3_06b_base.safetensors "
			+ "就是 1024 维。请在「模型」区确认编码器：Qwen-Image 2.1 管线的「文本编码器」要选 "
			+ "qwen3vl_8b_w4a8.safetensors（4096 维），Anima 管线的「原生编码器」要选 "
			+ "qwen_3_06b_base.safetensors（1024 维）。面板已按管线过滤编码器下拉，正常不会选错。";
		function withChannelHint(text, nodeType) {
			const raw = String(text ?? "");
			const where = raw + " " + String(nodeType ?? "");
			const isChannelErr = /channels,\s*but got/i.test(raw)
				|| /VAEDecode/i.test(where);
			// 维度报错家族：normalized_shape=[4096] 收到 1024 维输入；或文本编码节点本身报的维度错。
			const isEncoderDimErr = /normalized_shape/i.test(raw)
				|| (/TextEncodeQwenImage21/i.test(where) && /\b(?:4096|1024)\b/.test(raw))
				|| (/\b4096\b/.test(raw) && /\b1024\b/.test(raw) && /shape|norm/i.test(raw));
			if (!isChannelErr && !isEncoderDimErr) return raw;
			return raw + (isChannelErr ? CHANNEL_HINT : "") + (isEncoderDimErr ? ENCODER_HINT : "");
		}

		// v0.7：参考图（img2img）支持性判定（纯函数，便于 node 侧冒烟测试直接断言）。
		// 判据：object_info 同时具备 LoadImage 与 VAEEncode 节点，且当前管线已选定 VAE 文件——
		// 缺 LoadImage 读不进上传的图，缺 VAEEncode 编不出潜空间，缺 VAE 无从编码，缺一不可。
		function refSupport(oi, vaeFile) {
			const parts = [];
			if (!oi?.LoadImage || !oi?.VAEEncode) {
				const miss = [!oi?.LoadImage ? "LoadImage" : "", !oi?.VAEEncode ? "VAEEncode" : ""].filter(Boolean);
				parts.push("缺少 " + miss.join("/") + " 节点");
			}
			if (!vaeFile) parts.push("未选 VAE");
			if (parts.length === 0) return { supported: true, reason: "" };
			return { supported: false, reason: parts.join("，") + "，参考图将自动无效，按纯文生图生成。" };
		}

		function animaGraph(p, modelKey, encoderKey) {
			// v0.7：可选参考图。hasRef=false 时返回的图与 v0.6 逐字节等价：零新增节点、
			// 零接线改动，denoise 保持字面 1（未传 denoise 时 denoiseVal 恒为 1，NaN 会破坏基线）。
			// v0.8：可选 p.savePrefix（如 "anima-turbo-v1.1/wlop_3"）覆盖落盘位置与前缀；未传时与 v0.7 完全一致。
			const hasRef = !!p.refImage;
			const denoiseVal = Number.isFinite(Number(p.denoise)) ? Number(p.denoise) : 1;
			const g = {
				"1": { class_type: "Anima38BV2Loader", inputs: { [modelKey]: p.unet } },
				"4": { class_type: "CLIPLoader", inputs: { clip_name: p.nativeClip, type: "stable_diffusion", device: "default" } },
				"5": { class_type: "AnimaQwen35Loader", inputs: { [encoderKey]: p.qwenEncoder } },
				"10": { class_type: "VAELoader", inputs: { vae_name: p.vae } },
				"2": { class_type: "Anima38BV2Prompt", inputs: { model: ["1", 0], native_clip: ["4", 0], qwen35_clip: ["5", 0], prompt: p.positive } },
				"3": { class_type: "Anima38BV2Prompt", inputs: { model: ["1", 0], native_clip: ["4", 0], qwen35_clip: ["5", 0], prompt: p.negative } },
				"13": { class_type: "CFGGuider", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], cfg: Number(p.cfg) } },
				"8": { class_type: "KSamplerSelect", inputs: { sampler_name: "res_multistep" } },
				"9": { class_type: "BasicScheduler", inputs: { model: ["1", 0], scheduler: "beta", steps: Number(p.steps), denoise: 1 } },
				"12": { class_type: "RandomNoise", inputs: { noise_seed: Number(p.seed) } },
				"11": { class_type: "EmptySD3LatentImage", inputs: { width: Number(p.width), height: Number(p.height), batch_size: Number(p.batch) } },
				"14": { class_type: "SamplerCustomAdvanced", inputs: { noise: ["12", 0], guider: ["13", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["11", 0] } },
				"15": { class_type: "VAEDecode", inputs: { samples: ["14", 1], vae: ["10", 0] } },
				"17": { class_type: "SaveImage", inputs: { images: ["15", 0], filename_prefix: p.savePrefix ?? "DSH_Panel/Anima" } },
			};
			if (hasRef) {
				const px = p.refScale ? ["S", 0] : ["L", 0];
				g["L"] = { class_type: "LoadImage", inputs: { image: p.refImage } };
				if (p.refScale) g["S"] = { class_type: "ImageScaleToTotalPixels", inputs: { image: ["L", 0], megapixels: 1.0, upscale_method: "nearest-exact", resolution_steps: 1 } };
				g["V"] = { class_type: "VAEEncode", inputs: { pixels: px, vae: ["10", 0] } };
				g["14"].inputs.latent_image = ["V", 0];
				g["9"].inputs.denoise = denoiseVal;
			}
			return g;
		}

		// v0.6：通用 Anima（circlestone / HEIXUN 系的普通权重）的官方图。
		// 实测出图（见交付报告）：anima-turbo-v1.1（CFG 1 / 10 步）、Anima-2.9B-preview-v1、
		// Anima-2.9B-preview-v1_int8_convrot（CFG 4 / 12 步）三份都跑通并产出非退化 PNG。
		// 与 qwenGraph 形状同源（UNETLoader + CLIPLoader + 空潜空间 + KSampler + VAEDecode），
		// 关键差别是 CLIPLoader type=stable_diffusion、条件节点用 CLIPTextEncode、
		// VAE 用 16 通道的 qwen_image_vae.safetensors。
		// 空潜空间用 EmptyLatentImage 是正确的：它带 downscale_ratio_spacial=8，
		// comfy/sample.py:45 fix_empty_latent_channels 会按模型 latent_format 适配
		// （Anima = Wan21：16 通道 / 空间 //8）。
		function animaPlainGraph(p) {
			// v0.7：可选参考图，语义与 animaGraph 相同（未传 denoise 时 denoiseVal 恒为 1）。
			// v0.8：可选 p.savePrefix（如 "anima-turbo-v1.1/wlop_3"）覆盖落盘位置与前缀；未传时与 v0.7 完全一致。
			const hasRef = !!p.refImage;
			const denoiseVal = Number.isFinite(Number(p.denoise)) ? Number(p.denoise) : 1;
			const g = {
				"m1": { class_type: "UNETLoader", inputs: { unet_name: p.unet, weight_dtype: "default" } },
				"m2": { class_type: "CLIPLoader", inputs: { clip_name: p.clip, type: "stable_diffusion", device: "default" } },
				"m3": { class_type: "CLIPTextEncode", inputs: { clip: ["m2", 0], text: p.positive } },
				"m4": { class_type: "CLIPTextEncode", inputs: { clip: ["m2", 0], text: p.negative } },
				"m5": { class_type: "EmptyLatentImage", inputs: { width: Number(p.width), height: Number(p.height), batch_size: Number(p.batch) } },
				"m6": { class_type: "KSampler", inputs: {
					model: ["m1", 0], positive: ["m3", 0], negative: ["m4", 0], latent_image: ["m5", 0],
					seed: Number(p.seed), steps: Number(p.steps), cfg: Number(p.cfg),
					sampler_name: "er_sde", scheduler: "simple", denoise: 1 } },
				"m7": { class_type: "VAELoader", inputs: { vae_name: p.vae } },
				"m8": { class_type: "VAEDecode", inputs: { samples: ["m6", 0], vae: ["m7", 0] } },
				"m9": { class_type: "SaveImage", inputs: { images: ["m8", 0], filename_prefix: p.savePrefix ?? "DSH_Panel/AnimaPlain" } },
			};
			if (hasRef) {
				const px = p.refScale ? ["S", 0] : ["L", 0];
				g["L"] = { class_type: "LoadImage", inputs: { image: p.refImage } };
				if (p.refScale) g["S"] = { class_type: "ImageScaleToTotalPixels", inputs: { image: ["L", 0], megapixels: 1.0, upscale_method: "nearest-exact", resolution_steps: 1 } };
				g["V"] = { class_type: "VAEEncode", inputs: { pixels: px, vae: ["m7", 0] } };
				g["m6"].inputs.latent_image = ["V", 0];
				g["m6"].inputs.denoise = denoiseVal;
			}
			return g;
		}

		function qwenGraph(p) {
			// v0.7：可选参考图，语义与 animaGraph / animaPlainGraph 相同（未传 denoise 时恒为 1）。
			// v0.8：可选 p.savePrefix（如 "anima-turbo-v1.1/wlop_3"）覆盖落盘位置与前缀；未传时与 v0.7 完全一致。
			const hasRef = !!p.refImage;
			const denoiseVal = Number.isFinite(Number(p.denoise)) ? Number(p.denoise) : 1;
			const g = {
				"a": { class_type: "UNETLoader", inputs: { unet_name: p.unet, weight_dtype: "default" } },
				"b": { class_type: "CLIPLoader", inputs: { clip_name: p.clip, type: "qwen_image", device: "default" } },
				"c": { class_type: "VAELoader", inputs: { vae_name: p.vae } },
				"d": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["b", 0], prompt: p.positive, negative_prompt: p.negative, resolution: Number(p.width) } },
				"e": { class_type: "EmptyLatentImage", inputs: { width: Number(p.width), height: Number(p.height), batch_size: Number(p.batch) } },
				"f": { class_type: "KSampler", inputs: { model: ["a", 0], positive: ["d", 0], negative: ["d", 1], latent_image: ["e", 0], seed: Number(p.seed), steps: Number(p.steps), cfg: Number(p.cfg), sampler_name: "euler", scheduler: "simple", denoise: 1 } },
				"g": { class_type: "VAEDecode", inputs: { samples: ["f", 0], vae: ["c", 0] } },
				"h": { class_type: "SaveImage", inputs: { images: ["g", 0], filename_prefix: p.savePrefix ?? "DSH_Panel/Qwen" } },
			};
			if (hasRef) {
				const px = p.refScale ? ["S", 0] : ["L", 0];
				g["L"] = { class_type: "LoadImage", inputs: { image: p.refImage } };
				if (p.refScale) g["S"] = { class_type: "ImageScaleToTotalPixels", inputs: { image: ["L", 0], megapixels: 1.0, upscale_method: "nearest-exact", resolution_steps: 1 } };
				g["V"] = { class_type: "VAEEncode", inputs: { pixels: px, vae: ["c", 0] } };
				g["f"].inputs.latent_image = ["V", 0];
				g["f"].inputs.denoise = denoiseVal;
			}
			return g;
		}

		function SelRow(props) {
			return h("div", { className: "dcp-field" },
				h("span", null, props.label),
				h("select", { value: props.value ?? "", disabled: !!props.disabled, onChange: (e) => props.onChange(e.target.value) },
					(props.values ?? []).map((v) => h("option", { key: v, value: v }, v))),
			);
		}

		function Panel({ onClose, embed, layout: layoutProp }) {
			const [comfy, setComfy] = useState(null);        // {base}
			const [online, setOnline] = useState(false);
			const [stats, setStats] = useState(null);
			const [oi, setOi] = useState(null);
			const [sel, setSel] = useState(null);
			// v1.0.1：默认生图模型改为 anima-turbo-v1.1.safetensors（用户要求）——
			// 它是"通用 Anima"路线的权重，所以初始管线也随之设为 animaPlain，并按 turbo 的
			// 推荐参数初始化（默认表里 turbo 走 10 步 / CFG 1，见 MODEL_DEFAULT_OVERRIDES）。
			// 盘上没有这个文件时 snapChoice 会回落到该路线清单里的第一个可用模型，不会空选。
			const INIT_ROUTE = "animaPlain";
			const INIT_MODEL = "anima-turbo-v1.1.safetensors";
			const INIT_DEF = defaultsFor(INIT_ROUTE, INIT_MODEL);
			const [pipeline, setPipeline] = useState(INIT_ROUTE);
			const [positive, setPositive] = useState("");
			const [negative, setNegative] = useState(INIT_DEF.neg);
			const [size, setSize] = useState(() => INIT_DEF.size.map(textOf));
			const [steps, setSteps] = useState(() => textOf(INIT_DEF.steps));
			const [cfg, setCfg] = useState(() => textOf(INIT_DEF.cfg));
			const [batch, setBatch] = useState(1);
			// 提示词栏的宿主插槽（外壳把「本地 LLM / 提示词生成」portal 挂进来）。
			// 用 ref + 事件通知外壳，而不是让外壳去 DOM 里猜节点。
			const promptSlotRef = useRef(null);
			useEffect(() => {
				if (!promptSlotRef.current) return;
				window.__DCP_PANEL_SLOTS__ = Object.assign({}, window.__DCP_PANEL_SLOTS__, { prompt: promptSlotRef.current });
				try { window.dispatchEvent(new Event("dcp-panel-slots")); } catch { /* 老浏览器忽略 */ }
			}, [online, oi]);
			const [randomSeed, setRandomSeed] = useState(true);
			const [seed, setSeed] = useState(() => textOf(0));
			const [running, setRunning] = useState(false);
			const [progress, setProgress] = useState({ value: 0, max: 0 });
			const [nodeLabel, setNodeLabel] = useState("");
			const [queue, setQueue] = useState(0);
			const [images, setImages] = useState([]);
			const [current, setCurrent] = useState(null);
			const [error, setError] = useState("");
			const [note, setNote] = useState("");
			const [preview, setPreview] = useState(null);   // 采样实时预览帧（blob URL）
			const [startedAt, setStartedAt] = useState(0);  // 本次生成起始时间戳（计时用）
			const [tick, setTick] = useState(0);            // 每秒心跳，驱动“已用”显示
			const [modelsOpen, setModelsOpen] = useState(true);
			const promptIdRef = useRef(null);
			const previewUrlRef = useRef(null);
			// WS 结束但 history 未落盘的重试计数（竞态兜底）
			const histRetryRef = useRef(0);
			// WS 连不上时的诊断：只提示一次，连上即清（见下方 wsNote 说明）
			const wsFailRef = useRef(0);
			const wsNoteShownRef = useRef(false);
			// FINDING 1（v0.5.1）：刷新模型清单的并发守卫 + 「活选择」镜像。
			// 两次快速点击曾各自起飞一条 /object_info，且每条响应用「点击那一刻」闭包里的 sel
			// 快照覆盖全部选择键 —— 请求飞行途中用户改过的、本身仍合法的选择会被静默写回旧值
			// （写回的值也是合法的，所以吸附 effect 不会发现、没有 note、也没法解释）。
			const selRef = useRef(null);           // apply 时读它：永远是「此刻」的选择，不是闭包快照
			const refreshBusyRef = useRef(false);  // 已有一次刷新在飞：再次激活直接 no-op
			// FINDING 3（v0.6.0）：/object_info 的落地权序号，与 refreshBusyRef 配成两道闸。
			// 首次装载与手动「↻ 刷新模型」共用它们（见 loadObjectInfo）：
			//   ① refreshBusyRef 保证任何时刻最多一条 /object_info 在飞 ——
			//      「旧响应后到」在结构上不再可能；
			//   ② oiSeqRef 是第二道闸：即便将来有人绕过①，非最新的响应也绝不写 oi/sel。
			const oiSeqRef = useRef(0);
			if (selRef.current === null) selRef.current = sel;
			// sel 的唯一写入口：镜像与 state 同步推进。函数式更新按「镜像的当前值」求值，
			// 因此同一 tick 内的连续写入不会互相覆盖，apply 侧也总能读到最新选择。
			const selSet = (next) => {
				const v = typeof next === "function" ? next(selRef.current) : next;
				selRef.current = v;
				setSel(v);
			};

			// 预览帧替换时释放上一张 blob，避免持续生成时 URL 泄漏
			const showPreview = (url) => {
				if (previewUrlRef.current && previewUrlRef.current !== url) URL.revokeObjectURL(previewUrlRef.current);
				previewUrlRef.current = url;
				setPreview(url);
			};
			const clearPreview = () => {
				if (previewUrlRef.current) { URL.revokeObjectURL(previewUrlRef.current); previewUrlRef.current = null; }
				setPreview(null);
			};
			const flashNote = (text, ms) => {
				setNote(text);
				setTimeout(() => setNote((n) => (n === text ? "" : n)), ms ?? 4000);
			};

			// v0.7：上传参考图。【t1 实测结论，必须遵守】LoadImage 的 image 输入值必须带
			// " [input]" 后缀才通过校验并可执行；/object_info 的 LoadImage 文件列表有启动期
			// 缓存、上传后不刷新 —— 所以这里直接使用构造值，绝不依赖下拉列表做存在性校验。
			async function uploadRef(file) {
				setRefBusy(true);
				setError("");
				try {
					const fd = new FormData();
					fd.append("image", file);
					fd.append("subfolder", "dsh-panel-ref");
					fd.append("overwrite", "true");
					const data = await api("/upload/image", { method: "POST", body: fd });
					const name = (data.subfolder ? data.subfolder + "/" + data.name : data.name) + " [input]";
					if (refUrlRef.current) URL.revokeObjectURL(refUrlRef.current);
					refUrlRef.current = URL.createObjectURL(file);
					setRefName(name);
					setRefNote("参考图已上传：" + (data.name ?? file.name) + "（生成时以它为底 img2img，宽/高输入自动忽略）");
				} catch (e) {
					setRefNote("");
					setError("参考图上传失败：" + String(e.message ?? e));
				} finally {
					setRefBusy(false);
				}
			}
			// 清除参考图：释放预览 blob 并复位状态（生成中禁用，见按钮 disabled）。
			function clearRef() {
				if (refUrlRef.current) { URL.revokeObjectURL(refUrlRef.current); refUrlRef.current = null; }
				setRefName(null);
				setRefNote("");
			}
			// 选择文件后先清 input.value：同一张图二次选择也能再次触发 onChange。
			function onRefPick(e) {
				const f = e.target.files && e.target.files[0];
				e.target.value = "";
				if (f) uploadRef(f);
			}

			// 配置 + system_stats 轮询 + WebSocket 进度
			useEffect(() => {
				let dead = false;
				// v0.9.2：原来这里是 .catch(() => {}) 静默吞掉——鉴权失效（重启后旧 token）时
				// 面板会「看着加载了却什么都不响应」（模型下拉空、生成按钮置灰、点击无反应）。
				// 现在 401/403 与其它失败都给出可辨识提示，绝不再静默。
				fetch("/comfy-panel/config")
					.then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
					.then((c) => { if (!dead) setComfy(c); })
					.catch((e) => {
						if (dead) return;
						const s = String(e?.message ?? e);
						setNote(/40[13]/.test(s)
							? "鉴权失败（" + s + "）：局域网模式需要令牌 —— 请用带 ?token= 的地址重开页面"
							: "无法读取面板配置（" + s + "）：请确认本程序的后端进程还在运行（启动窗口是否已被关闭）");
					});
				const poll = setInterval(async () => {
					try {
						const s = await api("/system_stats");
						if (!dead) { setOnline(true); setStats(s); }
					} catch { if (!dead) setOnline(false); }
				}, 2000);

				let ws = null;
				let retry = null;
				let opened = false;
				// final=true 表示 WS 已明确结束该 prompt；否则只有 history 进入终态才算结束。
				const finish = (promptId) => { if (!promptId || promptId === promptIdRef.current) collectOutputs(promptId, true); };
				// 采样预览帧：4B 事件类型 + 负载。
				//   1 = PREVIEW_IMAGE：4B 图像格式(1=JPEG,2=PNG) + 图像字节
				//   4 = PREVIEW_IMAGE_WITH_METADATA：4B 元数据长度 + JSON + 图像字节
				const handlePreviewFrame = (buf) => {
					if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8) return;
					const view = new DataView(buf);
					const eventType = view.getUint32(0);
					let mime = "image/jpeg";
					let start = 8;
					if (eventType === 4) {
						const metaLength = view.getUint32(4);
						if (buf.byteLength < 8 + metaLength) return;
						try {
							const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, metaLength)));
							if (typeof meta.image_type === "string") mime = meta.image_type;
						} catch {}
						start = 8 + metaLength;
					} else if (eventType === 1) {
						mime = view.getUint32(4) === 2 ? "image/png" : "image/jpeg";
					} else {
						return;
					}
					if (start >= buf.byteLength) return;
					showPreview(URL.createObjectURL(new Blob([new Uint8Array(buf, start)], { type: mime })));
				};
				const connect = () => {
					if (dead) return;
					opened = false;
					try {
						// 同源 relay：/comfy-panel/ws 由 host 半授权并裸 TCP 反代到 ComfyUI，
						// 顺手把 Origin 改写成 ComfyUI 自己的来源，绕开它的 origin 围栏。
						ws = new WebSocket(wsUrlFor(window.location.origin, CLIENT_ID));
						ws.binaryType = "arraybuffer";
						// ComfyUI 只在客户端声明支持后才推 PREVIEW_IMAGE_WITH_METADATA，
						// 且必须是本连接的第一条消息；重连时新 socket 要重新声明。
						ws.onopen = () => {
							opened = true;
							wsFailRef.current = 0;
							if (wsNoteShownRef.current) { wsNoteShownRef.current = false; setNote(""); }
							try { ws.send(JSON.stringify({ type: "feature_flags", data: { supports_preview_metadata: true } })); } catch {}
						};
						ws.onmessage = (e) => {
							if (typeof e.data !== "string") { handlePreviewFrame(e.data); return; }
							let m; try { m = JSON.parse(e.data); } catch { return; }
							if (m.type === "status") setQueue(m.data?.status?.exec_info?.queue_remaining ?? 0);
							else if (m.type === "progress") setProgress({ value: m.data?.value ?? 0, max: m.data?.max ?? 0 });
							else if (m.type === "executing") {
								if (m.data?.node === null) finish(m.data.prompt_id);
								else setNodeLabel(NODE_NAMES[m.data.node] ?? ("节点 " + m.data.node));
							}
							else if (m.type === "execution_error") {
								setError(withChannelHint(
									(m.data?.exception_message ?? "执行出错") + "\n节点: " + (m.data?.node_type ?? "?"),
									m.data?.node_type));
								if (promptIdRef.current) promptIdRef.current = null;
								resetRun();
							}
							else if (m.type === "execution_interrupted") {
								// 点「中止」后：归位 UI，不再等一帧永不到来的预览
								if (!m.data?.prompt_id || m.data.prompt_id === promptIdRef.current) {
									promptIdRef.current = null;
									resetRun();
									flashNote("已中止当前生成");
								}
							}
						};
						ws.onclose = () => {
							if (dead) return;
							if (!opened) {
								// 从没连上过：重连几次后给一条克制提示（只提示一次，连上即清）
								wsFailRef.current += 1;
								if (wsFailRef.current >= 3 && !wsNoteShownRef.current) {
									wsNoteShownRef.current = true;
									setNote("实时通道未连通：请确认本程序的后端进程仍在运行，然后刷新页面");
								}
							}
							retry = setTimeout(connect, 3000);
						};
					} catch {}
				};
				connect();
				return () => { dead = true; clearInterval(poll); if (retry) clearTimeout(retry); try { ws?.close(); } catch {} clearPreview(); };
			}, []);

			// resetRun 需要引用最新 state setter；effect 闭包里用不到旧值，
			// 但函数得在 effect 之外定义（函数声明提升即可）。
			function resetRun() {
				setRunning(false);
				clearPreview();
				setProgress({ value: 0, max: 0 });
				setNodeLabel("");
			}

			// 跳转 ComfyUI 原生界面用：comfy 是 state，重新渲染时自然是最新值。
			function comfyBase() { return comfy?.base ?? "http://127.0.0.1:8188"; }

			// object_info → 选中值的映射（首次装载与手动刷新共用同一条路径）。
			// current 为 null = 首次装载：每个槽位都取管线默认值（snapped 恒为 false）；
			// current 为当前 sel = 手动刷新：保留现有选择，被新清单/规则拒绝的槽位吸附回默认值，
			// 并返回「改了什么、为什么」的 note 列表。
			function applyObjectInfo(o, current) {
				const clipV = comboOf(o, "CLIPLoader")?.values;
				const vaeV = comboOf(o, "VAELoader")?.values;
				const plan = [
					["animaModel", snapChoice("anima", "model", comboOf(o, "Anima38BV2Loader")?.values, current?.animaModel)],
					["nativeClip", snapChoice("anima", "clip", clipV, current?.nativeClip)],
					["animaVae", snapChoice("anima", "vae", vaeV, current?.animaVae)],
					["qwenUnet", snapChoice("qwen", "model", comboOf(o, "UNETLoader")?.values, current?.qwenUnet)],
					["qwenClip", snapChoice("qwen", "clip", clipV, current?.qwenClip)],
					["qwenVae", snapChoice("qwen", "vae", vaeV, current?.qwenVae)],
					// v0.6：通用 Anima 路线的三个槽位（与 anima 管线共用编码器/VAE 规则，
					// 只是默认模型不同——它是 UNETLoader 里那些普通 Anima 权重）。
					["plainModel", snapChoice("animaPlain", "model", comboOf(o, "UNETLoader")?.values, current?.plainModel)],
					["plainClip", snapChoice("animaPlain", "clip", clipV, current?.plainClip)],
					["plainVae", snapChoice("animaPlain", "vae", vaeV, current?.plainVae)],
				];
				const next = {};
				const notes = [];
				for (const [key, r] of plan) {
					next[key] = r.value;
					if (r.snapped) notes.push(r.note);
				}
				// Qwen3.5 编码器由 AnimaQwen35Loader 单独提供（单值），沿用旧的 pick 口径。
				next.qwenEncoder = pick(comboOf(o, "AnimaQwen35Loader")?.values, current?.qwenEncoder || "qwen35_4b.safetensors");
				return { sel: next, notes };
			}

			// ── /object_info 的唯一入口：首次装载与手动「↻ 刷新模型」共用 ─────────────
			// FINDING 3（v0.6.0）：这两条路径原先各写一次 oi + sel，守卫却各管各的 ——
			// 首次装载 effect 只看 oi/online（没有在飞标志），手动刷新有 refreshBusyRef
			// 但首次装载不认它。于是「首次装载的响应在手动刷新落地之后才到」是可能的：
			// 那时它照旧执行 applyObjectInfo(o, null) + 全量 selSet，把首次默认值盖回
			// 用户刚被刷新吸附过的选择上；写回的值同样合法，自动吸附 effect 发现不了、
			// 没有 note、也没有任何办法解释。
			// 现在两条路径共用同一个在飞标志与同一个落地权序号（见 oiSeqRef 处的说明）：
			//   ① refreshBusyRef —— 在飞时再次触发一律 no-op，所以永远不存在两条
			//      /object_info 并发，「旧响应后到」结构上不可能；
			//   ② oiSeqRef     —— 起飞即领取落地权，响应回来只认「自己仍是最新」的那一条。
			// first=true：首次装载，模型/VAE/编码器一律走管线规则（含过滤 + 默认值），
			// 整份铺满 sel；first=false：手动刷新，以「此刻」的 selRef.current 为准，
			// 只改新清单确实拒绝的键。
			// isDead：调用方 effect 卸载/换依赖后作废本次结果。
			async function loadObjectInfo(first, isDead) {
				if (refreshBusyRef.current) return;   // 共用在飞标志：并发触发一律 no-op
				refreshBusyRef.current = true;
				const seq = ++oiSeqRef.current;       // 起飞即领取落地权
				try {
					const o = await api("/object_info");
					if (isDead && isDead()) return;
					if (seq !== oiSeqRef.current) return;   // 已被更新的请求取代：绝不回写
					const live = first ? null : selRef.current;
					const applied = applyObjectInfo(o, live);
					setOi(o);
					if (first) {
						// 不做 ad-hoc pick：首次装载的选中值天然就是兼容的。
						selSet(applied.sel);
					} else {
						// 只合并「新清单真的不接受」的键；用户飞行途中改过的合法值一个都不动。
						const fixed = {};
						for (const k of Object.keys(applied.sel)) {
							if ((live == null ? undefined : live[k]) !== applied.sel[k]) fixed[k] = applied.sel[k];
						}
						if (Object.keys(fixed).length) selSet((s) => ({ ...s, ...fixed }));
						flashNote(applied.notes.length
							? applied.notes.join("；")
							: "已重新读取 ComfyUI 模型清单，下拉已按当前管线重新过滤", 8000);
					}
				} catch (e) {
					// 首次装载失败不弹错：保持 oi 为空，等 online 翻转或用户手动刷新时重试。
					if (!first) setError("刷新模型清单失败：" + String(e.message ?? e));
				} finally {
					refreshBusyRef.current = false;
				}
			}

			// object_info 拉取（首次打开或从离线恢复时）
			useEffect(() => {
				if (oi || !online) return;
				let dead = false;
				loadObjectInfo(true, () => dead);
				return () => { dead = true; };
			}, [online, oi]);

			// ITEM 3：手动重新读取模型清单。/object_info 每个在线周期只拉一次，而
			// Anima38BV2Loader 的兜底名（Anima-3.8B-v2.safetensors）会随系统提交内存压力闪烁 ——
			// 内存一松，活清单里就又有真模型了，但面板上的旧下拉会一直挂到重开面板。
			// 这里重跑同一条 object_info 路径，并用当前选择走一遍吸附逻辑（改了什么、为什么写进 note）。
			//
			// FINDING 1（v0.5.1）：
			//   * refreshBusyRef —— 一次刷新在飞时再次激活直接 no-op，永远不会并发两条
			//     /object_info，也就不存在「两个响应乱序落地」；
			//   * apply 时读 selRef.current（此刻的选择）而不是点击那一刻闭包里的 sel，并且只写
			//     「新清单确实要改」的键：飞行途中用户改过、且新清单仍接受的选择原样保留，
			//     只有被新清单/管线规则真正拒绝的键才吸附回默认值并写 note。
			// v1.0.1：在资源管理器里打开本机 output 目录（图片都落在这里）。
			// 走本程序自己的 /app/open-folder（同源）；失败时明确提示，不静默。
			async function openOutputFolder() {
				try {
					const r = await fetch("/app/open-folder", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ which: "output" }),
					});
					const j = await r.json().catch(() => ({}));
					if (j && j.ok) flashNote("已打开图片文件夹：" + j.dir, 8000);
					else flashNote("打开文件夹失败：" + ((j && j.error) || ("HTTP " + r.status)), 8000);
				} catch (e) {
					flashNote("打开文件夹失败：" + String(e.message ?? e), 8000);
				}
			}

			async function refreshModels() {
				if (running) { flashNote("生成中，暂不能刷新模型清单", 3000); return; }
				if (!online) return;                        // 按钮同口径 disabled，这里再兜一层				// 其余守卫（在飞 no-op、只改被新清单拒绝的键、note、错误提示）全部在
				// loadObjectInfo 里，与首次装载共用同一份实现 —— 两条路径再也不会各写一遍、
				// 各守一半，也就不存在「首次装载的旧响应盖掉刷新结果」那条时序。
				await loadObjectInfo(false);
			}

			// 自动吸附：object_info 刷新、切换管线之后，state 里若有被当前管线规则拒绝的
			// 模型/VAE/编码器，立刻改回默认值并把「改了什么、为什么」写到 note 里。只在真的吸附时
			// 才 setSel，避免 effect 自激（吸附后重跑一次即返回）。
			useEffect(() => {
				if (!oi || !sel) return;
				const clipV = comboOf(oi, "CLIPLoader")?.values;
				const vaeV = comboOf(oi, "VAELoader")?.values;
				// v0.6：三条路线各有一套「模型/编码器/VAE」槽位，规则仍由 ruleFor(路线) 决定。
				// 通用 Anima 与 Qwen 路线的模型清单同出自 UNETLoader。
				const fields = [
					["model", ROUTE_MODEL_KEY[pipeline] ?? "animaModel",
						pipeline === "anima" ? comboOf(oi, "Anima38BV2Loader")?.values : comboOf(oi, "UNETLoader")?.values],
					["clip", ROUTE_CLIP_KEY[pipeline] ?? "nativeClip", clipV],
					["vae", ROUTE_VAE_KEY[pipeline] ?? "animaVae", vaeV],
				];
				const next = {};
				const notes = [];
				for (const [field, key, values] of fields) {
					const r = snapChoice(pipeline, field, values, sel[key]);
					if (r.snapped) { next[key] = r.value; notes.push(r.note); }
				}
				if (!notes.length) return;
				selSet((s) => ({ ...s, ...next }));
				flashNote(notes.join("；"), 8000);
			}, [oi, pipeline, sel]);

			// 首次上线时回收历史结果：面板关闭/刷新期间生成完成的图不会丢
			useEffect(() => {
				if (!online) return;
				let dead = false;
				api("/history?max_items=6").then((hist) => {
					if (dead || !hist) return;
					const found = [];
					for (const pid of Object.keys(hist)) {
						for (const nid of Object.keys(hist[pid]?.outputs ?? {})) {
							for (const img of hist[pid].outputs[nid]?.images ?? []) {
								if (img.type === "temp") continue;
								found.push({
									url: "/comfy-panel/api/view?filename=" + encodeURIComponent(img.filename)
										+ "&subfolder=" + encodeURIComponent(img.subfolder ?? "")
										+ "&type=" + encodeURIComponent(img.type ?? "output"),
									name: img.filename,
								});
							}
						}
					}
					if (found.length) {
						// history 顺序即后端返回顺序（新的在前）；只补缺，不覆盖已有顺序
						setImages((prev) => {
							const merged = [...prev];
							for (const f of found) if (!prev.some((p) => p.url === f.url)) merged.push(f);
							return merged.slice(0, 40);
						});
						setCurrent((cur) => cur ?? found[0]?.url ?? null);
					}
				}).catch(() => {});
				return () => { dead = true; };
			}, [online]);

			// 兜底：运行中每 4s 查一次 history。它只负责“收图”，不负责判定结束——
			// 否则 Anima 40 步（约 2 分钟）会在第 4 秒被这里 setRunning(false) 掐断，
			// 面板显示回“空闲”，而 ComfyUI 其实还在采样。
			useEffect(() => {
				if (!running) return;
				const t = setInterval(() => collectOutputs(promptIdRef.current, false), 4000);
				return () => clearInterval(t);
			}, [running]);

			// “已用”计时：生成中每秒重渲染一次，驱动图片窗口里的状态条。
			useEffect(() => {
				if (!running) return;
				const t = setInterval(() => setTick(Date.now()), 1000);
				return () => clearInterval(t);
			}, [running]);

			// v0.7：参考图（img2img）状态。【冒烟红线】这批 hook 必须整体追加在既有 hook 链
			// 最末尾——冒烟测试按数字索引给 useState 喂值，插进现有序列中间会让后续索引
			// 整体错位、[5]/[8] 断言大面积变红。
			const [refName, setRefName] = useState(null);     // LoadImage 取值："sub/name [input]"（t1 实测格式）
			const [refBusy, setRefBusy] = useState(false);    // 参考图上传中
			const [refDenoise, setRefDenoise] = useState(() => textOf(0.75)); // 重绘幅度（原始文本，失焦收敛）
			const [refNote, setRefNote] = useState("");
			const refUrlRef = useRef(null);                   // 参考图预览 blob URL（清除/卸载时 revoke）
			// 卸载时释放参考图预览 blob（模式同 previewUrlRef 的 clearPreview）
			useEffect(() => () => {
				if (refUrlRef.current) { URL.revokeObjectURL(refUrlRef.current); refUrlRef.current = null; }
			}, []);

			// v0.7：剪贴板「一键替换」状态。同样【冒烟红线】追加在 hook 链最末尾
			// （接在参考图那批 hook 之后），索引只增不移。
			const [pasteFallback, setPasteFallback] = useState(false); // 剪贴板 API 不可用 → 显示面板内粘贴框
			const [fallbackText, setFallbackText] = useState("");      // 降级粘贴框的原始文本

			// v0.8：画师（大随机/小随机/随机收藏/指定）+ 收藏列表 + 逐张生成进度。
			// 【冒烟红线】这批 hook 整体追加在链尾，顺序只增不移。
			// v1.0.1：默认画师模式改为「大随机」（用户要求）——随机档能覆盖全部画师清单；
			// 清单缺失时下面会给出说明并自动回落到不注入，不会让生成失败。
			const [artistMode, setArtistMode] = useState("randomBig");   // off | randomBig | randomSmall | randomFav | fixed
			const [artistList, setArtistList] = useState(null);    // { all:[...], top:[...] }；{ failed:true } = 清单不可用
			const [artistQuery, setArtistQuery] = useState("");    // 搜索词（仅查询用，永远不会直接成为画师）
			const [artistDropOpen, setArtistDropOpen] = useState(false);
			const [artistFixed, setArtistFixed] = useState(null);  // 指定模式选中的画师 tag（原始形态，含 @ 与转义）
			const [artistFavs, setArtistFavs] = useState(() => loadFavorites()); // 收藏画师（localStorage）
			const [runProgress, setRunProgress] = useState(null);  // { i, n } 逐张生成进度
			const artistListFetchRef = useRef(false);   // 画师清单在飞标志（失败复位，下次进非 off 模式重试）
			const runAbortRef = useRef(false);          // 「中止」置位：逐张循环在下一张提交前停
			const runActiveRef = useRef(false);         // 逐张运行中：collectOutputs 不抢 resetRun（循环负责收尾）
			const artistByPromptRef = useRef(new Map()); // prompt_id → 画师 tag（预览「收藏该画师」用）

			// v1.0.0（独立版）新增 hook，整体追加在 hook 链最末尾（红线：索引只增不移）。
			const [artistBlacklist, setArtistBlacklist] = useState(() => loadBlacklist()); // 黑名单（服务端持久化）
			const [artistFavOnly, setArtistFavOnly] = useState(false);   // 指定模式：检索范围切为「仅收藏」
			const [artistCustom, setArtistCustom] = useState("");        // 自定义画师输入原文（格式规范化后可用）

			// v1.0.0：画师数据以服务端为准；画师管理页改了数据会广播事件，这里同步回面板 state。
			useEffect(() => {
				const onChanged = () => { setArtistFavs(loadFavorites()); setArtistBlacklist(loadBlacklist()); };
				window.addEventListener("dcp-artists-changed", onChanged);
				return () => window.removeEventListener("dcp-artists-changed", onChanged);
			}, []);

			// v1.0.0：跨页面能力（LLM 页「一键填入」→ 面板正向/负向输入框）。
			// 每次渲染刷新闭包，保证拿到最新的 setPositive/setNegative/generate 与当前值。
			useEffect(() => {
				const api = {
					setPrompts: ({ positive: p, negative: n } = {}) => {
						let n1 = 0;
						if (typeof p === "string") { setPositive(p); n1++; }
						if (typeof n === "string") { setNegative(n); n1++; }
						return n1;
					},
					getPrompts: () => ({ positive, negative }),
					generate: () => { if (!running && sel && positive.trim()) { generate(); return true; } return false; },
					mode: () => artistMode,
					setArtistMode: (m) => setArtistMode(m),
					setArtistFixed: (tag) => setArtistFixed(tag),
				};
				PANEL_API.current = api;
				if (typeof window !== "undefined") window.__DCP_PANEL_API__ = api;
				return () => { if (PANEL_API.current === api) PANEL_API.current = null; };
			});

			// v0.8：画师清单懒加载（host 半 /comfy-panel/artists）。只在非 off 模式且尚未拿到
			// 清单时拉。失败记 { failed:true } 但**不复位**在飞标志（否则 failed 态会让 effect
			// 无限重拉）；切回 off 时复位，下次再进非 off 模式时重试一次。
			useEffect(() => {
				if (artistMode === "off") { artistListFetchRef.current = false; return; }
				if (artistList && !artistList.failed) return;
				if (artistListFetchRef.current) return;
				artistListFetchRef.current = true;
				let dead = false;
				fetch("/comfy-panel/artists").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
					.then((d) => {
						if (dead) return;
						if (d && Array.isArray(d.all) && Array.isArray(d.top) && d.all.length && d.top.length) {
							setArtistList({ all: d.all, top: d.top });
						} else {
							setArtistList((cur) => (cur && cur.failed ? cur : { all: [], top: [], failed: true }));
						}
					})
					.catch((e) => {
						if (dead) return;
						// v0.9.2：鉴权失效要显式说出来，不能只记「清单不可用」。
						const s = String(e?.message ?? e);
						if (/40[13]/.test(s)) {
							setNote("鉴权失败（" + s + "）：局域网模式需要令牌 —— 请用带 ?token= 的地址重开页面");
						}
						setArtistList((cur) => (cur && cur.failed ? cur : { all: [], top: [], failed: true }));
					});
				return () => { dead = true; };
			}, [artistMode, artistList]);

			// 收藏变化即持久化（loadFavorites 的写回对偶）
			useEffect(() => { saveFavorites(artistFavs); }, [artistFavs]);

			// final=true 表示 WS 已明确结束该 prompt；否则只有 history 进入终态才算结束。
			async function collectOutputs(promptId, final) {
				if (!promptId) return;
				let terminal = !!final;
				let found = [];
				try {
					const hist = await api("/history/" + encodeURIComponent(promptId));
					const entry = hist?.[promptId];
					const status = entry?.status?.status_str;
					if (status === "success" || status === "error") terminal = true;
					for (const nid of Object.keys(entry?.outputs ?? {})) {
						for (const img of entry.outputs[nid]?.images ?? []) {
							if (img.type === "temp") continue;
							found.push({
								// 隐私：图片 <img> 也走 DSH 鉴权代理（同源、带签名 cookie），
								// 不再直连未鉴权的 http://127.0.0.1:8188/view。
								url: "/comfy-panel/api/view?filename=" + encodeURIComponent(img.filename)
									+ "&subfolder=" + encodeURIComponent(img.subfolder ?? "")
									+ "&type=" + encodeURIComponent(img.type ?? "output"),
								name: img.filename,
								// v0.8：这张图生成时注入的画师 tag（预览「收藏该画师」用；历史回收的图没有）
								artist: artistByPromptRef.current.get(promptId) ?? null,
							});
						}
					}
					if (found.length) {
						setImages((prev) => [...found, ...prev.filter((p) => !found.some((f) => f.url === p.url))].slice(0, 40));
						// 主图窗口永远跟着最新结果走（原来写的是 cur ?? found[0]，第一次之后就再也不换了）。
						setCurrent(found[0].url);
					}
					if (status === "error") {
						const ev = (entry?.status?.messages ?? []).find((m) => m[0] === "execution_error");
						setError((cur) => cur || withChannelHint(
							(ev?.[1]?.exception_message ?? "执行出错") + "\n节点: " + (ev?.[1]?.node_type ?? "?"),
							ev?.[1]?.node_type));
					}
				} catch {}
				// WS 说结束了但 history 还没写好（竞态）：短暂延迟后再收一次，
				// 最多重试 4 次，避免「跑完了图却不显示」。
				if (terminal && !found.length && histRetryRef.current < 4) {
					histRetryRef.current += 1;
					setTimeout(() => collectOutputs(promptId, true), 1500);
					return;
				}
				if (!terminal) return;
				histRetryRef.current = 0;
				// v0.8：逐张循环运行中——收图不收尾（running/进度条由循环持有），
				// resetRun 与 promptIdRef 清理由循环的 finally 统一做，避免中途闪「空闲」。
				if (runActiveRef.current) return;
				if (promptIdRef.current === promptId) promptIdRef.current = null;
				resetRun();
			}

			// 当前路线已选的模型：优先该路线自己的槽位，旧 state 还没写进去时回落默认值。
			function modelForRoute(route, s) {
				return s?.[ROUTE_MODEL_KEY[route] ?? "animaModel"] || PIPELINE_RULES[route].defaultModel;
			}

			function switchPipeline(next) {
				if (next === pipeline) return;
				if (running) { flashNote("生成中，暂不能切换管线", 3000); return; }
				if (online) unloadModels(false, true);
				setPipeline(next);
				const d = defaultsFor(next, modelForRoute(next, selRef.current));
				setSize(d.size.map(textOf)); setSteps(textOf(d.steps)); setCfg(textOf(d.cfg));   // 不重置正/负向提示词与画师设置（用户要求：切模型只换参数）
			}

			// v0.6 主选择器：模型是主选择，改它即重新派生管线 + CLIPLoader.type + 条件节点 +
			// 编码器 + VAE + 推荐参数，并把「配了什么、为什么」写进 note。
			function changePrimaryModel(value) {
				if (running) { flashNote("生成中，暂不能换模型", 3000); return; }
				const v = String(value ?? "");
				const route = routeFor(v, comboOf(oi, "Anima38BV2Loader")?.values);
				const d = defaultsFor(route, v);
				selSet((s) => ({ ...s, ...pairingFor(route, v) }));
				if (route !== pipeline) setPipeline(route);
				setSize(d.size.map(textOf)); setSteps(textOf(d.steps)); setCfg(textOf(d.cfg));   // 不重置正/负向提示词与画师设置（用户要求：切模型只换参数）
				unloadModels(false, true);
				flashNote(pairingNote(route, v), 9000);
			}

			async function unloadModels(full, quiet) {
				if (running) { flashNote("生成中，暂不释放显存", 4000); return; }
				try {
					await api("/free", { method: "POST", body: JSON.stringify({ unload_models: true, free_memory: !!full }) });
					if (!quiet) {
						flashNote(full ? "已请求卸载模型并释放显存缓存" : "已请求卸载旧模型，下次生图将加载新模型");
					}
				} catch (e) { setError(String(e.message ?? e)); }
			}

			function changeModel(field, value) {
				if (running) { flashNote("生成中，暂不能换模型", 3000); return; }
				selSet((s) => ({ ...s, [field]: value }));
				if (field === "animaModel" || field === "qwenUnet" || field === "plainModel") unloadModels(false);
			}

			async function launch() {
				setError(""); setNote("正在启动 ComfyUI…");
				try {
					const r = await fetch("/comfy-panel/launch", { method: "POST" }).then((x) => x.json());
					setNote(r.online ? "ComfyUI 已在运行" : r.launched ? "已拉起 ComfyUI，正在加载…约 10-30 秒后自动上线" : "启动异常: " + JSON.stringify(r));
				} catch (e) { setError(String(e.message ?? e)); setNote(""); }
			}

			// 一键填入统一生图测试提示词（黑白色斑点小狗 + 草地背景），并复位推荐参数
			function fillTest() {
				if (running) return;
				setPositive(TEST_PROMPTS[pipeline] ?? TEST_PROMPTS.anima);
				const d = defaultsFor(pipeline, modelForRoute(pipeline, selRef.current));
				setSize(d.size.map(textOf)); setSteps(textOf(d.steps)); setCfg(textOf(d.cfg));   // 不重置正/负向提示词与画师设置（用户要求：切模型只换参数）
				setBatch(1); setRandomSeed(true);
				setError("");
				flashNote("已填入统一测试提示词：黑白色斑点小狗 · 草地背景（参数已复位）");
			}

			// v0.7：剪贴板「一键替换」。handlePasteText 是纯应用逻辑（降级粘贴框共用）；
			// applyClipboard 走 navigator.clipboard，失败（无权限/非安全上下文）时打开降级粘贴框。
			function handlePasteText(text) {
				const r = parsePromptClipboard(text);
				if (r === null) { flashNote("剪贴板是空的"); return; }
				if (r.positive !== null) setPositive(r.positive);
				if (r.negative !== null) setNegative(r.negative);
				flashNote(r.summary);
			}
			async function applyClipboard() {
				if (running) return;
				try {
					const text = await navigator.clipboard.readText();
					handlePasteText(text);
				} catch {
					setPasteFallback(true);
				}
			}

			// v0.8：等待单张完成。轮询 /history/{id}：success → true；error → 取 execution_error
			// 人话提示（与 collectOutputs 同一份 shaping）后返回 false；「中止」置位 → false。
			// 等待期间不动 running/promptIdRef——WS 进度与实时预览照常工作，收尾归逐张循环。
			async function waitHistory(promptId, timeoutMs) {
				const deadline = Date.now() + timeoutMs;
				while (Date.now() < deadline) {
					if (runAbortRef.current) return false;
					await new Promise((res) => setTimeout(res, 1500));
					if (runAbortRef.current) return false;
					try {
						const hist = await api("/history/" + encodeURIComponent(promptId));
						const entry = hist?.[promptId];
						const status = entry?.status?.status_str;
						if (status === "success") return true;
						if (status === "error") {
							const ev = (entry?.status?.messages ?? []).find((m) => m[0] === "execution_error");
							setError(withChannelHint(
								(ev?.[1]?.exception_message ?? "执行出错") + "\n节点: " + (ev?.[1]?.node_type ?? "?"),
								ev?.[1]?.node_type));
							return false;
						}
					} catch {}
				}
				setError("等待超时：单张超过 20 分钟未完成，已停止后续张数");
				return false;
			}

			// v0.8：逐张生成。多张不再作为一次 ComfyUI batch 提交，而是同一组参数逐张
			// 提交/等待/收图——每张独立画师与独立种子，并按「模型文件夹/画师_序号」落盘
			// （savePrefix → SaveImage.filename_prefix；无画师记 noartist_序号）。
			async function generate() {
				setError(""); setNote("");
				if (!sel || !positive.trim()) return;
				// 硬闸门：已知不兼容的模型+VAE+文本编码器（或 Anima 未就绪）绝不再静默 POST ——
				// 那种图只会在 VAEDecode 的通道数校验、或文本编码器的维度校验里炸出一句看不懂的
				// 报错。这里当场点名是哪个文件、为什么，并说明它会死在哪个阶段。
				const modelFile = pipeline === "anima" ? sel.animaModel
					: pipeline === "animaPlain" ? sel.plainModel : sel.qwenUnet;
				const vaeFile = pipeline === "anima" ? sel.animaVae
					: pipeline === "animaPlain" ? sel.plainVae : sel.qwenVae;
				const clipFile = pipeline === "anima" ? sel.nativeClip
					: pipeline === "animaPlain" ? sel.plainClip : sel.qwenClip;
				// v0.6：先看点中的权重本身此刻可不可加载（清单里没有 / 是 v2 兜底名），
				// 再走管线规则闸门。两者都是「点名文件 + 说明原因」，绝不静默提交。
				const unusable = unusableReason(modelFile, comboOf(oi, "Anima38BV2Loader")?.values, comboOf(oi, "UNETLoader")?.values);
				const block = unusable || preSubmitBlock(pipeline, modelFile, vaeFile, comboOf(oi, "Anima38BV2Loader")?.values, clipFile);
				if (block) { setError("已阻止提交：" + block + "\n" + selectionLine(modelFile, vaeFile, clipFile)); return; }
				// v0.7：参考图（img2img）。当前模型/管线不支持（object_info 缺 LoadImage/VAEEncode
				// 节点或未选 VAE）时参考图自动无效：不携带参考图字段、按纯文生图生成，并说明原因。
				const refOk = refSupport(oi, vaeFile).supported;
				const ref = refName && !refBusy && refOk ? refName : null;
				if (refName && !refBusy && !refOk) flashNote("当前模型/管线不支持参考图，已自动忽略，按纯文生图生成");
				// v0.8：画师逐张解析。qwen 管线没有画师库（refSupport 同款「自动无效」姿态）：
				// 不注入 tag、文件名按 noartist 记，并在开始前提示一次原因。
				const animaLike = pipeline === "anima" || pipeline === "animaPlain";
				const total = clampInt(batch, 1, 20, 1);
				const baseSeedVal = randomSeed ? Math.floor(Math.random() * 281474976710656) : commitNum(seed, 0, 281474976710655, 0, true);
				const [w, hh] = snapSize(commitSize(size[0], 832), commitSize(size[1], 1216));
				const defs = defaultsFor(pipeline, modelFile);
				const stepsCommit = commitNum(steps, 1, 100, defs.steps, true);
				const cfgCommit = commitNum(cfg, 0.1, 30, defs.cfg, false);
				const modeLabel = { randomBig: "大随机（全部画师池）", randomSmall: "小随机（前 200 高频）", randomFav: "随机收藏", fixed: "指定画师" };
				// v1.0.0（独立版）：resolveTag 在三档随机里**剔除黑名单**；指定模式直接放行
				// artistFixed（它可能是清单内 tag，也可能是用户自定义的 @名字）。
				const resolveTag = () => {
					if (!animaLike || artistMode === "off") return null;
					if (artistMode === "fixed") return artistFixed || null;
					if (artistMode === "randomFav") {
						const favPool = withoutBlacklisted(artistFavs);
						return favPool.length ? pickRandomArtist(favPool) : null;
					}
					const pool = artistList && !artistList.failed
						? withoutBlacklisted(artistMode === "randomSmall" ? artistList.top : artistList.all)
						: null;
					return pool && pool.length ? pickRandomArtist(pool) : null;
				};
				const favPoolSize = withoutBlacklisted(artistFavs).length;
				if (!animaLike && artistMode !== "off") {
					flashNote("画师风格仅对 Anima 系列模型有效：Qwen-Image 2.1 本次不注入画师标签，文件名按 noartist 记", 8000);
				} else if ((artistMode === "randomBig" || artistMode === "randomSmall") && (!artistList || artistList.failed)) {
					flashNote("画师清单未加载，本次不注入画师（文件名按 noartist 记）", 6000);
				} else if (artistMode === "randomFav" && !favPoolSize) {
					flashNote(artistFavs.length
						? "收藏里的画师都被拉黑了，本次不注入画师（可在画师页取消拉黑）"
						: "收藏列表为空，本次不注入画师（可在搜索列表点 ★ 收藏）", 6000);
				} else if (artistMode !== "off") {
					const sampleTag = resolveTag();
					flashNote((modeLabel[artistMode] ?? "画师") + (sampleTag ? "：" + sampleTag : "")
						+ "：共 " + total + " 张逐张生成，每张独立取画师与种子，仅对 Anima 系列生效", 8000);
				}
				runActiveRef.current = true;
				runAbortRef.current = false;
				setRunning(true);
				clearPreview();
				setStartedAt(Date.now());
				setTick(Date.now());
				let done = 0;
				let lastSeed = baseSeedVal;
				try {
					for (let i = 1; i <= total; i++) {
						if (runAbortRef.current) break;
						const tag = resolveTag();
						const posFinal = withArtistTag(positive, tag).text;
						const prefix = savePrefixFor(modelFile, tag, i);
						const seedVal = randomSeed ? Math.floor(Math.random() * 281474976710656) : (baseSeedVal + i - 1) % 281474976710656;
						lastSeed = seedVal;
						setRunProgress({ i, n: total });
						setProgress({ value: 0, max: stepsCommit });
						const common = {
							positive: posFinal, negative, width: w, height: hh,
							steps: stepsCommit, cfg: cfgCommit, batch: 1, seed: seedVal,
							// 未用参考图时不携带 denoise/refScale：三条管线的图与旧行为逐字节一致
							...(ref ? {
								refImage: ref,
								denoise: commitNum(refDenoise, 0.05, 1, 0.75, false),
								refScale: !!oi?.ImageScaleToTotalPixels,
							} : {}),
						};
						const graph = pipeline === "anima"
							? animaGraph({
								...common, negative,
								unet: sel.animaModel, qwenEncoder: sel.qwenEncoder, nativeClip: sel.nativeClip, vae: sel.animaVae,
								savePrefix: prefix,
							}, comboOf(oi, "Anima38BV2Loader")?.key ?? "unet_name", comboOf(oi, "AnimaQwen35Loader")?.key ?? "clip_name")
							: pipeline === "animaPlain"
								? animaPlainGraph({ ...common, unet: sel.plainModel, clip: sel.plainClip, vae: sel.plainVae, savePrefix: prefix })
								: qwenGraph({ ...common, unet: sel.qwenUnet, clip: sel.qwenClip, vae: sel.qwenVae, savePrefix: prefix });
						// preview_method 覆盖 ComfyUI 的 CLI 默认值（默认 none）：逐任务生效。
						const r = await api("/prompt", {
							method: "POST",
							body: JSON.stringify({ prompt: graph, client_id: CLIENT_ID, extra_data: { preview_method: "auto" } }),
						});
						if (r.node_errors && Object.keys(r.node_errors).length) {
							setError("工作流校验失败: " + JSON.stringify(r.node_errors).slice(0, 400));
							break;
						}
						promptIdRef.current = r.prompt_id;
						histRetryRef.current = 0;
						artistByPromptRef.current.set(r.prompt_id, tag);
						const ok = await waitHistory(r.prompt_id, 20 * 60 * 1000);
						if (!ok) break;
						done = i;
					}
				} catch (e) {
					setError(String(e.message ?? e));
				} finally {
					runActiveRef.current = false;
					setRunProgress(null);
					resetRun();
					if (!randomSeed) setSeed(textOf(lastSeed));
					flashNote(done >= total
						? "已逐张完成 " + done + "/" + total + " 张"
						: "本次完成 " + done + "/" + total + " 张（已中止或出错停止）");
				}
			}

			const animaM = comboOf(oi, "Anima38BV2Loader");
			const animaQ = comboOf(oi, "AnimaQwen35Loader");
			const clipL = comboOf(oi, "CLIPLoader");
			const vaeL = comboOf(oi, "VAELoader");
			const unetL = comboOf(oi, "UNETLoader");
			// 模型/VAE/编码器下拉按当前管线过滤（筛空则回退全量，见 choiceList）。
			// 两条管线的编码器槽位共用 CLIPLoader.clip_name（同一份全量清单），过滤依据是
			// 各自管线要求的嵌入维度，所以两边必须分别取一次。
			// v0.6：主模型下拉不再过滤 —— 它是「唯一一份扩散模型清单」（两份 loader 的并集），
			// 这正是本次修复的目标：5 份权重全部可达。VAE/编码器下拉仍按路线过滤。
			const modelOptions = modelCatalog(animaM?.values, unetL?.values);
			const animaClipOptions = choiceList("anima", "clip", clipL?.values);
			const animaVaeOptions = choiceList("anima", "vae", vaeL?.values);
			const plainClipOptions = choiceList("animaPlain", "clip", clipL?.values);
			const plainVaeOptions = choiceList("animaPlain", "vae", vaeL?.values);
			const qwenClipOptions = choiceList("qwen", "clip", clipL?.values);
			const qwenVaeOptions = choiceList("qwen", "vae", vaeL?.values);
			const animaNotReady = !animaModelsReady(animaM?.values);
			// 生成按钮的禁用原因：模型/VAE/编码器组合被闸门拦下时，tooltip 直接给出原因（点名的
			// 文件 + 通道数/维度），而不是一句没用的「开始生成」。
			const curModel = pipeline === "anima" ? sel?.animaModel
				: pipeline === "animaPlain" ? sel?.plainModel : sel?.qwenUnet;
			const curVae = pipeline === "anima" ? sel?.animaVae
				: pipeline === "animaPlain" ? sel?.plainVae : sel?.qwenVae;
			const curClip = pipeline === "anima" ? sel?.nativeClip
				: pipeline === "animaPlain" ? sel?.plainClip : sel?.qwenClip;
			// v0.7：当前管线对参考图（img2img）的支持性 —— 说明行直接给结论或原因。
			const refState = refSupport(oi, curVae);
			// v0.8：预览图所属画师（逐张生成时由 prompt_id → 画师 映射带出）+ 指定模式的搜索派生值。
			// 只做渲染派生，不新增 hook。artistExact 是「查询词精确命中清单 tag」的原始 tag
			// （归一化 = 去转义反斜杠 + 小写），用于快捷收藏行；命中不了就不显示，绝不放行清单外名字。
			// v1.0.0：黑名单集合先算（下面多处派生都要用；面板的 const 在同一函数作用域里，
			// 出现在使用点之前才不会踩 TDZ）。
			const artistBlackSet = new Set(artistBlacklist);
			// v1.0.0：当前图的画师 tag —— 优先取生成元数据（artistByPromptRef），
			// 没有元数据时回落到**落盘文件名**（<模型文件夹>/<画师>_<序号>_00001_.png）。
			// 无论该画师是否已收藏，都显示出来（图上三按钮因此对所有历史图同样可用）。
			const curImage = images.find((im) => im.url === current) ?? null;
			const artistFromName = (im) => {
				if (!im) return null;
				const m = String(im.name ?? im.url ?? "").match(/([^/\\]+)_(\d+)_\d+_\.png$/i);
				if (!m) return null;
				const part = m[1];
				return /^noartist$/i.test(part) ? null : "@" + part.replace(/_/g, " ");
			};
			const curArtist = curImage ? ((curImage.artist ?? null) || artistFromName(curImage)) : null;
			const curArtistFaved = !!curArtist && artistFavs.includes(curArtist);
			const curArtistBlocked = !!curArtist && artistBlackSet.has(curArtist);
			// v1.0.0（独立版）：指定模式的检索范围可切为「仅收藏」（复用同一套前端过滤，只换池子）；
			// 黑名单画师在指定模式仍可搜到，但会打上「已拉黑」标记（可手动取消）。
			const artistPool = artistFavOnly ? artistFavs : (artistList && !artistList.failed ? artistList.all : []);
			const artistHits = (artistFavOnly || (artistList && !artistList.failed)) ? filterArtists(artistPool, artistQuery, 50) : [];
			const artistCustomTag = normalizeCustomArtist(artistCustom);
			const artistExact = (() => {
				const q = artistQuery.replace(/\\/g, "").trim().toLowerCase();
				if (!q) return null;
				return artistPool.find((t) => String(t).replace(/\\/g, "").toLowerCase() === q) ?? null;
			})();
			// v1.0.0：自定义画师「输入即可用」——不弹清单外警告、不做二次确认（有意放宽原红线）。
			const useCustomArtist = (tag) => {
				const t = tag || artistCustomTag;
				if (!t) return;
				setArtistMode("fixed");
				setArtistFixed(t);
				setArtistCustom("");
				setArtistDropOpen(false);
				flashNote("已使用自定义画师 " + t + "（不校验清单；可收藏，收藏后进入收藏列表与「仅收藏」检索）");
			};
			// v0.6：先把「这份权重本身此刻能不能加载」说清楚，再谈组合兼容性。
			const curUnusable = unusableReason(curModel, animaM?.values, unetL?.values);
			// 当前路线的图形态（条件节点 / CLIPLoader.type / 采样器 / 空潜空间来源）
			const shape = ROUTE_SHAPE[pipeline] ?? ROUTE_SHAPE.anima;
			// 负向提示词只有 CFG>1 才起作用（qwen 与 turbo 的推荐 CFG 都是 1）
			const negHint = defaultsFor(pipeline, curModel).cfg === 1 ? "（CFG=1 时不生效）" : "";
			const gateReason = pipeline === "anima" && !(animaM && animaQ) ? "缺少 Anima 节点：未找到 Anima38BV2Loader / AnimaQwen35Loader"
				: (pipeline === "qwen" || pipeline === "animaPlain") && !unetL ? "缺少 UNETLoader 节点"
				: curUnusable ? curUnusable
				: preSubmitBlock(pipeline, curModel, curVae, animaM?.values, curClip) ?? "";
			const genBlock = !online ? "ComfyUI 离线，请先点「启动」"
				: !sel ? "正在读取模型清单…"
				: !positive.trim() ? "请输入正向提示词，或点「🧪 测试图」填入统一测试提示词"
				: gateReason ? "已阻止提交：" + gateReason + "（" + selectionLine(curModel, curVae, curClip) + "）"
				: "";
			const canGen = online && !!sel && !running && positive.trim() !== "" && !genBlock;
			const genTitle = running ? "正在生成中…" : (genBlock || "开始生成（一次多张时逐张提交，每张独立随机画师与种子）");
			const dev = stats?.devices?.[0];
			const barW = progress.max > 0 ? Math.min(100, (progress.value / progress.max) * 100) : 0;
			// 百分比取两位小数：23/40 直接乘会得到 57.49999999999999 这种脏字符串
			const pct = (v) => Number((v).toFixed(2)) + "%";
			// 图片窗口里的实时状态：优先显示采样步数，其次当前节点，再退到排队/装载。
			const liveStatus = !online
				? "ComfyUI 离线"
				: progress.max > 0
					? (nodeLabel ? nodeLabel + " · " : "") + "采样 " + progress.value + "/" + progress.max
					: nodeLabel ? nodeLabel + "…"
						: queue > 0 ? "排队中（前面还有 " + queue + " 个）" : "正在载入模型 / 准备采样…";
			const elapsedSec = startedAt ? Math.max(0, Math.round(((tick || Date.now()) - startedAt) / 1000)) : 0;
			const elapsedText = "已用 " + String(Math.floor(elapsedSec / 60)).padStart(2, "0") + ":" + String(elapsedSec % 60).padStart(2, "0");

			return h("div", { className: "dcp-panel" + (embed ? " dcp-embedded" : "") + " dcp-layout-" + (layoutProp || "3") },
				h("div", { className: "dcp-head" },
					h("span", { title: "面板构建 " + BUILD_TAG + "；独立版为静态托管，改前端代码刷新页面即生效" }, "🎨 超低门槛 ComfyUI 工作流集成应用 " + BUILD_TAG),
					h("span", { className: "dcp-dot " + (online ? "dcp-dot-on" : "dcp-dot-off") }),
					h("span", { className: "dcp-muted" }, online ? "在线" : "离线"),
					h("span", { className: "sp" }),
					h("button", { className: "dcp-btn ghost", title: "在新标签页打开 ComfyUI 原生界面（" + (comfy?.base ?? "http://127.0.0.1:8188") + "）", onClick: () => window.open(comfyBase(), "_blank", "noopener") }, "跳转 ComfyUI ↗"),
					h("button", { className: "dcp-btn ghost", onClick: onClose }, "关闭"),
				),
				h("div", { className: "dcp-body dcp-body-3col" },
					// v1.0.1：主体三栏（视觉顺序 生图设置 1 : 提示词 1 : 图片 2）。
					// DOM 顺序仍是「图片 → 提示词 → 设置」，视觉顺序由 CSS 的 order 决定 ——
					// 这样不用把几百行 JSX 搬来搬去，列宽与顺序都只改样式。
					h("div", { className: "dcp-col dcp-col-img" },
						h("div", { className: "dcp-col-head" }, "🖼 图片"),
						h("div", { className: "dcp-sec" }, "图片窗口"),
					h("div", { className: "dcp-view" },
						// 生成中优先显示采样实时预览帧，跑完回到落盘的最终图
						running && preview
							? h("img", { className: "dcp-img live", src: preview, alt: "实时预览" })
							: current
								? h("img", { className: "dcp-img", src: current, title: "点击在新标签页打开原图", onClick: () => window.open(current, "_blank", "noopener") })
								: null,
						running && h("div", { className: "dcp-live" },
							h("span", { className: "dcp-live-tag" + (preview ? " on" : "") }, preview ? "实时预览" : "生成中"),
							h("span", null, (runProgress ? "第 " + runProgress.i + "/" + runProgress.n + " 张 · " : "") + liveStatus),
							h("span", { className: "sp" }),
							h("span", null, elapsedText),
						),
						running && h("div", { className: "dcp-live-bar" }, h("i", { style: { width: pct(barW) } })),
						!running && !current && h("div", { className: "dcp-empty" }, online ? "点击「生成」后在这里实时显示采样进度与成图" : "启动 ComfyUI 后开始生图"),
						running && !preview && !current && h("div", { className: "dcp-empty" }, online ? "等待首帧实时预览…" : "ComfyUI 离线"),
					),
					images.length > 1 && h("div", { className: "dcp-thumbs" },
						images.map((im) => h("img", { key: im.url, src: im.url, className: "dcp-thumb" + (im.url === current ? " cur" : ""), title: im.name, onClick: () => setCurrent(im.url) }))),
					// v1.0.1：历史图片放大显示 + 一键跳到图片文件夹（用户要求）
					h("div", { className: "row tight", style: { marginTop: 4 } },
						h("span", { className: "dcp-muted" }, "历史 " + images.length + " 张"),
						h("span", { className: "sp" }),
						h("button", {
							className: "dcp-btn ghost", style: { padding: "2px 8px", fontSize: 11 },
							title: "在资源管理器里打开本机 output 目录（成图都写在这里）",
							onClick: openOutputFolder,
						}, "📂 跳转到图片文件夹")),
					// v1.0.0（独立版）F4：图上画师三按钮 —— ⭐ 收藏/取消收藏、🎯 选为画师、🚫 拉黑/取消拉黑。
					// 画师 tag 一律显示（不论是否已收藏）；「选为画师」= 切到指定模式并固定该画师，
					// 效果等同搜索点选；「拉黑」写黑名单（三档随机全部剔除，指定模式仍可搜到并标注）。
					!running && curArtist && h("div", { className: "dcp-secrow", style: { gap: 6 } },
						h("span", { className: "dcp-artist-chip", title: "该图使用的画师 tag（来自生成元数据或落盘文件名）" },
							h("span", null, "画师：" + curArtist),
							curArtistBlocked ? h("span", { title: "已拉黑：不会出现在任何随机档" }, "🚫") : null,
						),
						h("button", {
							className: "dcp-btn ghost", style: { padding: "2px 8px", fontSize: 11 },
							title: curArtistFaved ? "从收藏列表移除该画师" : "把该画师加入收藏列表，之后可用「★ 随机收藏」",
							onClick: () => {
								const next = toggleFavExclusive(curArtist);
								setArtistFavs(next.favs);
								setArtistBlacklist(next.blacklist);
								flashNote(curArtistFaved ? "已取消收藏：" + curArtist : "已收藏画师 " + curArtist + "，可在画师区用「★ 随机收藏」");
							},
						}, (curArtistFaved ? "⭐ 取消收藏" : "⭐ 收藏") + "：" + curArtist),
						h("button", {
							className: "dcp-btn ghost", style: { padding: "2px 8px", fontSize: 11 },
							title: "切换到「指定画师」模式并固定使用该画师（等同在搜索列表点选）",
							onClick: () => { setArtistMode("fixed"); setArtistFixed(curArtist); setArtistFavOnly(false); flashNote("已选为画师：" + curArtist + "（指定模式，本次固定使用）"); },
						}, "🎯 选为画师"),
						h("button", {
							className: "dcp-btn ghost", style: { padding: "2px 8px", fontSize: 11 },
							title: curArtistBlocked ? "取消拉黑：该画师重新回到随机档候选池" : "拉黑：该画师在全部随机档（大随机/小随机/随机收藏）中被剔除",
							onClick: () => {
								const next = toggleBlacklistExclusive(curArtist);
								setArtistFavs(next.favs);
								setArtistBlacklist(next.blacklist);
								flashNote(curArtistBlocked ? "已取消拉黑：" + curArtist : "已拉黑画师 " + curArtist + "（三档随机均不再出现；收藏与拉黑互斥）");
							},
						}, curArtistBlocked ? "🚫 取消拉黑" : "🚫 拉黑"),
					),
					!online && h("button", { className: "dcp-btn", onClick: launch }, "启动 ComfyUI"),
					online && h("button", { className: "dcp-btn ghost", disabled: running, title: running ? "生成中，暂不释放显存" : "卸载模型并释放显存缓存", onClick: () => unloadModels(true) }, "释放显存"),
					note && h("div", { className: "dcp-note" }, note),
					error && h("div", { className: "dcp-err" }, error),
					// v0.7：标题行升级为 dcp-secrow 布局（参照模型区标题行写法），标题文本不变，
					// 右侧加「📋 一键替换」：读剪贴板按关键词自动区分正负向并替换。
					),
					h("div", { className: "dcp-col dcp-col-prompt" },
						h("div", { className: "dcp-col-head" }, "💬 LLM"),
					// v0.8：画师分区（关闭 / 大随机 / 小随机 / ★ 随机收藏 / 🔍 指定）。
					// 画师 tag 来自 Anima 2B 训练快照清单，只对 Anima 系列模型有效；指定模式的
					// 输入框只做查询词，画师只能经下拉行点选 ——「用户只能从列表选择」红线。
					// 宿主插槽：本地 LLM 的「提示词生成」由外壳 portal 挂到这里（同屏但不挤生图设置）。
					h("div", { className: "dcp-slot", ref: promptSlotRef }),
					),
					h("div", { className: "dcp-col dcp-col-set" },
						h("div", { className: "dcp-col-head" }, "⚙ 生图设置"),
						// v1.0.1：提示词与参考图挪到左栏最上方（用户要求：生图设置里先写提示词，操作更顺手）。
						h("div", { className: "dcp-secrow" },
							h("div", { className: "dcp-sec" }, "提示词"),
						h("button", {
							className: "dcp-btn ghost", style: { flex: "none", padding: "2px 8px", fontSize: 11 },
							disabled: running,
							title: "读取剪贴板，按 Positive prompt: / Negative prompt: 关键词自动区分并替换正向/负向提示词",
							onClick: applyClipboard,
						}, "📋 一键替换"),
					),
					h("div", { className: "dcp-field" },
						h("span", null, "正向提示词（自然语言 / booru 标签 / 混合）"),
						h("textarea", { value: positive, onChange: (e) => setPositive(e.target.value), placeholder: "例：a cute puppy with black and white spots, green grass background…" }),
					),
					h("div", { className: "dcp-field" },
						h("span", null, "负向提示词" + negHint),
						h("textarea", { value: negative, onChange: (e) => setNegative(e.target.value), style: { minHeight: 44 } }),
					),
					// v0.7：剪贴板 API 不可用时的降级 UI：面板内粘贴 + 手动确认使用。
					pasteFallback && h("div", { className: "dcp-paste-fallback" },
						h("textarea", {
							value: fallbackText,
							onChange: (e) => setFallbackText(e.target.value),
							placeholder: "剪贴板不可用，请在此粘贴 (Ctrl+V)",
						}),
						h("div", { className: "dcp-paste-fallback-foot" },
							h("button", {
								className: "dcp-btn ghost", disabled: running,
								onClick: () => { handlePasteText(fallbackText); setPasteFallback(false); },
							}, "使用该内容"),
						),
					),
					// v0.7：参考图（img2img）。生效时宽/高输入自动忽略；当前模型/管线不支持时
					// 参考图自动无效并在说明行给原因（不拦截生成，回落纯文生图）。
					h("div", { className: "dcp-sec" }, "参考图"),
					h("div", { className: "dcp-field" },
						h("span", null, "参考图（可选，生成时以它为底 img2img）"),
						h("div", { style: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" } },
							h("label", { className: "dcp-btn test", title: "选择一张本地图片作为参考图（上传到 ComfyUI 的 dsh-panel-ref 目录）", style: running || refBusy ? { opacity: 0.45, cursor: "default" } : undefined },
								refBusy ? "🖼 上传中…" : "🖼 选择参考图",
								h("input", { type: "file", accept: "image/*", style: { display: "none" }, disabled: running || refBusy, onChange: onRefPick }),
							),
							refName && h("button", { className: "dcp-btn ghost", disabled: running || refBusy, title: "清除参考图，回到纯文生图", onClick: clearRef }, "✕ 清除"),
							refUrlRef.current && h("img", { className: "dcp-refimg", src: refUrlRef.current, alt: "参考图预览" }),
						),
					),
					h("div", { className: "dcp-field" },
						h("span", null, "重绘幅度（denoise，仅参考图生效）"),
						h("input", {
							type: "number", min: 0.05, max: 1, step: 0.05, value: refDenoise,
							onChange: (e) => setRefDenoise(e.target.value),
							onBlur: () => setRefDenoise((v) => textOf(commitNum(v, 0.05, 1, 0.75, false))),
						}),
					),
					h("div", { className: "dcp-muted" },
						refState.supported
							? "生成时以参考图为底进行 img2img，宽/高输入自动忽略"
							: refState.reason + "；本次参考图自动无效，按纯文生图生成"),
					refNote && h("div", { className: "dcp-muted" }, refNote),
						h("div", { className: "dcp-sec" }, "画师（随机 / 收藏 / 指定）"),
					h("div", { className: "dcp-field" },
						h("span", null, "画师模式（多张时每张独立随机；仅对 Anima 系列模型生效）"),
						h("select", { value: artistMode, disabled: running, onChange: (e) => setArtistMode(e.target.value) },
							h("option", { value: "off" }, "关闭（不注入画师标签）"),
							h("option", { value: "randomBig" }, "🎲 大随机（全部 59,676 位画师）"),
							h("option", { value: "randomSmall" }, "🎲 小随机（前 200 高频画师）"),
							h("option", { value: "randomFav", disabled: artistFavs.length === 0 }, "★ 随机收藏（收藏 " + artistFavs.length + " 位）"),
							h("option", { value: "fixed" }, "🔍 指定画师（搜索并从列表点选）"),
						),
					),
					(artistMode === "randomBig" || artistMode === "randomSmall") && h("div", { className: "dcp-muted" },
						!artistList ? "画师清单加载中…"
							: artistList.failed ? "画师清单不可用：assets/artists/ 下缺少清单 txt（本次生成不注入画师）"
								: (artistMode === "randomBig" ? "大池 59,676 位（Anima 2B 训练快照全部画师）" : "小池 前 200 位高频大画师")
									+ " · 每张生成独立随机" + (artistBlacklist.length ? " · 已剔除 " + artistBlacklist.length + " 位拉黑画师" : "")),
					// v1.0.1：画师收藏 / 黑名单 / 检索 / 自定义输入的完整管理界面已挪到独立「画师」页
					//（用户要求：画师 UI 与生图分开、腾出的空间给图片）。这里只留生成时真正要用的三件事：
					// 模式、本次指定、以及"去画师页管理"的入口 —— 数量做只读提示，不再堆列表。
					h("div", { className: "dcp-field" },
						h("span", null, "画师管理（收藏 / 黑名单 / 自定义画师）"),
						h("div", { className: "dcp-muted" },
							h("span", null, "画师收藏 "), h("b", null, String(artistFavs.length)),
							h("span", null, " · 拉黑 "), h("b", null, String(artistBlackSet.size)),
							artistFixed ? h("span", null, " · 本次指定：") : null,
							artistFixed ? h("b", null, artistFixed) : null,
							(artistMode === "randomFav" && !artistFavs.length) ? h("span", null, "（收藏为空，随机收藏档不可用）") : null),
						h("div", { className: "row tight" },
							h("button", {
								className: "dcp-btn ghost", style: { padding: "2px 8px", fontSize: 11 },
								title: "打开「画师」页：收藏 / 黑名单 / 按名字检索 / 自定义画师都在那里",
								onClick: () => { try { window.dispatchEvent(new CustomEvent("dcp-go-tab", { detail: "artists" })); } catch { /* 忽略 */ } },
							}, "→ 去「画师」页管理"),
							artistFixed ? h("button", { className: "btn tiny ghost", style: { padding: "2px 8px", fontSize: 11 }, disabled: running, title: "清除本次指定画师", onClick: () => setArtistFixed(null) }, "✕ 清除本次指定") : null)),
					artistMode !== "off" && h("div", { className: "dcp-muted" }, ARTIST_NOTE),
					pipeline === "qwen" && artistMode !== "off" && h("div", { className: "dcp-note" }, "Qwen-Image 2.1 没有画师库：本次生成不注入画师标签，文件按 noartist_序号 命名"),
					h("div", { className: "dcp-sec" }, "参数"),
					h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
						h("div", { className: "dcp-field" }, h("span", null, "分辨率预设"),
							h("select", { value: (SIZE_PRESETS[pipeline].some((s) => textOf(s[1]) === textOf(size[0]) && textOf(s[2]) === textOf(size[1])) ? size[0] + "x" + size[1] : "custom"), onChange: (e) => { const p = SIZE_PRESETS[pipeline].find((s) => s[1] + "x" + s[2] === e.target.value); if (p) setSize(p.slice(1).map(textOf)); } },
								SIZE_PRESETS[pipeline].map((s) => h("option", { key: s[0], value: s[1] + "x" + s[2] }, s[0])),
								h("option", { value: "custom", disabled: true }, "自定义"),
							)),
						h("div", { className: "dcp-field" }, h("span", null, "宽 × 高"),
							h("div", { style: { display: "flex", gap: 4 } },
								h("input", {
									type: "number", step: 8, min: 64, max: 4096, value: size[0],
									onChange: (e) => setSize([e.target.value, size[1]]),
									onBlur: () => setSize((s) => [textOf(commitSize(s[0], 832)), s[1]]),
								}),
								h("input", {
									type: "number", step: 8, min: 64, max: 4096, value: size[1],
									onChange: (e) => setSize([size[0], e.target.value]),
									onBlur: () => setSize((s) => [s[0], textOf(commitSize(s[1], 1216))]),
								}))),
						h("div", { className: "dcp-field" }, h("span", null, "步数"),
							h("input", {
								type: "number", min: 1, max: 100, value: steps,
								onChange: (e) => setSteps(e.target.value),
								onBlur: () => setSteps((v) => textOf(commitNum(v, 1, 100, PIPE_DEFAULTS[pipeline].steps, true))),
							})),
						h("div", { className: "dcp-field" }, h("span", null, "CFG"),
							h("input", {
								type: "number", min: 0.1, max: 30, step: 0.5, value: cfg,
								onChange: (e) => setCfg(e.target.value),
								onBlur: () => setCfg((v) => textOf(commitNum(v, 0.1, 30, PIPE_DEFAULTS[pipeline].cfg, false))),
							})),
					),
					h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 } },
						h("div", { className: "dcp-field" },
							h("span", null, "图片张数（batch，逐张生成）"),
							h("select", { value: String(batch), onChange: (e) => setBatch(Number(e.target.value)) },
								[1, 2, 3, 4, 6, 8, 10, 12, 16, 20].map((n) => h("option", { key: n, value: n }, n + " 张"))),
						),
						h("div", { className: "dcp-field" },
							h("span", null, "种子"),
							h("div", { style: { display: "flex", gap: 6, alignItems: "center" } },
								h("label", { style: { display: "flex", gap: 4, alignItems: "center", fontSize: 12, whiteSpace: "nowrap", color: "#c4c4cf" } },
									h("input", { type: "checkbox", checked: randomSeed, onChange: (e) => setRandomSeed(e.target.checked) }), "随机"),
								!randomSeed && h("input", {
									type: "number", value: seed, style: { flex: 1, minWidth: 0 },
									onChange: (e) => setSeed(e.target.value),
									onBlur: () => setSeed((v) => textOf(commitNum(v, 0, 281474976710655, 0, true))),
								}),
								randomSeed && h("span", { className: "dcp-muted", style: { flex: 1 } }, "每次随机"),
							),
						),
					),
					h("div", { style: { display: "flex", gap: 8 } },
						h("button", { className: "dcp-btn test", title: "填入统一测试提示词：黑白色斑点小狗 + 草地背景，并复位推荐参数", disabled: running, onClick: fillTest }, "🧪 测试图"),
						h("button", { className: "dcp-btn", style: { flex: 1, padding: "8px 0" }, disabled: !canGen, title: genTitle, onClick: generate },
							running ? "生成中…" : "生成 " + batch + " 张（逐张）"),
						running && h("button", { className: "dcp-btn warn", onClick: () => { runAbortRef.current = true; api("/interrupt", { method: "POST", body: "{}" }).catch(() => {}); } }, "中止"),
					),
					running && h("div", { className: "dcp-bar" }, h("i", { style: { width: pct(barW) } })),
					h("div", { className: "dcp-muted" },
						running
							? (runProgress ? "第 " + runProgress.i + "/" + runProgress.n + " 张 · " : "") + (nodeLabel ? nodeLabel + " · " : "") + "步数 " + progress.value + "/" + (progress.max || steps) + (queue > 0 ? " · 队列 " + queue : "")
							: queue > 0 ? "队列中：" + queue + " 个任务" : "空闲"),
					h("div", { className: "dcp-details" },
						// 标题行：折叠开关 + 一个安静的「↻ 刷新模型」。
						// /object_info 每个在线周期只拉一次，而 Anima38BV2Loader 的兜底名会随系统提交
						// 内存压力闪烁；内存一松就得能重新拉清单，不该逼用户关掉面板再打开。
						h("div", { className: "dcp-secrow" },
							h("button", { className: "dcp-sec", onClick: () => setModelsOpen((v) => !v) },
								(modelsOpen ? "▾ " : "▸ ") + "模型（切换自动卸载旧模型）"),
							h("button", {
								className: "dcp-btn ghost", style: { flex: "none", padding: "2px 8px", fontSize: 11 },
								disabled: running || !online,
								title: online
									? "重新读取 ComfyUI 的 /object_info（模型清单变了、或 Anima 模型曾因内存压力缺失时用）"
									: "ComfyUI 离线，无法读取模型清单",
								onClick: refreshModels,
							}, "↻ 刷新模型"),
						),
						modelsOpen && h("div", { className: "dcp-body-in" },
							// v0.6 主选择器：唯一一份扩散模型清单（两份 loader 的并集）。
							// 改它 → routeFor() 重派管线，并自动配好 CLIPLoader.type / 条件节点 /
							// 编码器 / VAE / 推荐参数（pairingNote 会写明配了什么、为什么）。
							h(SelRow, {
								label: "主模型 (diffusion)",
								values: modelOptions,
								value: curModel ?? "",
								disabled: running || !modelOptions.length,
								onChange: changePrimaryModel,
							}),
							curUnusable && h("div", { className: "dcp-err" }, curUnusable),
							// 派生结果一眼可见：走哪条路线、配了什么编码器/条件节点/VAE/采样器。
							h("div", { className: "dcp-pair" },
								"→ " + PIPELINE_RULES[pipeline].label + " · 条件节点 " + shape.conditioning
								+ " · 编码器 " + PIPELINE_RULES[pipeline].defaultEncoder + "（" + PIPELINE_RULES[pipeline].encoderDim
								+ " 维, type=" + shape.clipType + "）"
								+ " · VAE " + PIPELINE_RULES[pipeline].defaultVae + "（" + PIPELINE_RULES[pipeline].latentChannels + " 通道）"
								+ " · " + shape.sampler + "/" + shape.scheduler),
							// 路线仍可手动钉住（模型是主选择，这里是细粒度兜底）
							h("div", { className: "dcp-seg" },
								h("button", { className: pipeline === "anima" ? "on" : "", title: "Anima 3.8B v2（lylogummy bundle）", disabled: running, onClick: () => switchPipeline("anima") }, "Anima 3.8B"),
								h("button", { className: pipeline === "animaPlain" ? "on" : "", title: "通用 Anima（circlestone / HEIXUN 系普通权重）", disabled: !unetL || running, onClick: () => switchPipeline("animaPlain") }, "Anima 通用"),
								h("button", { className: pipeline === "qwen" ? "on" : "", title: "Qwen-Image 2.1", disabled: !unetL || running, onClick: () => switchPipeline("qwen") }, "Qwen-Image 2.1"),
							),
							pipeline === "anima" ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
								h(SelRow, { label: "Qwen3.5 编码器", values: animaQ?.values, value: sel?.qwenEncoder, disabled: running, onChange: (v) => changeModel("qwenEncoder", v) }),
								h(SelRow, { label: "原生编码器", values: animaClipOptions, value: sel?.nativeClip, disabled: running, onChange: (v) => changeModel("nativeClip", v) }),
								h(SelRow, { label: "VAE", values: animaVaeOptions, value: sel?.animaVae, disabled: running, onChange: (v) => changeModel("animaVae", v) }),
								animaNotReady && h("div", { className: "dcp-err" }, ANIMA_NOT_READY_MSG),
								h("div", { className: "dcp-muted" }, MISSING_ADAPTER_REASON),
							) : pipeline === "animaPlain" ? h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
								h(SelRow, { label: "原生编码器", values: plainClipOptions, value: sel?.plainClip, disabled: running, onChange: (v) => changeModel("plainClip", v) }),
								h(SelRow, { label: "VAE", values: plainVaeOptions, value: sel?.plainVae, disabled: running, onChange: (v) => changeModel("plainVae", v) }),
							) : h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
								h(SelRow, { label: "文本编码器", values: qwenClipOptions, value: sel?.qwenClip, disabled: running, onChange: (v) => changeModel("qwenClip", v) }),
								h(SelRow, { label: "VAE", values: qwenVaeOptions, value: sel?.qwenVae, disabled: running, onChange: (v) => changeModel("qwenVae", v) }),
							),
						),
					),
					h("div", { className: "dcp-sec" }, "显存 / 内存"),
					h("div", { className: "dcp-stats" },
						stats && dev && h("div", null,
							h("div", null, "显存 " + gb(dev.vram_total - dev.vram_free) + " / " + gb(dev.vram_total) + " GB"),
							h("div", { className: "dcp-bar vram" }, h("i", { style: { width: pct(Math.min(100, (1 - dev.vram_free / dev.vram_total) * 100)) } }))),
						stats && h("div", null,
							h("div", null, "内存 " + gb(stats.system?.ram_total - stats.system?.ram_free) + " / " + gb(stats.system?.ram_total) + " GB"),
							h("div", { className: "dcp-bar ram" }, h("i", { style: { width: pct(Math.min(100, (1 - stats.system?.ram_free / stats.system?.ram_total) * 100)) } }))),
						!stats && h("span", null, online ? "读取中…" : "ComfyUI 离线"),
					),
					h("div", { className: "dcp-muted" }, "实时预览为 Latent2RGB 快速解码（示意构图与配色，非最终画质）· 采样：Anima 3.8B v2=res_multistep+Beta · Anima 通用=er_sde+simple · Qwen=euler+simple"),
					),
				),
			);
		}

		function Fab() {
			const [open, setOpen] = useState(false);
			return h("div", { className: "dcp-root" },
				h("button", { className: "dcp-fab", title: "超低门槛 ComfyUI 工作流集成应用", onClick: () => setOpen((v) => !v) }, "🎨"),
				open && h(Panel, { onClose: () => setOpen(false) }),
			);
		}

		const CSS = `
.dcp-root{display:contents;font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
.dcp-fab{pointer-events:auto;position:absolute;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%;border:1px solid rgba(128,128,128,.35);background:rgba(28,28,32,.92);color:#fff;font-size:20px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.dcp-fab:hover{transform:scale(1.07)}
.dcp-panel{pointer-events:auto;position:absolute;top:0;right:0;bottom:0;width:400px;max-width:94vw;background:rgba(22,22,26,.97);color:#e9e9ef;display:flex;flex-direction:column;box-shadow:-10px 0 30px rgba(0,0,0,.35);border-left:1px solid rgba(255,255,255,.1);z-index:5}
.dcp-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);font-weight:600;font-size:14px}
.dcp-head .sp{flex:1}
.dcp-btn{background:#2f6feb;color:#fff;border:0;border-radius:6px;padding:4px 10px;cursor:pointer;font:inherit;font-size:12px}
.dcp-btn.ghost{background:rgba(255,255,255,.12);color:#eceff5}
.dcp-btn.warn{background:#c2410c;color:#fff}
.dcp-btn.test{background:rgba(34,197,94,.16);border:1px solid rgba(74,222,128,.45);color:#86efac}
.dcp-btn:disabled{opacity:.45;cursor:default}
.dcp-btn:not(:disabled):hover{filter:brightness(1.12)}
.dcp-body{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:11px}
.dcp-sec{font-size:11px;font-weight:700;letter-spacing:.08em;color:#8fb4ff;margin-top:2px}
.dcp-field{display:flex;flex-direction:column;gap:3px;min-width:0}
.dcp-field>span{font-size:11px;color:#c4c4cf}
.dcp-panel input,.dcp-panel select,.dcp-panel textarea{background:rgba(255,255,255,.07);color:#f2f2f6;border:1px solid rgba(255,255,255,.14);border-radius:6px;padding:5px 8px;font:inherit;width:100%;box-sizing:border-box}
.dcp-panel input[type=checkbox]{width:auto;accent-color:#2f6feb;flex:none}
.dcp-panel textarea{resize:vertical;min-height:60px}
.dcp-panel input:focus,.dcp-panel select:focus,.dcp-panel textarea:focus{outline:1.5px solid #5b9bff}
.dcp-panel option{background:#1c1c22;color:#f2f2f6}
.dcp-seg{display:flex;border:1px solid rgba(255,255,255,.16);border-radius:7px;overflow:hidden}
.dcp-seg button{flex:1;min-width:0;background:transparent;color:#cfcfd8;border:0;padding:6px 2px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dcp-seg button.on{background:#2f6feb;color:#fff}
.dcp-seg button:disabled{opacity:.4}
.dcp-pair{font-size:11px;color:#a6a6b3;background:rgba(255,255,255,.05);border-radius:6px;padding:5px 8px;overflow-wrap:anywhere}
.dcp-stats{display:flex;flex-direction:column;gap:6px;font-size:11px;color:#cfcfd8}
.dcp-bar{height:6px;border-radius:3px;background:rgba(255,255,255,.1);overflow:hidden}
.dcp-bar>i{display:block;height:100%;background:linear-gradient(90deg,#2f6feb,#22c55e);transition:width .3s}
.dcp-bar.vram>i{background:#f59e0b}
.dcp-bar.ram>i{background:#8b5cf6}
.dcp-img{width:100%;border-radius:8px;border:1px solid rgba(255,255,255,.12);cursor:zoom-in;display:block;background:#111}
.dcp-thumbs{display:flex;gap:6px;flex-wrap:wrap}
.dcp-thumb{width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.18);cursor:pointer;opacity:.75}
.dcp-thumb.cur{outline:2px solid #5b9dff;opacity:1}
.dcp-refimg{width:64px;height:64px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.18);display:block;flex:none}
.dcp-err{color:#fda4af;font-size:12px;white-space:pre-wrap;background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.25);border-radius:6px;padding:6px 8px}
.dcp-note{color:#fcd34d;font-size:12px;background:rgba(251,191,36,.08);border-radius:6px;padding:4px 8px}
.dcp-empty{color:#a2a2b0;font-size:12px;text-align:center;padding:18px 0;border:1px dashed rgba(255,255,255,.16);border-radius:8px}
.dcp-muted{color:#a6a6b3;font-size:11px}
.dcp-dot{width:8px;height:8px;border-radius:4px;display:inline-block}
.dcp-dot.dcp-dot-on{background:#4ade80}.dcp-dot.dcp-dot-off{background:#f87171}
.dcp-view{position:relative}
.dcp-img.live{border-color:rgba(91,157,255,.6)}
.dcp-live{display:flex;align-items:center;gap:6px;font-size:11px;color:#d8d8e2;margin-top:6px}
.dcp-live .sp{flex:1}
.dcp-live-tag{background:rgba(255,255,255,.14);border-radius:4px;padding:1px 6px;font-size:10px;flex:none;color:#ececf4}
.dcp-live-tag.on{background:#2f6feb;color:#fff}
.dcp-live-bar{height:4px;border-radius:2px;background:rgba(255,255,255,.1);overflow:hidden;margin-top:6px}
.dcp-live-bar>i{display:block;height:100%;background:linear-gradient(90deg,#2f6feb,#22c55e);transition:width .3s}
.dcp-details{border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:0 10px}
.dcp-secrow{display:flex;align-items:center;gap:6px}
.dcp-details .dcp-sec{flex:1;min-width:0;text-align:left;background:transparent;border:0;cursor:pointer;padding:8px 0 2px;letter-spacing:.08em;font-size:11px;font-weight:700;color:#8fb4ff;font-family:inherit}
.dcp-details .dcp-sec:hover{color:#b9d2ff}
.dcp-details .dcp-body-in{display:flex;flex-direction:column;gap:8px;padding:2px 0 10px}
/* v0.7 功能③：剪贴板一键替换 —— secrow 内标题撑满、按钮靠右；剪贴板不可用时
   的降级粘贴区（沿用现有虚线边框/圆角/色板风格，textarea 走 .dcp-panel 基础样式）。 */
.dcp-secrow .dcp-sec{flex:1;min-width:0;text-align:left}
.dcp-paste-fallback{display:flex;flex-direction:column;gap:6px;border:1px dashed rgba(255,255,255,.16);border-radius:8px;padding:8px}
.dcp-paste-fallback textarea{font-size:12px;min-height:64px}
.dcp-paste-fallback-foot{display:flex;justify-content:flex-end}
/* v0.8 画师分区：搜索下拉（只能从列表点选/点★收藏）与收藏胶囊 */
.dcp-artist-drop{display:flex;flex-direction:column;max-height:180px;overflow-y:auto;border:1px solid rgba(255,255,255,.16);border-radius:6px;background:rgba(24,24,30,.98)}
.dcp-artist-drop-row{display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.06)}
.dcp-artist-drop-row:hover{background:rgba(47,111,235,.28)}
.dcp-artist-drop-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:#e9e9ef}
.dcp-artist-drop-star{flex:none;background:transparent;border:0;color:#fcd34d;font-size:13px;cursor:pointer;padding:0 2px}
.dcp-artist-chip{display:inline-flex;align-items:center;gap:6px;background:rgba(47,111,235,.18);border:1px solid rgba(91,157,255,.45);border-radius:6px;padding:2px 8px;font-size:12px;color:#d8e6ff}
.dcp-artist-chip button{background:transparent;border:0;color:#fda4af;cursor:pointer;font:inherit;font-size:11px;padding:0}
`;

		// 声明依赖 slots 服务：fiber 会等 ui-renderer 把服务备好再跑 apply；
		// 这同时是 client ctx facade 的服务白名单——不声明就摸不到 ctx.slots。
		const inject = ["slots"];

		exports.apply = function (ctx) {
			const style = document.createElement("style");
			style.textContent = CSS;
			document.head.appendChild(style);
			ctx.effect(() => () => style.remove(), "comfy-panel: css");

			// 存活探针：host 半的 /comfy-panel/health 会记下这个时间戳，
			// 便于在浏览器控制台之外诊断“client 半到底跑了没有”。
			try {
				fetch("/comfy-panel/client-alive", { method: "POST" }).catch(() => {});
			} catch {}

			// 与内置 UI 插件一致的注册姿势（参考 dsh-client-ui-jobs）：
			// slots.inject 会等 ui-layout 声明 shell.overlay 后自动落位，注册时机无竞态。
			// 组件根节点是 display:contents，悬浮按钮/面板绝对定位锚定到 shell 的
			// overlay 层（.qNbT7G_overlayLayer，inset:0），不会再盖住应用拦截点击。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "comfy-panel", order: 40, label: "ComfyUI 生图" },
				Fab,
			));
		};

		exports.inject = inject;
		// 冒烟测试钩子：仅暴露纯函数与面板组件，供 node 侧渲染/逻辑自检使用，
		// 运行时不被任何代码消费。
		exports.__test = {
			Panel, Fab, animaGraph, animaPlainGraph, qwenGraph, snapSize, clampInt, clampFloat, comboOf, pick, TEST_PROMPTS, CSS, wsUrlFor, commitNum, commitSize, textOf,
			// v0.4：模型/VAE 兼容性规则的纯函数（冒烟测试直接断言）
			PIPELINE_RULES, MODEL_FAMILIES, VAE_FAMILIES, ANIMA_FALLBACK_MODEL, ANIMA_NOT_READY_MSG,
			ruleFor, incompatibility, choiceList, snapChoice, animaModelsReady, preSubmitBlock, withChannelHint, selectionLine,
			// v0.5：文本编码器兼容性规则（同一批纯函数，按管线维度判定）
			ENCODER_FAMILIES, encoderIncompatibility,
			// v0.6：模型 → 管线/编码器/type/条件节点/VAE/采样默认值的派生层
			ROUTE_SHAPE, ROUTE_MODEL_KEY, ROUTE_CLIP_KEY, ROUTE_VAE_KEY,
			routeFor, modelCatalog, unusableReason, pairingNote, pairingFor, defaultsFor, MODEL_DEFAULT_OVERRIDES,
			MISSING_ADAPTER_FILE, MISSING_ADAPTER_REASON,
			// v0.7：参考图（img2img）支持性判定（冒烟测试直接断言）
			refSupport,
			// v0.7：剪贴板提示词解析（功能③「一键替换」纯函数，冒烟测试直接断言）
			parsePromptClipboard,
			// v0.8：随机画师纯函数层（冒烟测试直接断言）
			ARTIST_NOTE, filterArtists, pickRandomArtist, artistFileNamePart, modelFolderName, savePrefixFor, withArtistTag,
			// v0.8.1：构建标识（冒烟直接断言面板头部版本自证）
			BUILD_TAG,
			// v0.8：收藏画师（localStorage 持久化，冒烟测试直接断言）
			FAV_STORAGE_KEY, loadFavorites, saveFavorites, toggleArtist,
			// v1.0.0（独立版）：服务端收藏/黑名单、互斥切换、黑名单剔除、自定义画师规范化
			loadBlacklist, saveBlacklist, toggleFavExclusive, toggleBlacklistExclusive, withoutBlacklisted, normalizeCustomArtist, artistStore,
			// v1.0.0：跨页面能力（外壳「一键填入」用；Node 侧冒烟也可断言）
			PANEL_API,
		};
		return module.exports;
	}
});
