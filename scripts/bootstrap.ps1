# comfy-panel-standalone · 便携运行时引导
#
# 内嵌模式要求"新电脑不需要全局安装任何环境"，Node 运行时即随项目携带：
#   runtime\node\node.exe
# 本脚本负责把官方 Node 便携包（zip）解到 runtime\node。
#
# 下载策略（与 server\download.js 的 F3 策略同一套规则，这里是 PowerShell 版：
# 引导阶段还没有 Node，跑不了 Node 代码，所以镜像表在下面重复了一份）：
#   · 依次尝试多个国内镜像，**10 秒内没有正常开始下载就换源**；
#   · 中途连续 15 秒没有新数据也换源；
#   · 每个源都打印实测速度，排障时一眼看出哪个源能用。
# 已存在则直接跳过（幂等）。仅用 PowerShell 自带能力（5.1 也能跑）。

[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Version = 'v22.14.0',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
try { $null = & chcp.com 65001 2>$null } catch { }

function Write-Info($m) { Write-Host ("[bootstrap] " + $m) }
function Write-Warn2($m) { Write-Host ("[bootstrap][警告] " + $m) -ForegroundColor Yellow }

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$NodeDir = Join-Path $Root 'runtime\node'
$NodeExe = Join-Path $NodeDir 'node.exe'

if ((Test-Path $NodeExe) -and -not $Force) {
    Write-Info ("已存在便携 Node，跳过：" + $NodeExe)
    exit 0
}

$arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
$pkg = "node-$Version-win-$arch"
$file = "$pkg.zip"
# 镜像梯队：顺序 = 实测速度（2026-09 本机实测）。
#   tuna 29.6 MB/s / nodejs.org 17.2 MB/s / 华为云 9.8 MB/s / cdn.npmmirror 9.2 MB/s /
#   registry.npmmirror 8.2 MB/s（302 到 cdn，与上一条同后端，留作兜底）。
# 注意：mirrors.ustc.edu.cn 虽然最快（41 MB/s），但需要先带 JS 验证 Cookie，故不收录。
$mirrorTemplates = @(
    'https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/{ver}/{file}',
    'https://nodejs.org/dist/{ver}/{file}',
    'https://mirrors.huaweicloud.com/nodejs/{ver}/{file}',
    'https://cdn.npmmirror.com/binaries/node/{ver}/{file}',
    'https://registry.npmmirror.com/-/binary/node/{ver}/{file}'
)
$urls = @()
foreach ($t in $mirrorTemplates) {
    $urls += $t.Replace('{ver}', $Version).Replace('{file}', $file)
}

# 已知版本的官方字节数（用于校验；未知版本只做"体积合理 + node.exe 能跑"的检查）。
$knownSize = @{ 'v22.14.0|x64' = 34906389 }
$expectSize = 0
$key = "$Version|$arch"
if ($knownSize.ContainsKey($key)) { $expectSize = $knownSize[$key] }

$StartDeadlineMs = 10000     # 发出请求后多久必须有 64 KiB 以上数据
$StallDeadlineMs = 15000     # 中途多久没有新数据就判停滞
$MinStartBytes = 65536

<#
 .SYNOPSIS
  带"10 秒无进展即换源"的下载：返回 $true 表示成功。
#>
function Invoke-MirrorDownload {
    param([string]$Url, [string]$Dest)
    $req = $null
    $resp = $null
    $inS = $null
    $outS = $null
    try {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) comfy-panel-standalone/1.0'
        $req.AllowAutoRedirect = $true
        $req.Timeout = $StartDeadlineMs              # 连接 + 首字节（响应头）预算
        $req.ReadWriteTimeout = $StallDeadlineMs     # 单次读取超时 = 停滞判定
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $resp = $req.GetResponse()
        $totalRemote = $resp.ContentLength
        $inS = $resp.GetResponseStream()
        $outS = [System.IO.File]::Create($Dest)
        $buf = New-Object byte[] 262144
        $got = 0
        $lastReport = 0
        $lastProgress = $sw.ElapsedMilliseconds
        while ($true) {
            $n = $inS.Read($buf, 0, $buf.Length)
            if ($n -le 0) { break }
            $outS.Write($buf, 0, $n)
            $got += $n
            $lastProgress = $sw.ElapsedMilliseconds
            # 规则一：10 秒内必须真的开始下载（默认门槛 64 KiB；有些站会先回一个校验页）
            if ($got -lt $MinStartBytes -and $sw.ElapsedMilliseconds -gt $StartDeadlineMs) {
                throw ("10 秒内只收到 " + $got + " 字节，判定失败并换源")
            }
            $now = $sw.ElapsedMilliseconds
            if (($now - $lastReport) -ge 2000) {
                $lastReport = $now
                $kbs = 0
                if ($now -gt 0) { $kbs = [math]::Round($got / 1024.0 / ($now / 1000.0), 0) }
                $pct = ''
                if ($totalRemote -gt 0) { $pct = (' ' + [math]::Round($got * 100.0 / $totalRemote, 1) + '%') }
                Write-Host ("      " + [math]::Round($got / 1MB, 2) + " MB" + $pct + "  " + $kbs + " KB/s")
            }
        }
        $outS.Close(); $outS = $null
        $inS.Close(); $inS = $null
        $resp.Close(); $resp = $null
        $sec = [math]::Round($sw.ElapsedMilliseconds / 1000.0, 2)
        $mbps = 0
        if ($sec -gt 0) { $mbps = [math]::Round($got / 1MB / $sec, 2) }
        Write-Info ("  完成：" + [math]::Round($got / 1MB, 2) + " MB / " + $sec + " s = " + $mbps + " MB/s")
        return $true
    } catch {
        Write-Warn2 ("  失败：" + $_.Exception.Message)
        return $false
    } finally {
        foreach ($s in @($outS, $inS, $resp)) { if ($null -ne $s) { try { $s.Close() } catch { } } }
        if (Test-Path $Dest) {
            $len = (Get-Item $Dest).Length
            if ($len -lt $MinStartBytes) { Remove-Item $Dest -Force -ErrorAction SilentlyContinue }
        }
    }
}

$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dcp-node-" + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $tmpDir
$zip = Join-Path $tmpDir $file

$ok = $false
foreach ($u in $urls) {
    Write-Info ("尝试下载：" + $u)
    if (Invoke-MirrorDownload -Url $u -Dest $zip) {
        $len = (Get-Item $zip).Length
        if ($expectSize -gt 0 -and $len -ne $expectSize) {
            Write-Warn2 ("大小不符（期望 " + $expectSize + "，实际 " + $len + "），换下一个源。")
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            continue
        }
        if ($expectSize -eq 0 -and $len -lt 20MB) {
            Write-Warn2 ("下载文件过小（" + $len + " 字节），视为失败。")
            Remove-Item $zip -Force -ErrorAction SilentlyContinue
            continue
        }
        $ok = $true
        break
    }
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
}

if (-not $ok) {
    Write-Warn2 "无法下载便携 Node（全部 " + $urls.Count + " 个来源都不通）。"
    Write-Warn2 "可手动处理：① 安装任意 Node 18+ 后重跑启动器（会自动使用 PATH 里的 node）；"
    Write-Warn2 "            ② 或把官方 node-vX-win-x64.zip 解压后把 node.exe 放到：$NodeExe"
    exit 1
}

Write-Info "解压中…"
$dest = Join-Path $tmpDir 'x'
Expand-Archive -Path $zip -DestinationPath $dest -Force
$inner = Get-ChildItem -Path $dest -Directory | Select-Object -First 1
if (-not $inner) { Write-Warn2 "解压结果异常：没有目录。"; exit 1 }

if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
$null = New-Item -ItemType Directory -Force -Path $NodeDir
# 只搬运运行时真正需要的文件（node.exe + npm 本体，体积可控）
foreach ($f in @('node.exe', 'npm', 'npm.cmd', 'npm.ps1', 'npx', 'npx.cmd', 'npx.ps1', 'nodevars.bat', 'install_tools.bat', 'corepack', 'corepack.cmd')) {
    $src = Join-Path $inner.FullName $f
    if (Test-Path $src) { Copy-Item -Recurse -Force $src (Join-Path $NodeDir $f) }
}
$nm = Join-Path $inner.FullName 'node_modules'
if (Test-Path $nm) { Copy-Item -Recurse -Force $nm (Join-Path $NodeDir 'node_modules') }
Copy-Item -Force (Join-Path $inner.FullName 'LICENSE') (Join-Path $NodeDir 'LICENSE') -ErrorAction SilentlyContinue

Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue

if (Test-Path $NodeExe) {
    # 真正的验收：解出来的 node.exe 必须能跑起来并报版本号。
    $v = ''
    try { $v = (& $NodeExe -v) } catch { $v = '' }
    if ([string]::IsNullOrWhiteSpace($v)) {
        Write-Warn2 "解压完成但 node.exe 无法运行，请重试或手动放置便携 Node。"
        exit 1
    }
    Write-Info ("便携 Node 就绪：" + $NodeExe + "（" + $v + "）")
    exit 0
}
Write-Warn2 "解压完成但未找到 node.exe。"
exit 1
