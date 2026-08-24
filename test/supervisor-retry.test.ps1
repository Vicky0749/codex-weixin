$ErrorActionPreference = 'Stop'

$supervisorPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\codex-weixin-supervisor.ps1'
$testRoot = Join-Path $env:TEMP "codex-weixin-supervisor-$PID"
$attemptFile = Join-Path $testRoot 'attempts.txt'
$fakeEntryPath = Join-Path $testRoot 'fake-entry.mjs'
$serviceUrl = 'http://127.0.0.1:18789'
$nodePath = 'C:\nvm4w\nodejs\node.exe'

if (-not (Test-Path -LiteralPath $nodePath)) {
    throw "Node.js is not installed at $nodePath"
}

New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
Set-Content -LiteralPath $fakeEntryPath -Value @'
import fs from "node:fs";
import http from "node:http";

const attemptFile = process.env.SUPERVISOR_TEST_ATTEMPT_FILE;
const serviceUrl = new URL(process.env.SUPERVISOR_TEST_SERVICE_URL);
const attempt = (fs.existsSync(attemptFile) ? Number(fs.readFileSync(attemptFile, "utf8")) : 0) + 1;
fs.writeFileSync(attemptFile, String(attempt));
if (attempt < 2) process.exit(1);

http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"ok":true}');
}).listen(Number(serviceUrl.port), "127.0.0.1");
'@

$env:SUPERVISOR_TEST_ATTEMPT_FILE = $attemptFile
$env:SUPERVISOR_TEST_SERVICE_URL = $serviceUrl
$env:CODEX_WEIXIN_DEBUG_HEALTH = '1'

try {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $supervisorPath `
        -RunOnce `
        -NodePath $nodePath `
        -EntryPath $fakeEntryPath `
        -WorkingDirectory $testRoot `
        -ServiceUrl $serviceUrl `
        -MaxStartupAttempts 2 `
        -StartupAttemptTimeoutSeconds 3 `
        -RetryDelaySeconds 0

    if ($LASTEXITCODE -ne 0) {
        throw "Supervisor exited with code $LASTEXITCODE."
    }

    $attempts = [int](Get-Content -Raw -LiteralPath $attemptFile)
    if ($attempts -ne 2) {
        throw "Expected the supervisor to restart after one failed child process; actual attempts: $attempts."
    }

    $response = Invoke-WebRequest -UseBasicParsing -Uri "$serviceUrl/api/health" -TimeoutSec 2
    if ($response.StatusCode -ne 200 -or $response.Content -notmatch '"ok"\s*:\s*true') {
        throw "Expected the supervisor to preserve the healthy child service."
    }

    Write-Host 'PASS supervisor retries a failed bridge process and leaves a healthy service running.'
}
finally {
    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($fakeEntryPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item Env:SUPERVISOR_TEST_ATTEMPT_FILE -ErrorAction SilentlyContinue
    Remove-Item Env:SUPERVISOR_TEST_SERVICE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:CODEX_WEIXIN_DEBUG_HEALTH -ErrorAction SilentlyContinue
}
