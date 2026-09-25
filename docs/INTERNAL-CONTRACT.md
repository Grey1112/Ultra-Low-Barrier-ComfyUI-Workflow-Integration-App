# 内部接口契约（comfy-panel-standalone v1.0.0）

> 本文件是前端与后端的冻结契约。改动必须同步更新本文件。
> 脱敏要求：本文件与全部交付物**不得出现任何真实机器路径**（示例一律用占位符）。

## 0. 进程与地址

- 后端：Node 标准库，零 npm 依赖。入口 `server/index.js`。
- 默认监听 `127.0.0.1:8788`（设置可改）；`lan=true` 时监听 `0.0.0.0` 并要求 `X-DCP-Token`。
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
    "pipIndex": "https://pypi.tuna.tsinghua.edu.cn/simple"
  },
  "llm": {
    "contextMessages": 5,            // 0..20
    "defaultModel": "",              // models/llm 下的文件名
    "port": 8199,
    "ctxSize": 8192,
    "gpuLayers": 99
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

## 4. HTTP 接口清单

### 状态
| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/app/state` | `{version, buildTag, lang, root, comfy:{mode,dir,port,online,running,pid}, llm:{runtime:{ok,source,exe}, model, server:{running,port}}, setup:{completed, runtime, comfyui, models, artists, llm}, selfcheck:{ok, issues:[]}}` |
| GET | `/app/selfcheck` | `{ok, issues:[{code,level,message,fix,path?}], external:[{key,path,exists}]}` |
| GET | `/app/settings` | 设置全量 |
| PUT | `/app/settings` | 部分更新（深合并），返回更新后设置 |

### ComfyUI 进程
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/comfy/detect?dir=` | `{ok, dir, codeDir, modelsDir, mainPy, python, layout:"portable|venv|unknown", error?}`；`dir` 省略时用设置里的 |
| POST | `/app/comfy/launch` | `{online, launched, error?}`（已在跑则 `online:true, launched:false`） |
| POST | `/app/comfy/stop` | `{online:false, stopped:true|false, error?}` |
| GET | `/app/comfy/status` | `{online, running, pid, dir, mode, port, candidates:[...]}` |
| GET | `/app/comfy/log?tail=300` | `{path, lines:[...]}` |

### 画师数据（服务端持久化）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/artists/lists` | `{favs:[tag], blacklist:[tag]}` |
| POST | `/app/artists/toggle` | body `{tag, action:"fav"|"blacklist"}` → `{favs, blacklist, result:"added"|"removed"}`；两态互斥（后执行覆盖） |
| PUT | `/app/artists/favs` | body `{items:[...]}` |
| PUT | `/app/artists/blacklist` | body `{items:[...]}` |
| POST | `/app/artists/import` | body `{items:[...]}` 合并导入（用于 localStorage `dcp-artist-favs` 一次性迁移）→ `{favs, imported}` |
| GET | `/app/artists/search?q=&source=all\|top\|favs&limit=50` | `{items:[{tag, blacklisted:bool}], total}` |

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
| POST | `/app/llm/chat` | body `{messages:[{role,content}], sessionId}` → SSE：`data: {"delta":"..."}` … `data: {"done":true,"contextUsed":N}` |
| POST | `/app/llm/session/new` | `{ok:true}` 清空该会话的服务端上下文与推理缓存 |
| GET | `/app/llm/session/:id` | `{messages:[...]}`（服务端保留最近 N 条） |
| GET | `/app/llm/prompt` | `{text}`：`assets/templates/anima-system-prompt.txt` 原文 |

### 首次运行向导（F1/M4）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/app/setup/plan?mode=embedded\|external&sel=minimal` | `{mode, steps:[{id,title,detail}], models:[{id,file,bytes,license,tier,installed}], totalBytes, missing:[...]}` |
| POST | `/app/setup/run` | body `{mode, comfySource:{kind:"portable"\|"archive"\|"dir"\|"git"\|"skip", path?}, models:[ids], copyMode:"link"\|"copy", artists:true, licenses:true} → {jobId}` |
| GET | `/app/setup/status` | `{completed, runtime, comfyui, models, artists, llm, comfyDir, modelsDir}` |

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
| `data/artists.json` | `{favs:[], blacklist:[], updatedAt}` |
| `data/llm/models.json` | LLM 模型清单与默认项 |
| `data/llm/sessions.json` | 会话（最近 N 条） |
| `data/setup.json` | 向导完成状态 |
| `logs/server.log` | 后端日志 |
| `logs/comfyui.log` | ComfyUI 子进程 stdout/stderr |
| `logs/jobs/<jobId>.log` | 长任务日志（可下载/查看） |

所有写入走 `store.js` 的原子写（临时文件 + rename），JSON 产物**不带 BOM**。

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
