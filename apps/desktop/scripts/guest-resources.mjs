import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const mebibyte = 1024 * 1024

function unavailable(guests, reason) {
  return guests.map(guest => ({
    id: guest?.id ?? null,
    pid: guest?.child?.pid ?? null,
    metricsUnavailable: reason,
  }))
}

function samplerScript(pids, durationMs) {
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$guestIds = @(${pids.join(',')})
$identities = @{}
$records = [System.Collections.Generic.List[object]]::new()
$clock = [System.Diagnostics.Stopwatch]::StartNew()
for ($sampleIndex = 0; $sampleIndex -lt 5; $sampleIndex++) {
  $targetMs = $sampleIndex * ${durationMs} / 4
  $remainingMs = $targetMs - $clock.Elapsed.TotalMilliseconds
  if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Ceiling($remainingMs)) }
  foreach ($guestPid in $guestIds) {
    $guestProcess = $null
    try {
      $guestProcess = Get-Process -Id $guestPid -ErrorAction Stop
      $guestProcess.Refresh()
      $startTime = $guestProcess.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
      if ($identities.ContainsKey($guestPid) -and $identities[$guestPid] -ne $startTime) {
        throw 'Process identity changed'
      }
      $identities[$guestPid] = $startTime
      $cpuSeconds = $guestProcess.TotalProcessorTime.TotalSeconds
      $workingSet = $guestProcess.WorkingSet64
      $privateBytes = $guestProcess.PrivateMemorySize64
      if ($guestProcess.HasExited) { throw 'Process exited during sample' }
      $records.Add([pscustomobject]@{
        pid = $guestPid; startTime = $startTime; cpuSeconds = $cpuSeconds
        workingSet = $workingSet; privateBytes = $privateBytes
        elapsedMs = $clock.Elapsed.TotalMilliseconds
      })
    } catch {
      $records.Add([pscustomobject]@{
        pid = $guestPid; error = 'Process unavailable, exited, or changed identity'
      })
    } finally {
      if ($null -ne $guestProcess) { $guestProcess.Dispose() }
    }
  }
}
ConvertTo-Json -InputObject @($records.ToArray()) -Depth 3 -Compress
`
}

export async function sampleGuestResources(guests, durationMs = 10000) {
  if (!Array.isArray(guests)) return unavailable([{}], 'Expected an array of owned guests')
  if (guests.length < 1 || guests.length > 4) return unavailable(guests, 'Expected one to four owned guests')
  const pids = guests.map(guest => guest?.child?.pid)
  if (pids.some(pid => !Number.isInteger(pid) || pid <= 0 || pid > 2147483647)
    || new Set(pids).size !== pids.length) {
    return unavailable(guests, 'Owned guest PIDs must be positive, distinct integers')
  }
  if (guests.some(guest => guest.closed || typeof guest.id !== 'string' || !guest.id)) {
    return unavailable(guests, 'Guest is closed or has no identity')
  }
  if (!Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 10000) {
    return unavailable(guests, 'Sample duration must be between 1000 and 10000 milliseconds')
  }
  if (process.platform !== 'win32') return unavailable(guests, 'Resource sampling is supported on Windows only')

  let records
  try {
    const { stdout } = await execute('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', samplerScript(pids, durationMs),
    ], { windowsHide: true, timeout: durationMs + 45000, maxBuffer: 32768, encoding: 'utf8' })
    records = JSON.parse(stdout.replace(/^\uFEFF/, '').trim())
    if (!Array.isArray(records) || records.length !== pids.length * 5) {
      return unavailable(guests, 'Resource sampler returned incomplete observations')
    }
  } catch {
    return unavailable(guests, 'Resource sampler could not complete bounded process observations')
  }

  return guests.map((guest, index) => {
    const pid = pids[index]
    const fail = reason => ({ id: guest.id, pid, metricsUnavailable: reason })
    if (guest.closed || guest.child?.pid !== pid) return fail('Guest closed or changed during resource sampling')
    const samples = records.filter(record => record.pid === pid)
    if (samples.length !== 5 || samples.some(sample => sample.error)) {
      return fail('Guest process exited, changed identity, or could not be read')
    }
    const first = samples[0]
    const last = samples.at(-1)
    if (typeof first.startTime !== 'string' || !/^\d+$/.test(first.startTime)
      || samples.some(sample => sample.startTime !== first.startTime)) {
      return fail('Guest process start time changed during sampling')
    }
    const values = ['cpuSeconds', 'workingSet', 'privateBytes', 'elapsedMs']
    if (samples.some(sample => values.some(key => !Number.isFinite(sample[key]) || sample[key] < 0))) {
      return fail('Resource sampler returned invalid measurements')
    }
    if (samples.some((sample, position) => position > 0
      && (sample.cpuSeconds < samples[position - 1].cpuSeconds || sample.elapsedMs <= samples[position - 1].elapsedMs))) {
      return fail('Resource counters were not monotonic')
    }
    const sampleDurationMs = last.elapsedMs - first.elapsedMs
    const cpuSecondsDuringSample = last.cpuSeconds - first.cpuSeconds
    return {
      id: guest.id,
      pid,
      peakWorkingSetMiB: Math.max(...samples.map(sample => sample.workingSet)) / mebibyte,
      peakPrivateMiB: Math.max(...samples.map(sample => sample.privateBytes)) / mebibyte,
      cpuSecondsDuringSample,
      sampleDurationMs,
      averageLogicalCoresUsed: cpuSecondsDuringSample * 1000 / sampleDurationMs,
    }
  })
}
