<#
.SYNOPSIS
    Confirms the HID axis and button mapping against the physical gamepad.

.DESCRIPTION
    Streams the pad's raw HID input reports for N seconds and reports, per byte
    position, the observed minimum and maximum. That answers, from the device
    itself, which bytes are analog (the sticks), which are digital (buttons,
    hat), and which never change.

    Use it when the axis mapping looks wrong, or to confirm a new pad:
      * a byte whose range is large and centred on 0x80 is an analog axis
      * a byte that only ever takes two values is a button or hat field
      * a byte that never changes is padding

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File host/test-hid.ps1 -Seconds 20
#>
[CmdletBinding()]
param(
    [int]$Seconds = 20,
    [int]$DeviceIndex = 0
)

$ErrorActionPreference = 'Stop'

Write-Host ''
Write-Host '  Move each stick FULLY through its range, then press every button.' -ForegroundColor Cyan
Write-Host "  Recording for $Seconds seconds..." -ForegroundColor Cyan
Write-Host ''

# Reuse the reader's interop by dot-sourcing only its type definitions.
$readerPath = Join-Path $PSScriptRoot 'pad-reader.ps1'
$text = Get-Content $readerPath -Raw
$m = [regex]::Match($text, "(?s)Add-Type -Namespace PadHid -Name Native -MemberDefinition @'(.*?)'@")
if (-not $m.Success) { throw "could not extract the HID interop from $readerPath" }
if (-not ('PadHid.Native' -as [type])) {
    Add-Type -Namespace PadHid -Name Native -MemberDefinition $m.Groups[1].Value
}

$devs = [PadHid.Native]::Enumerate()
$pads = @($devs | Where-Object {
    $_.UsagePage -eq 1 -and ($_.Usage -eq 4 -or $_.Usage -eq 5 -or $_.Usage -eq 8) -and $_.InputReportLen -gt 0
})
if ($pads.Count -eq 0) {
    Write-Warning 'No HID game device found. Plug the gamepad in and retry.'
    Write-Host 'Devices Windows does expose (usage page 1):' -ForegroundColor DarkGray
    $devs | Where-Object { $_.UsagePage -eq 1 } | ForEach-Object {
        Write-Host ("  VID=0x{0:X4} PID=0x{1:X4} usage={2} inLen={3} '{4}'" -f $_.Vid, $_.Pid, $_.Usage, $_.InputReportLen, $_.Product) -ForegroundColor DarkGray
    }
    exit 2
}

if ($DeviceIndex -ge $pads.Count) { throw "DeviceIndex $DeviceIndex out of range ($($pads.Count) found)" }
$pad = $pads[$DeviceIndex]
Write-Host ("  Using: VID=0x{0:X4} PID=0x{1:X4} usage={2} ({3}) report={4}B '{5}'" -f `
    $pad.Vid, $pad.Pid, $pad.Usage,
    $(switch ($pad.Usage) { 4 { 'Joystick' } 5 { 'Game Pad' } 8 { 'Multi-axis' } default { '?' } }),
    $pad.InputReportLen, $pad.Product) -ForegroundColor Green

$err = $null
if (-not [PadHid.Native]::Open($pad, [ref]$err)) { throw "could not open the device: $err" }

$len = [Math]::Max($pad.InputReportLen, 8)
$min = New-Object int[] $len
$max = New-Object int[] $len
for ($i = 0; $i -lt $len; $i++) { $min[$i] = 255; $max[$i] = 0 }
$distinct = @{}
for ($i = 0; $i -lt $len; $i++) { $distinct[$i] = New-Object 'System.Collections.Generic.HashSet[int]' }

$sw = [Diagnostics.Stopwatch]::StartNew()
$reports = 0
$buttonHex = New-Object 'System.Collections.Generic.HashSet[string]'

try {
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
        $b = [PadHid.Native]::PollReport($pad)
        if ($null -ne $b) {
            $reports++
            for ($i = 0; $i -lt $len; $i++) {
                $v = if ($i -lt $b.Length) { $b[$i] } else { 0 }
                if ($v -lt $min[$i]) { $min[$i] = $v }
                if ($v -gt $max[$i]) { $max[$i] = $v }
                if ($distinct[$i].Count -lt 8) { $null = $distinct[$i].Add($v) }
            }
            $btns = [PadHid.Native]::GetButtons($pad, $b, $b.Length)
            if ($btns -ne 0 -and $buttonHex.Count -lt 16) { $null = $buttonHex.Add(('0x{0:X4}' -f $btns)) }
        }
        Start-Sleep -Milliseconds 15
    }
}
finally {
    [PadHid.Native]::Close($pad)
}

Write-Host ''
Write-Host "  reports captured: $reports" -ForegroundColor Cyan
Write-Host ''
Write-Host '  byte    min  max  range  distinct  interpretation'
Write-Host '  ---------------------------------------------------------------'
for ($i = 0; $i -lt $len; $i++) {
    if ($min[$i] -gt $max[$i]) { Write-Host ("  [{0,2}]      -    -      -         -  no data" -f $i); continue }
    $range = $max[$i] - $min[$i]
    $n = $distinct[$i].Count
    $interp = if ($range -eq 0) { 'constant (padding or fixed field)' }
              elseif ($n -le 2) { 'digital (button/hat bit)' }
              elseif ($range -ge 64) { 'ANALOG axis' }
              else { 'small-range value' }
    $colour = if ($interp -eq 'ANALOG axis') { 'Green' } elseif ($interp -like 'digital*') { 'Yellow' } else { 'DarkGray' }
    Write-Host ("  [{0,2}]  {1,4} {2,4} {3,6} {4,9}  {5}" -f $i, $min[$i], $max[$i], $range, $n, $interp) -ForegroundColor $colour
}

Write-Host ''
if ($buttonHex.Count -gt 0) {
    Write-Host "  button words seen: $($buttonHex -join ', ')" -ForegroundColor Yellow
} else {
    Write-Host '  no buttons were pressed during the run' -ForegroundColor DarkGray
}

$analog = @()
for ($i = 0; $i -lt $len; $i++) { if ($min[$i] -le $max[$i] -and ($max[$i]-$min[$i]) -ge 64) { $analog += $i } }
Write-Host ''
if ($analog.Count -gt 0) {
    Write-Host "  analog bytes: $($analog -join ', ')" -ForegroundColor Green
    Write-Host '  Compare with docs/PLAN.md: X=roll, Y=pitch, Z=CAS, R=vertical speed.'
} else {
    Write-Host '  No analog movement detected -- the sticks were not moved during the run.' -ForegroundColor Yellow
}
