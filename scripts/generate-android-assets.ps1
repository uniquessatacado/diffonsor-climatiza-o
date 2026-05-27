Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$resourceRoot = Join-Path $projectRoot "android\app\src\main\res"
$logoPath = Join-Path $projectRoot "public\logo-diffonso.png"
$iconPath = Join-Path $projectRoot "public\icone-diffonso.png"
$navy = [System.Drawing.Color]::FromArgb(255, 13, 16, 55)

function New-Canvas([int]$width, [int]$height, [bool]$transparent = $false) {
    $canvas = [System.Drawing.Bitmap]::new(
        $width,
        $height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear($(if ($transparent) { [System.Drawing.Color]::Transparent } else { $navy }))
    return @{ Bitmap = $canvas; Graphics = $graphics }
}

function Draw-Contained($graphics, $image, [int]$x, [int]$y, [int]$width, [int]$height) {
    $scale = [Math]::Min($width / $image.Width, $height / $image.Height)
    $renderWidth = [int][Math]::Round($image.Width * $scale)
    $renderHeight = [int][Math]::Round($image.Height * $scale)
    $renderX = $x + [int][Math]::Round(($width - $renderWidth) / 2)
    $renderY = $y + [int][Math]::Round(($height - $renderHeight) / 2)
    $graphics.DrawImage($image, $renderX, $renderY, $renderWidth, $renderHeight)
}

function Save-Canvas($canvas, [string]$path) {
    $canvas.Graphics.Dispose()
    $canvas.Bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $canvas.Bitmap.Dispose()
}

$logo = [System.Drawing.Bitmap]::new($logoPath)
$mark = [System.Drawing.Bitmap]::new($iconPath)

$launcherSizes = @{
    "mipmap-mdpi" = 48
    "mipmap-hdpi" = 72
    "mipmap-xhdpi" = 96
    "mipmap-xxhdpi" = 144
    "mipmap-xxxhdpi" = 192
}

$foregroundSizes = @{
    "mipmap-mdpi" = 108
    "mipmap-hdpi" = 162
    "mipmap-xhdpi" = 216
    "mipmap-xxhdpi" = 324
    "mipmap-xxxhdpi" = 432
}

foreach ($item in $launcherSizes.GetEnumerator()) {
    $size = $item.Value
    $directory = Join-Path $resourceRoot $item.Key
    $icon = New-Canvas $size $size
    $padding = [int][Math]::Round($size * 0.10)
    Draw-Contained $icon.Graphics $mark $padding $padding ($size - (2 * $padding)) ($size - (2 * $padding))
    Save-Canvas $icon (Join-Path $directory "ic_launcher.png")

    $round = New-Canvas $size $size
    Draw-Contained $round.Graphics $mark $padding $padding ($size - (2 * $padding)) ($size - (2 * $padding))
    Save-Canvas $round (Join-Path $directory "ic_launcher_round.png")
}

foreach ($item in $foregroundSizes.GetEnumerator()) {
    $size = $item.Value
    $directory = Join-Path $resourceRoot $item.Key
    $foreground = New-Canvas $size $size $true
    $padding = [int][Math]::Round($size * 0.23)
    Draw-Contained $foreground.Graphics $mark $padding $padding ($size - (2 * $padding)) ($size - (2 * $padding))
    Save-Canvas $foreground (Join-Path $directory "ic_launcher_foreground.png")
}

$splashFiles = Get-ChildItem -Path $resourceRoot -Recurse -Filter "splash.png"
foreach ($file in $splashFiles) {
    $existing = [System.Drawing.Image]::FromFile($file.FullName)
    $width = $existing.Width
    $height = $existing.Height
    $existing.Dispose()
    $splash = New-Canvas $width $height
    $horizontalPadding = [int][Math]::Round($width * 0.08)
    $verticalPadding = [int][Math]::Round($height * 0.20)
    Draw-Contained $splash.Graphics $logo $horizontalPadding $verticalPadding ($width - (2 * $horizontalPadding)) ($height - (2 * $verticalPadding))
    Save-Canvas $splash $file.FullName
}

$logo.Dispose()
$mark.Dispose()
