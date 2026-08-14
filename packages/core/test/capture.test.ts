import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCapture } from '../src/capture.js'

describe('writeCapture — repeats do not become duplicate memories', () => {
  let inbox: string
  beforeEach(async () => {
    inbox = await mkdtemp(join(tmpdir(), 'engram-capture-'))
  })
  afterEach(async () => {
    await rm(inbox, { recursive: true, force: true })
  })

  // The bug this exists for: one todo list captured five times in eight
  // seconds became five notes, each linking into every project it named.
  it('folds a burst of identical captures into one inbox item', async () => {
    const text = '- bge search\n- Engram chronicle\n- hcompany UAT'
    const results = []
    for (let i = 0; i < 5; i++) results.push(await writeCapture(inbox, text))

    expect(await readdir(inbox)).toHaveLength(1)
    expect(results[0]!.duplicate).toBe(false)
    expect(results.slice(1).every((r) => r.duplicate)).toBe(true)
    // every caller is told which item holds their text
    expect(new Set(results.map((r) => r.file)).size).toBe(1)
  })

  it('ignores surrounding whitespace when comparing', async () => {
    await writeCapture(inbox, 'remember the milk')
    const again = await writeCapture(inbox, '  remember the milk\n\n  ')
    expect(again.duplicate).toBe(true)
    expect(await readdir(inbox)).toHaveLength(1)
  })

  it('keeps genuinely different captures apart', async () => {
    const a = await writeCapture(inbox, 'first thought')
    const b = await writeCapture(inbox, 'second thought')
    expect(b.duplicate).toBe(false)
    expect(b.file).not.toBe(a.file)
    expect(await readdir(inbox)).toHaveLength(2)
  })

  it('captures again once the earlier item has been filed away', async () => {
    const text = 'a thought worth keeping'
    const first = await writeCapture(inbox, text)
    await rm(join(inbox, first.file)) // the librarian filed it
    const second = await writeCapture(inbox, text)
    expect(second.duplicate).toBe(false)
    expect(await readdir(inbox)).toHaveLength(1)
  })

  it('does not trip over non-markdown items sitting in the inbox', async () => {
    await writeFile(join(inbox, 'screenshot.png'), 'not text')
    const written = await writeCapture(inbox, 'a note')
    expect(written.duplicate).toBe(false)
    expect(written.file.endsWith('.md')).toBe(true)
  })
})
