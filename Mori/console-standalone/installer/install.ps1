# Mori Console : installeur Windows (lancé par l'installeur Inno Setup une fois les fichiers copiés)
#   - autorisation des extensions non signées dans Premiere Pro (CEP 9 à 14)
#   - rien d'autre à télécharger : la console n'utilise pas FFmpeg ni yt-dlp

$ErrorActionPreference = 'Stop'
$Target = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.mori.console'

function Step($n, $text) { Write-Host ''; Write-Host "  [$n/2] $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "        OK  $text" -ForegroundColor Green }
function Info($text) { Write-Host "        $text" -ForegroundColor Gray }

Write-Host ''
Write-Host '  Mori Console : installation dans Premiere Pro' -ForegroundColor White
Write-Host '  =============================================' -ForegroundColor DarkGray

try {
  Step 1 'Autorisation de la console dans Premiere Pro'
  foreach ($v in 9..14) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    Set-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -Type String
  }
  Ok 'extensions non signées autorisées (Premiere 2019 à 2026+)'

  Step 2 'Vérification'
  if (-not (Test-Path (Join-Path $Target 'console.html'))) { throw "fichiers absents de $Target" }
  Get-ChildItem -Path $Target -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
  Ok "installée dans $Target"
  # Mori complet déjà là : il contient la console, Mori Console reste inactive
  $mori = Get-ChildItem -Path (Split-Path -Parent $Target) -Directory -ErrorAction SilentlyContinue | Where-Object {
    $m = Join-Path $_.FullName 'CSXS\manifest.xml'
    (Test-Path $m) -and ((Get-Content -Raw -LiteralPath $m) -match 'ExtensionBundleId="com\.mori\.studio\.panel"')
  }
  if ($mori) { Info 'Mori est déjà installé et contient la console : Mori Console restera inactive.' }
  Write-Host ''
  Write-Host '  Installation terminée.' -ForegroundColor Green
  exit 0
} catch {
  Write-Host "        ÉCHEC  $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
