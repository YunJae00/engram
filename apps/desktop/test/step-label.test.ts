import { expect, it } from 'vitest'
import { t, tIn } from '../src/renderer/src/i18n.js'
import { threadT } from '../src/renderer/src/lib/threadLang.js'
import { stepLabel } from '../src/renderer/src/lib/pendingStatus.js'

const ko = threadT('ko')
const koParticles = (key: Parameters<typeof t>[0], vars?: Record<string, string | number>) => tIn('ko', key, vars)

it('drops empty parentheses when a step has no string argument', () => {
  expect(stepLabel(t, 'press_point: ')).toBe('Pressing the point it can see')
  expect(stepLabel(ko, 'press_point: ')).toBe('화면에서 보이는 곳을 누르는 중')
  expect(stepLabel(koParticles, 'press_point: ')).toBe('화면에서 보이는 곳을 누르는 중')
  expect(stepLabel(t, 'scroll: ')).toBe('Scrolling the page')
})

it('keeps parentheses that hold an argument', () => {
  expect(stepLabel(t, 'press_point: Send')).toBe('Pressing the point it can see (Send)')
  expect(stepLabel(ko, 'press_point: 보내기')).toBe('화면에서 보이는 곳을 누르는 중 (보내기)')
  expect(stepLabel(t, 'scroll: down')).toBe('Scrolling the page (down)')
  expect(stepLabel(t, 'search_web: lunch')).toBe('Searching the web for “lunch”')
})

it('never leaves empty parentheses for any step tool', () => {
  const tools = ['find_procedure', 'search_memory', 'read_note', 'search_web', 'open_page', 'read_open_page', 'propose_note', 'ask_person', 'run_procedure', 'press', 'type_text', 'choose', 'scroll', 'hover', 'press_key', 'press_point', 'reveal', 'look', 'aside', 'resume']
  for (const tool of tools) for (const tr of [t, ko, koParticles]) expect(stepLabel(tr, `${tool}: `)).not.toMatch(/\(\s*\)/)
})
