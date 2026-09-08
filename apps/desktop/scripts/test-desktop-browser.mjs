import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function testDesktopBrowser(helper, desktop, output, until) {
  if (process.env.CI !== 'true' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Owned browser input requires isolated CI')
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)
    .map(root => path.join(root, 'Microsoft/Edge/Application/msedge.exe'))
  const executable = candidates.find(existsSync)
  assert.ok(executable, 'The Windows test image must provide Edge')
  const id = randomUUID()
  const url = pathToFileURL(path.join(desktop, 'e2e/fixtures/desktop/browser.html'))
  url.hash = id
  const child = spawn(executable, [`--user-data-dir=${path.join(output, 'owned-browser')}`, `--app=${url.href}`,
    '--no-first-run', '--no-default-browser-check', '--force-renderer-accessibility', '--disable-background-mode'],
  { windowsHide: true, stdio: 'ignore' })
  let failure
  child.on('error', error => { failure = error })
  try {
    const windows = await until(async () => {
      if (failure) throw failure
      return helper.request('listWindows')
    }, value => value.windows.some(window => window.title.includes(id)), 'Owned browser window did not become available')
    const selected = windows.windows.find(window => window.title.includes(id))
    const target = { window: selected.window, pid: selected.pid }
    let view = await until(() => helper.request('observe', target), value => value.nodes.some(node => node.name === 'Browser entry'), 'Owned browser input must expose accessibility')
    const lease = await helper.request('bind', { ...target, grant: randomUUID() })
    const bound = { ...target, lease: lease.lease }
    view = await helper.request('observe', bound)
    const entry = view.nodes.find(node => node.name === 'Browser entry' && node.controlType === 'Edit')
    assert.ok(entry, 'Owned browser editable element must be identified')
    await helper.request('click', { ...bound, snapshot: view.snapshot, element: entry.id })
    view = await helper.request('observe', bound)
    await helper.request('type', { ...bound, snapshot: view.snapshot, text: 'Browser 한글 input' })
    view = await until(() => helper.request('observe', bound), value => value.nodes.some(node => node.value === 'Browser 한글 input'), 'Native typing must reach the browser field')
    const button = view.nodes.find(node => node.name === 'Browser count 0' && node.controlType === 'Button')
    assert.ok(button)
    await helper.request('click', { ...bound, snapshot: view.snapshot, element: button.id })
    view = await until(() => helper.request('observe', bound), value => value.nodes.some(node => node.name === 'Browser count 1'), 'Native click must update the browser')
    await helper.request('scroll', { ...bound, snapshot: view.snapshot, delta: -3 })
    await until(() => helper.request('observe', bound), value => value.nodes.some(node => /^Browser scroll [1-9]/.test(node.name)), 'Native browser scroll must move content')
    await helper.request('stop')
    return true
  } finally {
    await helper.request('stop').catch(() => undefined)
    if (child.exitCode === null) child.kill()
  }
}
