import { describe, expect, it } from 'vitest'
import { buildRoutineFromTeach, type TeachEvent } from '../src/teach.js'
import { validateRoutineSteps } from '../src/routine.js'

describe('buildRoutineFromTeach', () => {
  it('turns a portal walk into open → click → read', () => {
    const events: TeachEvent[] = [
      { kind: 'nav', url: 'https://portal.example/home' },
      { kind: 'click', css: 'a#notices', text: 'Notices' },
      { kind: 'nav', url: 'https://portal.example/notices' },
      { kind: 'read', url: 'https://portal.example/notices' },
    ]
    const steps = buildRoutineFromTeach(events)
    expect(steps).toEqual([
      { kind: 'open', url: 'https://portal.example/home' },
      { kind: 'click', target: { css: ['a#notices'], text: 'Notices' } },
      { kind: 'read' },
    ])
    expect(validateRoutineSteps(steps)).toBeNull()
  })

  it('never records a password field, nor anything typed on a login page', () => {
    const events: TeachEvent[] = [
      { kind: 'nav', url: 'https://portal.example/login' },
      { kind: 'input', css: '#user', text: 'Username', value: 'alice', walled: true },
      { kind: 'input', css: '#pass', text: 'Password', value: 'hunter2', secret: true, walled: true },
      { kind: 'click', css: 'button#in', text: 'Sign in', walled: true },
      { kind: 'nav', url: 'https://portal.example/app' },
      { kind: 'input', css: '#entry', text: 'Entry', value: 'shipped it' },
      { kind: 'read', url: 'https://portal.example/app' },
    ]
    const steps = buildRoutineFromTeach(events)
    expect(steps).toEqual([
      { kind: 'open', url: 'https://portal.example/login' },
      { kind: 'open', url: 'https://portal.example/app' },
      { kind: 'type', target: { css: ['#entry'], text: 'Entry' }, text: 'shipped it' },
      { kind: 'read' },
    ])
    expect(JSON.stringify(steps)).not.toContain('hunter2')
    expect(JSON.stringify(steps)).not.toContain('alice')
  })

  it('drops a click that a navigation followed, so replay does not double-open', () => {
    const steps = buildRoutineFromTeach([
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'click', text: 'Next' },
      { kind: 'nav', url: 'https://a.example/step2' },
    ])
    expect(steps).toEqual([
      { kind: 'open', url: 'https://a.example/' },
      { kind: 'click', target: { text: 'Next' } },
    ])
  })

  it('collapses repeated edits of one field to its final value', () => {
    const steps = buildRoutineFromTeach([
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'input', css: '#title', text: 'Title', value: 'draf' },
      { kind: 'input', css: '#title', text: 'Title', value: 'draft done' },
    ])
    expect(steps).toEqual([
      { kind: 'open', url: 'https://a.example/' },
      { kind: 'type', target: { css: ['#title'], text: 'Title' }, text: 'draft done' },
    ])
  })

  it('collapses consecutive reads and drops targetless clicks', () => {
    const steps = buildRoutineFromTeach([
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'click' },
      { kind: 'read', url: 'https://a.example/' },
      { kind: 'read', url: 'https://a.example/' },
    ])
    expect(steps).toEqual([{ kind: 'open', url: 'https://a.example/' }, { kind: 'read' }])
  })

  it('one navigation, however many sources report it', () => {
    // The browser reports the page, and the document reports itself: both are
    // true, and the person still only went there once.
    const steps = buildRoutineFromTeach([
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'click', text: 'Next' },
      { kind: 'nav', url: 'https://a.example/two' },
      { kind: 'nav', url: 'https://a.example/two' },
      { kind: 'read', url: 'https://a.example/two' },
    ])
    expect(steps).toEqual([
      { kind: 'open', url: 'https://a.example/' },
      { kind: 'click', target: { text: 'Next' } },
      { kind: 'read' },
    ])
  })

  it('ignores about:blank and other non-http navigations', () => {
    const steps = buildRoutineFromTeach([
      { kind: 'nav', url: 'about:blank' },
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'nav', url: 'https://a.example/' },
    ])
    expect(steps).toEqual([{ kind: 'open', url: 'https://a.example/' }])
  })

  it('produces steps the routine validator accepts, with caps enforced', () => {
    const steps = buildRoutineFromTeach([
      { kind: 'nav', url: 'https://a.example/' },
      { kind: 'input', css: '#f', text: 'Field', value: 'x'.repeat(900) },
    ])
    const typed = steps.find((s) => s.kind === 'type')
    expect(typed && typed.kind === 'type' && typed.text.length).toBe(500)
    expect(validateRoutineSteps(steps)).toBeNull()
  })
})
