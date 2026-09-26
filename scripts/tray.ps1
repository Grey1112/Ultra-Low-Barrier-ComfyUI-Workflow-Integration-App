# comfy-panel-standalone · 托盘助手
#
# 由 scripts\start.ps1 用 `powershell -WindowStyle Hidden` 拉起：控制台本体随后最小化，
# 用户在系统托盘（Windows 11 里是"后台应用"区域）能看到一个图标，右键菜单可以：
#   · 打开 Web UI（双击图标同样打开）
#   · 打开日志文件
#   · 复制访问地址
#   · 关闭控制台并停止后端（真正退出）
#
# 为什么单独一个进程：Windows PowerShell 的 NotifyIcon 需要消息循环，放在启动器里会挡住启动流程。
# 只用系统自带程序集（System.Windows.Forms / System.Drawing），不引入任何第三方依赖，
# 也不写注册表；图标直接取系统图标，不落任何资源文件。
#
# v1.2.2（R5）"先礼后兵"：退出时**先** POST /app/quit 请后端优雅退出（它会连带停掉自己拉起的
# ComfyUI），等后端自己消失（最多 8 秒）；只有请求失败/超时才回退到原来的 taskkill /T /F 强杀。
# 为什么必须这样：Windows 上 taskkill /F 就是 TerminateProcess，实测不给 node 任何执行机会
# （SIGTERM / SIGINT / SIGBREAK / exit 处理器一个都不跑），直接强杀等于放弃让后端清理 ComfyUI，
# 于是留下"跨进程孤儿"——父链已断，下一次 /T 永远够不着它。
# 另外无论走哪条路径，退出前都会按 data/run 里的归属记录再清一次"本程序拉起的 ComfyUI"。
#
# 参数：
#   -Url        要打开的地址
#   -BackendPid 后端 node 进程号（退出时按进程树结束）
#   -Port       后端端口（取不到 pid 时按端口找监听进程）
#   -LauncherPid 启动器进程号（可选：启动器退出后本图标仍保留，便于继续控制）
#   -StopOnly   只执行"停止后端"这一个动作然后退出（不建托盘；供脚本/自检调用）

[CmdletBinding()]
param(
    [string]$Url = '',
    [int]$BackendPid = 0,
    [int]$Port = 0,
    [int]$LauncherPid = 0,
    [string]$Root = '',
    [switch]$StopOnly
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
$LogFile = Join-Path $Root 'logs\tray.log'
function Write-TrayLog($m) {
    try {
        if (-not (Test-Path (Split-Path -Parent $LogFile))) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogFile) | Out-Null }
        Add-Content -Path $LogFile -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8
    } catch { }
}

# ── v1.2.2：退出先礼后兵 ──────────────────────────────────

function Test-BackendAlive {
    if ($BackendPid -gt 0) {
        return [bool](Get-Process -Id $BackendPid -ErrorAction SilentlyContinue)
    }
    if ($Port -gt 0) {
        try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
    }
    return $false
}

function Get-QuitUrl {
    if (-not [string]::IsNullOrWhiteSpace($Url)) { return ($Url.TrimEnd('/') + '/app/quit') }
    if ($Port -gt 0) { return ('http://127.0.0.1:{0}/app/quit' -f $Port) }
    return ''
}

function Request-GracefulQuit {
    $target = Get-QuitUrl
    if ([string]::IsNullOrWhiteSpace($target)) { return $false }
    try {
        $r = Invoke-WebRequest -Uri $target -Method POST -ContentType 'application/json' -Body '{}' -TimeoutSec 6 -UseBasicParsing
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true }
        Write-TrayLog ('优雅退出请求返回 HTTP {0}。' -f $r.StatusCode)
        return $false
    } catch {
        # 后端收到请求后会主动关掉 HTTP 服务，连接有可能在读响应之前就被断开 —— 这不代表请求没生效。
        # 真正的判据是"后端进程有没有真的消失"，由调用方接着轮询确认。
        Write-TrayLog ('优雅退出请求异常（后端可能已开始退出）：' + $_.Exception.Message)
        return $false
    }
}

function Stop-OwnedComfyUI {
    # 只清"本程序拉起的"：data/run 下由后端写下的归属记录 + 进程存活 + 命令行确实是 ComfyUI main.py。
    # 三条不同时成立就绝不动手 —— 用户自己启动的 ComfyUI 没有任何记录，永远不在候选里。
    # 强杀路径（taskkill /F）下 node 没机会执行自己的清理，这一层就是最后的兜底。
    $runDir = Join-Path $Root 'data\run'
    if (-not (Test-Path $runDir)) { return @() }
    $gone = @()
    $files = @(Get-ChildItem -Path $runDir -Filter 'comfy-owner-*.json' -File -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
        $ownerPid = 0
        try {
            $rec = Get-Content -Path $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $ownerPid = [int]$rec.pid
        } catch { continue }
        if ($ownerPid -le 0 -or $ownerPid -eq $PID) { continue }
        if (-not (Get-Process -Id $ownerPid -ErrorAction SilentlyContinue)) {
            Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
            continue
        }
        $cmd = ''
        try { $cmd = [string](Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $ownerPid) -ErrorAction SilentlyContinue).CommandLine } catch { $cmd = '' }
        if ([string]::IsNullOrWhiteSpace($cmd) -or ($cmd -notmatch 'main\.py')) {
            Write-TrayLog ('归属记录 {0} 未清理（不动手）：命令行不是 ComfyUI main.py。' -f $f.Name)
            continue
        }
        & taskkill.exe /PID $ownerPid /T /F 2>$null | Out-Null
        Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
        $gone += ('pid=' + $ownerPid)
    }
    return $gone
}

$script:StopMode = 'none'

function Stop-Backend {
    $killed = @()
    $graceful = $false
    $aliveAtStart = Test-BackendAlive
    if ($aliveAtStart) {
        Write-TrayLog ('先请求后端优雅退出（POST ' + (Get-QuitUrl) + '，最多等 8 秒）…')
        $null = Request-GracefulQuit
        $deadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $deadline) {
            if (-not (Test-BackendAlive)) { $graceful = $true; break }
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $aliveAtStart) {
        $script:StopMode = 'already-stopped'
        Write-TrayLog '后端本来就不在运行（无需请求优雅退出）。'
    } elseif ($graceful) {
        $script:StopMode = 'graceful'
        Write-TrayLog '优雅退出成功：后端已自行退出，它拉起的 ComfyUI 已由后端退出路径连带停止。'
    } else {
        $script:StopMode = 'forced'
        Write-TrayLog '优雅退出失败或超时（8 秒）→ 回退到强制终止（taskkill /T /F）。'
        if ($BackendPid -gt 0) {
            try {
                & taskkill.exe /PID $BackendPid /T /F 2>$null | Out-Null
                $killed += "pid=$BackendPid"
            } catch { }
        }
        if ($Port -gt 0) {
            try {
                $pids = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
                foreach ($p in $pids) {
                    if ($p -and $p -ne $PID) { & taskkill.exe /PID $p /T /F 2>$null | Out-Null; $killed += "port:$p" }
                }
            } catch { }
        }
        Write-TrayLog ('已强制终止后端：' + ($killed -join ', '))
    }
    # 无论走哪条路径，退出前都按归属记录再清一次"本程序拉起的 ComfyUI"。
    $owned = @(Stop-OwnedComfyUI | Where-Object { $_ })
    if ($owned.Count -gt 0) {
        Write-TrayLog ('已按归属记录终止本程序拉起的 ComfyUI：' + ($owned -join ', '))
    } else {
        Write-TrayLog '归属记录里没有需要清理的 ComfyUI（用户自己启动的实例不会被碰）。'
    }
    return $killed
}

# -StopOnly：只做"停止后端"这一件事（供脚本/自检调用，不建托盘、不需要 WinForms）
if ($StopOnly) {
    $stopped = Stop-Backend
    Write-Host ("[tray] StopOnly 完成（" + $script:StopMode + "）。已强制终止：" + ((@($stopped) -join ', ') -replace '^$', '（无）'))
    exit 0
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    Write-TrayLog ("无法加载 WinForms（{0}）：跳过托盘，控制台保持可见。" -f $_.Exception.Message)
    exit 2
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = '超低门槛 ComfyUI 工作流集成应用（在后台运行）'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开 Web UI')
$openItem.add_Click({ try { Start-Process $Url } catch { Write-TrayLog ("打开浏览器失败：" + $_.Exception.Message) } })
$copyItem = $menu.Items.Add('复制访问地址')
$copyItem.add_Click({
        try { [System.Windows.Forms.Clipboard]::SetText($Url); $notify.ShowBalloonTip(2000, '超低门槛 ComfyUI 工作流集成应用', "已复制：$Url", [System.Windows.Forms.ToolTipIcon]::Info) } catch { }
    })
$logItem = $menu.Items.Add('打开日志文件夹')
$logItem.add_Click({ try { Start-Process explorer.exe (Join-Path $Root 'logs') } catch { } })
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$quitItem = $menu.Items.Add('关闭控制台并停止后端')
$quitItem.add_Click({
        Write-TrayLog '用户选择退出。'
        $null = Stop-Backend
        $notify.Visible = $false
        $notify.Dispose()
        [System.Windows.Forms.Application]::Exit()
        exit 0
    })
$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ try { Start-Process $Url } catch { } })

$notify.ShowBalloonTip(4000, '超低门槛 ComfyUI 工作流集成应用已启动', "Web UI：$Url`n右键托盘图标可退出程序。", [System.Windows.Forms.ToolTipIcon]::Info)
Write-TrayLog ("托盘已就绪：Url=$Url BackendPid=$BackendPid Port=$Port LauncherPid=$LauncherPid")

# 消息循环 + 看护后端：后端没了就自己退出，避免留一个点不动的图标。
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
        $alive = $false
        if ($BackendPid -gt 0) {
            $alive = [bool](Get-Process -Id $BackendPid -ErrorAction SilentlyContinue)
        } elseif ($Port -gt 0) {
            try { $alive = [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch { $alive = $false }
        } else {
            $alive = $true
        }
        if (-not $alive) {
            Write-TrayLog '后端已退出，托盘关闭。'
            $notify.Visible = $false
            $notify.Dispose()
            [System.Windows.Forms.Application]::Exit()
        }
    })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$notify.Dispose()
exit 0
