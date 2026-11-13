import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { avatarSaver, changedAvatar, pickerOptions, stepGrid, type AvatarOps } from '../src/renderer/src/lib/avatarPicker.js'
import { CHARACTERS, defaultCharacter } from '../src/renderer/src/lib/botAvatar.js'
import { AvatarPicker } from '../src/renderer/src/components/AvatarPicker.js'

function deferredOps() {
  const calls: string[] = []
  const queue: { resolve(avatar: unknown): void; reject(error: unknown): void }[] = []
  const ops: AvatarOps = {
    update: avatar => {
      calls.push(JSON.stringify(avatar))
      return new Promise((resolve, reject) => queue.push({ resolve: saved => resolve({ avatar: saved }), reject }))
    },
  }
  return { ops, calls, queue }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const picker = (props: Record<string, unknown>) => renderToStaticMarkup(createElement(AvatarPicker, { id: 'bot-x', value: undefined, theme: 'light', onPick() {}, onDefault() {}, ...props }))

describe('avatar picker logic', () => {
  it('offers exactly the 16 characters; pick saves the exact shape, Default the plain hash of the real id', () => {
    expect(pickerOptions()).toEqual(CHARACTERS)
    expect(changedAvatar('bot-x', { kind: 'pick', next: '05-squircle' })).toEqual({ character: '05-squircle' })
    expect(changedAvatar('bot-x', { kind: 'default' })).toEqual({ character: defaultCharacter('bot-x') })
  })

  it('grid keys move ±1 across, ±4 down, wrap, and Home/End jump', () => {
    expect(stepGrid(0, 16, 'ArrowRight')).toBe(1)
    expect(stepGrid(15, 16, 'ArrowRight')).toBe(0)
    expect(stepGrid(0, 16, 'ArrowLeft')).toBe(15)
    expect(stepGrid(1, 16, 'ArrowDown')).toBe(5)
    expect(stepGrid(13, 16, 'ArrowDown')).toBe(1)
    expect(stepGrid(2, 16, 'ArrowUp')).toBe(14)
    expect(stepGrid(7, 16, 'Home')).toBe(0)
    expect(stepGrid(7, 16, 'End')).toBe(15)
    expect(stepGrid(7, 16, 'a')).toBeNull()
  })

  it('renders one 4x4 radiogroup named by id, one tab stop, no upload control', () => {
    const html = picker({ value: { character: '06-triangle' } })
    expect(html.match(/role="radio"/g)).toHaveLength(16)
    expect(html.match(/role="radiogroup"/g)).toHaveLength(1)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="06-triangle" aria-checked="true" tabindex="0"/)
    for (const id of CHARACTERS) expect(html).toContain(`aria-label="${id}"`)
    expect(html).not.toMatch(/type="file"|avatar-picker-random|photo/i)
    expect(picker({ value: { character: '06-triangle' }, picked: false })).not.toContain('aria-checked="true"')
    const css = readFileSync(join(__dirname, '../src/renderer/src/bot-avatar.css'), 'utf8')
    expect(css).toContain('grid-template-columns: repeat(4, 56px)')
    expect(css).toContain('.avatar-picker-cell[aria-checked="true"] { outline: 2px solid var(--ink, #1C1C1E)')
    expect(css).not.toMatch(/avatar-picker[^{]*\{[^}]*--focus-ring/)
  })

  it('saves serially in call order and reports the last stored value', async () => {
    const { ops, calls, queue } = deferredOps()
    const done: unknown[] = []
    const saver = avatarSaver('bot-x', ops, error => done.push(error))
    saver.save({ kind: 'pick', next: '02-cloud' }, undefined)
    saver.save({ kind: 'default' }, undefined)
    await tick()
    expect(calls).toEqual(['{"character":"02-cloud"}'])
    queue[0]!.resolve({ character: '02-cloud' })
    await tick()
    expect(calls).toHaveLength(2)
    expect(saver.idle()).toBe(false)
    queue[1]!.reject(new Error('disk full'))
    await tick()
    expect(done).toEqual([undefined, new Error('disk full')])
    expect(saver.idle()).toBe(true)
    expect(saver.latest()).toEqual({ character: '02-cloud' })
  })

  it('a stopped saver for another bot reports nothing when its write finishes', async () => {
    const { ops, queue } = deferredOps()
    const done: unknown[] = []
    const saver = avatarSaver('bot-old', ops, error => done.push(error))
    saver.save({ kind: 'pick', next: '03-cashew' }, undefined)
    await tick()
    saver.stop()
    queue[0]!.resolve({ character: '03-cashew' })
    await tick()
    expect(done).toEqual([])
    expect(saver.idle()).toBe(true)
    const pane = readFileSync(join(__dirname, '../src/renderer/src/components/BotInfoPane.tsx'), 'utf8')
    expect(pane).toContain('if (avatarWrites.current?.id !== bot.id) {')
    expect(pane).toContain('avatarWrites.current?.stop()')
  })
})
