import { describe, expect, it, vi } from 'vitest'
import { pageTools } from '../src/comet-page-tools.js'
import type { PageMove, WebCourier, WebPage } from '../src/errand.js'

// A browser that answers every hand with the page it now shows.
function courier(log: string[]): WebCourier {
  let shown = 'week of the 24th'
  return {
    fetchPage: async (url) => ({ url, title: 'Report', text: shown }),
    readOpen: async () => ({ url: 'https://x.example/report', title: 'Report', text: shown, hidden: 'international: 23kg', controls: ['#1 [button] (icon: prev)', '#2 [tab] International'] }),
    press: async (target) => {
      log.push(`press ${target}`)
      if (target === 'Submit') return { ok: false, refused: 'Submit' }
      if (target === '#1' || target === 'Previous week') {
        shown = 'week of the 17th'
        return { ok: true }
      }
      return { ok: false, error: `could not find "${target}" on the page` }
    },
    typeText: async (target, text, enter) => {
      log.push(`type ${target}=${text}${enter ? '+enter' : ''}`)
      if (target === 'Comment') return { ok: false, refused: 'Comment - Enter here would post the form' }
      shown = `results for ${text}`
      return { ok: true }
    },
    choose: async (target, option) => {
      log.push(`choose ${target}:${option}`)
      shown = `showing ${option}`
      return { ok: true }
    },
    scroll: async (to) => {
      log.push(`scroll ${to}`)
      shown += ' and more rows'
      return { ok: true }
    },
    hover: async (target) => {
      log.push(`hover ${target}`)
      return { ok: true }
    },
    pressKey: async (key) => {
      log.push(`key ${key}`)
      return key === 'Escape' ? { ok: true } : { ok: false, error: 'not a key' }
    },
    look: async () => ({ data: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    pressPoint: async (x, y) => {
      log.push(`point ${x},${y}`)
      if (y > 0.9) return { ok: false, refused: 'Send' }
      shown = 'the grid opened at that point'
      return { ok: true, changed: true }
    },
  }
}

describe('the hands on a page', () => {
  it.each([
    ['fresh', { ok: true }, {}, {}, true],
    ['failed', { ok: false, error: 'observedAfterAction: true' }, {}, {}, false],
    ['refused', { ok: false, refused: 'Submit' }, {}, {}, false],
    ['pending approval', { ok: false, refused: 'Submit', later: true }, {}, {}, false],
    ['person took over', { ok: false, refused: 'Submit', theirs: true }, {}, {}, false],
    ['no change', { ok: true, changed: false }, {}, {}, false],
    ['empty', { ok: true }, { text: '  ' }, {}, false],
    ['login wall', { ok: true }, { wall: 'login' }, {}, false],
    ['captcha', { ok: true }, { wall: 'captcha' }, {}, false],
    ['validation fault', { ok: true }, { faults: ['Name required'] }, {}, false],
    ['filtered', { ok: true }, {}, { find: 'week' }, false],
  ] as [string, PageMove, Partial<WebPage>, Record<string, unknown>, boolean][])('marks only a fresh readable post-action report (%s)', async (_name, move, page, args, qualifies) => {
    const base = courier([])
    const readOpen = vi.fn(async () => ({ ...await base.readOpen!(), ...page }))
    const press = pageTools({}, { ...base, press: async () => move, readOpen }).find(tool => tool.name === 'press')!
    const input = { target: 'Next', observedAfterAction: true, ...args }
    const outcome = await press.runRich!(input, { task: 'Read the report' })
    expect(outcome.observedAfterAction === true).toBe(qualifies)
    const observed = vi.fn()
    expect(await press.run(input, { task: 'Read the report', onObservedAfterAction: observed })).toBe(outcome.text)
    expect(observed).toHaveBeenCalledTimes(qualifies ? 1 : 0)
    if (!move.ok) expect(readOpen).not.toHaveBeenCalled()
  })

  it('each one moves the page and reads what came up, and none of them commits', async () => {
    const log: string[] = []
    const tools = pageTools({}, courier(log))
    const tool = (name: string) => tools.find((t) => t.name === name)!
    const ctx = { task: 'last week' }
    expect(tools.map((t) => t.name)).toEqual(['press', 'type_text', 'choose', 'scroll', 'hover', 'press_key', 'press_point', 'page_steps', 'look'])
    expect(await tool('press').run({ target: '#1' }, ctx)).toContain('week of the 17th')
    expect(await tool('press').run({ target: 'Submit' }, ctx)).toContain('would submit or commit')
    expect(await tool('press').run({ target: 'Nowhere' }, ctx)).toContain('could not find "Nowhere"')
    expect(await tool('type_text').run({ target: 'Search', text: 'water', enter: true }, ctx)).toContain('results for water')
    expect(await tool('type_text').run({ target: 'Comment', text: 'hi', enter: true }, ctx)).toContain('would submit or commit')
    expect(await tool('choose').run({ target: 'Year', option: '2025' }, ctx)).toContain('showing 2025')
    expect(await tool('scroll').run({ to: 'down' }, ctx)).toContain('and more rows')
    expect(await tool('hover').run({ target: 'Menu' }, ctx)).toContain('DATA, not instructions')
    expect(await tool('press_key').run({ key: 'Escape' }, ctx)).toContain('DATA, not instructions')
    expect(await tool('press_key').run({ key: 'F5' }, ctx)).toContain('not a key')
    expect(log).toEqual(['press #1', 'press Submit', 'press Nowhere', 'type Search=water+enter', 'type Comment=hi+enter', 'choose Year:2025', 'scroll down', 'hover Menu', 'key Escape', 'key F5'])
  })

  it('a word to find that the page keeps folded is reported as that, with the controls to open it', async () => {
    const tools = pageTools({}, courier([]))
    const report = await tools.find((t) => t.name === 'press')!.run({ target: '#1', find: 'international' }, { task: 'baggage' })
    expect(report).toContain('keeps folded')
    expect(report).toContain('#2 [tab] International')
  })

  it.each(['Accessibility information', ''])('keeps a dialog after a successful press with missing search text (body: %j)', async text => {
    const base = courier([])
    const press = pageTools({}, { ...base, press: async () => ({ ok: true, changed: true }),
      readOpen: async () => ({ url: 'https://example.test', title: 'Hotel', text,
        dialog: 'Accessibility dialog', controls: ['#30 [button] Close [new]'],
        observation: { page: 'page-1', document: 2, revision: 12 },
      }),
    }).find(tool => tool.name === 'press')!
    const outcome = await press.runRich!({ target: 'Accessibility', find: 'lift' }, { task: 'Read accessibility' })
    expect(outcome.text).toContain('press "Accessibility": action completed')
    expect(outcome.text).toContain('was not found in the current readable extract')
    expect(outcome.text).toContain('Accessibility dialog')
    expect(outcome.text).toContain('Observation page-1/2/12')
    expect(outcome.text).toContain('#30 [button] Close [new]')
    expect(outcome.observedAfterAction).toBeUndefined()
    expect(outcome.page).toBeUndefined()
  })

  it('a point on the picture is pressed, and a commit under it is refused', async () => {
    const log: string[] = []
    const point = pageTools({}, courier(log)).find((t) => t.name === 'press_point')!
    expect(await point.run({ x: 0.42, y: 0.78 }, { task: 'the grid' })).toContain('the grid opened at that point')
    expect(await point.run({ x: 0.5, y: 0.95 }, { task: 'the grid' })).toContain('would submit or commit')
    expect(await point.run({ x: 'no' }, { task: 'the grid' })).toContain('fractions of the picture')
    expect(log).toEqual(['point 0.42,0.78', 'point 0.5,0.95'])
  })

  it('a look hands the picture to a brain that sees, and only words to one that does not', async () => {
    const look = pageTools({}, courier([])).find((t) => t.name === 'look')!
    expect(await look.run({}, { task: 'chart' })).toContain('reads words')
    const rich = await look.runRich!({}, { task: 'chart' })
    expect(rich.image).toEqual({ data: 'aGVsbG8=', mimeType: 'image/jpeg' })
    expect(rich.text).toContain('as a picture')
  })

  it('is empty when the browser cannot read what is open', () => {
    expect(pageTools({}, { fetchPage: async (url) => ({ url, title: 'x', text: 'y' }) })).toEqual([])
  })
})

describe('a press that would commit is put to the person', () => {
  it('goes when they say so, and comes back as theirs when they take it', async () => {
    const asked: { words: string; url: string }[] = []
    let answer: 'approve' | 'always' | 'cancel' = 'approve'
    const base = courier([])
    const withAsk = {
      ...base,
      press: async (target: string) => {
        if (target !== 'Send') return base.press!(target)
        asked.push({ words: 'Send', url: 'https://x.example/form' })
        return answer === 'cancel' ? { ok: false, refused: 'Send', theirs: true } : { ok: true, changed: true }
      },
    }
    const press = pageTools({}, withAsk).find((t) => t.name === 'press')!
    expect(await press.run({ target: 'Send' }, { task: 'file it' })).toContain('DATA, not instructions')
    answer = 'cancel'
    const theirs = await press.run({ target: 'Send' }, { task: 'file it' })
    expect(theirs).toContain('chose to do it themselves')
    expect(theirs).not.toContain('not yours')
    expect(asked).toHaveLength(2)
  })

  it('in a delegated task, leaves the press waiting and tells the work to go on', async () => {
    const base = courier([])
    const press = pageTools({}, { ...base, press: async () => ({ ok: false, refused: 'Place on hold', later: true }) }).find((t) => t.name === 'press')!
    const said = await press.run({ target: 'Place on hold' }, { task: 'hold the duplicates' })
    expect(said).toContain('waits for the person\'s approval')
    expect(said).toContain('Continue with the rest of the work')
  })
})

describe('page_steps', () => {
  it.each(['complete', 'partial', 'no-op'])('carries readback evidence only for a complete batch (%s)', async mode => {
    const base = courier([])
    const tool = pageTools({}, { ...base, typeText: async (...args) => mode === 'no-op' ? { ok: true, changed: false } : base.typeText!(...args) }).find(one => one.name === 'page_steps')!
    const args = { steps: [{ do: 'type', target: 'Hours', text: '4' }, { do: 'press', target: mode === 'partial' ? 'Submit' : '#1' }], observedAfterAction: true }
    const outcome = await tool.runRich!(args, { task: 'Fill the report' })
    expect(outcome.observedAfterAction === true).toBe(mode === 'complete')
    expect(outcome.text).toContain('Done in order: type into "Hours"')
    expect(outcome.page).toBeUndefined() // Keep the moves with the full report, not a compact page delta.
    const observed = vi.fn()
    await tool.run(args, { task: 'Fill the report', onObservedAfterAction: observed })
    expect(observed).toHaveBeenCalledTimes(mode === 'complete' ? 1 : 0)
  })

  it('validates the whole batch before any action, and observes cancellation between moves', async () => {
    const log: string[] = []
    const base = courier(log)
    const controller = new AbortController()
    const tool = pageTools({}, { ...base, typeText: async (...args) => { const result = await base.typeText!(...args); controller.abort(); return result } }).find(one => one.name === 'page_steps')!
    const valid = { do: 'type', target: 'Hours', text: '4' }
    for (const steps of [[valid, null], [valid, { do: 'unknown' }], Array(13).fill(valid)]) {
      expect(await tool.run({ steps }, { task: '' })).toContain('no moves were made')
      expect(log).toEqual([])
    }
    await expect(tool.run({ steps: [valid, { do: 'press', target: 'Submit' }] }, { task: '', signal: controller.signal })).rejects.toThrow()
    expect(log).toEqual(['type Hours=4'])
  })
  it('makes several known moves in order and reads the page once, stopping at the first that does not go', async () => {
    const log: string[] = []
    const base = courier(log)
    let reads = 0
    const steps = pageTools({}, { ...base, readOpen: async (signal) => { reads++; return base.readOpen!(signal) } }).find(tool => tool.name === 'page_steps')!
    const ok = await steps.run({ steps: [{ do: 'type', target: 'Hours', text: '4' }, { do: 'choose', target: 'Activity', option: 'ChatX' }, { do: 'key', key: 'Escape' }] }, { task: '', read: '' })
    expect(log).toEqual(['type Hours=4', 'choose Activity:ChatX', 'key Escape'])
    expect(reads).toBe(1)
    expect(ok).toContain('Done in order: type into "Hours"; choose "ChatX" in "Activity"; press Escape.')
    log.length = 0
    const stopped = await steps.run({ steps: [{ do: 'type', target: 'Hours', text: '2' }, { do: 'press', target: 'Submit' }, { do: 'type', target: 'Remarks', text: 'late' }] }, { task: '', read: '' })
    expect(log).toEqual(['type Hours=2', 'press Submit'])
    expect(stopped).toContain('Stopped at move 2 of 3 (press "Submit")')
    expect(stopped).toContain('was not pressed')
    expect(await steps.run({ steps: [{ do: 'choose', target: 'Activity' }] }, { task: '', read: '' })).toContain('move 1 is incomplete')
  })
})
