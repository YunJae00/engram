import { expect, it } from 'vitest'
import { pageRecovery } from '../src/page-recovery.js'

it('retains matching failures across new control numbers, other failures and screenshots', () => {
  const guard = pageRecovery()
  guard.after('press', { target: '#29' }, 'that did not work: "#29" no longer matches the page you read')
  guard.after('look', {}, 'the page as a picture')
  guard.after('press_key', { key: 'Escape' }, 'that did not work: Could not read the page')
  guard.after('press', { target: '#82' }, 'that did not work: "#82" no longer matches the page you read')
  expect(guard.before('press', { target: '#30' })).toContain('was not run again')
  guard.after('read_open_page', {}, 'Observation page-1/2/12; fresh controls')
  expect(guard.before('press', { target: '#30' })).toBeUndefined()
})

it('bounds failed rereads without blocking a different source', () => {
  const guard = pageRecovery()
  guard.before('open_page', { url: 'https://example.test/first' })
  guard.after('open_page', { url: 'https://example.test/first' }, 'Observation page-1; fresh controls')
  for (const find of ['hours', 'access']) guard.after('read_open_page', { find }, 'that did not work: The page has not exposed readable content after waiting.')
  expect(guard.before('read_open_page', { find: 'schedule' })).toContain('open a different relevant address')
  guard.before('open_page', { url: 'https://example.test/other' })
  guard.after('open_page', { url: 'https://example.test/other' }, 'Observation page-2; fresh controls')
  expect(guard.before('read_open_page', {})).toBeUndefined()
})

it('does not count successful key/scroll actions or approval waits as failures', () => {
  const guard = pageRecovery()
  for (let i = 0; i < 4; i++) {
    for (const tool of ['press_key', 'scroll']) {
      expect(guard.before(tool, {})).toBeUndefined()
      guard.after(tool, {}, `page: row ${i}`)
    }
    expect(guard.before('page_steps', {})).toBeUndefined()
    guard.after('page_steps', {}, 'that did not work: Stopped at move 1. "Submit" was not pressed: it waits for the person\'s approval')
  }
})

it('bounds no-change actions even when their key names differ', () => {
  const guard = pageRecovery()
  for (const key of ['Escape', 'Tab']) guard.after('press_key', { key }, `press ${key}: nothing on the page changed, so inspect it\npage: same`)
  expect(guard.before('press_key', { key: 'Space' })).toContain('two matching browser failures')
})

it('lets a fresh reading re-arm a blocked action only twice per page', () => {
  const guard = pageRecovery()
  guard.before('open_page', { url: 'https://example.test/form' })
  guard.after('open_page', { url: 'https://example.test/form' }, 'Observation page-1; fresh controls')
  for (let round = 0; round < 3; round++) {
    for (const target of ['#1', '#2']) guard.after('press', { target }, `that did not work: "${target}" no longer matches the page you read`)
    guard.after('read_open_page', {}, 'Observation page-1; fresh controls')
  }
  expect(guard.before('press', { target: '#3' })).toContain('was not run again')
  guard.before('open_page', { url: 'https://example.test/other' })
  guard.after('open_page', { url: 'https://example.test/other' }, 'Observation page-2; fresh controls')
  expect(guard.before('press', { target: '#3' })).toBeUndefined()
  guard.after('open_page', { url: 'https://example.test/form' }, 'Observation page-1; fresh controls')
  expect(guard.before('press', { target: '#3' })).toContain('was not run again')
})

it('does not clear failures on invalid arguments, incomplete reads or failed navigation', () => {
  const guard = pageRecovery()
  for (let i = 0; i < 2; i++) guard.after('press', {}, 'that did not work: target is stale')
  for (const [tool, args, observation] of [
    ['press', {}, 'press needs the words on the thing to press'],
    ['open_page', { url: 'invalid' }, 'open_page needs a full web address'],
    ['search_web', { query: 'find help' }, 'no search address is known yet'],
    ['open_page', { url: 'https://example.test/other' }, 'that did not work: navigation failed'],
    ['read_open_page', {}, 'Observation page-1; This extract is incomplete; reobserve'],
  ] as const) {
    guard.before(tool, args)
    guard.after(tool, args, observation)
    expect(guard.before('press', {})).toContain('was not run again')
  }
})

it('does not treat different batch search terms as different failing strategies', () => {
  const guard = pageRecovery()
  for (const find of ['name', 'other']) guard.after('read_pages', { pages: [{ url: 'https://example.test/', ready: 'Ready', find }] }, 'that did not work: Batch stopped')
  expect(guard.before('read_pages', { pages: [{ url: 'https://example.test/', ready: 'New label', find: 'more' }] })).toContain('was not run again')
})
