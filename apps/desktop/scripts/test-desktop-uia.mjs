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
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder title, int size);
  [MTAThread] private static int Main(string[] args) {
    try {
      if (Environment.GetEnvironmentVariable("CI") != "true" || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" || args.Length != 2)
        throw new InvalidOperationException("An isolated Windows CI fixture is required");
      var window = new IntPtr(long.Parse(args[0]));
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      var title = new StringBuilder(128);
      GetWindowText(window, title, title.Capacity);
      if (pid != uint.Parse(args[1]) || title.ToString() != "Desktop input fixture")
        throw new InvalidOperationException("The owned fixture window is unavailable");
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
    run('cl.exe', ['/nologo', '/EHsc', '/O2', '/std:c++17',
      path.join(desktop, 'e2e/fixtures/desktop/AutomationProbe.cpp'), `/Fe:${native}`, '/link', 'ole32.lib', 'oleaut32.lib', 'user32.lib'],
    { cwd: output, env: environment })
    const framework = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319')
    const source = path.join(output, 'ManagedAutomationProbe.cs')
    writeFileSync(source, managedSource)
    run(path.join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/optimize+',
      '/reference:System.dll', `/reference:${path.join(framework, 'WPF/UIAutomationClient.dll')}`,
      `/reference:${path.join(framework, 'WPF/UIAutomationTypes.dll')}`, `/reference:${path.join(framework, 'WPF/WindowsBase.dll')}`,
      `/out:${managed}`, source])
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
  return samples
}
