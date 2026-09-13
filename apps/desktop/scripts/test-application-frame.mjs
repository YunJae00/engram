import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = fileURLToPath(new URL('..', import.meta.url))
export function testApplicationFrame() {
  if (process.platform !== 'win32') return
  const temporary = path.resolve(desktop, '../../tmp')
  mkdirSync(temporary, { recursive: true })
  const executable = path.join(mkdtempSync(path.join(temporary, 'application-frame-')), 'ApplicationFrameFixture.exe')
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/reference:System.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
    `/out:${executable}`, path.join(desktop, 'native/desktop/ApplicationFrame.cs'), path.join(desktop, 'e2e/fixtures/desktop/ApplicationFrameFixture.cs')], { stdio: 'inherit', windowsHide: true })
  const screenshot = path.join(path.dirname(executable), 'application-frame.png')
  execFileSync(executable, [screenshot], { stdio: 'inherit', windowsHide: true, timeout: 30000 })
  console.log(`Application frame screenshot: ${screenshot}`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) testApplicationFrame()
