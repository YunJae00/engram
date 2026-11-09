import { expect, it } from 'vitest'
import { cometIdentity } from '../src/main/cometIdentity.js'

const ROLE = 'a colleague who gets the task done'
const RULE = 'Stay within that charter.'

it('does not name an untitled comet', () => {
  for (const name of ['New comet', '', '  New comet ']) {
    const line = cometIdentity({ name, purpose: '' }, ROLE)
    expect(line).not.toContain('New comet')
    expect(line).not.toContain('You are "')
    expect(line).toContain("one of the user's comets")
    expect(line).not.toContain('Your charter')
  }
})

it('keeps a real name', () => {
  const line = cometIdentity({ name: '천문 도우미', purpose: '' }, ROLE)
  expect(line).toContain('You are "천문 도우미"')
  expect(line).not.toContain('Your charter')
  expect(cometIdentity({ name: 'New comet helper', purpose: '' }, ROLE)).toContain('You are "New comet helper"')
})

it('includes the charter when purpose is set', () => {
  const named = cometIdentity({ name: '천문 도우미', purpose: 'Track sky events.' }, ROLE, RULE)
  expect(named).toContain('You are "천문 도우미"')
  expect(named).toContain(`Your charter: Track sky events. ${RULE}`)
  const unnamed = cometIdentity({ name: 'New comet', purpose: 'Track sky events.' }, ROLE)
  expect(unnamed).toContain('Your charter: Track sky events.')
  expect(unnamed).not.toContain('New comet')
})

it('matches the previous persona for named comets', () => {
  expect(cometIdentity({ name: 'R', purpose: 'P' }, ROLE)).toBe(`You are "R", one of the user's comets — ${ROLE}. Your charter: P`)
})

it('tolerates a stored bot without purpose', () => {
  expect(cometIdentity({ name: 'R' }, ROLE)).toBe(`You are "R", one of the user's comets — ${ROLE}.`)
})
