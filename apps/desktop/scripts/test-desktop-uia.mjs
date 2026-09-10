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
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetObject(IntPtr self, out IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int SetInt(IntPtr self, int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int SetObject(IntPtr self, IntPtr value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int FindAll(IntPtr self, int scope, IntPtr condition, out IntPtr elements);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int FindCached(IntPtr self, int scope, IntPtr condition, IntPtr cache, out IntPtr elements);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetCount(IntPtr self, out int value);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetElement(IntPtr self, int index, out IntPtr element);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int GetCached(IntPtr self, int property, int ignoreDefault,
    [MarshalAs(UnmanagedType.Struct)] out object value);
  private static T Method<T>(IntPtr value, int slot) where T : class {
    if (value == IntPtr.Zero) throw new InvalidOperationException("The cache interface is unavailable");
    return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(value), slot * IntPtr.Size), typeof(T));
  }
  private static IntPtr Native(object value, string guid) {
    var unknown = Marshal.GetIUnknownForObject(value);
    try { IntPtr result; var id = new Guid(guid); Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown, ref id, out result)); return result; }
    finally { Marshal.Release(unknown); }
  }
  private static void Release(IntPtr value) { if (value != IntPtr.Zero) Marshal.Release(value); }
  private static void CacheSamples(IntPtr window, int pid, bool managedFirst) {
    AutomationElement managedRoot = null;
    if (managedFirst) {
      managedRoot = AutomationElement.FromHandle(window);
      if (managedRoot.GetRuntimeId().Length == 0) throw new InvalidOperationException("Managed root identity is unavailable");
    }
    var client = (Client)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
    var native = IntPtr.Zero; var cache = IntPtr.Zero; var all = IntPtr.Zero; var raw = IntPtr.Zero;
    try {
      native = Native(client, "30cbe57d-d9d0-452a-ab13-7ac5ac4825ee");
      Marshal.ThrowExceptionForHR(Method<GetObject>(native, 20)(native, out cache));
      Marshal.ThrowExceptionForHR(Method<GetObject>(native, 21)(native, out all));
      Marshal.ThrowExceptionForHR(Method<GetObject>(native, 17)(native, out raw));
      Marshal.ThrowExceptionForHR(Method<SetInt>(cache, 7)(cache, 1)); // Cache only each matched element.
      Marshal.ThrowExceptionForHR(Method<SetObject>(cache, 9)(cache, raw));
      Marshal.ThrowExceptionForHR(Method<SetInt>(cache, 11)(cache, 0)); // Cached-only references reject current reads.
      foreach (var property in new[] { 30019, 30022, 30002 }) Marshal.ThrowExceptionForHR(Method<SetInt>(cache, 3)(cache, property));
      Console.Write("[");
      for (var sample = 0; sample < 3; sample++) {
        Element root = null;
        var rootPointer = IntPtr.Zero; var elements = IntPtr.Zero; var reference = IntPtr.Zero;
        try {
          Marshal.ThrowExceptionForHR(client.ElementFromHandle(window, out root));
          rootPointer = Native(root, "d22108aa-8ac5-49a5-837b-37bbb3d7591e");
          var watch = Stopwatch.StartNew();
          Marshal.ThrowExceptionForHR(Method<FindCached>(rootPointer, 8)(rootPointer, 4, all, cache, out elements));
          int count = 0; var available = true; var password = false;
          if (elements != IntPtr.Zero) Marshal.ThrowExceptionForHR(Method<GetCount>(elements, 3)(elements, out count));
          if (count < 0 || count > 1024) available = false;
          for (var index = 0; available && index < count; index++) {
            var element = IntPtr.Zero;
            try {
              Marshal.ThrowExceptionForHR(Method<GetElement>(elements, 4)(elements, index, out element));
              object secret, offscreen, process;
              Marshal.ThrowExceptionForHR(Method<GetCached>(element, 13)(element, 30019, 1, out secret));
              Marshal.ThrowExceptionForHR(Method<GetCached>(element, 13)(element, 30022, 1, out offscreen));
              Marshal.ThrowExceptionForHR(Method<GetCached>(element, 13)(element, 30002, 1, out process));
              available = secret is bool && offscreen is bool && process is int && (int)process == pid;
              if (available && (bool)secret && !(bool)offscreen) password = true;
            } finally { Release(element); }
          }
          watch.Stop();
          Marshal.ThrowExceptionForHR(Method<FindAll>(rootPointer, 6)(rootPointer, 4, all, out reference));
          int referenceCount = 0;
          if (reference != IntPtr.Zero) Marshal.ThrowExceptionForHR(Method<GetCount>(reference, 3)(reference, out referenceCount));
          available = available && count == referenceCount;
          if (sample > 0) Console.Write(",");
          Console.Write("{\\"available\\":" + (available ? "true" : "false")
            + ",\\"password\\":" + (available ? (password ? "true" : "false") : "null")
            + ",\\"elapsedMs\\":" + watch.Elapsed.TotalMilliseconds.ToString(System.Globalization.CultureInfo.InvariantCulture)
            + ",\\"nodes\\":" + count + ",\\"referenceNodes\\":" + referenceCount + "}");
        } finally { Release(reference); Release(elements); Release(rootPointer); if (root != null) Marshal.FinalReleaseComObject(root); }
      }
      Console.WriteLine("]");
    } finally { Release(raw); Release(all); Release(cache); Release(native); Marshal.FinalReleaseComObject(client); GC.KeepAlive(managedRoot); }
  }
  private static void Production(IntPtr window, int pid, string mode) {
    AutomationElement managedRoot = null;
    if (mode == "--production-managed-first") {
      managedRoot = AutomationElement.FromHandle(window);
      if (managedRoot.GetRuntimeId().Length == 0) throw new InvalidOperationException("Managed root identity is unavailable");
    }
    var client = (Client)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("e22ad333-b25f-460c-83d0-0581107395c9"), true));
    try {
      using (var scan = new RemotePasswordScan()) {
        var warmup = "not-run";
        if (mode == "--production-native-first-mixed") {
          Element nativeRoot = null;
          try {
            Marshal.ThrowExceptionForHR(client.ElementFromHandle(window, out nativeRoot));
            bool ignored;
            warmup = scan.TryScan(nativeRoot, pid, out ignored) ? "available" : scan.Diagnostic;
          } finally { if (nativeRoot != null) Marshal.FinalReleaseComObject(nativeRoot); }
          managedRoot = AutomationElement.FromHandle(window);
          if (managedRoot.GetRuntimeId().Length == 0) throw new InvalidOperationException("Managed root identity is unavailable");
        }
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
              + ",\\"diagnostic\\":\\"" + scan.Diagnostic + "\\",\\"warmup\\":\\"" + warmup + "\\"}");
          } finally { if (root != null) Marshal.FinalReleaseComObject(root); }
        }
        Console.WriteLine("]");
      }
    } finally { Marshal.FinalReleaseComObject(client); GC.KeepAlive(managedRoot); }
  }
  [MTAThread] private static int Main(string[] args) {
    try {
      if (Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
          || (args.Length != 2 && (args.Length != 3 || (args[2] != "--production" && args[2] != "--production-managed-first"
              && args[2] != "--production-native-first-mixed" && args[2] != "--cache" && args[2] != "--cache-managed-first"))))
        throw new InvalidOperationException("An isolated Windows CI fixture is required");
      var window = new IntPtr(long.Parse(args[0]));
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      var title = new StringBuilder(128);
      GetWindowText(window, title, title.Capacity);
      if (pid != uint.Parse(args[1]) || title.ToString() != "Desktop input fixture")
        throw new InvalidOperationException("The owned fixture window is unavailable");
      if (args.Length == 3) {
        if (args[2] == "--cache" || args[2] == "--cache-managed-first") CacheSamples(window, checked((int)pid), args[2] == "--cache-managed-first");
        else Production(window, checked((int)pid), args[2]);
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
  const initializationOrder = {
    managedFirst: JSON.parse(run(managed, [...args, '--production-managed-first'], { timeout: 10000 })),
    nativeFirstMixed: JSON.parse(run(managed, [...args, '--production-native-first-mixed'], { timeout: 10000 })),
  }
  for (const measurements of Object.values(initializationOrder)) {
    assert.equal(measurements.length, 3)
    for (const sample of measurements) {
      assert.equal(typeof sample.available, 'boolean')
      assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0)
      assert.equal(typeof sample.diagnostic, 'string')
      if (sample.available) assert.equal(sample.password, expectedPassword)
      else assert.equal(sample.password, null, 'Initialization failure cannot establish the absence of passwords')
    }
  }
  const bulkCache = {
    native: JSON.parse(run(managed, [...args, '--cache'], { timeout: 20000 })),
    managedFirst: JSON.parse(run(managed, [...args, '--cache-managed-first'], { timeout: 20000 })),
  }
  for (const measurements of Object.values(bulkCache)) {
    assert.equal(measurements.length, 3)
    for (const sample of measurements) {
      assert.equal(typeof sample.available, 'boolean')
      assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs >= 0)
      assert.ok(Number.isInteger(sample.nodes) && sample.nodes >= 0)
      assert.ok(Number.isInteger(sample.referenceNodes) && sample.referenceNodes > 0)
      if (sample.available) {
        assert.equal(sample.nodes, sample.referenceNodes)
        assert.equal(sample.password, expectedPassword, 'The complete bulk cache missed a password surface')
      } else assert.equal(sample.password, null, 'Incomplete cached properties cannot clear the password scan')
    }
  }
  return { ...samples, remote, production, ...initializationOrder, bulkCache }
}
