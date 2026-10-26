// What one reading of a document holds.
export interface FrameReading {
  text: string
  hidden: string
  hasPasswordField: boolean
  links: { text: string; url: string }[]
  controls: { kind: string; name: string; state: string; ref?: string }[]
  // What stands in front of the page right now: a dialog it has opened over
  // itself. Its own words, so it can be answered without hunting for them
  // among the page behind it.
  dialog: string
  // Fields the page itself says are wrong or missing, each with what it said
  // about them. Read off the page's own markup, never guessed.
  faults: string[]
}

export interface PageReading extends FrameReading {
  // Control lines as the model sees them: "#12 [button] Next (closed)".
  lines: string[]
}
