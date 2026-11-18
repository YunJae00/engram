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
