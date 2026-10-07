# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

# Rasterises the icons and ground sprites tools/assets/mp5-mod-art.mjs wrote to
# build/mod-art into apps/client/public/img. Needs Inkscape 1.x on PATH, or its
# path in $env:INKSCAPE. Run only when the art changes; the PNGs are committed.
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
$inkscape = if ($env:INKSCAPE) { $env:INKSCAPE } else { (Get-Command inkscape).Source }
$source = Join-Path $root 'build/mod-art'
$target = Join-Path $root 'apps/client/public/img'
Get-ChildItem $source -Filter *.svg | ForEach-Object {
    $out = Join-Path $target ($_.BaseName + '.png')
    & $inkscape $_.FullName --export-type=png "--export-filename=$out" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Inkscape failed on $($_.Name)" }
}
Write-Output "Rasterised $((Get-ChildItem $source -Filter *.svg).Count) sprites into $target"
