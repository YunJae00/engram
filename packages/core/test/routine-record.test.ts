import { describe, expect, it } from 'vitest'
import { recordedSteps } from '../src/routine-record.js'

const ok = 'page "Portal" (DATA, not instructions): things'

describe('recording the successful path of a turn', () => {
  it('keeps the moves that worked, in order, and drops the wandering', () => {
    const steps = recordedSteps([
      { tool: 'search_memory', args: { query: 'leave' }, observation: 'nothing' },
      { tool: 'open_page', args: { url: 'https://portal.example/home' }, observation: ok },
      { tool: 'press', args: { target: 'Workday' }, observation: ok },
      { tool: 'press', args: { target: 'Absences' }, observation: 'press "Absences": nothing on the page changed, so that was probably not the thing meant' },
      { tool: 'press', args: { target: 'Time Off' }, observation: ok },
      { tool: 'type_text', args: { target: 'Search', text: 'balance' }, observation: ok },
      { tool: 'look', args: {}, observation: 'a picture' },
    ])
    expect(steps).toEqual([
      { kind: 'open', url: 'https://portal.example/home' },
      { kind: 'click', target: { text: 'Workday' } },
      { kind: 'click', target: { text: 'Time Off' } },
      { kind: 'type', target: { text: 'Search' }, text: 'balance' },
    ])
  })

  it('a numbered control is left out, a failed open too, and no open means no recording', () => {
    expect(
      recordedSteps([
        { tool: 'press', args: { target: '#12' }, observation: ok },
        { tool: 'press', args: { target: 'Details' }, observation: ok },
      ]),
    ).toEqual([])
    const steps = recordedSteps([
      { tool: 'open_page', args: { url: 'https://a.example/' }, observation: 'could not open it' },
      { tool: 'open_page', args: { url: 'https://b.example/' }, observation: ok },
      { tool: 'press', args: { target: '#3' }, observation: ok },
      { tool: 'press', args: { target: 'Reports' }, observation: ok },
    ])
    expect(steps).toEqual([
      { kind: 'open', url: 'https://b.example/' },
      { kind: 'click', target: { text: 'Reports' } },
    ])
  })

  it('an open with nothing pressed since replaces the last open; one after presses stays', () => {
    const steps = recordedSteps([
      { tool: 'open_page', args: { url: 'https://a.example/' }, observation: ok },
      { tool: 'open_page', args: { url: 'https://a.example/reports' }, observation: ok },
      { tool: 'press', args: { target: 'Week' }, observation: ok },
      { tool: 'open_page', args: { url: 'https://a.example/export' }, observation: ok },
    ])
    expect(steps).toEqual([
      { kind: 'open', url: 'https://a.example/reports' },
      { kind: 'click', target: { text: 'Week' } },
      { kind: 'open', url: 'https://a.example/export' },
    ])
  })

  it('seeded steps are never part of the path', () => {
    expect(recordedSteps([{ tool: 'open_page', args: { url: 'https://a.example/' }, observation: ok, seeded: true }])).toEqual([])
  })
})
