import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { expect, it } from 'vitest'
const context = createContext({ ObjC: { import: () => undefined } })
runInContext(readFileSync(new URL('../native/macos/Office.js', import.meta.url), 'utf8'), context)
const formula = context['localFormula'] as (text: string) => void
const composition = context['validateComposition'] as (args: object, kind: string, page: object) => string
it('rejects external and named formulas before touching Excel', () => {
  for (const value of ['=SUM(A1:B3)', '=IF(A1>2,1,0)', 'plain text']) expect(() => formula(value)).not.toThrow()
  for (const value of ['=WEBSERVICE(A1)', '=Sheet2!A1', '=MYSECRET', '=HYPERLINK("https://example.com")']) expect(() => formula(value)).toThrow()
})
it('validates every composition box before creating any slide', () => {
  const box = { text: 'Owned', x: 10, y: 10, width: 200, height: 40, fontSize: 20, color: '112233' }
  const page = { slideCount: 1, pageWidth: 640, pageHeight: 480 }
  expect(composition({ slides: [{ boxes: [box] }] }, 'powerpoint', page)).toBe('slides')
  expect(() => composition({ slides: [{ boxes: [box, { ...box, x: 500 }] }] }, 'powerpoint', page)).toThrow('outside')
  expect(() => composition({ slides: [{ slide: 2, boxes: [box] }] }, 'powerpoint', page)).toThrow('existing')
  expect(() => composition({ paragraphs: [{ text: 'bad\u0000' }] }, 'word', {})).toThrow('text')
  expect(() => composition({ format: { numberFormat: 'arbitrary' } }, 'excel', {})).toThrow('number format')
})
