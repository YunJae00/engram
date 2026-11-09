import { expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const koreanAllowed = (file: string) => /^i18n-ko(?:-[\w-]+)?\.ts$/.test(file) || /threadLangKo\.ts$/.test(file)

it('Korean literals only in i18n-ko*.ts and threadLangKo.ts, and dates are formatted explicitly instead of inheriting the OS language', async () => {
  for (const file of ['i18n-ko.ts', 'i18n-ko-1.ts', 'lib/threadLangKo.ts']) expect(koreanAllowed(file), file).toBe(true)
  for (const file of ['components/i18n-ko-1.ts', 'i18n-ko.ts.bak.ts', 'i18n.ts', 'components/Foo.tsx']) expect(koreanAllowed(file), file).toBe(false)
  const root = resolve('apps/desktop/src/renderer/src')
  for (const file of await readdir(root, { recursive: true })) {
    if (!/\.tsx?$/.test(file)) continue
    // The words inside a conversation follow the person's language; this is their one table.
    if (/threadLangKo\.ts$/.test(file)) continue
    const text = await readFile(resolve(root, file), 'utf8')
    if (!koreanAllowed(file.split('\\').join('/'))) expect(text, file).not.toMatch(/[가-힣]/)
    expect(text, file).not.toMatch(/(?:toLocale(?:Date|Time)?String|Intl\.DateTimeFormat)\(\s*(?:\)|undefined|\[\])/)
  }
})
