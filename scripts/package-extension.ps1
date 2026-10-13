$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

npm run check

$artifactDir = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force -Path $artifactDir | Out-Null
$version = (Get-Content (Join-Path $root 'dist\manifest.json') -Raw | ConvertFrom-Json).version
$zip = Join-Path $artifactDir "ChatGPT-Deep-Search-Edge-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $root 'dist\*') -DestinationPath $zip -CompressionLevel Optimal
Write-Host "Created: $zip"
