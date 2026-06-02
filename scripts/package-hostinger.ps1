param(
  [switch]$SkipBuild,
  [string]$Stamp = (Get-Date -Format "yyyyMMdd-HHmmss")
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outputDir = Join-Path $root "release-assets\hostinger"
$sourceZip = Join-Path $outputDir "garage-crm-hostinger-source-$Stamp.zip"
$distZip = Join-Path $outputDir "garage-crm-web-dist-$Stamp.zip"

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

if (!$SkipBuild) {
  Push-Location $root
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

Remove-Item -LiteralPath $sourceZip, $distZip -ErrorAction SilentlyContinue

$sourceItems = @(
  "package.json",
  "package-lock.json",
  "index.html",
  "vite.config.js",
  ".env.example",
  "hostinger.env.example",
  "public",
  "src",
  "docs\HOSTINGER.md"
)

$sourcePaths = $sourceItems | ForEach-Object { Join-Path $root $_ }
$missing = $sourcePaths | Where-Object { !(Test-Path $_) }
if ($missing) {
  throw "Cannot create Hostinger source package. Missing: $($missing -join ', ')"
}

Compress-Archive -Path $sourcePaths -DestinationPath $sourceZip -Force
Compress-Archive -Path (Join-Path $root "dist\*") -DestinationPath $distZip -Force

Write-Host "Created Hostinger packages:"
Write-Host "  $sourceZip"
Write-Host "  $distZip"
