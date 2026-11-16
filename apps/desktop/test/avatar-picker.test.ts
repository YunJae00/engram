import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { avatarSaver, changedAvatar, pickerOptions, stepGrid, type AvatarOps } from '../src/renderer/src/lib/avatarPicker.js'
import { ORBS, defaultCharacter } from '../src/renderer/src/lib/botAvatar.js'
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
  it('offers exactly the 8 orbs; pick saves the exact shape, Default the plain hash of the real id', () => {
    expect(pickerOptions()).toEqual(ORBS)
    expect(changedAvatar('bot-x', { kind: 'pick', next: 'orb-amber' })).toEqual({ character: 'orb-amber' })
    expect(changedAvatar('bot-x', { kind: 'default' })).toEqual({ character: defaultCharacter('bot-x') })
  })

  it('grid keys move ±1 across, ±4 down, wrap, and Home/End jump', () => {
    expect(stepGrid(0, 8, 'ArrowRight')).toBe(1)
    expect(stepGrid(7, 8, 'ArrowRight')).toBe(0)
    expect(stepGrid(0, 8, 'ArrowLeft')).toBe(7)
    expect(stepGrid(1, 8, 'ArrowDown')).toBe(5)
    expect(stepGrid(5, 8, 'ArrowDown')).toBe(1)
    expect(stepGrid(2, 8, 'ArrowUp')).toBe(6)
    expect(stepGrid(5, 8, 'Home')).toBe(0)
    expect(stepGrid(5, 8, 'End')).toBe(7)
    expect(stepGrid(5, 8, 'a')).toBeNull()
  })

  it('renders one 4x2 radiogroup named by id, one tab stop, no upload control', () => {
    const html = picker({ value: { character: 'orb-green' } })
    expect(html.match(/role="radio"/g)).toHaveLength(8)
    expect(html.match(/class="bot-orb"/g)).toHaveLength(8)
    expect(html).not.toContain('<img')
    expect(html.match(/role="radiogroup"/g)).toHaveLength(1)
    expect(html.match(/tabindex="0"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-label="orb-green" aria-checked="true" tabindex="0"/)
    expect(picker({ value: { character: '04-lobe' } })).toMatch(/aria-label="orb-green" aria-checked="true" tabindex="0"/)
    for (const id of ORBS) expect(html).toContain(`aria-label="${id}"`)
    expect(html).not.toMatch(/type="file"|avatar-picker-random|photo/i)
    expect(picker({ value: { character: 'orb-green' }, picked: false })).not.toContain('aria-checked="true"')
    const css = readFileSync(join(__dirname, '../src/renderer/src/bot-avatar.css'), 'utf8')
    expect(css).toContain('grid-template-columns: repeat(4, 56px)')
    expect(css).toContain('.avatar-picker-cell[aria-checked="true"] { outline: 2px solid var(--ink, #1C1C1E)')
    expect(css).not.toMatch(/avatar-picker[^{]*\{[^}]*--focus-ring/)
  })

  it('saves serially in call order and reports the last stored value', async () => {
    const { ops, calls, queue } = deferredOps()
    const done: unknown[] = []
    const saver = avatarSaver('bot-x', ops, error => done.push(error))
    saver.save({ kind: 'pick', next: 'orb-blue' }, undefined)
    saver.save({ kind: 'default' }, undefined)
    await tick()
    expect(calls).toEqual(['{"character":"orb-blue"}'])
    queue[0]!.resolve({ character: 'orb-blue' })
    await tick()
    expect(calls).toHaveLength(2)
    expect(saver.idle()).toBe(false)
    queue[1]!.reject(new Error('disk full'))
    await tick()
    expect(done).toEqual([undefined, new Error('disk full')])
    expect(saver.idle()).toBe(true)
    expect(saver.latest()).toEqual({ character: 'orb-blue' })
  })

  it('a stopped saver for another bot reports nothing when its write finishes', async () => {
    const { ops, queue } = deferredOps()
    const done: unknown[] = []
    const saver = avatarSaver('bot-old', ops, error => done.push(error))
    saver.save({ kind: 'pick', next: 'orb-teal' }, undefined)
    await tick()
    saver.stop()
    queue[0]!.resolve({ character: 'orb-teal' })
    await tick()
    expect(done).toEqual([])
    expect(saver.idle()).toBe(true)
    // The info pane that held one saver per bot is gone; the icon is picked once, when the bot is made.
    expect(existsSync(join(__dirname, '../src/renderer/src/components/BotInfoPane.tsx'))).toBe(false)
    expect(readFileSync(join(__dirname, '../src/renderer/src/components/CreateBotDialog.tsx'), 'utf8')).toContain('AvatarPicker')
  })
})
