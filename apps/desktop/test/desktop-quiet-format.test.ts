import { describe, expect, it } from 'vitest'
import type { QuietControlDto, QuietObservationDto } from '../src/shared/desktop.js'
import { controlLine, formatScan, formatSet, formatText } from '../src/main/desktop-quiet-format.js'

const control = (over: Partial<QuietControlDto>): QuietControlDto => ({
  id: 'c1', type: 'Button', name: 'Send', value: null, placeholder: null, can: { set: false, press: true, text: false }, enabled: true, offscreen: false, focused: false, secret: false, ...over,
})
const observation = (over: Partial<QuietObservationDto> = {}): QuietObservationDto => ({
  window: '7', pid: 70, title: 'Claude', snapshot: 'a'.repeat(32), controls: [], texts: [], skippedControls: 0, skippedTexts: 0, ms: 120,
  state: { foreground: false, idleMs: 9000, minimized: false }, ...over,
})

describe('quiet readings for the brain', () => {
  it('prints one line per control, with actions and only the flags that say something', () => {
    expect(controlLine(control({}))).toBe('c1 Button "Send" [press]')
    expect(controlLine(control({ id: 'c2', type: 'Edit', name: 'Prompt', can: { set: true, press: false, text: true }, placeholder: 'Prompt', focused: true }))).toBe('c2 Edit "Prompt" [set,text] (empty, shows placeholder) {focused}')
    expect(controlLine(control({ id: 'c3', type: 'Edit', name: 'Prompt', can: { set: true, press: false, text: true }, value: 'hello\nworld' }))).toBe('c3 Edit "Prompt" [set,text] = "hello\\nworld"')
    expect(controlLine(control({ enabled: false, offscreen: true }))).toBe('c1 Button "Send" [press] {disabled,offscreen}')
  })

  it('keeps the text tail and says how much more there is', () => {
    const texts = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, text: `line ${i}` }))
    const out = formatScan(observation({ controls: [control({})], texts, skippedTexts: 10 }), undefined)
    expect(out).toContain('Claude [window:7:0] — snapshot ' + 'a'.repeat(32) + ' (person elsewhere)')
    expect(out).toContain('controls (1):')
    expect(out).toContain('text (40 of 60; app_text reads it all):')
    expect(out).toContain('t49: line 49')
    expect(out).not.toContain('t9: line 9\n')
    const narrowed = formatScan(observation({ texts: texts.slice(0, 3), skippedControls: 5, state: { foreground: true, idleMs: 100, minimized: false } }), 'line')
    expect(narrowed).toContain('person is using this app now (changes wait), find "line"')
    expect(narrowed).toContain('5 more not shown, narrow with find')
    expect(narrowed).toContain('text (3):')
  })

  it('reports a set as exact, as holding more than the text, or as not landed', () => {
    expect(JSON.parse(formatSet({ landed: true, exact: true, value: 'hi', ms: 300, control: 'c2', foregroundChanged: true }, 'hi'))).toMatchObject({ exact: true, foregroundChanged: true, requiresVerification: true })
    expect(JSON.parse(formatSet({ landed: true, exact: false, value: 'xhi', ms: 300, control: 'c2' }, 'hi'))).toMatchObject({ exact: false, value: 'xhi' })
    expect(JSON.parse(formatSet({ landed: false, exact: false, value: '', ms: 1500, control: 'c2' }, 'hi'))).toMatchObject({ landed: false, exact: false })
  })

  it('heads the text with how it was read', () => {
    expect(JSON.parse(formatText({ text: 'answer', chars: 6, headClipped: false, settled: true, waitedMs: 0 }))).toMatchObject({ text: 'answer', settled: true })
    expect(JSON.parse(formatText({ text: 'answer', chars: 6, headClipped: true, settled: true, waitedMs: 4200 }))).toMatchObject({ headClipped: true, settled: true, waitedMs: 4200 })
    expect(JSON.parse(formatText({ text: 'answer', chars: 6, headClipped: false, settled: false, waitedMs: 180000 }))).toMatchObject({ settled: false, waitedMs: 180000 })
  })
})
