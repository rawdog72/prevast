# Copyright (c) 2026 rawdog72 and Prevast Open Server Contributors
# SPDX-License-Identifier: GPL-2.0-only

# Reproducible, code-drawn currency sprites; no external art dependencies.
Add-Type -AssemblyName System.Drawing
$outputDir = Join-Path $PSScriptRoot '../../apps/client/public/img'
function Brush($hex) { [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($hex)) }
function Draw-Icon($kind, $name, $night = $false, $hovered = $false) {
    $bitmap = [System.Drawing.Bitmap]::new(112,112)
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $ink = Brush '#252c29'; $light = Brush '#eadab5'; $green = Brush '#8fafa0'; $gold = Brush '#d7ab55'
    if ($hovered) { $g.FillEllipse((Brush '#304238'),2,2,108,108) }
    switch ($kind) {
        'cap' {
            $points = [System.Drawing.PointF[]](0..31 | ForEach-Object { $a=$_*[Math]::PI/16; $r=if ($_%2) {36} else {42}; [System.Drawing.PointF]::new(56+[Math]::Cos($a)*$r,56+[Math]::Sin($a)*$r) })
            $g.FillPolygon($ink,$points)
            $g.FillEllipse($green,23,23,66,66); $g.FillEllipse($ink,30,30,52,52); $g.FillEllipse($green,33,33,46,46)
            $g.DrawString('1',[System.Drawing.Font]::new('Arial',27,[System.Drawing.FontStyle]::Bold),$light,43,34)
        }
        'note' {
            $g.TranslateTransform(56,56); $g.RotateTransform(-12); $g.TranslateTransform(-56,-56)
            $g.FillRectangle($ink,10,26,92,62); $g.FillRectangle($green,14,30,84,54)
            $g.DrawRectangle([System.Drawing.Pen]::new('#DAD8B5',2),20,36,72,42)
            $g.FillEllipse($light,37,37,38,40)
            $g.DrawString('100',[System.Drawing.Font]::new('Arial',14,[System.Drawing.FontStyle]::Bold),$ink,37,46)
        }
        'gold' {
            $shape=[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(12,65),[System.Drawing.PointF]::new(26,36),[System.Drawing.PointF]::new(82,24),[System.Drawing.PointF]::new(100,49),[System.Drawing.PointF]::new(93,79),[System.Drawing.PointF]::new(28,92))
            $g.FillPolygon($ink,$shape)
            $g.FillPolygon($gold,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(17,65),[System.Drawing.PointF]::new(30,40),[System.Drawing.PointF]::new(80,29),[System.Drawing.PointF]::new(94,50),[System.Drawing.PointF]::new(80,72),[System.Drawing.PointF]::new(30,85)))
            $g.FillPolygon($light,[System.Drawing.PointF[]]@([System.Drawing.PointF]::new(30,40),[System.Drawing.PointF]::new(80,29),[System.Drawing.PointF]::new(94,50),[System.Drawing.PointF]::new(42,62)))
            $g.DrawLine([System.Drawing.Pen]::new('#866E3B',3),42,63,30,85)
        }
    }
    $g.ResetTransform()
    if ($night) { $g.FillRectangle([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(65,8,19,45)),0,0,112,112) }
    $bitmap.Save((Join-Path $outputDir "$name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bitmap.Dispose(); $ink.Dispose(); $light.Dispose(); $green.Dispose(); $gold.Dispose()
}
foreach ($kind in @('cap','note','gold')) {
    Draw-Icon $kind "inv-npc-$kind-out"
    Draw-Icon $kind "inv-npc-$kind-in" $false $true
    Draw-Icon $kind "inv-npc-$kind-click" $false $true
    Draw-Icon $kind "day-ground-npc-$kind"
    # Use the same silhouette at night; the renderer provides ambient lighting.
    Draw-Icon $kind "night-ground-npc-$kind"
}
$bitmap=[System.Drawing.Bitmap]::new(176,88); $g=[System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode=[System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.FillRectangle((Brush '#27342F'),2,2,172,84)
$g.DrawRectangle([System.Drawing.Pen]::new('#97BBA9',3),3,3,170,82)
$g.DrawString('E',[System.Drawing.Font]::new('Arial',25,[System.Drawing.FontStyle]::Bold),(Brush '#EADAB5'),14,24)
$g.FillEllipse((Brush '#B9D5C4'),69,19,80,45)
$g.FillPolygon((Brush '#B9D5C4'),[System.Drawing.Point[]]@([System.Drawing.Point]::new(86,56),[System.Drawing.Point]::new(80,73),[System.Drawing.Point]::new(106,60)))
foreach ($x in @(88,107,126)) { $g.FillEllipse((Brush '#27342F'),$x,36,7,7) }
$bitmap.Save((Join-Path $outputDir 'e-npc.png'),[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bitmap.Dispose()
