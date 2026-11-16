import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const src = (path: string) => readFile(resolve('apps/desktop/src', path), 'utf8')

// Settings is one page of five things. This reads the page's own source: a sixth row, a section switcher or a
// save footer coming back fails here before any window is opened (e2e/appearance.spec.ts checks the built page).
it('the settings page holds theme, shortcut, AI account, start fresh and version, and nothing else', async () => {
  const page = await src('renderer/src/views/SettingsView.tsx')
  const body = page.slice(page.indexOf('<DialogHeader'))
  const mounted = [...body.matchAll(/<([A-Z]\w+)[\s/>]/g)].map(match => match[1]).filter(name => !['DialogHeader', 'SettingsGroup', 'SettingsItem', 'Sparkles'].includes(name!))
  expect(mounted).toEqual(['AppearanceSettings', 'Keys', 'EngineSettings', 'ResetSettings', 'SettingsStatus', 'DeveloperSettings'])
  // The developer rows exist only under the developer fixture flag, which is off in the product.
  expect(body).toMatch(/\{api\.developerUiEnabled && <section[^\n]*<DeveloperSettings \/>/)
  expect([...body.matchAll(/testId="([\w-]+)"/g)].map(match => match[1])).toEqual(['settings-theme', 'settings-shortcut', 'settings-start-fresh', 'settings-about'])
  for (const gone of ['SettingsNavigation', 'setting-autostart', 'setting-desk-journal', 'audit-open', 'settings-github-backup', 'settings-export-logs', 'uiLanguage', 'semantic', 'settingsUi.saved', 'settingsUi.done', 'dialog-actions', 'ComputerSettings', 'ReviewRulesSettings', 'WorkMapSettings', 'WorkHabitsSettings']) expect(page, gone).not.toContain(gone)
})

it('the AI account section signs in, disconnects, takes a key and tests, with no model picker', async () => {
  const engine = await src('renderer/src/components/EngineSettings.tsx')
  for (const kept of ['brain-${id}-connect', 'brain-${id}-disconnect', 'KeyConnection', 'ai-check-filing', 'AccountProfiles']) expect(engine, kept).toContain(kept)
  for (const gone of ['ModelPicker', 'provider="decision"', 'AccountUsage']) expect(engine, gone).not.toContain(gone)
  const status = await src('renderer/src/components/SettingsStatus.tsx')
  for (const kept of ['settings-version', 'settings-update-check', 'updateInstall']) expect(status, kept).toContain(kept)
  expect(status).not.toMatch(/semantic/i)
  expect(await src('renderer/src/components/AppearanceSettings.tsx')).not.toMatch(/language/i)
})

it('nothing in the window creates, switches, joins or deletes a workspace, and there is no tour', async () => {
  const components = await readdir(resolve('apps/desktop/src/renderer/src/components'))
  expect(components.filter(name => /WorkspaceSwitcher|TourOverlay|SettingsNavigation|ComputerSettings|ReviewRulesSettings|WorkMapSettings|WorkHabitsSettings/.test(name))).toEqual([])
  const preload = await src('preload/index.ts')
  expect(preload).not.toMatch(/workspace:|tourEligible|audit:open|semantic:status|reviewRules:(add|remove)|apps:set|habits:scan|workMap:refresh/)
  const menu = await src('renderer/src/components/SidebarMenu.tsx')
  expect(menu).not.toMatch(/\bapi\.|sidebar\.workspaces|'ws\./)
  expect([...menu.matchAll(/\['(\w+)', t\(/g)].map(match => match[1])).toEqual(['bots', 'sky', 'list'])
})
