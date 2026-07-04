$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $PSScriptRoot
$targetRoot = Join-Path ([Environment]::GetFolderPath("MyDocuments")) "GitHub\stockholm-golf-prices"

if (-not (Test-Path -LiteralPath $targetRoot)) {
  throw "GitHub clone was not found at $targetRoot"
}

$files = @(
  "index.html",
  "app.js",
  "styles.css",
  "package.json",
  "README.md",
  ".github\workflows\scrape-and-deploy.yml",
  "scripts\serve-static.mjs",
  "scripts\start-static-server.ps1"
)

foreach ($relativePath in $files) {
  $source = Join-Path $sourceRoot $relativePath
  $target = Join-Path $targetRoot $relativePath
  $targetDirectory = Split-Path -Parent $target

  if (Test-Path -LiteralPath $source) {
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Force
  }
}

Write-Output "Synced mobile dashboard changes to $targetRoot"
