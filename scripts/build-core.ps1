# comfy-panel-standalone · 核心版打包 + 交付前自查
#
# 产出：<项目根>\release\core\  —— 可直接上传 GitHub 的干净拷贝
#   · 只包含源码 / 脚本 / 🌐 文档 / 画师清单文本（MIT）/ 许可全文
#   · 排除 runtime、models、data、logs、dist、release、以及全部压缩包与权重
#   · 生成后可选 git init，并做"零隐私路径 / 零权重 / 零 GPL 代码"三项扫描
#
# 用法：
#   pwsh -File .\scripts\build-core.ps1                # 打包 + 扫描（默认不 git init）
#   pwsh -File .\scripts\build-core.ps1 -GitInit       # 打包 + 扫描 + git init + 首次提交
#   pwsh -File .\scripts\build-core.ps1 -ScanOnly      # 只扫描现有 release\core

[CmdletBinding()]
param(
    [string]$Root = '',
    [switch]$GitInit,
    [switch]$ScanOnly,
    [switch]$SkipClean
)

$ErrorActionPreference = 'Stop'
try { $null = & chcp.com 65001 2>$null } catch { }

function Write-Info($m) { Write-Host ("[打包] " + $m) }
function Write-Ok($m) { Write-Host ("[打包][OK] " + $m) -ForegroundColor Green }
function Write-Warn2($m) { Write-Host ("[打包][警告] " + $m) -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host ("[打包][错误] " + $m) -ForegroundColor Red }

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$CoreDir = Join-Path $Root 'release\core'

# 顶层白名单：核心版 = 这些目录/文件的干净拷贝（其余一律不拷）
$IncludeDirs = @('server', 'web', 'scripts', 'assets', 'installer', 'docs', 'LICENSES')
$IncludeFiles = @('start.cmd', 'README.md', 'FEATURES.md', 'MIGRATION.md', 'LICENSE', 'THIRD_PARTY.md', '.gitignore', '.gitattributes', 'package.json')

# 这些名字一旦出现在拷贝结果里就是错误（运行期数据 / 权重 / 运行时）
$ForbiddenNames = @('runtime', 'models', 'data', 'logs', 'dist', 'release', 'node_modules', '.scratch')
$ForbiddenExt = @('.safetensors', '.ckpt', '.pt', '.pth', '.onnx', '.gguf', '.7z', '.zip', '.rar', '.tar', '.gz', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.log', '.part')

function Copy-CoreTree {
    if ((Test-Path $CoreDir) -and -not $SkipClean) {
        Write-Info "清理旧的 release\core …"
        Remove-Item -Recurse -Force $CoreDir
    }
    $null = New-Item -ItemType Directory -Force -Path $CoreDir
    foreach ($d in $IncludeDirs) {
        $src = Join-Path $Root $d
        if (-not (Test-Path $src)) { Write-Warn2 ("缺少目录，跳过：" + $d); continue }
        $dst = Join-Path $CoreDir $d
        $null = New-Item -ItemType Directory -Force -Path $dst
        Get-ChildItem -Path $src -Recurse -File -Force | ForEach-Object {
            $rel = $_.FullName.Substring($src.Length).TrimStart('\')
            if ($ForbiddenExt -contains $_.Extension.ToLower()) { return }
            $parts = $rel.Split('\')
            foreach ($p in $parts) { if ($ForbiddenNames -contains $p) { return } }
            $target = Join-Path $dst $rel
            $parent = Split-Path -Parent $target
            if (-not (Test-Path $parent)) { $null = New-Item -ItemType Directory -Force -Path $parent }
            Copy-Item -Force $_.FullName $target
        }
        Write-Info ("已拷贝：" + $d)
    }
    foreach ($f in $IncludeFiles) {
        $src = Join-Path $Root $f
        if (Test-Path $src) { Copy-Item -Force $src (Join-Path $CoreDir $f); Write-Info ("已拷贝：" + $f) }
        else { Write-Warn2 ("缺少文件，跳过：" + $f) }
    }
}

function Scan-Core {
    Write-Info "开始交付前自查（隐私 / 权重 / 许可）…"
    $fail = 0
    $files = Get-ChildItem -Path $CoreDir -Recurse -File -Force
    Write-Info ("核心版文件数：" + $files.Count)

    # ① 隐私：真实机器路径与用户名（占位符写法不受影响）
    #    注意：模式里刻意不写死任何真实用户名，用"任意用户目录"的通用形态来匹配。
    $privacyPatterns = @(
        '[A-Za-z]:\\Users\\',
        '[A-Za-z]:\\Game\\',
        '[A-Za-z]:\\AI\\',
        'AppData\\Roaming',
        '\\Users\\[^\\]+\\'
    )
    $privacyHits = @()
    foreach ($f in $files) {
        if ($f.Extension -in @('.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff2')) { continue }
        foreach ($p in $privacyPatterns) {
            $m = Select-String -Path $f.FullName -Pattern $p -ErrorAction SilentlyContinue -Encoding UTF8
            if ($m) { $privacyHits += ("{0}: {1}" -f $f.FullName.Substring($CoreDir.Length).TrimStart('\'), $p) }
        }
    }
    if ($privacyHits.Count -gt 0) {
        Write-Err2 "发现隐私路径命中（必须清零）："
        $privacyHits | Select-Object -First 20 | ForEach-Object { Write-Host ("   " + $_) -ForegroundColor Red }
        $fail++
    } else { Write-Ok "隐私扫描：零命中" }

    # ② 权重 / 二进制 / GPL 代码
    $weights = $files | Where-Object { $ForbiddenExt -contains $_.Extension.ToLower() }
    if ($weights) {
        Write-Err2 "核心版里出现了不该有的文件："
        $weights | Select-Object -First 20 | ForEach-Object { Write-Host ("   " + $_.FullName) -ForegroundColor Red }
        $fail++
    } else { Write-Ok "权重与压缩包扫描：零命中" }

    # ②b GPL 代码扫描：只看"真代码行"上的**导入/继承**特征，并排除本脚本自身
    #     （注释里引用 ComfyUI 源码路径作为证据是允许的，不算内联代码）。
    $pyFiles = $files | Where-Object { $_.Extension -eq '.py' }
    if ($pyFiles) {
        Write-Err2 ("核心版里出现了 Python 源文件（可能是 ComfyUI 代码）：" + ($pyFiles | Select-Object -First 5 | ForEach-Object { $_.Name }) -join '、')
        $fail++
    } else { Write-Ok "Python 源文件扫描：零命中（ComfyUI 不随包分发）" }

    $gplImportMarkers = @('from comfy.', 'import comfy.', 'import comfy_api', 'from comfy_api', 'class ComfyUI', 'def load_checkpoint')
    $gplHits = @()
    foreach ($f in ($files | Where-Object { $_.Extension -in @('.js', '.mjs', '.cjs', '.ps1') -and $_.Name -ne 'build-core.ps1' })) {
        $codeLines = Get-Content -Path $f.FullName -Encoding UTF8 -ErrorAction SilentlyContinue | Where-Object {
            $t = $_.TrimStart()
            -not ($t.StartsWith('//') -or $t.StartsWith('*') -or $t.StartsWith('#') -or $t.StartsWith('<!--'))
        }
        foreach ($p in $gplImportMarkers) {
            if ($codeLines | Where-Object { $_ -like ('*' + $p + '*') }) { $gplHits += ("{0}: {1}" -f $f.Name, $p) }
        }
    }
    if ($gplHits.Count -gt 0) {
        Write-Warn2 "疑似 ComfyUI(GPL) 代码内联命中，请人工确认："
        $gplHits | Select-Object -First 10 | ForEach-Object { Write-Host ("   " + $_) -ForegroundColor Yellow }
    } else { Write-Ok "GPL 代码内联扫描：零命中（注释里引用 ComfyUI 源码路径作为证据不算内联）" }

    # ③ 四份文档齐全
    $docs = @('README.md', 'FEATURES.md', 'MIGRATION.md', 'docs\FULL-REFERENCE.md')
    $missing = @()
    foreach ($d in $docs) { if (-not (Test-Path (Join-Path $CoreDir $d))) { $missing += $d } }
    if ($missing.Count -gt 0) {
        Write-Err2 ("文档缺失：" + ($missing -join '、'))
        $fail++
    } else { Write-Ok "四份文档齐全" }

    # ④ 语法自检（核心版必须能直接跑）
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($node) {
        $bad = 0
        Get-ChildItem -Path (Join-Path $CoreDir 'server') -Recurse -Filter *.js | ForEach-Object {
            $null = & $node.Source --check $_.FullName 2>&1
            if ($LASTEXITCODE -ne 0) { $bad++; Write-Err2 ("语法错误：" + $_.Name) }
        }
        foreach ($f in @('web\panel.js', 'web\panel-host.js')) {
            $p = Join-Path $CoreDir $f
            if (Test-Path $p) { $null = & $node.Source --check $p 2>&1; if ($LASTEXITCODE -ne 0) { $bad++; Write-Err2 ("语法错误：" + $f) } }
        }
        if ($bad -eq 0) { Write-Ok "核心版语法自检通过（server 与面板半）" } else { $fail++ }
    } else { Write-Warn2 "本机没有 node，跳过语法自检" }

    return $fail
}

if (-not $ScanOnly) { Copy-CoreTree }
if (-not (Test-Path $CoreDir)) { Write-Err2 ("找不到 " + $CoreDir + "，请先不带 -ScanOnly 跑一次。"); exit 1 }

$fail = Scan-Core

if ($GitInit) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { Write-Warn2 "未找到 git，跳过 git init。" }
    else {
        Write-Info "初始化 git 仓库（核心版 = 仓库本身）…"
        Push-Location $CoreDir
        try {
            if (-not (Test-Path (Join-Path $CoreDir '.git'))) { & $git.Source init -q }
            & $git.Source add -A
            & $git.Source -c user.name='comfy-panel-standalone' -c user.email='noreply@example.com' commit -q -m 'chore: comfy-panel-standalone core v1.0.0' 2>$null
            $tracked = (& $git.Source ls-files | Measure-Object).Count
            Write-Ok ("git 仓库就绪，已跟踪文件数：" + $tracked)
            $suspicious = & $git.Source ls-files | Select-String -Pattern '\.(safetensors|gguf|ckpt|pt|pth|onnx|7z|zip)$'
            if ($suspicious) { Write-Err2 "仓库里仍有权重/压缩包被跟踪！"; $fail++ } else { Write-Ok "git 跟踪清单：零权重、零压缩包" }
        } finally { Pop-Location }
    }
}

if ($fail -gt 0) {
    Write-Err2 ("交付前自查未通过（" + $fail + " 项）。")
    exit 1
}
Write-Ok ("核心版已就绪：" + $CoreDir)
Write-Info "上传 GitHub 前请再确认：① 不含 ComfyUI 源码；② 不含任何模型权重；③ 文档里没有真实机器路径。"
exit 0
