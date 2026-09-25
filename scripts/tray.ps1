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

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    Write-TrayLog ("无法加载 WinForms（{0}）：跳过托盘，控制台保持可见。" -f $_.Exception.Message)
    exit 2
}

function Stop-Backend {
    $killed = @()
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
    Write-TrayLog ("已停止后端：" + ($killed -join ', '))
    return $killed
}

# -StopOnly：只做"停止后端"这一件事（供脚本/自检调用，不建托盘）
if ($StopOnly) {
    $stopped = Stop-Backend
    Write-Host ("[tray] StopOnly 完成，已停止：" + (($stopped -join ', ') -replace '^$', '（没有匹配的进程）'))
    exit 0
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
