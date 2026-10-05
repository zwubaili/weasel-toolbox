param(
  [string]$NodeVersion = '24.20.0'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$bundleName = "WeaselToolbox-Portable-v$($package.version)-win-x64"
$artifactRoot = Join-Path $projectRoot 'artifacts'
$downloadCache = Join-Path $projectRoot '.cache\downloads'
$tempRoot = Join-Path $artifactRoot ("weasel-toolbox-package-" + [guid]::NewGuid().ToString('N'))
$bundleRoot = Join-Path $tempRoot $bundleName
$appRoot = Join-Path $bundleRoot 'app'
$runtimeRoot = Join-Path $bundleRoot 'runtime'
$archiveName = "$bundleName.zip"
$archivePath = Join-Path $artifactRoot $archiveName
$checksumPath = "$archivePath.sha256"

function Assert-SafeTempPath([string]$PathValue) {
  $resolvedTemp = [IO.Path]::GetFullPath($artifactRoot).TrimEnd('\') + '\'
  $resolvedTarget = [IO.Path]::GetFullPath($PathValue)
  if (-not $resolvedTarget.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -or
      -not ([IO.Path]::GetFileName($resolvedTarget)).StartsWith('weasel-toolbox-package-')) {
    throw "Refusing unsafe temporary path: $resolvedTarget"
  }
}

function Get-Sha256([string]$PathValue) {
  $stream = [IO.File]::OpenRead($PathValue)
  try {
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
      return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha256.Dispose() }
  }
  finally { $stream.Dispose() }
}

try {
  New-Item -ItemType Directory -Path $appRoot,$runtimeRoot,$artifactRoot -Force | Out-Null

  Push-Location $projectRoot
  try { pnpm build } finally { Pop-Location }

  $nodeArchive = "node-v$NodeVersion-win-x64.zip"
  $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeArchive"
  $sumsUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
  New-Item -ItemType Directory -Path $downloadCache -Force | Out-Null
  $downloadedNode = Join-Path $downloadCache $nodeArchive
  $downloadedSums = Join-Path $downloadCache "SHASUMS256-$NodeVersion.txt"
  if (-not (Test-Path -LiteralPath $downloadedNode)) {
    Invoke-WebRequest -Uri $nodeUrl -OutFile $downloadedNode
  }
  if (-not (Test-Path -LiteralPath $downloadedSums)) {
    Invoke-WebRequest -Uri $sumsUrl -OutFile $downloadedSums -TimeoutSec 60
  }
  $sumLine = Get-Content -LiteralPath $downloadedSums | Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchive))$" } | Select-Object -First 1
  if (-not $sumLine) { throw 'Node.js checksum entry was not found.' }
  $expected = ($sumLine -split '\s+')[0].ToLowerInvariant()
  $actual = Get-Sha256 $downloadedNode
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $downloadedNode -Force
    throw 'Node.js archive checksum verification failed; the cached download was removed.'
  }

  $nodeExtract = Join-Path $tempRoot 'node-extracted'
  Expand-Archive -LiteralPath $downloadedNode -DestinationPath $nodeExtract
  $nodeSource = Join-Path $nodeExtract "node-v$NodeVersion-win-x64"
  Copy-Item -LiteralPath (Join-Path $nodeSource 'node.exe') -Destination $runtimeRoot
  Copy-Item -LiteralPath (Join-Path $nodeSource 'LICENSE') -Destination (Join-Path $runtimeRoot 'NODE-LICENSE.txt')

  Copy-Item -LiteralPath (Join-Path $projectRoot 'server.mjs'),(Join-Path $projectRoot 'package.json') -Destination $appRoot
  Copy-Item -LiteralPath (Join-Path $projectRoot 'lib'),(Join-Path $projectRoot 'dist') -Destination $appRoot -Recurse
  New-Item -ItemType Directory -Path (Join-Path $appRoot 'node_modules') -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $projectRoot 'node_modules\yaml') -Destination (Join-Path $appRoot 'node_modules\yaml') -Recurse
  Copy-Item -LiteralPath (Join-Path $projectRoot 'portable\便携版使用说明.txt') -Destination $bundleRoot

  $launcherSource = Get-Content -LiteralPath (Join-Path $projectRoot 'portable\Launcher.cs') -Raw -Encoding UTF8
  Add-Type -TypeDefinition $launcherSource -Language CSharp -OutputAssembly (Join-Path $bundleRoot 'WeaselToolbox.exe') -OutputType WindowsApplication -ReferencedAssemblies 'System.Windows.Forms','System.Drawing'

  $forbidden = Get-ChildItem -LiteralPath $bundleRoot -Recurse -Force | Where-Object {
    $_.Name -eq '.local-data' -or $_.Name -eq 'backups' -or $_.Name -match '\.sqlite($|-)' -or $_.Name -match '\.(log|userdb)$'
  }
  if ($forbidden) { throw "Privacy gate failed: $($forbidden.FullName -join ', ')" }

  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  if (Test-Path -LiteralPath $checksumPath) { Remove-Item -LiteralPath $checksumPath -Force }
  Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
  $archiveHash = Get-Sha256 $archivePath
  Set-Content -LiteralPath $checksumPath -Value "$archiveHash  $archiveName" -Encoding ascii

  [pscustomobject]@{
    Archive = $archivePath
    Checksum = $checksumPath
    Sha256 = $archiveHash
    NodeVersion = $NodeVersion
  }
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Assert-SafeTempPath $tempRoot
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
