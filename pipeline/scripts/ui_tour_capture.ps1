# Real-window screenshots of Studio (v0.3 UI tour or v0.2 keyboard tour).
#   powershell -File scripts/ui_tour_capture.ps1 -Exe <PikaraScienceStudio.exe> -Data <data dir> -Out <png dir> [-Width 1440 -Height 900] [-Mode tour|keys] [-Episode ep04:zh-TW]
# tour : starts Studio with PIKARA_UI_TOUR=1; the app walks every section/tab in light + dark mode and writes
#        <data>\ui-tour\current.txt + <step>.json (layout / state checks); this script captures the window each time
#        current.txt changes, until "done". Exits Studio afterwards (only the process it started).
# keys : for builds without the tour (v0.2.x "before" shots): sends Ctrl+1..N and captures after each.
param(
  [Parameter(Mandatory)] [string]$Exe,
  [Parameter(Mandatory)] [string]$Data,
  [Parameter(Mandatory)] [string]$Out,
  [int]$Width = 1440, [int]$Height = 900,
  [ValidateSet('tour', 'keys')] [string]$Mode = 'tour',
  [int]$Keys = 6,
  [string]$Episode = '',
  [int]$TimeoutSec = 900
)
$ErrorActionPreference = 'Stop'
# Screenshots never run together with rendering, TTS or other GPU tests: take the machine-wide GPU lease first
# (scripts/gpu_lock.py waits for it, then re-runs this script as its child with PIKARA_GPU_LOCK_OWNER set).
if (-not $env:PIKARA_GPU_LOCK_OWNER) {
  $fwd = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  foreach ($k in $PSBoundParameters.Keys) { $fwd += "-$k"; $fwd += [string]$PSBoundParameters[$k] }
  & py -3.11 (Join-Path $PSScriptRoot 'gpu_lock.py') --who 'ui-screenshot-tour' -- powershell @fwd
  exit $LASTEXITCODE
}
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class Win {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  // Returns false when the capture is blank (WebView2 not composited yet, e.g. while the GPU is busy); caller retries.
  public static bool Shot(IntPtr h, string path) {
    RECT r; GetWindowRect(h, out r);
    int w = r.R - r.L, hh = r.B - r.T;
    using (var bmp = new Bitmap(w, hh, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) { IntPtr dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      int lit = 0, n = 0;
      for (int y = hh / 10; y < hh; y += hh / 10) for (int x = w / 10; x < w; x += w / 10) { var c = bmp.GetPixel(x, y); n++; if (c.R + c.G + c.B > 30) lit++; }
      bmp.Save(path, ImageFormat.Png);
      return lit > n / 10;
    }
  }
  public static void ShotRetry(IntPtr h, string path) {
    for (int i = 0; i < 4; i++) { if (Shot(h, path)) return; System.Threading.Thread.Sleep(1200); }
  }
}
"@
[Win]::SetProcessDPIAware() | Out-Null  # physical pixels: the whole window at any display scaling
New-Item -ItemType Directory -Force $Out | Out-Null
New-Item -ItemType Directory -Force $Data | Out-Null
$tourDir = Join-Path $Data 'ui-tour'
if (Test-Path $tourDir) { Remove-Item -Recurse -Force $tourDir }
$env:PIKARA_STUDIO_DATA = $Data
if ($Mode -eq 'tour') { $env:PIKARA_UI_TOUR = '1'; $env:PIKARA_UI_TOUR_STEP_MS = '2600'; if ($Episode) { $env:PIKARA_UI_TOUR_EPISODE = $Episode } }
$p = Start-Process -FilePath $Exe -PassThru
try {
  $deadline = (Get-Date).AddSeconds(60)
  while ($p.MainWindowHandle -eq 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500; $p.Refresh() }
  if ($p.MainWindowHandle -eq 0) { throw 'Studio window did not appear' }
  $h = $p.MainWindowHandle
  [Win]::ShowWindow($h, 9) | Out-Null
  $scale = [Win]::GetDpiForWindow($h) / 96.0; if ($scale -le 0) { $scale = 1 }
  # -Width/-Height are logical (CSS) pixels; the window itself is sized in physical pixels
  [Win]::SetWindowPos($h, [IntPtr]::Zero, 20, 20, [int]($Width * $scale), [int]($Height * $scale), 0x0040) | Out-Null
  Start-Sleep -Seconds 4
  if ($Mode -eq 'keys') {
    Add-Type -AssemblyName System.Windows.Forms
    [Win]::ShotRetry($h, (Join-Path $Out '00-start.png'))
    for ($i = 1; $i -le $Keys; $i++) {
      [Win]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 300
      [System.Windows.Forms.SendKeys]::SendWait("^$i"); Start-Sleep -Seconds 3
      [Win]::ShotRetry($h, (Join-Path $Out ("{0:D2}-ctrl{0}.png" -f $i)))
    }
  } else {
    $cur = ''; $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
      $f = Join-Path $tourDir 'current.txt'
      if (Test-Path $f) {
        $s = (Get-Content $f -Raw).Trim()
        if ($s -ne $cur) {
          $cur = $s
          if ($s -eq 'done') { break }
          if ($s -ne 'start') { Start-Sleep -Milliseconds 250; [Win]::ShotRetry($h, (Join-Path $Out "$s.png")) }
        }
      }
      Start-Sleep -Milliseconds 150
    }
    Copy-Item (Join-Path $tourDir '*.json') $Out -ErrorAction SilentlyContinue
  }
} finally {
  if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force }
}
"captured: " + (Get-ChildItem $Out -Filter *.png).Count
