export interface FrameReading {
  text: string
  hidden: string
  hasPasswordField: boolean
  links: { text: string; url: string }[]
  controls: { kind: string; name: string; state: string; ref?: string; context?: string }[]
  dialog: string
  faults: string[]
}

export interface PageReading extends FrameReading {
  lines: string[]
}
