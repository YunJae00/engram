import { describe, expect, it } from 'vitest'
import { integrationCommands, integrationTier, tierScenarios } from './tier.mjs'
import { loadRoles } from './ledger.mjs'
import { URL, fileURLToPath } from 'node:url'

describe('integration tier', () => {
  it('defaults to quick and lets a flag override roles', () => {
    expect(integrationTier({})).toBe('quick')
    expect(integrationTier({ integration: { tier: 'full' } })).toBe('full')
    expect(integrationTier({ integration: { tier: 'full' } }, ['--quick'])).toBe('quick')
    expect(integrationTier({}, ['--full'])).toBe('full')
    expect(() => integrationTier({ integration: { tier: 'slow' } })).toThrow(/quick, full/)
  })

  it('roles.md ships the quick tier', () => {
    expect(integrationTier(loadRoles(fileURLToPath(new URL('../../', import.meta.url))))).toBe('quick')
  })

  it('quick never runs the e2e suite; full runs npm run verify', () => {
    const quick = integrationCommands('quick').map(([c, a]) => [c, ...a].join(' '))
    expect(quick).toEqual(['npm run check:quick', 'pnpm run test', 'pnpm --filter desktop build'])
    expect(quick.some((c) => /verify|e2e/.test(c))).toBe(false)
    expect(integrationCommands('full').map(([c, a]) => [c, ...a].join(' '))).toEqual(['npm run verify'])
  })

  it('quick runs every item scenario plus boot and smoke; full keeps boot and smoke', () => {
    const items = ['boot', 'ui-status-line', 'ui-preview-aspect', 'cosmos']
    expect(tierScenarios('quick', items, 2)).toEqual(['boot', 'ui-status-line', 'ui-preview-aspect', 'cosmos', 'note-open', 'ui-activity-status'])
    expect(tierScenarios('full', items, 2)).toEqual(['boot', 'cosmos', 'note-open', 'ui-activity-status'])
    expect(tierScenarios('quick', ['boot'], 0)).toEqual(['boot'])
  })
})
