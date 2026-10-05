param(
  [string]$Archive = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\WeaselToolbox-Portable-v0.4.1-win-x64.zip'),
  [int]$Port = 43188
)

$ErrorActionPreference = 'Stop'
$testRoot = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts') ('weasel-toolbox-smoke-' + [guid]::NewGuid().ToString('N'))
$process = $null

function Assert-SafeSmokePath([string]$PathValue) {
  $tempPrefix = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts')).TrimEnd('\') + '\'
  $target = [IO.Path]::GetFullPath($PathValue)
  if (-not $target.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not ([IO.Path]::GetFileName($target)).StartsWith('weasel-toolbox-smoke-')) {
    throw "Refusing unsafe smoke-test path: $target"
  }
}

try {
  New-Item -ItemType Directory -Path $testRoot | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $testRoot
  $bundle = Get-ChildItem -LiteralPath $testRoot -Directory | Select-Object -First 1
  if (-not $bundle) { throw 'Portable bundle directory was not found.' }

  $forbidden = Get-ChildItem -LiteralPath $bundle.FullName -Recurse -Force | Where-Object {
    $_.Name -eq '.local-data' -or $_.Name -eq 'backups' -or
    $_.Name -match '\.sqlite($|-)' -or $_.Name -match '\.(log|userdb)$'
  }
  if ($forbidden) { throw "Forbidden content: $($forbidden.FullName -join ', ')" }

  $env:TOOLBOX_STATIC = '1'
  $env:TOOLBOX_PORT = [string]$Port
  $node = Join-Path $bundle.FullName 'runtime\node.exe'
  $server = Join-Path $bundle.FullName 'app\server.mjs'
  $process = Start-Process -FilePath $node -ArgumentList $server -WorkingDirectory (Join-Path $bundle.FullName 'app') -WindowStyle Hidden -PassThru

  $html = $null
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try {
      $html = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/").Content
      break
    }
    catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $html) { throw 'Portable server did not become ready.' }
  if ($html -notmatch "__TOOLBOX_TOKEN__='([a-f0-9]+)'") { throw 'API token was not embedded in HTML.' }
  $token = $Matches[1]

  $assetMatches = [regex]::Matches($html, '(?:src|href)="(/assets/[^"]+)"')
  if ($assetMatches.Count -lt 2) { throw 'Built asset links were not found.' }
  foreach ($match in $assetMatches) {
    $null = Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:$Port" + $match.Groups[1].Value)
  }
  $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -Headers @{ 'x-toolbox-token' = $token }

  [pscustomobject]@{
    Root = 200
    Assets = $assetMatches.Count
    Api = 200
    ForbiddenFiles = $forbidden.Count
    BundleFiles = (Get-ChildItem -LiteralPath $bundle.FullName -Recurse -File).Count
  }
}
finally {
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
    $null = $process.WaitForExit(5000)
  }
  Remove-Item Env:TOOLBOX_STATIC -ErrorAction SilentlyContinue
  Remove-Item Env:TOOLBOX_PORT -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $testRoot) {
    Assert-SafeSmokePath $testRoot
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
