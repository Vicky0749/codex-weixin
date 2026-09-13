param(
    [switch]$RunOnce,
    [string]$NodePath = "",
    [string]$EntryPath = "",
    [string]$WorkingDirectory = "",
    [string]$ServiceUrl = "http://127.0.0.1:18787",
    [string[]]$NodeArguments = @(),
    [ValidateRange(1, 10)]
    [int]$MaxStartupAttempts = 3,
    [ValidateRange(1, 60)]
    [int]$StartupAttemptTimeoutSeconds = 20,
    [ValidateRange(0, 60)]
    [int]$RetryDelaySeconds = 3,
    [ValidateRange(5, 300)]
    [int]$HealthCheckIntervalSeconds = 30
)

$ErrorActionPreference = "Stop"
$packageRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $PSScriptRoot "codex-weixin-launcher.ps1"
$logDirectory = Join-Path $env:LOCALAPPDATA "CodexWeixin\logs"
$port = ([uri]$ServiceUrl).Port
$mutex = [Threading.Mutex]::new($false, "Local\CodexWeixinSupervisor-$port")
$hasLock = $false

function Write-SupervisorLog {
    param([string]$Message)

    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $path = Join-Path $logDirectory ("supervisor-{0}.log" -f (Get-Date -Format "yyyyMMdd"))
    Add-Content -LiteralPath $path -Value "$stamp $Message"
}

function Test-CodexWeixinHealth {
    try {
        $request = [System.Net.HttpWebRequest]::Create("$ServiceUrl/api/health")
        $request.Proxy = $null
        $request.Timeout = 5000
        $request.ReadWriteTimeout = 5000
        $response = [System.Net.HttpWebResponse]$request.GetResponse()
        try {
            if ([int]$response.StatusCode -ne 200) {
                return $false
            }
            $reader = [IO.StreamReader]::new($response.GetResponseStream())
            try {
                $body = $reader.ReadToEnd() | ConvertFrom-Json
                return $body.ok -eq $true
            }
            finally {
                $reader.Dispose()
            }
        }
        finally {
            $response.Dispose()
        }
    }
    catch {
        if ($env:CODEX_WEIXIN_DEBUG_HEALTH -eq "1") {
            Write-SupervisorLog "Health probe failed: $($_.Exception.Message)"
        }
        return $false
    }
}

function Get-BridgeProcessIds {
    param([string]$ExpectedEntryPath)

    return @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf($ExpectedEntryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        } |
        Select-Object -ExpandProperty ProcessId)
}

function Stop-BridgeProcesses {
    param([string[]]$ProcessIds)

    foreach ($processId in $ProcessIds) {
        if ($processId -eq $PID) {
            continue
        }
        Write-SupervisorLog "Stopping unhealthy bridge process $processId."
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Test-PortHeldByAnotherProgram {
    param([int]$ExpectedPort, [string[]]$BridgeProcessIds)

    $listeners = @(Get-NetTCPConnection -LocalPort $ExpectedPort -State Listen -ErrorAction SilentlyContinue)
    if (-not $listeners.Count) {
        return $false
    }
    $bridgeIds = @($BridgeProcessIds | ForEach-Object { [int]$_ })
    return @($listeners | Where-Object { $bridgeIds -notcontains [int]$_.OwningProcess }).Count -gt 0
}

function Start-OrRecoverBridge {
    if (Test-CodexWeixinHealth) {
        return $true
    }

    $bridgeProcessIds = Get-BridgeProcessIds -ExpectedEntryPath $EntryPath
    if ($bridgeProcessIds.Count) {
        Stop-BridgeProcesses -ProcessIds $bridgeProcessIds
        Start-Sleep -Milliseconds 500
    }
    if (Test-PortHeldByAnotherProgram -ExpectedPort $port -BridgeProcessIds (Get-BridgeProcessIds -ExpectedEntryPath $EntryPath)) {
        Write-SupervisorLog "Port $port is occupied by another program; waiting without touching that process."
        return $false
    }

    try {
        Write-SupervisorLog "Starting bridge through the controlled launcher."
        & $launcherPath `
            -NoOpen `
            -NodePath $NodePath `
            -EntryPath $EntryPath `
            -WorkingDirectory $WorkingDirectory `
            -ServiceUrl $ServiceUrl `
            -NodeArguments $NodeArguments `
            -MaxStartupAttempts $MaxStartupAttempts `
            -StartupAttemptTimeoutSeconds $StartupAttemptTimeoutSeconds `
            -RetryDelaySeconds $RetryDelaySeconds
        if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            throw "Launcher exited with code $LASTEXITCODE."
        }
    }
    catch {
        Write-SupervisorLog "Bridge launch failed: $($_.Exception.Message)"
        return $false
    }

    if (Test-CodexWeixinHealth) {
        Write-SupervisorLog "Bridge health is restored."
        return $true
    }
    Write-SupervisorLog "Bridge did not pass its health check after startup."
    return $false
}

try {
    try {
        $hasLock = $mutex.WaitOne(0, $false)
    }
    catch [Threading.AbandonedMutexException] {
        $hasLock = $true
    }
    if (-not $hasLock) {
        Write-SupervisorLog "Another Codex Weixin supervisor already owns port $port."
        exit 0
    }

    if ([string]::IsNullOrWhiteSpace($NodePath)) {
        $nvmNodePath = "C:\nvm4w\nodejs\node.exe"
        $NodePath = if (Test-Path -LiteralPath $nvmNodePath) { $nvmNodePath } else { (Get-Command node.exe -ErrorAction Stop).Source }
    }
    if ([string]::IsNullOrWhiteSpace($EntryPath)) {
        $EntryPath = Join-Path $packageRoot "dist\server\index.js"
    }
    if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
        $WorkingDirectory = $packageRoot
    }
    if (-not (Test-Path -LiteralPath $NodePath)) {
        throw "Node.js is not installed at $NodePath"
    }
    if (-not (Test-Path -LiteralPath $EntryPath)) {
        throw "The Codex Weixin bridge entry point is unavailable at $EntryPath"
    }

    $failureCount = 0
    while ($true) {
        if (Start-OrRecoverBridge) {
            $failureCount = 0
            if ($RunOnce) {
                exit 0
            }
            Start-Sleep -Seconds $HealthCheckIntervalSeconds
            continue
        }

        $failureCount++
        if ($RunOnce) {
            throw "The bridge did not become healthy. See $logDirectory for supervisor logs."
        }
        $delaySeconds = [Math]::Min(300, 5 * [Math]::Pow(2, [Math]::Min($failureCount - 1, 6)))
        Write-SupervisorLog "Bridge remains unhealthy; retry $failureCount after $delaySeconds seconds."
        Start-Sleep -Seconds ([int]$delaySeconds)
    }
}
finally {
    if ($hasLock) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
