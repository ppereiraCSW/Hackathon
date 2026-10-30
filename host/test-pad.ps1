<#
.SYNOPSIS
    Pad setup check: reports what Windows actually exposes for the gamepad and
    prints live axis values for a few seconds. Does not need QEMU.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File host/test-pad.ps1
#>
[CmdletBinding()]
param([int]$Seconds = 5)

$ErrorActionPreference = 'Stop'

if (-not ('PadReader.WinMM' -as [type])) {
    Add-Type -Namespace PadReader -Name WinMM -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct JOYCAPS {
    public ushort wMid, wPid;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public uint wXmin, wXmax, wYmin, wYmax, wZmin, wZmax;
    public uint wNumButtons, wPeriodMin, wPeriodMax;
    public uint wRmin, wRmax, wUmin, wUmax, wVmin, wVmax;
    public uint wCaps, wMaxAxes, wNumAxes, wMaxButtons;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szRegKey;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szOEMVxD;
}
[StructLayout(LayoutKind.Sequential)]
public struct JOYINFOEX {
    public uint dwSize, dwFlags, dwXpos, dwYpos, dwZpos, dwRpos,
                dwUpos, dwVpos, dwButtons, dwButtonNumber, dwPOV,
                dwReserved1, dwReserved2;
}
public const uint JOY_RETURNALL = 0xFF;
[DllImport("winmm.dll")] public static extern uint joyGetNumDevs();
[DllImport("winmm.dll")] public static extern uint joyGetDevCaps(System.UIntPtr id, ref JOYCAPS caps, uint cb);
[DllImport("winmm.dll")] public static extern uint joyGetPosEx(uint id, ref JOYINFOEX info);
'@
}

Write-Host "joyGetNumDevs = $([PadReader.WinMM]::joyGetNumDevs())"
$found = $false
foreach ($id in 0..15) {
    $c = New-Object PadReader.WinMM+JOYCAPS
    $r = [PadReader.WinMM]::joyGetDevCaps([System.UIntPtr]::new($id), [ref]$c, [System.Runtime.InteropServices.Marshal]::SizeOf($c))
    if ($r -ne 0) { continue }
    $found = $true
    Write-Host "[$id] '$($c.szPname)' axes=$($c.wNumAxes) buttons=$($c.wNumButtons)" -ForegroundColor Green
    Write-Host "     X[$($c.wXmin)..$($c.wXmax)] Y[$($c.wYmin)..$($c.wYmax)] Z[$($c.wZmin)..$($c.wZmax)] R[$($c.wRmin)..$($c.wRmax)]"
    Write-Host "     poll period $($c.wPeriodMin)..$($c.wPeriodMax) ms"

    $i = New-Object PadReader.WinMM+JOYINFOEX
    $i.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf($i)
    $i.dwFlags = [PadReader.WinMM]::JOY_RETURNALL
    Write-Host "     live for ${Seconds}s -- move the sticks and press buttons" -ForegroundColor DarkGray
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $Seconds) {
        $r2 = [PadReader.WinMM]::joyGetPosEx([uint32]$id, [ref]$i)
        $pov = if ($i.dwPOV -eq 4294967295) { 'centred' } else { "$($i.dwPOV)" }
        Write-Host ("     X={0,5} Y={1,5} Z={2,5} R={3,5} btn=0x{4:X4} pov={5}" -f `
            $i.dwXpos, $i.dwYpos, $i.dwZpos, $i.dwRpos, $i.dwButtons, $pov)
        Start-Sleep -Milliseconds 200
    }
}
if (-not $found) { Write-Warning "No joystick devices found (joyGetDevCaps returned non-zero for id 0..15)." }
