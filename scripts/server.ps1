# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

param(
    [ValidateSet('Build', 'Run', 'Validate', 'Selftest')][string]$Action = 'Build',
    [ValidateSet('Release', 'Debug')][string]$Configuration = 'Release',
    [ValidateSet('development', 'benchmark', 'scenario')][string]$Profile = 'development'
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Action -eq 'Build') {
    $msbuild = $env:PREVAST_MSBUILD
    if (-not $msbuild) {
        $locator = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
        if (-not (Test-Path -LiteralPath $locator)) { throw 'Install Visual Studio C++ tools, or set PREVAST_MSBUILD.' }
        $msbuild = & $locator -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
    }
    if (-not $msbuild) { throw 'MSBuild was not found. Set PREVAST_MSBUILD to MSBuild.exe.' }
    & $msbuild (Join-Path $projectRoot 'apps\server\prevast_server.vcxproj') /t:Build "/p:Configuration=$Configuration" /p:Platform=x64 /m:1 /v:minimal /nologo
    exit $LASTEXITCODE
}
& node (Join-Path $PSScriptRoot 'setup.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$binary = Join-Path $projectRoot "dist\server\$Configuration\prevast_server.exe"
if (-not (Test-Path -LiteralPath $binary)) { throw 'Build the game server first: npm run server:build' }
Push-Location (Join-Path $projectRoot "runtime\$Profile")
try {
    if ($Action -eq 'Validate') { & $binary --validate }
    elseif ($Action -eq 'Selftest') { & $binary --selftest (Join-Path $projectRoot 'tests\fixtures\accounts') }
    else { & $binary }
    $result = $LASTEXITCODE
} finally { Pop-Location }
exit $result
