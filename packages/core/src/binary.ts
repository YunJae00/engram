// All external binaries (git, node, whisper) are resolved through this
// interface only. Core code must never care whether a path points at a
// system binary or a bundled one — M8 swaps the provider, nothing else.
export interface BinaryProvider {
  git(): string
  node(): string
  whisper(): string
}

export class SystemBinaryProvider implements BinaryProvider {
  git(): string {
    return 'git'
  }
  node(): string {
    return process.execPath
  }
  whisper(): string {
    return 'whisper'
  }
}

export const defaultBinaryProvider: BinaryProvider = new SystemBinaryProvider()
