import { describe, expect, it } from 'vitest'
import { detectAvailableEngines, keepsEngine } from '../src/engine/registry.js'
import type { EngineDetection } from '../src/engine/types.js'

// Field reports: "Claude just disconnects on its own." Detection re-runs every
// ten minutes for the life of the process, and a probe that merely TIMED OUT —
// laptop resuming from sleep, a virus scanner on the .cmd shim, the machine
// busy — was recorded as "not installed". The engine vanished from the usable
// list and the shell announced there was no engine, on a machine where Claude
// was working fine.
//
// The rule: an engine leaves only when detection positively says it is
// unusable. A non-answer changes nothing.

const usable: EngineDetection = { installed: true, loggedIn: true }
const gone: EngineDetection = { installed: false, loggedIn: false, conclusive: true }
const unknown: EngineDetection = { installed: false, loggedIn: false, conclusive: false }
const loggedOut: EngineDetection = { installed: true, loggedIn: false, conclusive: true }

describe('a non-answer must not retire a working engine', () => {
  it('keeps an engine that was working when the probe times out', () => {
    expect(keepsEngine(unknown, true)).toBe(true)
  })

  it('does not invent an engine that was never there', () => {
    expect(keepsEngine(unknown, false)).toBe(false)
  })

  it('still retires an engine that is genuinely gone', () => {
    expect(keepsEngine(gone, true)).toBe(false)
  })

  it('still retires an engine whose login really ended', () => {
    expect(keepsEngine(loggedOut, true)).toBe(false)
  })

  it('accepts a usable engine regardless of history', () => {
    expect(keepsEngine(usable, false)).toBe(true)
    expect(keepsEngine(usable, true)).toBe(true)
  })

  // Adapters that cannot time out (the mock, test stubs) omit the flag. Absent
  // must read as a real verdict, or no stub could ever be retired.
  it('treats an omitted conclusive flag as a real verdict', () => {
    expect(keepsEngine({ installed: false, loggedIn: false }, true)).toBe(false)
  })
})

describe('detectAvailableEngines end to end', () => {
  // A binary that cannot exist gives a spawn error, which IS conclusive — so
  // even a remembered engine is correctly dropped. This guards the other side
  // of the rule: hysteresis must not become "never let go".
  it('drops a remembered engine whose binary is really absent', async () => {
    const engines = await detectAvailableEngines('claude', { claude: 'engram-no-such-binary-xyz' }, ['claude'])
    expect(engines).toHaveLength(0)
  })
})
