<#
pi-clip.ps1 -- grab an image off the Windows clipboard for pi-super-vim.

Called by :Img in vim/pi-super-vim.vim, not by hand:

    pwsh -Sta -File pi-clip.ps1 -Out <ctrl>\<sid>.img3

The clipboard is probed in this order: a bitmap (screenshot), files copied in
Explorer, a path copied as text.  The image bytes are written to <Out>.<ext>
and the verdict to <Out>.res, one line:

    <absolute path of the image>    success
    ERROR: <message>                nothing usable on the clipboard

Everything goes through files and argv, never stdout: no quoting problems with
unicode paths, and :Img can tell success from failure by reading one file.
#>
param(
	[Parameter(Mandatory = $true)][string]$Out,
	[int]$MaxBytes = 4194304
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Write-Result([string]$text) {
	$enc = New-Object System.Text.UTF8Encoding($false)
	[System.IO.File]::WriteAllText($Out + '.res', $text, $enc)
}

# Magic bytes, not the extension: a .png that is really a WebP must not be sent
# as image/png.
function Get-ImageExtension([byte[]]$b) {
	if ($b.Length -ge 8 -and $b[0] -eq 0x89 -and $b[1] -eq 0x50 -and $b[2] -eq 0x4E -and $b[3] -eq 0x47) { return 'png' }
	if ($b.Length -ge 3 -and $b[0] -eq 0xFF -and $b[1] -eq 0xD8 -and $b[2] -eq 0xFF) { return 'jpg' }
	if ($b.Length -ge 6 -and $b[0] -eq 0x47 -and $b[1] -eq 0x49 -and $b[2] -eq 0x46) { return 'gif' }
	if ($b.Length -ge 12 -and $b[0] -eq 0x52 -and $b[1] -eq 0x49 -and $b[2] -eq 0x46 -and $b[3] -eq 0x46 -and
		$b[8] -eq 0x57 -and $b[9] -eq 0x45 -and $b[10] -eq 0x42 -and $b[11] -eq 0x50) { return 'webp' }
	return ''
}

function Format-Size([long]$bytes) {
	if ($bytes -ge 1MB) { return ('{0:N1} MB' -f ($bytes / 1MB)) }
	if ($bytes -ge 1KB) { return ('{0:N0} KB' -f ($bytes / 1KB)) }
	return "$bytes bytes"
}

function Save-Image([byte[]]$bytes, [string]$origin) {
	if ($bytes.Length -eq 0) { throw "clipboard $origin is empty" }
	if ($bytes.Length -gt $MaxBytes) {
		throw ('{0} is {1}, over the {2} limit' -f $origin, (Format-Size $bytes.Length), (Format-Size $MaxBytes))
	}
	$ext = Get-ImageExtension $bytes
	if ($ext -eq '') { throw "$origin is not a PNG/JPEG/GIF/WebP image" }
	$file = $Out + '.' + $ext
	[System.IO.File]::WriteAllBytes($file, $bytes)
	Write-Result $file
}

function Get-ClipboardBytes {
	$img = [System.Windows.Forms.Clipboard]::GetImage()
	if ($img -ne $null) {
		# The clipboard holds a DIB; PNG keeps it lossless and small enough for
		# a screenshot without any resizing.
		$ms = New-Object System.IO.MemoryStream
		try { $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
		return @{ bytes = $ms.ToArray(); origin = 'clipboard image' }
	}

	$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
	if ($files -ne $null -and $files.Count -gt 0) {
		$file = [string]$files[0]
		return @{ bytes = [System.IO.File]::ReadAllBytes($file); origin = $file }
	}

	$text = [System.Windows.Forms.Clipboard]::GetText()
	if (-not [string]::IsNullOrWhiteSpace($text)) {
		$line = (($text.Trim() -split "\r?\n")[0]).Trim()
		if ($line.Length -ge 2 -and (($line.StartsWith('"') -and $line.EndsWith('"')) -or ($line.StartsWith("'") -and $line.EndsWith("'")))) {
			$line = $line.Substring(1, $line.Length - 2)
		}
		if ($line -like 'file://*') { $line = ([uri]$line).LocalPath }
		if ($line -eq '~') { $line = $env:USERPROFILE }
		elseif ($line.StartsWith('~/') -or $line.StartsWith('~\')) { $line = Join-Path $env:USERPROFILE $line.Substring(2) }
		if (-not [System.IO.Path]::IsPathRooted($line)) { $line = Join-Path (Get-Location).Path $line }
		$line = [System.IO.Path]::GetFullPath($line)
		if (-not (Test-Path -LiteralPath $line -PathType Leaf)) { throw "clipboard text is not a file: $line" }
		return @{ bytes = [System.IO.File]::ReadAllBytes($line); origin = $line }
	}

	return $null
}

try {
	$found = Get-ClipboardBytes
	if ($null -eq $found) { throw 'the clipboard holds no image and no image path' }
	Save-Image $found.bytes $found.origin
} catch {
	Write-Result ('ERROR: ' + $_.Exception.Message)
}
