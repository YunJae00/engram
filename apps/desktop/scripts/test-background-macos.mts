import { _electron as electron } from '@playwright/test'
import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

if (process.platform !== 'darwin') throw new Error('Requires macOS')
const root = fileURLToPath(new URL('../../..', import.meta.url))
const output = join(root, 'tmp/background-work')
await mkdir(output, { recursive: true })
const run = await mkdtemp(join(output, 'run-'))
const fixturePath = join(run, 'EngramFixture')
execFileSync('xcrun', ['swiftc', '-parse-as-library', join(root, 'apps/desktop/native/macos-test/Fixture.swift'), '-o', fixturePath])
const fixture = spawn(fixturePath)
const lines = createInterface({ input: fixture.stdout! })
const [target] = await once(lines, 'line')
const server = createServer((_request, response) => { response.setHeader('content-type', 'text/html'); response.end('<html><body><h1>Engram browser background fixture</h1><p>Verified alongside the desktop app.</p></body></html>') })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const browserUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
const main = join(run, 'out/main/index.mjs')
await mkdir(join(run, 'userdata'), { recursive: true })
await mkdir(join(run, 'out/main'), { recursive: true })
const { symlink } = await import('node:fs/promises')
for (const dir of ['renderer', 'preload']) await symlink(join(root, 'apps/desktop/out', dir), join(run, 'out', dir))
await symlink(join(root, 'apps/desktop/native-bin'), join(run, 'native-bin'))
await symlink(join(root, 'apps/desktop/out/main/process-worker.js'), join(run, 'out/main/process-worker.js'))
await build({
  stdin: { contents: `
import { app, BrowserWindow } from 'electron';
import { agentCourier } from './apps/desktop/src/main/agent-courier.ts';
import { closeAgentBrowser, ensureAgentPage } from './apps/desktop/src/main/agent-browser.ts';
import { desktopAgentTools } from './apps/desktop/src/main/desktop-agent.ts';
import { closeDesktopAccess } from './apps/desktop/src/main/desktop-access.ts';
import { closeWorkPreview } from './apps/desktop/src/main/work-preview.ts';
app.setPath('userData', ${JSON.stringify(join(run, 'userdata'))});
app.whenReady().then(async () => {
const win = new BrowserWindow({width: 600, height: 360, title: 'Engram foreground typing fixture', webPreferences: {contextIsolation: true}});
await win.loadURL('data:text/html,<html><body style="font:20px system-ui;padding:30px"><h2>Engram foreground typing fixture</h2><textarea id="typing" autofocus style="width:100%;height:120px"></textarea></body></html>');
win.show();app.focus({steal:true});win.focus();
globalThis.backgroundFocusLosses = 0;
win.on('blur', () => globalThis.backgroundFocusLosses++);
globalThis.backgroundTool = async (name,args) => {
 const tool=desktopAgentTools('bot-background-fixture').find(t=>t.name===name);
 if(!tool)throw Error('Tool unavailable: '+name);
 return await tool.run(args,{task:'Read and edit the owned fixture draft without sending anything'});
};
globalThis.backgroundBrowser = (lane = 'bot-background-fixture') => agentCourier({lane}).fetchPage(${JSON.stringify(browserUrl)});
globalThis.backgroundPopup = async () => {
 const page = await ensureAgentPage('bot-background-fixture');
 const waiting = page.waitForEvent('popup');
 await page.evaluate(() => window.open('/popup', 'popup', 'width=600,height=500'));
 const popup = await waiting; await popup.waitForLoadState('domcontentloaded');
 await popup.evaluate(() => window.focus());
};
globalThis.backgroundClose = async () => {closeWorkPreview();closeDesktopAccess();await closeAgentBrowser({force:true});};
}).catch(error => {console.error(error);app.exit(1);});
`, resolveDir: root },
  outfile: main, bundle: true, platform: 'node', format: 'esm', packages: 'external', alias: { core: join(root, 'packages/core/src/index.ts') }, logLevel: 'warning',
})
// Resolve workspace packages for the bundled probe without changing global installs.
await mkdir(join(run, 'node_modules'))
for (const base of ['apps/desktop/node_modules', 'packages/core/node_modules']) {
  for (const name of await readdir(join(root, base))) {
    if (name.startsWith('.')) continue
    if (name.startsWith('@')) {
      await mkdir(join(run, 'node_modules', name), { recursive: true })
      for (const child of await readdir(join(root, base, name))) await symlink(join(root, base, name, child), join(run, 'node_modules', name, child)).catch(error => { if (error.code !== 'EEXIST') throw error })
    } else await symlink(join(root, base, name), join(run, 'node_modules', name)).catch(error => { if (error.code !== 'EEXIST') throw error })
  }
}
const app = await electron.launch({ args: [main], timeout: 30000, recordVideo: { dir: join(run, 'video'), size: { width: 900, height: 720 } }, env: { ...process.env, ENGRAM_USERDATA: join(run, 'userdata') } })
try {
  app.process().stderr?.on('data', data => process.stderr.write(data))
  const page = await app.firstWindow({ timeout: 20000 })
  await page.locator('#typing').focus()
  const nativeFocus = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Engram foreground typing fixture')?.isFocused())
  assert.equal(await nativeFocus(), true, 'The foreground fixture must have native focus before testing')
  const tool = (name: string, args: Record<string, unknown>) => app.evaluate(async (_, { name, args }) => (globalThis as unknown as { backgroundTool(name: string, args: Record<string, unknown>): Promise<unknown> }).backgroundTool(name, args), { name, args })
  const read = await tool('app_read', { app: `window:${target}:0` }) as string
  assert.match(read, /snapshot [a-f0-9]{32}/)
  const snapshot = /snapshot ([a-f0-9]{32})/.exec(read)![1]
  const control = /^(c\d+) .*"Fixture message"/m.exec(read)![1]
  const input = 'I keep typing while Engram edits another app. '
  const typing = page.locator('#typing').pressSequentially(input.repeat(3), { delay: 45 })
  const result = JSON.parse(await tool('app_set', { app: `window:${target}:0`, snapshot, control, text: '한글 초안 🙂 — background edit', expected: 'owned fixture initial' }) as string)
  assert.equal(result.exact, true)
  assert.equal(result.foregroundChanged, false)
  assert.match(result.appNow, /한글 초안/)
  await typing
  assert.equal(await page.locator('#typing').inputValue(), input.repeat(3))
  assert.equal(await page.evaluate(() => document.hasFocus()), true)
  const browserResult = await app.evaluate(async () => (globalThis as unknown as {backgroundBrowser(): Promise<unknown>}).backgroundBrowser())
  assert.match(JSON.stringify(browserResult), /Engram browser background fixture/)
  assert.equal(await nativeFocus(), true, 'Browser startup stole the typing window focus')
  await app.evaluate(async () => (globalThis as unknown as {backgroundBrowser(lane: string): Promise<unknown>}).backgroundBrowser('bot-background-second'))
  assert.equal(await nativeFocus(), true, 'Another conversation browser stole native focus')
  await app.evaluate(async () => (globalThis as unknown as {backgroundPopup(): Promise<void>}).backgroundPopup())
  assert.equal(await nativeFocus(), true, 'A website popup stole native focus')
  const windows = await tool('list_windows', {}) as string
  await writeFile(join(run, 'windows.txt'), windows)
  const calculatorId = windows.split('\n').filter(line => /계산기|Calculator/.test(line) && !line.includes(' Window —')).map(line => /^- (window:\d+:0) /.exec(line)?.[1]).find(Boolean)
  assert(calculatorId, 'Open Calculator for this real-app comparison')
  let calculatorRead = await tool('app_read', { app: calculatorId }) as string
  await writeFile(join(run, 'calculator-read.txt'), calculatorRead)
  const continuingInput = page.locator('#typing').pressSequentially(' Calculator stays in the background.', { delay: 50 }).catch(error => error)
  for (const labels of [['모두 지우기', 'All Clear'], ['1'], ['2'], ['3'], ['더하기', 'Add'], ['4'], ['5'], ['6'], ['등호', 'Equals']]) {
    const line = calculatorRead.split('\n').find(line => labels.some(label => line.includes(JSON.stringify(label))) && line.includes('[press'))
    assert(line, `Calculator control missing: ${labels.join('/')}`)
    const snap = /snapshot ([a-f0-9]{32})/.exec(calculatorRead)![1]
    const controlId = /^(c\d+) /.exec(line)![1]
    const receipt = JSON.parse(await tool('app_press', { app: calculatorId, snapshot: snap, control: controlId }) as string)
    assert.equal(receipt.foregroundChanged, false)
    calculatorRead = receipt.appNow
    assert(calculatorRead, 'Each calculator press must return a fresh observation')
  }
  await continuingInput
  assert.match(calculatorRead, /579/)
  assert.equal(await nativeFocus(), true, 'Calculator stole focus')
  const focusLosses = await app.evaluate(() => (globalThis as unknown as {backgroundFocusLosses: number}).backgroundFocusLosses)
  assert.equal(focusLosses, 0, 'A background action briefly took native focus')
  assert.equal(await page.locator('#typing').inputValue(), input.repeat(3) + ' Calculator stays in the background.')
  const frames = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('work-preview')).map(w => ({ focusable: w.isFocusable(), visible: w.isVisible() })))
  assert(frames.length === 1 && !frames[0]!.focusable)
  await page.screenshot({ path: join(run, 'foreground-input.png') })
  const preview = app.windows().find(w => w.url().includes('work-preview'))
  if (preview) { await new Promise(resolve => setTimeout(resolve, 3000)); await preview.locator('.work-preview-card').first().waitFor({ timeout: 10000 }); await preview.screenshot({ path: join(run, 'work-preview.png') }) }
  await writeFile(join(run, 'result.json'), JSON.stringify({ passed: true, target, backgroundEdit: result.exact, foregroundChanged: result.foregroundChanged, nativeFocusLosses: focusLosses, inputPreserved: true, calculator: '123+456=579', browserRead: true, frames }, null, 2))
  console.log('PASS background app_set through public tool, Korean readback, concurrent foreground typing and nonfocusable preview', run)
} catch (error) { console.error(error); throw error } finally {
  await app.evaluate(() => (globalThis as unknown as { backgroundClose(): void }).backgroundClose()).catch(() => {})
  await app.close()
  fixture.kill(); lines.close(); server.close()
}
