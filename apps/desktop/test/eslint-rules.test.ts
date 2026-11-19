import { ESLint } from 'eslint'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const eslint = new ESLint({ cwd: root })

async function rulesHit(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) })
  return (result?.messages ?? []).map(message => `${message.line}:${message.ruleId}`)
}

describe('eslint repo rules', () => {
  it('reports Korean matched in product code', async () => {
    const code = [
      "export const lamp = /등불/.test('x')",
      "export const kettle = new RegExp('주전자')",
      'export const shelf = `선반 ${lamp}`',
    ].join('\n')
    expect(await rulesHit('apps/desktop/src/main/garden-shed.ts', code)).toEqual(['1:no-restricted-syntax', '2:no-restricted-syntax', '3:no-restricted-syntax'])
    expect(await rulesHit('packages/core/src/orchard.ts', "export const pear = '배나무'")).toEqual(['1:no-restricted-syntax'])
  })

  it('leaves the same Korean text alone in a locale catalog and outside product code', async () => {
    const code = "export const lamp = /등불/.test('x')\n"
    expect(await rulesHit('apps/desktop/src/main/locale/garden-shed.ts', code)).toEqual([])
    expect(await rulesHit('apps/desktop/src/renderer/src/garden-shed.ts', code)).toEqual([])
    expect(await rulesHit('apps/desktop/src/main/garden-shed.ts', "export const lamp = /lantern/.test('x')\n")).toEqual([])
  })

  it('reports skipped and narrowed tests, and keeps conditional platform gates', async () => {
    const narrowed = (runner: string, mode: string) => [runner, mode].join('.')
    const code = [
      "import { describe, it, test } from 'vitest'",
      `${narrowed('it', 'skip')}('folds the map', () => {})`,
      `${narrowed('describe', 'only')}('compass', () => {})`,
      `${narrowed('it', 'todo')}('reads the tide')`,
      `${narrowed('test', 'skip')}(process.platform !== 'linux', 'needs the linux tray')`,
      `it('boils water', () => { ${narrowed('test', 'skip')}() })`,
      "it('pours tea', () => {})",
    ].join('\n')
    expect(await rulesHit('apps/desktop/test/kettle.test.ts', code)).toEqual(['2:no-restricted-syntax', '3:no-restricted-syntax', '4:no-restricted-syntax', '6:no-restricted-syntax'])
  })
})
