import { expect, it } from 'vitest'
import { isNewBotShortcut } from '../src/renderer/src/lib/newBotShortcut.js'

type Keys = Parameters<typeof isNewBotShortcut>[0]
const press = (over: Partial<Keys>): Keys => ({
  key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, keyCode: 0, ...over,
})

it('Cmd or Ctrl+N without Shift or Alt opens the new bot dialog', () => {
  expect(isNewBotShortcut(press({ key: 'n', metaKey: true }))).toBe(true)
  expect(isNewBotShortcut(press({ key: 'n', ctrlKey: true }))).toBe(true)
  expect(isNewBotShortcut(press({ key: 'N', ctrlKey: true }))).toBe(true)
})

it('IME composition and other keys do not open it', () => {
  expect(isNewBotShortcut(press({ key: 'n', metaKey: true, isComposing: true }))).toBe(false)
  expect(isNewBotShortcut(press({ key: 'n', metaKey: true, keyCode: 229 }))).toBe(false)
  expect(isNewBotShortcut(press({ key: 'n', metaKey: true, shiftKey: true }))).toBe(false)
  expect(isNewBotShortcut(press({ key: 'n', ctrlKey: true, altKey: true }))).toBe(false)
  expect(isNewBotShortcut(press({ key: 'p', metaKey: true }))).toBe(false)
  expect(isNewBotShortcut(press({ key: 'n' }))).toBe(false)
})
