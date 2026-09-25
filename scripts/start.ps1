# comfy-panel-standalone · 启动器（Windows PowerShell 5.1 与 7 都能跑）
#
# 设计要点：
#   1. 全部路径从**脚本自身位置**推导（$PSScriptRoot 的上一级 = 项目根），
#      所以项目文件夹改名 / 换盘符 / 整体拷到另一台电脑后仍然能启动（可迁移性硬性要求）。
#   2. 运行时优先用随项目携带的便携 Node（runtime\node\node.exe）；
#      找不到才用 PATH 里的 node；再找不到就调 bootstrap 下载（需要网络）。
#   3. 控制台按 UTF-8 输出，避免中文日志在 cmd 里变乱码。
#
# 参数：
#   -Port <n>    指定后端端口（默认取 data\settings.json 里的值，否则 8788）
#   -Lan         本次以局域网模式监听（等价于在设置页打开局域网开关）
#   -NoBrowser   不自动打开浏览器
#   -NoTray      不装托盘图标、也不最小化控制台（默认：就绪后最小化到任务栏 + 常驻托盘图标）
#   -Foreground  把后端日志直接打到当前控制台（默认写 logs\server.log 并跟随）

[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$Lan,
    [switch]$NoBrowser,
    [switch]$NoTray,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

# ── 控制台 UTF-8 ──────────────────────────────────────────
try {
    $null = & chcp.com 65001 2>$null
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }

function Write-Info($m) { Write-Host ("[启动器] " + $m) }
function Write-Warn2($m) { Write-Host ("[启动器][警告] " + $m) -ForegroundColor Yellow }
function Write-Err2($m) { Write-Host ("[启动器][错误] " + $m) -ForegroundColor Red }

# ── 路径推导（相对，不写死任何机器路径） ──────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Split-Path -Parent $ScriptDir
if (-not (Test-Path (Join-Path $Root 'server\index.js'))) {
    Write-Err2 "在 $Root 下找不到 server\index.js —— 请从项目内的 scripts 目录运行本脚本。"
    exit 1
}

$NodeExe = Join-Path $Root 'runtime\node\node.exe'
$ServerJs = Join-Path $Root 'server\index.js'
$LogDir = Join-Path $Root 'logs'
$OutLog = Join-Path $LogDir 'server-console.out.log'
$ErrLog = Join-Path $LogDir 'server-console.err.log'
$SettingsFile = Join-Path $Root 'data\settings.json'

foreach ($d in @($LogDir, (Join-Path $Root 'data'), (Join-Path $LogDir 'jobs'))) {
    if (-not (Test-Path $d)) { $null = New-Item -ItemType Directory -Force -Path $d }
}

# ── 找 Node 运行时 ────────────────────────────────────────
function Resolve-Node {
    if (Test-Path $NodeExe) { return $NodeExe }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        try {
            $v = (& $cmd.Source -v) -replace '^v', ''
            $major = [int]($v.Split('.')[0])
            if ($major -ge 18) {
                Write-Warn2 "使用系统 Node（$v）：$($cmd.Source)"
                return $cmd.Source
            }
            Write-Warn2 "系统 Node 版本过低（$v），需要 18 及以上。"
        } catch { }
    }
    $bootstrap = Join-Path $ScriptDir 'bootstrap.ps1'
    if (Test-Path $bootstrap) {
        Write-Info "未找到可用 Node，开始获取便携运行时（runtime\node）…"
        & $bootstrap -Root $Root
        if (Test-Path $NodeExe) { return $NodeExe }
    }
    return $null
}

# ── 端口 ─────────────────────────────────────────────────
function Read-SettingPort {
    if (Test-Path $SettingsFile) {
        try {
            $raw = [System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8)
            $raw = $raw.TrimStart([char]0xFEFF)
            $j = $raw | ConvertFrom-Json
            if ($j.listen -and $j.listen.port) { return [int]$j.listen.port }
        } catch { }
    }
    return 8788
}

$BasePort = if ($Port -gt 0) { $Port } else { Read-SettingPort }
$Host0 = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }

$node = Resolve-Node
if (-not $node) {
    Write-Err2 "没有可用的 Node 运行时。请联网后重跑本脚本（会自动下载便携 Node），或手动把 node.exe 放到 runtime\node\ 下。"
    exit 1
}

Write-Info ("项目根目录：" + $Root)
Write-Info ("Node：" + $node)
Write-Info ("后端：http://" + $(if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }) + ":" + $BasePort + "/")

# ── 启动后端 ─────────────────────────────────────────────
$env:DCP_PORT = [string]$BasePort
if ($Lan) { $env:DCP_HOST = '0.0.0.0' }

if ($Foreground) {
    & $node $ServerJs
    exit $LASTEXITCODE
}

# 红线：路径一律加引号。项目路径常含空格（例如 "…\COMFY UI\…"），
# Start-Process 的 -ArgumentList 是按空格拼命令行的，不加引号会被拆成两个参数，
# node 只会拿到前半截 → "Cannot find module '<盘符>:\...\<项目根前半截>'"（实测踩过）。
$proc = Start-Process -FilePath $node -ArgumentList @("`"$ServerJs`"") -WorkingDirectory $Root -PassThru -NoNewWindow -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog

# ── 等就绪（最多 60 秒；端口被占用时后端会自增，所以多试几个） ──
$ready = $null
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { break }
    for ($p = $BasePort; $p -le ($BasePort + 20); $p++) {
        try {
            $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ("http://127.0.0.1:" + $p + "/app/state")
            if ($r.StatusCode -eq 200) { $ready = $p; break }
        } catch { }
    }
    if ($ready) { break }
    Start-Sleep -Milliseconds 700
}

if (-not $ready) {
    Write-Err2 "后端在 60 秒内没有就绪。最后几行输出："
    if (Test-Path $OutLog) { Get-Content $OutLog -Tail 15 | ForEach-Object { Write-Host ("  " + $_) } }
    if (Test-Path $ErrLog) { Get-Content $ErrLog -Tail 15 | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor Red } }
    try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    exit 1
}

$url = "http://127.0.0.1:" + $ready + "/"
Write-Info ("已就绪：" + $url)
Write-Info ("日志：" + $OutLog + " ｜ " + (Join-Path $LogDir 'server.log'))
if ($Lan) {
    $lanUrls = Select-String -Path $OutLog -Pattern '局域网地址：' -ErrorAction SilentlyContinue
    if ($lanUrls) { Write-Info $lanUrls[0].Line }
}
Write-Info "要退出：托盘图标右键 → 关闭控制台并停止后端；或在本窗口按 Ctrl+C。"

# ── 自动打开 Web UI（要求：启用控制台即自动打开界面） ──────
if (-not $NoBrowser) {
    try { Start-Process $url; Write-Info "已自动打开 Web UI。" } catch { Write-Warn2 "无法自动打开浏览器，请手动访问上面的地址。" }
}

# ── 托盘图标 + 控制台最小化 ───────────────────────────────
# 说明：托盘助手是独立进程（需要消息循环），控制台随后最小化到任务栏；
# 托盘菜单可「打开 Web UI / 复制访问地址 / 打开日志 / 关闭控制台并停止后端」。
$trayStarted = $false
if (-not $NoTray -and -not $Foreground) {
    $trayScript = Join-Path $ScriptDir 'tray.ps1'
    if (Test-Path $trayScript) {
        try {
            $trayArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
                '-File', "`"$trayScript`"",
                '-Url', "`"$url`"",
                '-BackendPid', [string]$proc.Id,
                '-Port', [string]$ready,
                '-Root', "`"$Root`"")
            Start-Process -FilePath 'powershell.exe' -ArgumentList $trayArgs -WindowStyle Hidden | Out-Null
            $trayStarted = $true
            Write-Info "托盘图标已就绪（右键可退出）。控制台将最小化到任务栏。"
        } catch {
            Write-Warn2 ("托盘启动失败（{0}）：控制台保持可见，可用 Ctrl+C 退出。" -f $_.Exception.Message)
        }
    } else {
        Write-Warn2 "未找到 scripts\tray.ps1，跳过托盘。"
    }
}

if ($trayStarted) {
    # 把控制台窗口最小化（不隐藏：用户还能从任务栏找回它看输出）
    try {
        Add-Type -Namespace Dcp -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr GetConsoleWindow();
'@ -ErrorAction Stop
        $hwnd = [Dcp.Win]::GetConsoleWindow()
        if ($hwnd -ne [System.IntPtr]::Zero) { $null = [Dcp.Win]::ShowWindow($hwnd, 6) }   # 6 = SW_MINIMIZE
    } catch {
        Write-Warn2 ("最小化控制台失败（{0}）：保持可见。" -f $_.Exception.Message)
    }
}

# ── 跟随日志，直到后端退出 ────────────────────────────────
try {
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 1
    }
} finally {
    if (-not $proc.HasExited) { try { $proc.Kill() } catch { } }
}
Write-Info ("后端已退出（exit " + $proc.ExitCode + "）。")
exit $proc.ExitCode
