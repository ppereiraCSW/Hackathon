<#
.SYNOPSIS
    Reads the USB gamepad through the WinMM joystick API and streams pad frames
    to the emulated embedded system inside QEMU.

.DESCRIPTION
    The pad on this machine is a generic DirectInput device (HID\VID_0079&PID_181C),
    which XInput cannot see, so this uses joyGetPosEx from winmm.dll. No npm
    packages, no admin rights, no drivers.

    Frame layout (17 bytes, little-endian, matches firmware/src/pad.h):
        A5 5A | seq:u16 | X Y Z R : u16 x4 | buttons:u16 | pov:i16 | xor:u8
    The XOR covers every preceding byte.

    Transport: TCP to QEMU's UART1 chardev socket (the guest is the client,
    QEMU listens), because QEMU's guest side must connect to us -- so this
    script LISTENS on -Port and QEMU connects to it.

.PARAMETER Port
    TCP port for QEMU to connect to (firmware UART1). Default 5556.

.PARAMETER RateHz
    Poll rate. The firmware expects ~50 Hz. Default 50.

.PARAMETER Echo
    Print live axis values instead of only streaming (for setup checks).

.PARAMETER Seconds
    Stop after N seconds. 0 (default) runs until Ctrl+C.
#>
[CmdletBinding()]
param(
    [int]$Port = 5556,
    [int]$RateHz = 50,
    [switch]$Echo,
    [int]$Seconds = 0
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- WinMM interop
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

public static int FindPad(out string name, out int axes, out int buttons) {
    name = null; axes = 0; buttons = 0;
    for (uint id = 0; id < 16; id++) {
        JOYCAPS c = new JOYCAPS();
        uint r = joyGetDevCaps(new System.UIntPtr(id), ref c, (uint)Marshal.SizeOf(c));
        if (r == 0) { name = c.szPname; axes = (int)c.wNumAxes; buttons = (int)c.wNumButtons; return (int)id; }
    }
    return -1;
}
'@
}

# ------------------------------------------------------------------ find a pad
$padName = $null; $padAxes = 0; $padButtons = 0
$padId = [PadReader.WinMM]::FindPad([ref]$padName, [ref]$padAxes, [ref]$padButtons)
if ($padId -lt 0) {
    throw "No joystick found. Plug the USB gamepad in and retry. (joyGetNumDevs=$([PadReader.WinMM]::joyGetNumDevs()))"
}
Write-Host "[pad] id=$padId name='$padName' axes=$padAxes buttons=$padButtons" -ForegroundColor Green

# ------------------------------------------------------------------ transport
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "[pad] listening on 127.0.0.1:$Port for QEMU UART1" -ForegroundColor DarkGray
Write-Host "[pad] waiting for the emulated guest to connect..." -ForegroundColor DarkGray
$client = $listener.AcceptTcpClient()
$stream = $client.GetStream()
Write-Host "[pad] guest connected" -ForegroundColor Green

# Force no-delay so 50 Hz frames are not coalesced by Nagle.
$client.NoDelay = $true

$info = New-Object PadReader.WinMM+JOYINFOEX
$info.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
$info.dwFlags = [PadReader.WinMM]::JOY_RETURNALL

$period = [int](1000.0 / $RateHz)
$seq = 0
$sent = 0
$lastPadRead = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = if ($Seconds -gt 0) { $Seconds * 1000 } else { [long]::MaxValue }

try {
    while ($sw.ElapsedMilliseconds -lt $deadline) {
        $t0 = $sw.ElapsedMilliseconds

        $r = [PadReader.WinMM]::joyGetPosEx([uint32]$padId, [ref]$info)
        if ($r -ne 0) {
            # 165 = JOYERR_UNPLUGGED; keep the link alive, emit centre values.
            Write-Warning "joyGetPosEx returned $r (pad unplugged?) - sending neutral"
            $info.dwXpos = 32767; $info.dwYpos = 32767; $info.dwZpos = 32767; $info.dwRpos = 32767
            $info.dwButtons = 0; $info.dwPOV = 65535
        }

        $seq16 = [uint16]($seq -band 0xFFFF)
        $pov = if ($info.dwPOV -eq 65535 -or $info.dwPOV -eq 4294967295) { [int16]-1 } else { [int16]$info.dwPOV }

        $frame = [byte[]]::new(17)
        $frame[0] = 0xA5; $frame[1] = 0x5A
        [BitConverter]::GetBytes($seq16).CopyTo($frame, 2)
        [BitConverter]::GetBytes([uint16]$info.dwXpos).CopyTo($frame, 4)
        [BitConverter]::GetBytes([uint16]$info.dwYpos).CopyTo($frame, 6)
        [BitConverter]::GetBytes([uint16]$info.dwZpos).CopyTo($frame, 8)
        [BitConverter]::GetBytes([uint16]$info.dwRpos).CopyTo($frame, 10)
        [BitConverter]::GetBytes([uint16]$info.dwButtons).CopyTo($frame, 12)
        [BitConverter]::GetBytes($pov).CopyTo($frame, 14)
        $x = [byte]0
        for ($i = 0; $i -lt 16; $i++) { $x = $x -bxor $frame[$i] }
        $frame[16] = $x

        $stream.Write($frame, 0, $frame.Length)
        $stream.Flush()
        $sent++

        if ($Echo -and ($sent % 10 -eq 0)) {
            Write-Host ("seq={0,5} X={1,5} Y={2,5} Z={3,5} R={4,5} btn=0x{5:X4} pov={6}" -f `
                $seq16, $info.dwXpos, $info.dwYpos, $info.dwZpos, $info.dwRpos, $info.dwButtons, $pov)
        }

        $seq++
        $elapsed = $sw.ElapsedMilliseconds - $t0
        $sleep = $period - $elapsed
        if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
    }
}
finally {
    Write-Host "[pad] stopping after $sent frames" -ForegroundColor Yellow
    try { $stream.Close() } catch {}
    try { $client.Close() } catch {}
    $listener.Stop()
}
