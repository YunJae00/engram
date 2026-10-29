import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform === 'win32') {
  const script = fileURLToPath(new URL('./build-desktop.ps1', import.meta.url))
  execFileSync('powershell.exe', ['-NoProfile', '-File', script, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true })
}

if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const args = process.argv.slice(2)
  const outputIndex = args.indexOf('-OutputPath')
  const output = resolve(root, outputIndex < 0 ? 'native-bin/desktop' : args[outputIndex + 1])
  mkdirSync(output, { recursive: true })
  const source = join(root, 'native/macos')
  const files = readdirSync(source).filter(name => name.endsWith('.swift')).map(name => join(source, name))
  copyFileSync(join(source, 'Office.js'), join(output, 'Office.js'))
  const binaries = []
  for (const arch of ['arm64', 'x86_64']) {
    const binary = join(output, `EngramDesktop-${arch}`)
    execFileSync('xcrun', ['swiftc', '-O', '-module-name', 'EngramMacDesktop', '-target', `${arch}-apple-macos11.0`, ...files, '-o', binary], { stdio: 'inherit' })
    binaries.push(binary)
  }
  execFileSync('xcrun', ['lipo', '-create', ...binaries, '-output', join(output, 'EngramDesktop')], { stdio: 'inherit' })
  for (const binary of binaries) rmSync(binary)
  execFileSync('codesign', ['--force', '--sign', '-', join(output, 'EngramDesktop')], { stdio: 'inherit' })
}
