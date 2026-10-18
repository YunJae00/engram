import { expect, it } from 'vitest'
import PptxGenJS from 'pptxgenjs'
import { withoutMissingParts } from 'core'
import { readPackage, validatePackage } from '../../../packages/core/src/document-package.js'

it('writes decks that a strict package reader accepts', async () => {
  const pptx = new PptxGenJS()
  for (const title of ['One', 'Two', 'Three']) pptx.addSlide().addText(title, { x: 1, y: 1, w: 4, h: 1 })
  const raw = await pptx.write({ outputType: 'nodebuffer' }) as Buffer
  await expect((async () => validatePackage(await readPackage(raw), '.pptx'))()).rejects.toThrow('missing or duplicate part')
  const tidy = await withoutMissingParts(raw)
  expect(validatePackage(await readPackage(tidy), '.pptx').textParts.some(part => part.includes('slide'))).toBe(true)
})
