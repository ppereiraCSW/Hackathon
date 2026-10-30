<#
.SYNOPSIS
    Reads the USB gamepad and streams pad frames to the emulated embedded system
    inside QEMU.

.DESCRIPTION
    Three backends, tried in order:

      1. XInput -- Xbox-style controllers (8BitDo, Xbox, most modern pads,
                  VID_2DC8&PID_310B among them). Windows also exposes these over
                  HID, but with 16-bit axes and a combined trigger axis that the
                  HID path below misreads as full deflection, so XInput is the
                  only correct way to read them.
      2. HID    -- read the device's HID input reports directly. Used for the
                  DirectInput-only pad (VID_0079&PID_181C) that XInput cannot
                  see; it keeps working when the WinMM layer loses the device.
      3. WinMM  -- joyGetPosEx, the classic joystick API, used as a fallback.

    XInput mapping onto the frame (the firmware treats axes as rate commands):
        left stick X   -> X  roll          left stick Y  -> Y  pitch (back = up)
        RT minus LT    -> Z  speed         right stick Y -> R  (carried; unused by the model)
        A, B, LB, RB, START -> the same button bits as the original pad
        D-pad          -> POV (up 0, right 9000, down 18000, left 27000)

    Why HID first: on this machine the pad (VID_0079&PID_181C, "Gamepad") is a
    HID game-pad device (usage page 1, usage 5) that WinMM sometimes fails to see
    -- joyGetDevCaps returned JOYERR_UNPLUGGED (165) on every slot while the HID
    interface opened fine. Reading reports directly removes that dependency.

    No npm packages, no admin rights, no drivers.

    Frame layout (17 bytes, little-endian, matches firmware/src/pad.h):
        A5 5A | seq:u16 | X Y Z R : u16 x4 | buttons:u16 | pov:i16 | xor:u8
    Axes are always normalised to WinMM's 0..65535 convention (32767 = centre),
    whichever backend produced them, so the firmware needs no changes.
    The XOR covers every preceding byte.

    Transport: this script LISTENS on -Port and QEMU connects to it (the guest is
    the TCP client for its UART1).

.PARAMETER Port
    TCP port for QEMU to connect to (firmware UART1). Default 5556.

.PARAMETER RateHz
    Poll rate. The firmware expects ~50 Hz. Default 50.

.PARAMETER Echo
    Print live axis values and raw reports (for setup checks).

.PARAMETER Seconds
    Stop after N seconds. 0 (default) runs until Ctrl+C.

.PARAMETER Backend
    auto (default) | xinput | hid | winmm. Forces a specific input path.
#>
[CmdletBinding()]
param(
    [int]$Port = 5556,
    [int]$RateHz = 50,
    [switch]$Echo,
    [int]$Seconds = 0,
    [ValidateSet('auto', 'xinput', 'hid', 'winmm')]
    [string]$Backend = 'auto'
)

$ErrorActionPreference = 'Stop'

# ============================================================== HID interop
if (-not ('PadHid.Native' -as [type])) {
    Add-Type -Namespace PadHid -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct SP_DEVICE_INTERFACE_DATA {
    public int cbSize; public Guid InterfaceClassGuid; public int Flags; public IntPtr Reserved;
}
[StructLayout(LayoutKind.Sequential)]
public struct HIDD_ATTRIBUTES { public int Size; public ushort VendorID; public ushort ProductID; public ushort VersionNumber; }
[StructLayout(LayoutKind.Sequential)]
public struct HIDP_CAPS {
    public ushort Usage; public ushort UsagePage; public ushort InputReportByteLength;
    public ushort OutputReportByteLength; public ushort FeatureReportByteLength;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 17)] public ushort[] Reserved;
    public ushort NumberLinkCollectionNodes; public ushort NumberInputButtonCaps;
    public ushort NumberInputValueCaps; public ushort NumberInputDataIndices;
    public ushort NumberOutputButtonCaps; public ushort NumberOutputValueCaps;
    public ushort NumberOutputDataIndices; public ushort NumberFeatureButtonCaps;
    public ushort NumberFeatureValueCaps; public ushort NumberFeatureDataIndices;
}
[StructLayout(LayoutKind.Sequential)]
public struct HIDP_VALUE_CAPS {
    public ushort UsagePage; public byte ReportID; public byte IsAlias;
    public ushort BitField; public ushort LinkCollection; public ushort LinkUsage;
    public ushort LinkUsagePage; public byte IsRange; public byte IsStringRange;
    public byte IsDesignatorRange; public byte IsAbsolute;
    public int UsageMin, UsageMax, StringMin, StringMax, DesignatorMin, DesignatorMax;
    public int DataIndexMin, DataIndexMax;
    public uint LogicalMin, LogicalMax, PhysicalMin, PhysicalMax;
    public ushort Units, UnitsExp;
}
[StructLayout(LayoutKind.Sequential)]
public struct HIDP_BUTTON_CAPS {
    public ushort UsagePage; public byte ReportID; public byte IsAlias;
    public ushort BitField; public ushort LinkCollection; public ushort LinkUsage;
    public ushort LinkUsagePage; public byte IsRange; public byte IsStringRange;
    public byte IsDesignatorRange; public byte IsAbsolute;
    public int UsageMin, UsageMax, StringMin, StringMax, DesignatorMin, DesignatorMax;
    public int DataIndexMin, DataIndexMax;
}

[DllImport("hid.dll")] public static extern void HidD_GetHidGuid(out Guid g);
[DllImport("hid.dll")] public static extern bool HidD_GetAttributes(IntPtr h, ref HIDD_ATTRIBUTES a);
[DllImport("hid.dll")] public static extern bool HidD_GetPreparsedData(IntPtr h, out IntPtr p);
[DllImport("hid.dll")] public static extern bool HidD_FreePreparsedData(IntPtr p);
[DllImport("hid.dll")] public static extern int HidP_GetCaps(IntPtr p, ref HIDP_CAPS c);
[DllImport("hid.dll", CharSet = CharSet.Unicode)] public static extern bool HidD_GetProductString(IntPtr h, System.Text.StringBuilder b, int n);
[DllImport("hid.dll")]
public static extern int HidP_GetValueCaps(int reportType, [Out] HIDP_VALUE_CAPS[] caps, ref ushort len, IntPtr pre);
[DllImport("hid.dll")]
public static extern int HidP_GetButtonCaps(int reportType, [Out] HIDP_BUTTON_CAPS[] caps, ref ushort len, IntPtr pre);
[DllImport("hid.dll")]
public static extern int HidP_GetUsageValue(int reportType, ushort usagePage, ushort linkCollection,
    ushort usage, out uint value, IntPtr pre, [In] byte[] report, int reportLen);
[DllImport("hid.dll")]
public static extern int HidP_GetUsages(int reportType, ushort usagePage, ushort linkCollection,
    [Out] ushort[] usageList, ref uint usageLength, IntPtr pre, [In] byte[] report, int reportLen);

[DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr w, int f);
[DllImport("setupapi.dll", SetLastError = true)]
public static extern bool SetupDiEnumDeviceInterfaces(IntPtr s, IntPtr i, ref Guid g, int idx, ref SP_DEVICE_INTERFACE_DATA d);
[DllImport("setupapi.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr s, ref SP_DEVICE_INTERFACE_DATA d,
    IntPtr detail, int size, out int needed, IntPtr i);
[DllImport("setupapi.dll")] public static extern bool SetupDiDestroyDeviceInfoList(IntPtr s);

[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern IntPtr CreateFile(string n, uint a, uint sh, IntPtr sec, uint d, uint f, IntPtr t);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool ReadFile(IntPtr h, IntPtr b, int n, out int read, IntPtr ov);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool GetOverlappedResult(IntPtr h, IntPtr ov, out int transferred, bool wait);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CancelIoEx(IntPtr h, IntPtr ov);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern IntPtr CreateEvent(IntPtr sec, bool manual, bool initial, string name);
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint WaitForSingleObject(IntPtr h, uint ms);

public static readonly IntPtr INVALID = new IntPtr(-1);
public const uint GENERIC_READ_WRITE = 0xC0000000;
public const uint FILE_SHARE_RW = 3;
public const uint OPEN_EXISTING = 3;
public const uint FILE_FLAG_OVERLAPPED = 0x40000000;
public const int ERROR_IO_PENDING = 997;

// SP_DEVICE_INTERFACE_DETAIL_DATA_W is { DWORD cbSize; WCHAR DevicePath[]; }.
// cbSize is 8 on x64, but the string begins at byte 4. Reading at 8 drops the
// first two characters and every CreateFile then fails with ERROR_FILE_NOT_FOUND.
const int PATH_OFFSET = 4;

public class Device {
    public string Path;
    public IntPtr Handle = INVALID;
    public IntPtr PreParsed = IntPtr.Zero;
    public ushort Vid, Pid;
    public string Product = "";
    public ushort UsagePage, Usage;
    public int InputReportLen;
    public int NumButtons;
    public int NumValues;
    /** Unmanaged OVERLAPPED block (event handle + offsets), zeroed. */
    public IntPtr OverlappedMem = IntPtr.Zero;
    public IntPtr Event = IntPtr.Zero;
    /** Unmanaged read buffer. An overlapped ReadFile completes after the call
     *  returns, so the target must not be a managed array the GC can move. */
    public IntPtr ReadMem = IntPtr.Zero;
    public int ReadLen;
    public byte[] LastBuf;
    public int LastLen;
    public bool ReadPending;
}

public static System.Collections.Generic.List<Device> Enumerate() {
    var list = new System.Collections.Generic.List<Device>();
    Guid g; HidD_GetHidGuid(out g);
    IntPtr set = SetupDiGetClassDevs(ref g, IntPtr.Zero, IntPtr.Zero, 0x12);
    if (set == INVALID) return list;
    for (int i = 0; ; i++) {
        var d = new SP_DEVICE_INTERFACE_DATA(); d.cbSize = Marshal.SizeOf(d);
        if (!SetupDiEnumDeviceInterfaces(set, IntPtr.Zero, ref g, i, ref d)) break;
        int need = 0;
        SetupDiGetDeviceInterfaceDetail(set, ref d, IntPtr.Zero, 0, out need, IntPtr.Zero);
        if (need <= 0) continue;
        IntPtr buf = Marshal.AllocHGlobal(need);
        try {
            Marshal.WriteInt32(buf, 0, IntPtr.Size == 8 ? 8 : 6);
            if (!SetupDiGetDeviceInterfaceDetail(set, ref d, buf, need, out need, IntPtr.Zero)) continue;
            string path = Marshal.PtrToStringUni(new IntPtr(buf.ToInt64() + PATH_OFFSET));
            IntPtr h = CreateFile(path, 0, FILE_SHARE_RW, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
            if (h == INVALID) continue;
            try {
                var a = new HIDD_ATTRIBUTES(); a.Size = Marshal.SizeOf(a);
                if (!HidD_GetAttributes(h, ref a)) continue;
                var dev = new Device { Path = path, Vid = a.VendorID, Pid = a.ProductID };
                var sb = new System.Text.StringBuilder(260);
                if (HidD_GetProductString(h, sb, 260)) dev.Product = sb.ToString();
                IntPtr pre;
                if (HidD_GetPreparsedData(h, out pre)) {
                    var caps = new HIDP_CAPS();
                    if (HidP_GetCaps(pre, ref caps) == 0x00110000) {
                        dev.UsagePage = caps.UsagePage; dev.Usage = caps.Usage;
                        dev.InputReportLen = caps.InputReportByteLength;
                        dev.NumButtons = caps.NumberInputButtonCaps;
                        dev.NumValues = caps.NumberInputValueCaps;
                    }
                    HidD_FreePreparsedData(pre);
                }
                list.Add(dev);
            } finally { CloseHandle(h); }
        } finally { Marshal.FreeHGlobal(buf); }
    }
    SetupDiDestroyDeviceInfoList(set);
    return list;
}

public static bool Open(Device dev, out string err) {
    err = null;
    // FILE_FLAG_OVERLAPPED is essential: a synchronous ReadFile on a HID handle
    // blocks until the device happens to send a report. A resting gamepad may
    // send none for a long time, which would stall the whole pipeline.
    dev.Handle = CreateFile(dev.Path, GENERIC_READ_WRITE, FILE_SHARE_RW, IntPtr.Zero,
        OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero);
    if (dev.Handle == INVALID) {
        dev.Handle = CreateFile(dev.Path, 0x80000000u, FILE_SHARE_RW, IntPtr.Zero,
            OPEN_EXISTING, FILE_FLAG_OVERLAPPED, IntPtr.Zero);
        if (dev.Handle == INVALID) {
            int e = Marshal.GetLastWin32Error();
            err = e + " (" + new System.ComponentModel.Win32Exception(e).Message + ")";
            return false;
        }
    }
    if (!HidD_GetPreparsedData(dev.Handle, out dev.PreParsed)) {
        err = "HidD_GetPreparsedData failed";
        return false;
    }
    // Prepare the OVERLAPPED block once: an auto-reset event goes in the hEvent
    // field (offset 16 on x86, 24 on x64) so we can poll it with a 0 ms wait.
    dev.OverlappedMem = Marshal.AllocHGlobal(64);
    for (int i = 0; i < 64; i++) Marshal.WriteByte(dev.OverlappedMem, i, 0);
    dev.Event = CreateEvent(IntPtr.Zero, false, false, null);
    Marshal.WriteIntPtr(dev.OverlappedMem, IntPtr.Size == 8 ? 24 : 16, dev.Event);
    dev.ReadLen = Math.Max(dev.InputReportLen, 8);
    dev.ReadMem = Marshal.AllocHGlobal(dev.ReadLen);
    dev.ReadPending = false;
    return true;
}

public static void Close(Device dev) {
    if (dev.ReadPending) {
        try {
            CancelIoEx(dev.Handle, IntPtr.Zero);
            // Wait for the cancelled read to finish before its buffer is freed.
            int ignored;
            GetOverlappedResult(dev.Handle, dev.OverlappedMem, out ignored, true);
        } catch { }
        dev.ReadPending = false;
    }
    if (dev.ReadMem != IntPtr.Zero) { Marshal.FreeHGlobal(dev.ReadMem); dev.ReadMem = IntPtr.Zero; }
    if (dev.PreParsed != IntPtr.Zero) { HidD_FreePreparsedData(dev.PreParsed); dev.PreParsed = IntPtr.Zero; }
    if (dev.Handle != INVALID) { CloseHandle(dev.Handle); dev.Handle = INVALID; }
    if (dev.Event != IntPtr.Zero) { CloseHandle(dev.Event); dev.Event = IntPtr.Zero; }
    if (dev.OverlappedMem != IntPtr.Zero) { Marshal.FreeHGlobal(dev.OverlappedMem); dev.OverlappedMem = IntPtr.Zero; }
}

/**
 * Non-blocking read: returns the newest complete report, or null if none has
 * arrived since the last call. Never blocks.
 *
 * A synchronous ReadFile on a HID handle waits until the device sends a report;
 * a resting gamepad can go quiet for a long time, which would stall the whole
 * pipeline. Overlapped I/O plus a 0 ms wait keeps the 50 Hz loop honest.
 */
public static byte[] PollReport(Device dev) {
    if (dev.Handle == INVALID || dev.OverlappedMem == IntPtr.Zero) return null;

    if (dev.ReadPending) {
        uint w = WaitForSingleObject(dev.Event, 0);
        if (w == 258 /*WAIT_TIMEOUT*/) return null;
        int got = 0;
        bool ok = GetOverlappedResult(dev.Handle, dev.OverlappedMem, out got, false);
        dev.ReadPending = false;
        if (!ok || got <= 0) return null;
        return TakeReport(dev, got);
    }

    int read = 0;
    bool r = ReadFile(dev.Handle, dev.ReadMem, dev.ReadLen, out read, dev.OverlappedMem);
    if (!r) {
        int e = Marshal.GetLastWin32Error();
        if (e == ERROR_IO_PENDING) dev.ReadPending = true;
        return null;
    }
    if (read <= 0) return null;
    return TakeReport(dev, read);
}

static byte[] TakeReport(Device dev, int got) {
    // HidP_* expects the full report length, so copy into a buffer of ReadLen.
    var buf = new byte[dev.ReadLen];
    Marshal.Copy(dev.ReadMem, buf, 0, Math.Min(got, dev.ReadLen));
    dev.LastBuf = buf;
    dev.LastLen = got;
    return buf;
}

/**
 * Drains every report Windows has queued and returns the newest, or null if
 * none arrived since the last call.
 *
 * The pad sends ~200 reports/s but the loop ticks at 50 Hz. Taking one report
 * per tick lets the HID input queue (32 deep by default) fill up, so every
 * frame carried a value ~0.6 s old and the driver's overflow drops made the
 * motion jerky. Only the latest state matters, so read until the queue is empty.
 */
public static byte[] PollLatest(Device dev) {
    byte[] latest = null;
    for (int i = 0; i < 256; i++) {
        var b = PollReport(dev);
        if (b == null) break;
        latest = b;
    }
    return latest;
}

/** Value in the report for a usage on the Generic Desktop page (1). */
public static uint GetValue(Device dev, ushort usage, byte[] report, int len) {
    uint v = 0;
    // Report type 0 = HidP_Input (1 is Output, 2 is Feature).
    int st = HidP_GetUsageValue(0, 1, 0, usage, out v, dev.PreParsed, report, len);
    return st == 0x00110000 ? v : uint.MaxValue;
}

/** Bits of the button usages (page 9) currently set. */
public static uint GetButtons(Device dev, byte[] report, int len) {
    var list = new ushort[64];
    uint n = 64;
    int st = HidP_GetUsages(0, 9, 0, list, ref n, dev.PreParsed, report, len);
    if (st != 0x00110000) return 0;
    uint bits = 0;
    for (uint i = 0; i < n; i++) {
        int u = list[i];
        if (u >= 1 && u <= 32) bits |= (1u << (u - 1));
    }
    return bits;
}

/** HID hat switch in degrees (0,90,...315) or -1 when centred. */
public static int GetHat(Device dev, byte[] report, int len) {
    uint v = GetValue(dev, 0x39, report, len);
    if (v == uint.MaxValue || v == 8 || v > 8) return -1;
    return (int)v * 45;
}
'@
}

# ============================================================== WinMM interop
if (-not ('PadWinMM.Native' -as [type])) {
    Add-Type -Namespace PadWinMM -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct JOYCAPS {
    public ushort wMid, wPid;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szPname;
    public uint wXmin, wXmax, wYmin, wYmax, wZmin, wZmax, wNumButtons, wPeriodMin, wPeriodMax;
    public uint wRmin, wRmax, wUmin, wUmax, wVmin, wVmax;
    public uint wCaps, wMaxAxes, wNumAxes, wMaxButtons;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szRegKey;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szOEMVxD;
}
[StructLayout(LayoutKind.Sequential)]
public struct JOYINFOEX {
    public uint dwSize, dwFlags, dwXpos, dwYpos, dwZpos, dwRpos, dwUpos, dwVpos,
                dwButtons, dwButtonNumber, dwPOV, dwReserved1, dwReserved2;
}
public const uint JOY_RETURNALL = 0xFF;
[DllImport("winmm.dll")] public static extern uint joyGetNumDevs();
[DllImport("winmm.dll")] public static extern uint joyGetDevCaps(System.UIntPtr id, ref JOYCAPS caps, uint cb);
[DllImport("winmm.dll")] public static extern uint joyGetPosEx(uint id, ref JOYINFOEX info);

public static int FindPad(out string name, out int axes, out int buttons) {
    name = null; axes = 0; buttons = 0;
    for (uint id = 0; id < 16; id++) {
        JOYCAPS c = new JOYCAPS();
        if (joyGetDevCaps(new System.UIntPtr(id), ref c, (uint)Marshal.SizeOf(c)) == 0) {
            name = c.szPname; axes = (int)c.wNumAxes; buttons = (int)c.wNumButtons; return (int)id;
        }
    }
    return -1;
}
'@
}

# ============================================================= XInput interop
if (-not ('PadXInput.Native' -as [type])) {
    Add-Type -Namespace PadXInput -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct XINPUT_GAMEPAD {
    public ushort wButtons; public byte bLeftTrigger; public byte bRightTrigger;
    public short sThumbLX; public short sThumbLY; public short sThumbRX; public short sThumbRY;
}
[StructLayout(LayoutKind.Sequential)]
public struct XINPUT_STATE { public uint dwPacketNumber; public XINPUT_GAMEPAD Gamepad; }
[DllImport("xinput1_4.dll")] public static extern uint XInputGetState(uint index, out XINPUT_STATE state);
'@
}

# ================================================================== backends

function Start-XInputBackend {
    for ($i = 0; $i -lt 4; $i++) {
        $s = New-Object PadXInput.Native+XINPUT_STATE
        if ([PadXInput.Native]::XInputGetState([uint32]$i, [ref]$s) -eq 0) {
            Write-Host "[pad] backend: XInput  controller slot $i" -ForegroundColor Green
            return @{ Kind = 'xinput'; Slot = [uint32]$i }
        }
    }
    return $null
}

# XInput thumbstick (-32768..32767, up/right positive) -> 0..65535, 32767 centre.
function From-Thumb([int]$v, [bool]$invert) {
    if ($invert) { $v = -$v }
    $u = $v + 32767
    if ($u -lt 0) { $u = 0 }
    if ($u -gt 65535) { $u = 65535 }
    return $u
}

function Read-XInput {
    param($ctx)
    $s = New-Object PadXInput.Native+XINPUT_STATE
    $r = [PadXInput.Native]::XInputGetState($ctx.Slot, [ref]$s)
    if ($r -ne 0) {
        return @{ Ok = $false; Error = $r; X = 32767; Y = 32767; Z = 32767; R = 32767; Buttons = 0; Pov = -1 }
    }
    $g = $s.Gamepad
    $b = [int]$g.wButtons

    # The frame keeps the original pad's button bits (firmware/src/pad.h).
    $buttons = 0
    if ($b -band 0x1000) { $buttons = $buttons -bor 0x0001 }  # A     -> wings level
    if ($b -band 0x2000) { $buttons = $buttons -bor 0x0002 }  # B     -> heading reset (hold)
    if ($b -band 0x0100) { $buttons = $buttons -bor 0x0004 }  # LB    -> CAS -10
    if ($b -band 0x0200) { $buttons = $buttons -bor 0x0008 }  # RB    -> CAS +10
    if ($b -band 0x0010) { $buttons = $buttons -bor 0x0010 }  # START -> freeze

    $pov = -1
    if ($b -band 0x0001) { $pov = 0 }
    elseif ($b -band 0x0008) { $pov = 9000 }
    elseif ($b -band 0x0002) { $pov = 18000 }
    elseif ($b -band 0x0004) { $pov = 27000 }

    # Speed from the triggers: right speeds up, left slows down, both = hold.
    $trig = ([int]$g.bRightTrigger - [int]$g.bLeftTrigger) / 255.0
    $z = [int][Math]::Round(32767 + $trig * 32767)

    return @{
        Ok      = $true
        X       = (From-Thumb $g.sThumbLX $false)
        # Pulling the stick back reads negative in XInput; back must be pitch up.
        Y       = (From-Thumb $g.sThumbLY $true)
        Z       = $z
        R       = (From-Thumb $g.sThumbRY $false)
        Buttons = $buttons
        Pov     = $pov
    }
}
function Find-HidGamepad {
    $devs = [PadHid.Native]::Enumerate()
    # Accept ONLY genuine game devices: 4 = Joystick, 5 = Game Pad, 8 = Multi-axis
    # controller. Usages 6 (Keyboard) and 7 (Keypad) live in the same Generic
    # Desktop page but are not game controllers -- an earlier version of this
    # filter accepted 4..8 and happily picked a keyboard, which then failed to
    # open with Access Denied.
    $pad = $devs |
        Where-Object { $_.UsagePage -eq 1 -and ($_.Usage -eq 4 -or $_.Usage -eq 5 -or $_.Usage -eq 8) -and $_.InputReportLen -gt 0 } |
        Sort-Object -Property @{ Expression = { if ($_.Usage -eq 5) { 0 } elseif ($_.Usage -eq 4) { 1 } else { 2 } } } |
        Select-Object -First 1
    return ,$pad
}

function Start-HidBackend {
    $pad = Find-HidGamepad
    if (-not $pad) { return $null }
    $err = $null
    if (-not [PadHid.Native]::Open($pad, [ref]$err)) {
        Write-Warning "HID device found (VID=0x$('{0:X4}' -f $pad.Vid) PID=0x$('{0:X4}' -f $pad.Pid)) but could not open it: $err"
        return $null
    }
    Write-Host ("[pad] backend: HID  'VID=0x{0:X4} PID=0x{1:X4} usagePage={2} usage={3} inReport={4}B' {5}" -f `
        $pad.Vid, $pad.Pid, $pad.UsagePage, $pad.Usage, $pad.InputReportLen, $pad.Product) -ForegroundColor Green

    # Which Generic Desktop usages does this device actually report?
    $axes = @{}
    foreach ($u in 0x30, 0x31, 0x32, 0x35, 0x36, 0x33, 0x34, 0x39) {
        $axes[$u] = $true
    }

    return @{
        Kind    = 'hid'
        Device  = $pad
        Axes    = $axes
        Buffer  = New-Object byte[] ([Math]::Max($pad.InputReportLen, 8))
        LastRaw = $null
    }
}

function Start-WinMMBackend {
    $name = $null; $ax = 0; $btn = 0
    $id = [PadWinMM.Native]::FindPad([ref]$name, [ref]$ax, [ref]$btn)
    if ($id -lt 0) { return $null }
    Write-Host "[pad] backend: WinMM  id=$id '$name' axes=$ax buttons=$btn" -ForegroundColor Green
    $info = New-Object PadWinMM.Native+JOYINFOEX
    $info.dwSize = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
    $info.dwFlags = [PadWinMM.Native]::JOY_RETURNALL
    return @{ Kind = 'winmm'; Id = [uint32]$id; Info = $info }
}

# Axis normalisation to WinMM's 0..65535, centre 32767.
function To-U16([double]$v, [double]$min, [double]$max) {
    if ($max -le $min) { return 32767 }
    $n = ($v - $min) / ($max - $min)
    if ($n -lt 0) { $n = 0 }
    if ($n -gt 1) { $n = 1 }
    return [int][Math]::Round($n * 65535)
}

function Read-Pad {
    param($ctx)
    if ($ctx.Kind -eq 'xinput') { return Read-XInput -ctx $ctx }
    if ($ctx.Kind -eq 'winmm') {
        $i = $ctx.Info
        $r = [PadWinMM.Native]::joyGetPosEx($ctx.Id, [ref]$i)
        if ($r -ne 0) {
            return @{ Ok = $false; Error = $r; X = 32767; Y = 32767; Z = 32767; R = 32767; Buttons = 0; Pov = -1 }
        }
        return @{ Ok = $true; X = [int]$i.dwXpos; Y = [int]$i.dwYpos; Z = [int]$i.dwZpos; R = [int]$i.dwRpos
                  Buttons = [int]$i.dwButtons
                  Pov = $(if ($i.dwPOV -eq 4294967295 -or $i.dwPOV -eq 65535) { -1 } else { [int]$i.dwPOV }) }
    }

    # --- HID: non-blocking poll for the newest input report
    $buf = [PadHid.Native]::PollLatest($ctx.Device)
    if ($null -eq $buf) {
        # No new report this tick. HID is state-based, so repeating the last
        # report is correct: the sticks have not moved.
        if ($null -eq $ctx.Device.LastBuf) { return $null }
        $buf = $ctx.Device.LastBuf
    }
    $n = $buf.Length
    $d = $ctx.Device

    # Generic Desktop: X=0x30 Y=0x31 Z=0x32 Rx=0x33 Ry=0x34 Rz=0x35 Slider=0x36 Dial=0x37 Hat=0x39
    $gx = [PadHid.Native]::GetValue($d, 0x30, $buf, $n)
    $gy = [PadHid.Native]::GetValue($d, 0x31, $buf, $n)
    $gz = [PadHid.Native]::GetValue($d, 0x32, $buf, $n)
    $grz = [PadHid.Native]::GetValue($d, 0x35, $buf, $n)
    $gry = [PadHid.Native]::GetValue($d, 0x34, $buf, $n)

    if ($ctx.Echo -and $ctx.LastRaw -ne ($buf[0..([Math]::Min($n,8)-1)] -join ',')) {
        $hex = ($buf[0..([Math]::Min($n,$buf.Length)-1)] | ForEach-Object { $_.ToString('X2') }) -join ' '
        $ctx.LastRaw = ($buf[0..([Math]::Min($n,8)-1)] -join ',')
        Write-Host ("[hid] report {0}B: {1}" -f $n, $hex) -ForegroundColor DarkGray
    }

    # HID logical ranges for a generic gamepad are typically 0..255 or 0..65535;
    # map via the observed logical max when available, else assume 0..255.
    $span = { param($v, $maxv) if ($v -eq [uint32]::MaxValue) { 32767 } else { To-U16 $v 0 $maxv } }
    $maxV = 255
    return @{
        Ok      = $true
        X       = (& $span $gx $maxV)
        Y       = (& $span $gy $maxV)
        Z       = (& $span $gz $maxV)
        R       = (& $span $grz $maxV)
        Buttons = [int]([PadHid.Native]::GetButtons($d, $buf, $n))
        Pov     = [int]([PadHid.Native]::GetHat($d, $buf, $n))
        # extra axes, kept for the echo view
        _Ry     = (& $span $gry $maxV)
    }
}

# ================================================================ start up
$ctx = $null
if ($Backend -in @('auto', 'xinput')) { $ctx = Start-XInputBackend }
if (-not $ctx -and $Backend -in @('auto', 'hid')) { $ctx = Start-HidBackend }
if (-not $ctx -and $Backend -in @('auto', 'winmm')) {
    if ($Backend -eq 'auto') { Write-Host '[pad] HID unavailable, trying WinMM' -ForegroundColor Yellow }
    $ctx = Start-WinMMBackend
}
if (-not $ctx) {
    throw "No gamepad found by any backend (XInput, HID or WinMM). Plug the USB gamepad in and retry. Run host/test-pad.ps1 for a full device report."
}
$ctx.Echo = $Echo

# ----------------------------------------------------------------- transport
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "[pad] listening on 127.0.0.1:$Port for QEMU UART1" -ForegroundColor DarkGray
Write-Host '[pad] waiting for the emulated guest to connect...' -ForegroundColor DarkGray
$client = $listener.AcceptTcpClient()
$client.NoDelay = $true
$stream = $client.GetStream()
$period = [int](1000.0 / $RateHz)

# The default Windows timer ticks every ~15.6 ms, so Start-Sleep 20 really
# sleeps ~31 ms and the loop ran at ~32 Hz instead of 50. 1 ms resolution for
# this process fixes the cadence; Windows restores it when the process exits.
if (-not ('PadTimer.Native' -as [type])) {
    Add-Type -Namespace PadTimer -Name Native -MemberDefinition @'
[DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
[DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
'@
}
[void][PadTimer.Native]::timeBeginPeriod(1)

$seq = 0
$sent = 0
$last = @{ X = 32767; Y = 32767; Z = 32767; R = 32767; Buttons = 0; Pov = -1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$deadline = if ($Seconds -gt 0) { $Seconds * 1000 } else { [long]::MaxValue }
$nextTick = $sw.ElapsedMilliseconds

# If the guest (QEMU) goes away, do not die: drop the connection and wait for a
# new one. A crashed guest should not force a restart of the whole stack, and a
# half-open socket would otherwise throw on every write.
while ($sw.ElapsedMilliseconds -lt $deadline) {
    $client.NoDelay = $true
    $stream = $client.GetStream()
    Write-Host '[pad] guest connected' -ForegroundColor Green

    try {
        while ($sw.ElapsedMilliseconds -lt $deadline) {
            $s = Read-Pad -ctx $ctx
            if ($null -ne $s) {
                if ($s.Ok) { $last = $s }
                elseif ($s.Error) { Write-Warning "input read failed (code $($s.Error)) - sending neutral" }
            }

            $seq16 = [uint16]($seq -band 0xFFFF)
            $frame = [byte[]]::new(17)
            $frame[0] = 0xA5; $frame[1] = 0x5A
            [BitConverter]::GetBytes($seq16).CopyTo($frame, 2)
            [BitConverter]::GetBytes([uint16]$last.X).CopyTo($frame, 4)
            [BitConverter]::GetBytes([uint16]$last.Y).CopyTo($frame, 6)
            [BitConverter]::GetBytes([uint16]$last.Z).CopyTo($frame, 8)
            [BitConverter]::GetBytes([uint16]$last.R).CopyTo($frame, 10)
            [BitConverter]::GetBytes([uint16]$last.Buttons).CopyTo($frame, 12)
            [BitConverter]::GetBytes([int16]$last.Pov).CopyTo($frame, 14)
            $x = [byte]0
            for ($i = 0; $i -lt 16; $i++) { $x = $x -bxor $frame[$i] }
            $frame[16] = $x

            $stream.Write($frame, 0, $frame.Length)
            $stream.Flush()
            $sent++

            if ($Echo -and ($sent % 10 -eq 0)) {
                Write-Host ("seq={0,5} X={1,5} Y={2,5} Z={3,5} R={4,5} btn=0x{5:X4} pov={6}" -f `
                    $seq16, $last.X, $last.Y, $last.Z, $last.R, $last.Buttons, $last.Pov)
            }

            $seq++
            # Schedule against absolute targets, not "period minus this pass":
            # when the OS oversleeps, the next wait is shorter, so the average
            # rate stays at $RateHz instead of drifting down to ~32 Hz.
            $nextTick += $period
            $now = $sw.ElapsedMilliseconds
            if ($nextTick -lt $now - $period) { $nextTick = $now }  # after a stall, do not burst
            $sleep = $nextTick - $now
            if ($sleep -gt 0) { Start-Sleep -Milliseconds $sleep }
        }
    } catch [System.IO.IOException] {
        Write-Host '[pad] guest disconnected; waiting for it to reconnect' -ForegroundColor Yellow
    } catch [System.Net.Sockets.SocketException] {
        Write-Host '[pad] guest socket closed; waiting for it to reconnect' -ForegroundColor Yellow
    } finally {
        try { $stream.Close() } catch {}
        try { $client.Close() } catch {}
    }

    if ($sw.ElapsedMilliseconds -ge $deadline) { break }
    Write-Host '[pad] waiting for the emulated guest to connect...' -ForegroundColor DarkGray
    $client = $listener.AcceptTcpClient()
}

Write-Host "[pad] stopping after $sent frames" -ForegroundColor Yellow
[void][PadTimer.Native]::timeEndPeriod(1)
if ($ctx.Kind -eq 'hid') { [PadHid.Native]::Close($ctx.Device) }
$listener.Stop()
