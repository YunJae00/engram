import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const managedSource = `
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;
internal static class AutomationProbe {
  [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface Client {
    [PreserveSig] int CompareElements(IntPtr first, IntPtr second, out int same);
    [PreserveSig] int CompareRuntimeIds(IntPtr first, IntPtr second, out int same);
    [PreserveSig] int GetRootElement(out IntPtr root);
    [PreserveSig] int ElementFromHandle(IntPtr window, out Element root);
  }
  [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface Element { }
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  private static void Production(IntPtr window, int pid) {
    var client = (Client)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
    try {
      using (var scan = new RemotePasswordScan()) {
        Console.Write("[");
        for (var index = 0; index < 3; index++) {
          Element root = null;
          try {
            Marshal.ThrowExceptionForHR(client.ElementFromHandle(window, out root));
            var watch = Stopwatch.StartNew();
            bool password;
            var available = scan.TryScan(root, pid, out password);
            watch.Stop();
            if (index > 0) Console.Write(",");
            Console.Write("{\\"available\\":" + (available ? "true" : "false")
              + ",\\"password\\":" + (available ? (password ? "true" : "false") : "null")
              + ",\\"elapsedMs\\":" + watch.Elapsed.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture)
              + ",\\"diagnostic\\":\\"" + scan.Diagnostic + "\\"}");
          } finally { if (root != null) Marshal.FinalReleaseComObject(root); }
        }
        Console.WriteLine("]");
      }
    } finally { Marshal.FinalReleaseComObject(client); }
  }
  [MTAThread] private static int Main(string[] args) {
    try {
      if (Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
          || (args.Length != 2 && (args.Length != 3 || args[2] != "--production")))
        throw new InvalidOperationException("An isolated Windows CI fixture is required");
      var window = new IntPtr(long.Parse(args[0]));
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      var title = new StringBuilder(128);
      GetWindowText(window, title, title.Capacity);
      if (pid != uint.Parse(args[1]) || title.ToString() != "Desktop input fixture")
        throw new InvalidOperationException("The owned fixture window is unavailable");
      if (args.Length == 3) {
        Production(window, checked((int)pid));
        return 0;
      }
      var condition = new AndCondition(new PropertyCondition(AutomationElement.IsPasswordProperty, true),
        new PropertyCondition(AutomationElement.IsOffscreenProperty, false));
      Console.Write("[");
      for (var index = 0; index < 3; index++) {
        var root = AutomationElement.FromHandle(window);
        var watch = Stopwatch.StartNew();
        var found = root.FindFirst(TreeScope.Descendants, condition);
        watch.Stop();
        if (index > 0) Console.Write(",");
        Console.Write("{\\"elapsedMs\\":" + watch.Elapsed.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture)
          + ",\\"password\\":" + (found == null ? "false" : "true") + "}");
      }
      Console.WriteLine("]");
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
  }
}`

export function testDesktopUia(desktop, output, target, expectedPassword) {
  if (process.platform !== 'win32' || process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('UI Automation measurements require an isolated Windows CI runner')
  }
  assert.match(String(target.window), /^[1-9][0-9]*$/)
  assert.ok(Number.isInteger(target.pid) && target.pid > 0)
  assert.equal(typeof expectedPassword, 'boolean')
  const native = path.join(output, 'AutomationProbe.exe')
  const managed = path.join(output, 'ManagedAutomationProbe.exe')
  const run = (executable, args, options = {}) => execFileSync(executable, args,
    { windowsHide: true, encoding: 'utf8', timeout: 60000, ...options })
  if (!existsSync(native)) {
    const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio/Installer/vswhere.exe')
    const visualStudio = run(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']).trim()
    assert.ok(visualStudio, 'The Windows CI C++ compiler is unavailable')
    const setup = path.join(visualStudio, 'Common7/Tools/VsDevCmd.bat')
    const environment = { ...process.env }
    for (const line of run('cmd.exe', ['/d', '/s', '/c', `"call "${setup}" -no_logo -arch=x64 >nul && set"`],
      { windowsVerbatimArguments: true }).split(/\r?\n/)) {
      const separator = line.indexOf('=')
      if (separator > 0) environment[line.slice(0, separator)] = line.slice(separator + 1)
    }
    run('cl.exe', ['/nologo', '/EHsc', '/O2', '/std:c++20',
      path.join(desktop, 'e2e/fixtures/desktop/AutomationProbe.cpp'), `/Fe:${native}`, '/link', 'ole32.lib', 'oleaut32.lib', 'user32.lib', 'runtimeobject.lib'],
    { cwd: output, env: environment })
    const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319')
    const source = path.join(output, 'ManagedAutomationProbe.cs')
    writeFileSync(source, managedSource)
    run(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+',
      '/reference:System.dll', `/reference:${path.join(framework, 'WPF/UIAutomationClient.dll')}`,
      `/reference:${path.join(framework, 'WPF/UIAutomationTypes.dll')}`, `/reference:${path.join(framework, 'WPF/WindowsBase.dll')}`,
      `/out:${managed}`, source, path.join(desktop, 'native/desktop/RemotePasswordScan.cs'),
      path.join(desktop, 'native/desktop/RemoteScanProgram.cs')])
  }
  const args = [String(target.window), String(target.pid)]
  const samples = { managed: JSON.parse(run(managed, args)), ...JSON.parse(run(native, args)) }
  for (const measurements of Object.values(samples)) {
    assert.equal(measurements.length, 3)
    for (const sample of measurements) {
      assert.equal(sample.password, expectedPassword, 'UI Automation backends disagreed about the password surface')
      assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0)
    }
  }
  let remote
  try { remote = JSON.parse(run(native, [...args, '--remote'], { timeout: 10000 })) }
  catch { remote = { available: false, stage: 'timeout-or-process-failure', completeCoverage: false } }
  assert.equal(typeof remote.available, 'boolean')
  assert.equal(typeof remote.completeCoverage, 'boolean')
  if (remote.available) {
    assert.equal(remote.propertyMatches, true, 'Remote property results disagreed with the live control')
    assert.equal(remote.navigationMatches, true, 'Remote navigation identified different controls')
    assert.equal(remote.completeCoverage, remote.fullScan?.completeCoverage === true)
    if (remote.completeCoverage) {
      const scan = remote.fullScan
      assert.equal(scan.exhausted, true)
      assert.equal(scan.reason, 0)
      assert.equal(scan.password, expectedPassword, 'The complete remote scan missed a password surface')
      assert.equal(scan.passwordMatches, true)
      assert.equal(scan.nodeCountMatches, true)
      assert.equal(scan.nodesVisited, scan.referenceNodes)
      assert.ok(scan.nodesVisited > 0 && scan.nodesVisited <= scan.nodeLimit)
      assert.ok(scan.maxDepth > 0 && scan.maxDepth <= scan.depthLimit)
      assert.ok(scan.chargedInstructions <= scan.instructionLimit)
      assert.ok(Number.isFinite(scan.elapsedMs) && scan.elapsedMs >= 0)
    }
  }
  const production = JSON.parse(run(managed, [...args, '--production'], { timeout: 10000 }))
  assert.equal(production.length, 3)
  for (const sample of production) {
    assert.equal(typeof sample.available, 'boolean')
    assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0)
    if (remote.completeCoverage) assert.equal(sample.available, true, 'The production WinRT fast path failed despite complete native remote coverage')
    if (sample.available) assert.equal(sample.password, expectedPassword, 'The production fast path disagreed with the full reference query')
    else assert.equal(sample.password, null, 'An unavailable scan must not claim the absence of passwords')
  }
  return { ...samples, remote, production }
}
