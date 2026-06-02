param(
  [string]$Version = "1.1.2"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseDir = Join-Path $root "release-assets\$Version-github-dots"
$keyPath = Join-Path $env:USERPROFILE ".tauri\garage-crm.key"

$sourceExe = Join-Path $root "src-tauri\target\release\bundle\nsis\Garage CRM_${Version}_x64-setup.exe"
$sourceMsi = Join-Path $root "src-tauri\target\release\bundle\msi\Garage CRM_${Version}_x64_en-US.msi"
$releaseExe = Join-Path $releaseDir "Garage.CRM_${Version}_x64-setup.exe"
$releaseMsi = Join-Path $releaseDir "Garage.CRM_${Version}_x64_en-US.msi"

if (!(Test-Path $sourceExe)) {
  throw "Missing built EXE: $sourceExe"
}

if (!(Test-Path $sourceMsi)) {
  throw "Missing built MSI: $sourceMsi"
}

if (!(Test-Path $keyPath)) {
  throw "Missing Tauri signing key: $keyPath"
}

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
Copy-Item -LiteralPath $sourceExe -Destination $releaseExe -Force
Copy-Item -LiteralPath $sourceMsi -Destination $releaseMsi -Force

$securePassword = Read-Host "Tauri signing key password" -AsSecureString
$passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

try {
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)

  foreach ($asset in @($releaseExe, $releaseMsi)) {
    $output = & npm.cmd run tauri signer sign -- -f $keyPath $asset 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw ($output -join [Environment]::NewLine)
    }

    $sigPath = "$asset.sig"
    if (!(Test-Path $sigPath)) {
      $signature = $output |
        ForEach-Object {
          if ($_ -match "([A-Za-z0-9+/=]{300,})") {
            $Matches[1]
          }
        } |
        Select-Object -Last 1

      if (!$signature) {
        throw "Signing succeeded but no signature file or signature output was found for $asset"
      }

      Set-Content -LiteralPath $sigPath -Value $signature.Trim() -NoNewline -Encoding ascii
    }
  }
}
finally {
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  if ($passwordPtr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
  }
}

$exeSignature = (Get-Content -Raw "$releaseExe.sig").Trim()
$latest = [ordered]@{
  version = $Version
  notes = "Garage CRM $Version release"
  pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $exeSignature
      url = "https://github.com/Hlopowod/GarageCRM/releases/latest/download/Garage.CRM_${Version}_x64-setup.exe"
    }
  }
}

$latest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $releaseDir "latest.json") -Encoding ascii

Get-ChildItem -File $releaseDir | Sort-Object Name | Select-Object Name, Length, LastWriteTime
