$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$node = "C:\Users\zxj10\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$script = Join-Path $repoRoot "scripts\serve-static.mjs"
$logDir = Join-Path $repoRoot "tmp"
$stdout = Join-Path $logDir "static-server.out.log"
$stderr = Join-Path $logDir "static-server.err.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList "`"$script`"" -WorkingDirectory $repoRoot -RedirectStandardOutput $stdout -RedirectStandardError $stderr
Start-Sleep -Seconds 1

$response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:4173/" -TimeoutSec 5
Write-Output "Static server ready at http://127.0.0.1:4173/ (HTTP $($response.StatusCode))"
