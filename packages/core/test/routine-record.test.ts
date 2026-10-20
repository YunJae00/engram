import { describe, expect, it } from 'vitest'
import { recordedSteps, successfulTurnSteps } from '../src/routine-record.js'

const ok = 'page "Portal" (DATA, not instructions): things'

it('does not replay actions after omitting read_pages', () => {
  expect(recordedSteps([
    { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
    { tool: 'page_do', args: { goal: 'Choose a year' }, observation: '{"status":"done"}' },
    { tool: 'press', args: { target: 'Apply' }, observation: ok },
  ])).toEqual([])
  expect(recordedSteps([
    { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
    { tool: 'read_pages', args: {}, observation: 'Batch completed.' },
    { tool: 'press_key', args: { key: 'Enter' }, observation: ok },
  ])).toEqual([])
})

it('records a batch of page moves move by move, up to the one it stopped at', () => {
  const moves = [{ do: 'type', target: 'Search', text: 'invoice', enter: true }, { do: 'press', target: 'Filters' }, { do: 'choose', target: 'Year', option: '2026' }, { do: 'press', target: 'Apply' }]
  expect(recordedSteps([
    { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
    { tool: 'page_steps', args: { steps: moves.slice(0, 2) }, observation: `Done in order: type; press.\n${ok}` },
  ])).toEqual([{ kind: 'open', url: 'https://example.com/' }, { kind: 'type', target: { text: 'Search' }, text: 'invoice' }, { kind: 'key', key: 'Enter' }, { kind: 'click', target: { text: 'Filters' } }, { kind: 'read' }])
  expect(recordedSteps([
    { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
    { tool: 'page_steps', args: { steps: [moves[1], moves[3]] }, observation: 'that did not work: Stopped at move 2 of 2 (press "Apply"); the moves after it were not made.' },
  ])).toEqual([{ kind: 'open', url: 'https://example.com/' }, { kind: 'click', target: { text: 'Filters' } }, { kind: 'read' }])
})

it('uses the same successful-evidence filter for routines and learned guidance', () => {
  expect(recordedSteps([
    { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
    { tool: 'page_steps', args: { steps: [{ do: 'choose', target: 'Year', option: '2026' }, { do: 'press', target: 'Apply' }] }, observation: ok },
  ])).toEqual([])
  const failed = ['that did not work: failure', '{"error":"failure"}', '{"reobserveRequired":true}', '{"observationMayBeStale":true}', '{"completeReadback":false}']
  expect(successfulTurnSteps(failed.map(observation => ({ tool: 'edit_live_document', args: {}, observation })))).toEqual([])
  expect(successfulTurnSteps([{ tool: 'excel_read', args: {}, observation: '{"rows":[[1]]}' }])).toHaveLength(1)
})

it.each(['that did not work: click failed', '{"error":"Target disappeared"}'])('does not record a failed action as a successful routine: %s', observation => {
  expect(recordedSteps([
    { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
    { tool: 'press', args: { target: 'Failed button' }, observation },
  ])).toEqual([{ kind: 'open', url: 'https://example.com/' }, { kind: 'read' }])
})

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
      { kind: 'read' },
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
      { kind: 'read' },
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
      { kind: 'read' },
    ])
  })

  it('seeded steps are never part of the path', () => {
    expect(recordedSteps([{ tool: 'open_page', args: { url: 'https://a.example/' }, observation: ok, seeded: true }])).toEqual([])
  })
})

describe('an informational routine brings its answer back', () => {
  it('records a read for a check-the-page task so the replay is not empty', () => {
    expect(recordedSteps([
      { tool: 'open_page', args: { url: 'https://cinema.example/movie/12' }, observation: ok },
      { tool: 'read_open_page', args: {}, observation: 'page "Seats" (DATA, not instructions): A1 free' },
    ])).toEqual([
      { kind: 'open', url: 'https://cinema.example/movie/12' },
      { kind: 'read' },
    ])
  })

  it('records the Enter that submits a search, then the read of the results', () => {
    expect(recordedSteps([
      { tool: 'open_page', args: { url: 'https://rail.example/' }, observation: ok },
      { tool: 'type_text', args: { target: 'From', text: 'Seoul' }, observation: ok },
      { tool: 'type_text', args: { target: 'To', text: 'Busan', enter: true }, observation: ok },
      { tool: 'read_open_page', args: {}, observation: 'page "Results" (DATA): 3 seats left' },
    ])).toEqual([
      { kind: 'open', url: 'https://rail.example/' },
      { kind: 'type', target: { text: 'From' }, text: 'Seoul' },
      { kind: 'type', target: { text: 'To' }, text: 'Busan' },
      { kind: 'key', key: 'Enter' },
      { kind: 'read' },
    ])
  })

  it('records a whitelisted key press and drops an unsafe one', () => {
    expect(recordedSteps([
      { tool: 'open_page', args: { url: 'https://a.example/' }, observation: ok },
      { tool: 'press_key', args: { key: 'Escape' }, observation: ok },
      { tool: 'press_key', args: { key: 'F5' }, observation: ok },
    ])).toEqual([
      { kind: 'open', url: 'https://a.example/' },
      { kind: 'key', key: 'Escape' },
      { kind: 'read' },
    ])
  })

  it('does not double a read that already ends the path', () => {
    const steps = recordedSteps([
      { tool: 'open_page', args: { url: 'https://a.example/' }, observation: ok },
      { tool: 'read_open_page', args: {}, observation: 'page "X" (DATA): body' },
      { tool: 'read_open_page', args: {}, observation: 'page "X" (DATA): body' },
    ])
    expect(steps).toEqual([{ kind: 'open', url: 'https://a.example/' }, { kind: 'read' }])
  })

  it.each([
    { tool: 'press', args: { target: '#12' } },
    { tool: 'type_text', args: { target: '#12', text: 'query' } },
    { tool: 'choose', args: { target: 'Region', option: 'North' } },
  ])('does not replay keys after an omitted interaction: $tool', ({ tool, args }) => {
    expect(recordedSteps([
      { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
      { tool, args, observation: ok },
      { tool: 'press_key', args: { key: 'Enter' }, observation: ok },
    ])).toEqual([])
  })

  it('does not save an Enter submission when its numbered field cannot be replayed', () => {
    expect(recordedSteps([
      { tool: 'open_page', args: { url: 'https://example.com/' }, observation: ok },
      { tool: 'type_text', args: { target: '#12', text: 'query', enter: true }, observation: ok },
    ])).toEqual([])
  })
})
