# Tray icon for API Key Pool Proxy
# Zero-dependency: uses NotifyIcon + Process
# Icon color: GREEN = proxy running, RED = proxy stopped

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$proxyDir = Split-Path -Parent $MyInvocation.MyCommand.Path
# ─── Locate a valid node.exe (runtime version may change; never hardcode) ───
function Find-Node {
    $candidates = New-Object System.Collections.ArrayList

    # 1) WorkBuddy managed runtimes (skip leftover .deleting dirs)
    $versionsDir = "C:\Users\55007\.workbuddy\binaries\node\versions"
    if (Test-Path $versionsDir) {
        $found = Get-ChildItem -Path $versionsDir -Filter "node.exe" -Recurse -File -ErrorAction SilentlyContinue |
                 Where-Object { $_.FullName -notmatch '\.deleting' } |
                 Sort-Object -Property FullName -Descending |
                 ForEach-Object { $_.FullName }
        foreach ($f in $found) { [void]$candidates.Add($f) }
    }

    # 2) System-installed node
    [void]$candidates.Add("D:\node\node.exe")

    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }

    # 3) Fallback: node on PATH
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    return $null
}

$nodeExe = Find-Node
if (-not $nodeExe) { Write-Host "WARNING: node.exe not found in any known location" }
$proxyScript = Join-Path $proxyDir "retry-proxy.js"
$manageUrl = "http://127.0.0.1:9120"
$proxyPort = 9119
$modelsJson = "C:\Users\55007\.workbuddy\models.json"

# ─── Switch models.json between proxy URLs and direct URLs ───
# Proxy 停掉后 WorkBuddy 必须能直连回原供应商，否则会一直报错
function Switch-ModelsJson {
    param([bool]$toProxy)
    if (-not (Test-Path $modelsJson)) { return }
    try {
        $content = [System.IO.File]::ReadAllText($modelsJson)
        if ($toProxy) {
            if ($content -match "localhost:9119") { return }  # 已是代理
            $content = $content -replace "https://tokenrhythm.studio/v1", "http://localhost:9119/tr/v1"
            $content = $content -replace "https://token.sensenova.cn/v1/chat/completions", "http://localhost:9119/sn/v1/chat/completions"
            $content = $content -replace "https://api.teamorouter.cn/v1", "http://localhost:9119/tm/v1"
        } else {
            if ($content -notmatch "localhost:9119") { return }  # 已是直连
            $content = $content -replace "http://localhost:9119/tr/v1", "https://tokenrhythm.studio/v1"
            $content = $content -replace "http://localhost:9119/sn/v1/chat/completions", "https://token.sensenova.cn/v1/chat/completions"
            $content = $content -replace "http://localhost:9119/tm/v1", "https://api.teamorouter.cn/v1"
        }
        # 无 BOM 写入（UTF8Encoding $false），避免 JSON 解析失败
        $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($modelsJson, $content, $utf8NoBom)
        Write-Host "models.json switched to $($(if ($toProxy) { 'proxy' } else { 'direct' })) URLs"
    } catch {
        Write-Host "Switch-ModelsJson error: $($_.Exception.Message)"
    }
}

# ─── Build icons ───
function New-TrayIcon {
    param($color, $letter)
    $bmp = New-Object System.Drawing.Bitmap(32, 32)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $brushBg = New-Object System.Drawing.SolidBrush($color)
    $g.FillEllipse($brushBg, 2, 2, 28, 28)
    $brushFg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font("Segoe UI", 13, [System.Drawing.FontStyle]::Bold)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $g.DrawString($letter, $font, $brushFg, (New-Object System.Drawing.RectangleF(0, 0, 32, 32)), $sf)
    # Release GDI objects
    $sf.Dispose()
    $font.Dispose()
    $brushFg.Dispose()
    $brushBg.Dispose()
    $g.Dispose()
    # Get handle BEFORE disposing bitmap (GetHicon on disposed bitmap throws "参数无效")
    $hIcon = $bmp.GetHicon()
    $bmp.Dispose()
    return [System.Drawing.Icon]::FromHandle($hIcon)
}

$green = [System.Drawing.Color]::FromArgb(74, 222, 128)
$red = [System.Drawing.Color]::FromArgb(248, 113, 113)
$iconGreen = New-TrayIcon -color $green -letter "P"
$iconRed = New-TrayIcon -color $red -letter "P"

# ─── Create tray icon ───
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconRed
$notify.Text = "Key Pool Proxy (Stopped)"
$notify.Visible = $true

# Track proxy process
$proxyProcess = $null
$proxyRunning = $false

# ─── Check if proxy port is actually listening (survives external starts) ───
function Test-ProxyPort {
    $conn = Get-NetTCPConnection -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue
    return ($null -ne $conn)
}

function Update-IconStatus {
    $script:proxyRunning = Test-ProxyPort
    if ($script:proxyRunning) {
        $script:notify.Icon = $iconGreen
        $script:notify.Text = "Key Pool Proxy (Running) - :$proxyPort"
    } else {
        $script:notify.Icon = $iconRed
        $script:notify.Text = "Key Pool Proxy (Stopped)"
    }
    $script:itemStart.Enabled = -not $script:proxyRunning
    $script:itemStop.Enabled = $script:proxyRunning
}

function Start-Proxy {
    param($nodeExe, $proxyScript)
    if ($script:proxyRunning) { return }
    if (-not $nodeExe) {
        $script:notify.ShowBalloonTip(6000, "Key Pool Proxy", "找不到 node.exe，无法启动代理", [System.Windows.Forms.ToolTipIcon]::Error)
        Write-Host "ERROR: node.exe not found, cannot start proxy"
        return
    }
    # Launch node with FULLY HIDDEN window (no taskbar icon, no console flash)
    Start-Process -FilePath $nodeExe -ArgumentList "`"$proxyScript`"" -WindowStyle Hidden
    Start-Sleep -Milliseconds 800
    Switch-ModelsJson -toProxy $true
    Update-IconStatus
    Write-Host "Proxy start requested (hidden window)"
}

function Stop-Proxy {
    # Kill whatever is listening on the proxy port (not just our tracked PID)
    $conns = Get-NetTCPConnection -LocalPort $proxyPort -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    Switch-ModelsJson -toProxy $false
    Update-IconStatus
    Write-Host "Proxy stopped"
}

# ─── Build context menu ───
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemManage = New-Object System.Windows.Forms.ToolStripMenuItem
$itemManage.Text = "打开管理页面"
$itemManage.Add_Click({
    Start-Process $manageUrl
})

$itemStart = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStart.Text = "启动代理"
$itemStart.Add_Click({
    Start-Proxy -nodeExe $nodeExe -proxyScript $proxyScript
})

$itemStop = New-Object System.Windows.Forms.ToolStripMenuItem
$itemStop.Text = "停止代理"
$itemStop.Enabled = $false
$itemStop.Add_Click({
    Stop-Proxy
})

$itemSep1 = New-Object System.Windows.Forms.ToolStripSeparator

# ─── Auto-start on boot (HKCU Run key -> silent VBS launch) ───
$runKeyPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runKeyName = 'KeyPoolProxy'
$vbsPath = Join-Path $proxyDir "启动代理.vbs"

$itemAuto = New-Object System.Windows.Forms.ToolStripMenuItem
$itemAuto.Text = "开机自启（静默）"
$itemAuto.CheckOnClick = $true
if (Test-Path $vbsPath) {
    $existing = Get-ItemProperty -Path $runKeyPath -Name $runKeyName -ErrorAction SilentlyContinue
    $itemAuto.Checked = ($null -ne $existing -and $existing.$runKeyName -like "*$vbsPath*")
} else {
    $itemAuto.Enabled = $false
    Write-Host "WARNING: $vbsPath not found, auto-start menu disabled"
}
$itemAuto.Add_Click({
    if ($script:itemAuto.Checked) {
        # Silent boot: wscript runs the zero-window VBS, which relaunches the tray
        Set-ItemProperty -Path $runKeyPath -Name $runKeyName -Value "wscript.exe `"$vbsPath`""
        Write-Host "Auto-start ENABLED (Run key -> wscript $vbsPath)"
    } else {
        Remove-ItemProperty -Path $runKeyPath -Name $runKeyName -ErrorAction SilentlyContinue
        Write-Host "Auto-start DISABLED (Run key removed)"
    }
})

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem
$itemExit.Text = "退出"
$itemExit.Add_Click({
    Stop-Proxy
    $script:notify.Visible = $false
    $script:notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
})

$menu.Items.AddRange(@($itemManage, $itemSep1, $itemStart, $itemStop, $itemAuto, $itemExit))
$notify.ContextMenuStrip = $menu

# Double-click opens management page
$notify.Add_MouseDoubleClick({
    Start-Process $manageUrl
})

# ─── Timer: poll port status every 2s, auto-update icon color ───
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({
    Update-IconStatus
})
$timer.Start()

# Auto-start proxy on launch (if not already running)
Update-IconStatus
if (-not $script:proxyRunning) {
    Start-Proxy -nodeExe $nodeExe -proxyScript $proxyScript
}

# Keep script alive
Write-Host "Tray icon running (green=running, red=stopped). Right-click for options."
[System.Windows.Forms.Application]::Run()
