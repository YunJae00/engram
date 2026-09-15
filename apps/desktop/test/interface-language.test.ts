import { expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

it('keeps shipped interface text English and explicitly formats dates instead of inheriting the OS language', async () => {
  const root = resolve('apps/desktop/src/renderer/src')
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.tsx?$/.test(file)) continue
    const text = await readFile(resolve(root, file), 'utf8')
    expect(text, file).not.toMatch(/[가-힣]/)
    expect(text, file).not.toMatch(/(?:toLocale(?:Date|Time)?String|Intl\.DateTimeFormat)\(\s*(?:\)|undefined|\[\])/)
  }
})
