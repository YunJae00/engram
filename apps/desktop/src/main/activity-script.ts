// One PowerShell child for the whole life of the watcher, waking each second.
// Every SAMPLE_MS it prints the foreground process and title, one
// pipe-separated line, and the first time a process is seen, at start for any
// with a window and later in front, its program's path on a ":path|" line
// (":" cannot begin a process name). Titles are read
// wide: the narrow call turns whatever the system code page cannot hold into "?".
//
// Each second it also looks at the system's notification store. That store
// sends no change event to an unpackaged app and a file watcher never fires on
// it, but its write-ahead log changes on every notification, so the list is
// read only when that log changed, and each notification not yet printed goes
// out at once as ":toast|<json>" - before the person can clear it. A list that
// cannot be read is said once on a ":toasts|" line.
export function activityScript(ownerPid: number, sampleMs: number): string {
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
'@
$toasts = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = '' + $listener.GetAccessStatus()
  if ($access -eq 'Allowed') {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -match '^IAsyncOperation.1$' } | Select-Object -First 1
    $asTask = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
    $wal = [System.IO.Path]::Combine($env:LOCALAPPDATA, 'Microsoft', 'Windows', 'Notifications', 'wpndatabase.db-wal')
    $toasts = @{}
  } else { Write-Output (':toasts|access ' + $access) }
} catch { Write-Output (':toasts|' + $_.Exception.Message) }
$stamp = ''
$seen = @{}
# Apps used before paths were kept get theirs from any window open now.
foreach ($p in Get-Process | Where-Object { $_.MainWindowHandle -ne 0 }) {
  try { if (-not $seen.ContainsKey($p.ProcessName) -and $p.Path) { $seen[$p.ProcessName] = 1; Write-Output (':path|' + $p.ProcessName + '|' + $p.Path) } } catch {}
}
$tick = 0
$every = ${Math.max(1, Math.round(sampleMs / 1000))}
while ($true) {
  if ($tick % $every -eq 0) {
    if (-not (Get-Process -Id ${ownerPid} -ErrorAction SilentlyContinue)) { break }
    try {
      $h = [FG]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [void][FG]::GetWindowText($h, $sb, 512)
      $procId = 0
      [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      $name = $p.ProcessName
      if ($name -and -not $seen.ContainsKey($name)) { $seen[$name] = 1; if ($p.Path) { Write-Output (':path|' + $name + '|' + $p.Path) } }
      if ($name) { Write-Output ($name + '|' + $sb.ToString()) }
    } catch {}
  }
  if ($toasts) {
    try {
      $file = New-Object System.IO.FileInfo $wal
      $now = '' + $file.LastWriteTimeUtc.Ticks + '/' + $file.Length
      if ($now -ne $stamp) {
        $stamp = $now
        $task = $asTask.Invoke($null, @($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)))
        if ($task.Wait(5000)) {
          $next = @{}
          foreach ($n in $task.Result) {
            $key = '' + $n.AppInfo.AppUserModelId + '|' + $n.Id + '|' + $n.CreationTime.UtcTicks
            $next[$key] = 1
            if ($toasts.ContainsKey($key)) { continue }
            $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
            $texts = @(if ($binding) { $binding.GetTextElements() | ForEach-Object { $_.Text } })
            Write-Output (':toast|' + (ConvertTo-Json -Compress @{ key = $key; app = $n.AppInfo.DisplayInfo.DisplayName; aumid = $n.AppInfo.AppUserModelId; at = $n.CreationTime.UtcDateTime.ToString('o'); texts = $texts }))
          }
          $toasts = $next
        } else { $stamp = '' }
      }
    } catch { $stamp = '' }
  }
  $tick++
  Start-Sleep -Milliseconds 1000
}
`
}
