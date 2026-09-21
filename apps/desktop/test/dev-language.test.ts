import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { devLanguage } from '../src/main/dev-language.js'

it('checks unsaved TypeScript, completes symbols and locates definitions without executing project plugins', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-language-')), path = 'code.ts'
  await writeFile(join(root, path), '')
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, plugins: [{ name: 'never-execute-fixture' }] } }))
  const source = 'const greeting: string = 123;\nconst data = { value: 1 };\ndata.'
  const diagnostics = devLanguage(root, path, source, 0, 'check').diagnostics!
  expect(diagnostics.some(item => item.message.includes('not assignable'))).toBe(true)
  expect(devLanguage(root, path, source, source.length, 'complete').completions).toContainEqual(expect.objectContaining({ name: 'value' }))
  await writeFile(join(root, 'value.ts'), 'export const greeting = "hello"')
  const imported = 'import { greeting } from "./value";\ngreeting'
  expect(devLanguage(root, path, imported, imported.length - 1, 'definition').definitions).toContainEqual({ path: 'value.ts', line: 1 })
  expect(() => devLanguage(root, '../outside.ts', '', 0, 'check')).toThrow()
})
