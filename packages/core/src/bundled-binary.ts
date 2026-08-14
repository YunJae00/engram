import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'
import type { BinaryProvider } from './binary.js'
import { SystemBinaryProvider } from './binary.js'

// M8 bundled provider: binaries live under a bundle dir shipped with the
// app (resources/bin). Anything missing falls back to the system — core
// code never knows which one it got (BinaryProvider contract).
//
// Layout:
//   Windows: <bundleDir>/git/cmd/git.exe   (MinGit; self-locates git-core)
//   Unix:    <bundleDir>/git/bin/git       (+ git-core via GIT_EXEC_PATH)
//   <bundleDir>/whisper/main[.exe]         (whisper.cpp executable)
export class BundledBinaryProvider implements BinaryProvider {
  private fallback = new SystemBinaryProvider()

  constructor(private bundleDir: string) {}

  private existing(path: string): string | null {
    try {
      accessSync(path, constants.X_OK)
      return path
    } catch {
      return null
    }
  }

  private bundledGit(): string | null {
    const candidates =
      process.platform === 'win32'
        ? [join(this.bundleDir, 'git', 'cmd', 'git.exe'), join(this.bundleDir, 'git', 'bin', 'git.exe')]
        : [join(this.bundleDir, 'git', 'bin', 'git')]
    for (const candidate of candidates) {
      const hit = this.existing(candidate)
      if (hit) return hit
    }
    return null
  }

  git(): string {
    return this.bundledGit() ?? this.fallback.git()
  }

  gitExecPath(): string | null {
    // MinGit's cmd/git.exe locates its own exec path relative to itself.
    if (process.platform === 'win32') return null
    const execPath = join(this.bundleDir, 'git', 'libexec', 'git-core')
    try {
      accessSync(execPath)
      return execPath
    } catch {
      return null
    }
  }

  node(): string {
    // Electron's own binary doubles as node via ELECTRON_RUN_AS_NODE.
    return process.execPath
  }

  private bundledWhisper(): string | null {
    const name = process.platform === 'win32' ? 'main.exe' : 'main'
    return this.existing(join(this.bundleDir, 'whisper', name))
  }

  whisper(): string {
    return this.bundledWhisper() ?? this.fallback.whisper()
  }

  hasBundledGit(): boolean {
    return this.bundledGit() !== null
  }

  hasBundledWhisper(): boolean {
    return this.bundledWhisper() !== null
  }
}
