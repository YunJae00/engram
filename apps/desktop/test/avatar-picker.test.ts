import { describe, expect, it } from 'vitest'
import { en } from '../src/renderer/src/i18n'
import { ko } from '../src/renderer/src/i18n-ko'
import { avatarSaver, currentCharacter, optionLabel, pickerOptions, randomCharacter, stepRadio, withPart, type AvatarOps, type Part } from '../src/renderer/src/lib/avatarPicker.js'
import { previewCharacter } from '../src/renderer/src/lib/createBot.js'

const PARTS: Part[] = ['body', 'face', 'accessory', 'palette']

function deferredOps() {
  const calls: string[] = []
  const queue: { resolve(avatar: unknown): void; reject(error: unknown): void }[] = []
  const op = (name: string) => () => {
    calls.push(name)
    return new Promise<{ avatar?: unknown }>((resolve, reject) => queue.push({ resolve: avatar => resolve({ avatar }), reject }))
  }
  const ops: AvatarOps = {
    update: avatar => op(`update:${JSON.stringify(avatar)}`)(),
    set: () => op('set')(),
    clear: () => op('clear')(),
  }
  return { ops, calls, queue }
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('avatar picker logic', () => {
  it('picker edits: a pick saves the four parts, Default returns the id character, Random follows hash(id + n), no sun for a non-primary bot', async () => {
    const id = 'bot-x'
    const start = currentCharacter(id, undefined)
    expect(start).toEqual(previewCharacter(id, 0))
    const picked = withPart(withPart(start, 'face', 3), 'palette', 6)
    expect(picked).not.toBe(start)
    expect(currentCharacter(id, picked)).toEqual(picked)
    expect(Object.keys(picked).sort()).toEqual(['accessory', 'body', 'face', 'palette'])
    expect(currentCharacter(id, { image: 'bot-avatars/x.png' })).toEqual(previewCharacter(id, 0))
    for (const n of [1, 2]) {
      expect(randomCharacter(id, n, 5)).toEqual(previewCharacter(`${id}${n}`, 5))
      expect(randomCharacter(id, n, 5)).toEqual(randomCharacter(id, n, 5))
      expect(randomCharacter(id, n, 5).accessory).toBe(5)
    }
    expect(pickerOptions(false).body).toEqual([0, 1, 2, 3, 4, 5])
    expect(pickerOptions(false).body).not.toContain('sun')
    expect(pickerOptions(true).body).toEqual(['sun'])

    const two = deferredOps(), doneTwo: unknown[] = []
    const saverTwo = avatarSaver(id, two.ops, error => doneTwo.push(error))
    saverTwo.save({ kind: 'pick', next: withPart(start, 'face', 3) }, undefined)
    saverTwo.save({ kind: 'pick', next: withPart(withPart(start, 'face', 3), 'palette', 1) }, undefined)
    await tick()
    expect(two.calls).toHaveLength(1)
    two.queue[0]!.resolve(withPart(start, 'face', 3))
    await tick()
    expect(two.calls[1]).toBe(`update:${JSON.stringify(withPart(withPart(start, 'face', 3), 'palette', 1))}`)
    two.queue[1]!.resolve(withPart(withPart(start, 'face', 3), 'palette', 1))
    await tick()
    expect(saverTwo.idle()).toBe(true)

    const photo = deferredOps()
    const saverPhoto = avatarSaver(id, photo.ops, () => undefined)
    saverPhoto.save({ kind: 'photo', data: new Uint8Array([1]) }, start)
    saverPhoto.save({ kind: 'default' }, start)
    await tick()
    photo.queue[0]!.resolve({ image: 'bot-avatars/x.png' })
    await tick()
    expect(photo.calls).toEqual(['set', 'clear'])
    photo.queue[1]!.resolve(undefined)
    await tick()

    const failing = deferredOps(), errors: unknown[] = []
    const saverFail = avatarSaver(id, failing.ops, error => errors.push(error))
    saverFail.save({ kind: 'pick', next: start }, start)
    saverFail.save({ kind: 'default' }, start)
    await tick()
    failing.queue[0]!.reject(new Error('disk'))
    await tick()
    expect(errors[0]).toBeInstanceOf(Error)
    expect(failing.calls[1]).toBe('update:undefined')

    const idle = deferredOps()
    const saverIdle = avatarSaver(id, idle.ops, () => undefined)
    saverIdle.save({ kind: 'default' }, { image: 'bot-avatars/x.png' })
    await tick()
    expect(idle.calls).toEqual(['clear'])
  })

  it('each row is a radiogroup with arrow keys; every option has a ko and en aria-label', () => {
    expect(stepRadio(0, 6, 'ArrowRight')).toBe(1)
    expect(stepRadio(5, 6, 'ArrowRight')).toBe(0)
    expect(stepRadio(2, 6, 'ArrowDown')).toBe(3)
    expect(stepRadio(0, 6, 'ArrowLeft')).toBe(5)
    expect(stepRadio(3, 6, 'ArrowUp')).toBe(2)
    expect(stepRadio(3, 6, 'Home')).toBe(0)
    expect(stepRadio(3, 6, 'End')).toBe(5)
    expect(stepRadio(0, 1, 'ArrowRight')).toBe(0)
    expect(stepRadio(3, 6, 'Tab')).toBeNull()
    expect(stepRadio(3, 6, 'a')).toBeNull()
    for (const primary of [false, true]) {
      const options = pickerOptions(primary)
      for (const part of PARTS) {
        const values: readonly (number | 'sun')[] = options[part]
        for (const table of [en, ko] as Record<string, string>[]) {
          const labels = values.map(v => table[optionLabel(part, v)])
          for (const label of labels) expect(label).toBeTruthy()
          expect(new Set(labels).size).toBe(labels.length)
        }
      }
    }
  })
})
