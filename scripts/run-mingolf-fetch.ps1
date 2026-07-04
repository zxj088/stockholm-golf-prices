$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if (Test-Path $bundledNode) {
  $node = $bundledNode
} else {
  $node = "node"
}

Set-Location -LiteralPath $root
& $node "scripts\fetch-mingolf-prices.mjs" @args
