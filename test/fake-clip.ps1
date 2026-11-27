<#
Test double for vim/pi-clip.ps1, used by test/image.mjs.

Same contract (writes <Out>.<ext> plus <Out>.res), but it never touches the
clipboard: it copies the image named by PI_SUPER_VIM_TEST_IMAGE.  That keeps the
test runnable on a machine whose clipboard holds whatever the user last copied.
#>
param(
	[Parameter(Mandatory = $true)][string]$Out,
	[int]$MaxBytes = 4194304
)

$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
$src = $env:PI_SUPER_VIM_TEST_IMAGE

if ([string]::IsNullOrWhiteSpace($src) -or -not (Test-Path -LiteralPath $src -PathType Leaf)) {
	[System.IO.File]::WriteAllText($Out + '.res', 'ERROR: PI_SUPER_VIM_TEST_IMAGE is not a file', $enc)
	exit 1
}
$bytes = [System.IO.File]::ReadAllBytes($src)
if ($bytes.Length -gt $MaxBytes) {
	[System.IO.File]::WriteAllText($Out + '.res', 'ERROR: test image is over the limit', $enc)
	exit 1
}
[System.IO.File]::WriteAllBytes($Out + '.png', $bytes)
[System.IO.File]::WriteAllText($Out + '.res', $Out + '.png', $enc)
