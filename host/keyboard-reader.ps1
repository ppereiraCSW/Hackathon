<#
.SYNOPSIS
    Flies the emulated aircraft from the keyboard: a drop-in replacement for
    pad-reader.ps1 when no gamepad is available.

.DESCRIPTION
    Polls the keyboard at 50 Hz and streams the same 17-byte pad frames as
    pad-reader.ps1 to QEMU's UART1, so the firmware, backend and SFD do not know
    or care which one is running.

    Keys are read with GetAsyncKeyState, which sees them whichever window has the
    focus, so you can fly while looking at the SFD in the browser. Only the keys
    listed below are queried; nothing is recorded. Keys typed into other windows
    while this runs will also move the aircraft.

    The firmware treats the axes as rate commands: holding a key moves the value,
    releasing it holds the value.

        Arrow Left / Right   roll               (X axis)
        Arrow Up / Down      pitch up / down    (Y axis)
        W / S                speed up / down    (Z axis)
        R / F                climb / descend    (R axis, vertical speed)
        Shift (held)         gentle: about a third of full deflection
        Space                wings level                       (button A)
        H (hold 1 s)         reset heading                     (button B)
        Q / E                speed -10 / +10 kt                (LB / RB)
        Page Up / Page Down  altitude +500 / -500 ft per press (D-pad)
        Enter                freeze: every label NCD, again to clear (START)

    Frame layout (17 bytes, little-endian, matches firmware/src/pad.h):
        A5 5A | seq:u16 | X Y Z R : u16 x4 | buttons:u16 | pov:i16 | xor:u8

    Transport: this script LISTENS on -Port and QEMU connects to it.

.PARAMETER Port
    TCP port for QEMU to connect to (firmware UART1). Default 5556.

.PARAMETER RateHz
    Frame rate. The firmware expects ~50 Hz. Default 50.

.PARAMETER Seconds
    Stop after N seconds. 0 (default) runs until Ctrl+C.

.PARAMETER Echo
    Print the frame being sent, ten times less often than it is sent.

.PARAMETER Hold
    Pretend these keys are held for the whole run instead of reading the
    keyboard, e.g. -Hold Right,W. Key names as in the table above (Left, Right,
    Up, Down, W, S, R, F, Shift, Space, H, Q, E, PageUp, PageDown, Enter). Used by
    tools/test-keyboard-path.mjs; no real key presses are injected.
#>
[CmdletBinding()]
param(
    [int]$Port = 5556,
    [int]$RateHz = 50,
    [int]$Seconds = 0,
    [switch]$Echo,
    [string[]]$Hold = @()
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------- key table
# Windows virtual-key codes for the keys this script reads.
$VK = [ordered]@{
    Left = 0x25; Up = 0x26; Right = 0x27; Down = 0x28
    W = 0x57; S = 0x53; R = 0x52; F = 0x46
    Shift = 0x10; Space = 0x20; H = 0x48; Q = 0x51; E = 0x45
    PageUp = 0x21; PageDown = 0x22; Enter = 0x0D
}

# `powershell -File` passes "Right,W" as one string, so split it here.
$Hold = @($Hold | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($k in $Hold) {
    if (-not $VK.Contains($k)) { throw "unknown key '$k' in -Hold; known: $($VK.Keys -join ', ')" }
}

if (-not ('KbdInput.Native' -as [type])) {
    Add-Type -Namespace KbdInput -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
[DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
[DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
'@
}

function Get-Keys {
    $down = @{}
    if ($Hold.Count -gt 0) {
        foreach ($k in $VK.Keys) { $down[$k] = $Hold -contains $k }
    } else {
        foreach ($k in $VK.Keys) {
            $down[$k] = ([KbdInput.Native]::GetAsyncKeyState($VK[$k]) -band 0x8000) -ne 0
        }
    }
    return $down
}

# Axis value for a key pair: centre 32767, full deflection 0 / 65535.
function Get-Axis([bool]$neg, [bool]$pos, [double]$gain) {
    $d = 0.0
    if ($pos) { $d += 1.0 }
    if ($neg) { $d -= 1.0 }
    # 32768 up and 32767 down, so full deflection lands exactly on 65535 and 0
    $span = if ($d -gt 0) { 32768 } else { 32767 }
    return [uint16][Math]::Round(32767 + $d * $gain * $span)
}

# ----------------------------------------------------------------- transport
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "[kbd] listening on 127.0.0.1:$Port for QEMU UART1" -ForegroundColor DarkGray
if ($Hold.Count -gt 0) {
    Write-Host "[kbd] test mode: holding $($Hold -join ', '); the real keyboard is not read" -ForegroundColor Yellow
} else {
    Write-Host '[kbd] arrows roll/pitch, W/S speed, R/F climb, Space level, H hold = heading 0, Q/E speed step, PgUp/PgDn altitude step, Enter freeze' -ForegroundColor Cyan
    Write-Host '[kbd] keys are read in any window, so you can fly while watching the SFD' -ForegroundColor DarkGray
}
Write-Host '[kbd] waiting for the emulated guest to connect...' -ForegroundColor DarkGray
$client = $listener.AcceptTcpClient()

# 1 ms timer resolution so a 20 ms period is really 20 ms (see pad-reader.ps1).
[void][KbdInput.Native]::timeBeginPeriod(1)

$period = [int](1000.0 / $RateHz)
$seq = 0
$sent = 0
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = if ($Seconds -gt 0) { $Seconds * 1000 } else { [long]::MaxValue }
$nextTick = $sw.ElapsedMilliseconds

while ($sw.ElapsedMilliseconds -lt $deadline) {
    $client.NoDelay = $true
    $stream = $client.GetStream()
    Write-Host '[kbd] guest connected' -ForegroundColor Green

    try {
        while ($sw.ElapsedMilliseconds -lt $deadline) {
            $k = Get-Keys
            $gain = if ($k.Shift) { 0.35 } else { 1.0 }

            $x = Get-Axis $k.Left $k.Right $gain
            $y = Get-Axis $k.Down $k.Up $gain
            $z = Get-Axis $k.S $k.W $gain
            $r = Get-Axis $k.F $k.R $gain

            # Buttons are held for as long as the key is held: the firmware does
            # its own edge detection, and B needs the hold to reset heading.
            $buttons = 0
            if ($k.Space) { $buttons = $buttons -bor 0x0001 }
            if ($k.H) { $buttons = $buttons -bor 0x0002 }
            if ($k.Q) { $buttons = $buttons -bor 0x0004 }
            if ($k.E) { $buttons = $buttons -bor 0x0008 }
            if ($k.Enter) { $buttons = $buttons -bor 0x0010 }

            # D-pad held while the key is held, like the gamepad; the firmware
            # steps altitude once per press (edge-triggered).
            $pov = -1
            if ($k.PageUp) { $pov = 0 }
            elseif ($k.PageDown) { $pov = 18000 }

            $seq16 = [uint16]($seq -band 0xFFFF)
            $frame = [byte[]]::new(17)
            $frame[0] = 0xA5; $frame[1] = 0x5A
            [BitConverter]::GetBytes($seq16).CopyTo($frame, 2)
            [BitConverter]::GetBytes([uint16]$x).CopyTo($frame, 4)
            [BitConverter]::GetBytes([uint16]$y).CopyTo($frame, 6)
            [BitConverter]::GetBytes([uint16]$z).CopyTo($frame, 8)
            [BitConverter]::GetBytes([uint16]$r).CopyTo($frame, 10)
            [BitConverter]::GetBytes([uint16]$buttons).CopyTo($frame, 12)
            [BitConverter]::GetBytes([int16]$pov).CopyTo($frame, 14)
            $xor = [byte]0
            for ($i = 0; $i -lt 16; $i++) { $xor = $xor -bxor $frame[$i] }
            $frame[16] = $xor

            $stream.Write($frame, 0, $frame.Length)
            $stream.Flush()
            $sent++

            if ($Echo -and ($sent % 10 -eq 0)) {
                Write-Host ("seq={0,5} X={1,5} Y={2,5} Z={3,5} R={4,5} btn=0x{5:X4} pov={6}" -f `
                    $seq16, $x, $y, $z, $r, $buttons, $pov)
            }

            $seq++
            # Absolute schedule, as in pad-reader.ps1, so the rate stays at $RateHz.
            $nextTick += $period
            $now = $sw.ElapsedMilliseconds
            if ($nextTick -lt $now - $period) { $nextTick = $now }
            $sleep = $nextTick - $now
            if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
        }
    } catch [System.IO.IOException] {
        Write-Host '[kbd] guest disconnected; waiting for it to reconnect' -ForegroundColor Yellow
    } catch [System.Net.Sockets.SocketException] {
        Write-Host '[kbd] guest socket closed; waiting for it to reconnect' -ForegroundColor Yellow
    } finally {
        try { $stream.Close() } catch {}
        try { $client.Close() } catch {}
    }

    if ($sw.ElapsedMilliseconds -ge $deadline) { break }
    Write-Host '[kbd] waiting for the emulated guest to connect...' -ForegroundColor DarkGray
    $client = $listener.AcceptTcpClient()
}

Write-Host "[kbd] stopping after $sent frames" -ForegroundColor Yellow
[void][KbdInput.Native]::timeEndPeriod(1)
$listener.Stop()
