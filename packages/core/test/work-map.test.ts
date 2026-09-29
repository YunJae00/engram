import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { applyLabels, buildWorkMap, labelPrompt, placeNote, placeNoteId, readWorkMap, safeAddress, workShortcuts, writeWorkMap } from '../src/work-map.js'
import type { VaultPaths } from '../src/vault.js'

const NOW = new Date(2026, 8, 28, 18, 0)
// Visits at a local hour on each of the given days back from NOW.
const on = (url: string, title: string, daysBack: number[], hour: number) => daysBack.map((back) => {
  const at = new Date(NOW); at.setDate(at.getDate() - back); at.setHours(hour, 5, 0, 0)
  return { url, title, at: at.getTime() }
})
// NOW is a Monday: offsets back from it that land on weekdays, and on Fridays.
const fridays = [3, 10, 17, 24, 31, 38], weekdays = [0, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 17]

it('keeps the places a person returns to, with the page they land on and the hour they go', () => {
  const map = buildWorkMap([
    ...on('https://time.example/report?week=current', 'Time Report', weekdays, 17),
    ...on('https://time.example/', 'Time Report', [0], 9),
    ...on('https://expenses.example/card', 'Corporate card', fridays, 10),
    ...on('https://login.example/sso?code=abc', 'Sign in', weekdays, 9),
    ...on('https://news.example/story', 'Once', [2], 12),
    ...on('https://portal.example/view?id=1&session=zzz&token=' + 'x'.repeat(50), 'Portal', [1, 2], 11),
  ], [
    { title: 'Tracker', url: 'https://tracker.example/board', folder: 'Dev' },
    { title: 'Learning', url: 'https://learn.example/', folder: 'Company', managed: true },
  ], NOW)
  const hosts = map.places.map((place) => place.host)
  expect(hosts).toEqual(['time.example', 'tracker.example', 'expenses.example', 'portal.example', 'learn.example'])
  const time = map.places[0]!
  expect(time.entry).toBe('https://time.example/report?week=current')
  expect(time.rhythm).toEqual({ hour: 17, weekdaysOnly: true })
  expect(map.places.find((place) => place.host === 'expenses.example')!.rhythm).toEqual({ hour: 10, day: 5, weekdaysOnly: true })
  expect(map.places.find((place) => place.host === 'portal.example')!.entry).toBe('https://portal.example/view?id=1')
  expect(map.places.find((place) => place.host === 'learn.example')!.managed).toBe(true)
  expect(map.places.find((place) => place.host === 'tracker.example')!.bookmarks).toEqual(['Dev / Tracker'])
})

it('names places with one labelled call and gives comets a short list of work places only', () => {
  const map = buildWorkMap([...on('https://time.example/r', 'Time Report', weekdays, 17), ...on('https://video.example/w', 'Fireplace sounds', weekdays, 21)], [{ title: 'Learning', url: 'https://learn.example/', folder: 'Company', managed: true }], NOW)
  expect(labelPrompt(map)).toContain('1. time.example | bookmarks: - | pages: Time Report')
  const labelled = applyLabels(map, 'Here: [{"n": 1, "purpose": "Log working hours", "work": true}, {"n": 2, "purpose": "Videos", "work": false}, {"n": 9, "purpose": "ignored"}]')
  const shortcuts = workShortcuts(labelled)
  expect(shortcuts).toContain('- Log working hours: https://time.example/r (weekdays, around 17:00)')
  expect(shortcuts).not.toContain('video.example')
  expect(shortcuts).not.toContain('learn.example')
  expect(workShortcuts(null)).toBe('')
  expect(() => applyLabels(map, '{"n": 1}')).toThrow('not a list')
})

it('refreshes a place note without losing what the person wrote under their own heading', () => {
  const map = buildWorkMap(on('https://time.example/r', 'Time Report', weekdays, 17), [], NOW)
  const first = placeNote(map.places[0]!, NOW)
  expect(first.front.id).toBe(placeNoteId('time.example'))
  expect(first.front.type).toBe('place')
  const edited = { ...first, body: first.body.replace('Add how you use this place. Lines above this section are refreshed from your browser.', 'Submit before 18:00 on Fridays.') }
  const later = placeNote({ ...map.places[0]!, purpose: 'Log working hours' }, new Date(NOW.getTime() + 86_400_000), edited)
  expect(later.body).toContain('# Log working hours')
  expect(later.body).toContain('Submit before 18:00 on Fridays.')
  expect(later.front.created).toBe(first.front.created)
})

it('drops credentials and token-shaped values from addresses, and round-trips the map', async () => {
  expect(safeAddress('https://user:pw@example.com/')).toBeNull()
  expect(safeAddress('javascript:alert(1)')).toBeNull()
  expect(safeAddress('https://example.com/a?tab=assigned&state=abc#frag')).toBe('https://example.com/a?tab=assigned')
  expect(safeAddress('https://example.com/app#/board')).toBe('https://example.com/app#/board')
  expect(safeAddress('https://example.com/app#/board?access_token=SYNTHETIC_SECRET')).toBe('https://example.com/app#/board')
  expect(safeAddress('https://example.com/app#/' + 'x'.repeat(50))).toBeNull()
  expect(safeAddress('https://example.com/' + 'x'.repeat(50))).toBeNull()
  const paths = { cache: join(await mkdtemp(join(tmpdir(), 'engram-work-map-')), '.engram') } as VaultPaths
  expect(await readWorkMap(paths)).toBeNull()
  const map = buildWorkMap(on('https://time.example/r', 'Time Report', weekdays, 17), [], NOW)
  await writeWorkMap(paths, map)
  expect(await readWorkMap(paths)).toEqual(map)
})
