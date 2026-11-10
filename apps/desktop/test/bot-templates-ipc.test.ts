import { expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appendBotTurn, BUILTIN_TEMPLATES, createBot, initVault, loadBots, recordFacts, type Bot, type VaultPaths } from 'core'
import { updateBot } from 'core/src/bots'
import { createFromTemplate, exportTemplateTo, importTemplateFrom, templateList, templateSecrets } from '../src/main/bot-templates-ipc.js'

const KEYS = ['id', 'name', 'purpose', 'label', 'avatar', 'skills']

async function vault(): Promise<VaultPaths> {
  await mkdir(resolve('tmp'), { recursive: true })
  return initVault(await mkdtemp(resolve('tmp/bot-templates-ipc-')), { git: false })
}

const botsBytes = (p: VaultPaths) => readFile(join(p.cache, 'bots.json')).catch(() => null)

function spy() {
  const calls: Bot[] = []
  return { calls, fn: (b: Bot) => { calls.push(b) } }
}

async function rejectsClean(p: VaultPaths, run: (created: (b: Bot) => void) => Promise<unknown>, message?: RegExp) {
  const before = await botsBytes(p)
  const s = spy()
  if (message) await expect(run(s.fn)).rejects.toThrow(message)
  else await expect(run(s.fn)).rejects.toThrow()
  expect(await botsBytes(p)).toEqual(before)
  expect(s.calls).toEqual([])
}

async function writeTemplate(p: VaultPaths, name: string, value: unknown): Promise<string> {
  const file = join(p.root, `${name}.json`)
  await writeFile(file, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value))
  return file
}

const missing = (file: string) => expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' })

it('createFromTemplate returns bot with template fields and avatar accessory', async () => {
  const paths = await vault()
  await rejectsClean(paths, created => createFromTemplate(paths, 'nope', undefined, created), /no such template/)
  expect(await botsBytes(paths)).toBeNull()
  const s = spy()
  const bot = await createFromTemplate(paths, 'research', undefined, s.fn)
  expect(bot.id).toMatch(/^bot-/)
  expect(bot).toMatchObject({ name: '리서치', label: '자료 조사', templateId: 'research', purpose: BUILTIN_TEMPLATES[1]!.purpose })
  expect(bot.avatar).toEqual({ body: 1, face: 3, accessory: 4, palette: 4 })
  expect((await loadBots(paths)).find(b => b.id === bot.id)).toEqual(bot)
  expect(s.calls).toEqual([bot])
  const mine = await createFromTemplate(paths, 'research', { name: '내 리서치' }, () => {})
  expect(mine.name).toBe('내 리서치')
  expect(mine.id).not.toBe(bot.id)
  await rejectsClean(paths, created => createFromTemplate(paths, 'nope', undefined, created), /no such template/)
  await rejectsClean(paths, created => createFromTemplate(paths, 3, undefined, created), /no such template/)
  await rejectsClean(paths, created => createFromTemplate(paths, 'research', { name: '   ' }, created))
  const [a, b] = await Promise.all([createFromTemplate(paths, 'schedule', undefined, () => {}), createFromTemplate(paths, 'schedule', undefined, () => {})])
  expect(a.id).not.toBe(b.id)
  const ids = (await loadBots(paths)).map(x => x.id)
  expect(ids).toContain(a.id)
  expect(ids).toContain(b.id)
})

it('import rejects file with secrets', async () => {
  const paths = await vault()
  await createBot(paths, { name: 'Existing' })
  const base = { id: 'research', name: 'R', purpose: 'p' }
  const cases: [unknown, RegExp][] = [
    [{ ...base, token: 'abc123secret' }, /only id, name/],
    [{ ...base, memory: [] }, /only id, name/],
    [{ ...base, history: [] }, /only id, name/],
    [{ ...base, purpose: 'my password is hunter22' }, /password or key/],
    [{ ...base, label: 'token: abc123secret' }, /password or key/],
    [{ ...base, skills: ['ok', 'api key: sk-test-123'] }, /password or key/],
  ]
  for (const [i, [value, message]] of cases.entries()) {
    const file = await writeTemplate(paths, `secret-${i}`, value)
    await rejectsClean(paths, created => importTemplateFrom(paths, file, created), message)
  }
  expect(templateSecrets({ purpose: 'my password is hunter22' })).toEqual(['hunter22'])
  expect(templateSecrets({ purpose: 'password is ••••••' })).toEqual([])
  expect(templateSecrets({ skills: ['ok', 'api key: sk-test-123'] })).toEqual(['sk-test-123'])
  for (const value of [null, 'x', [], { skills: 'token: abc123secret' }, undefined]) expect(templateSecrets(value)).toEqual([])
  const throwing = Object.defineProperty({ label: 'token: abc123secret' }, 'purpose', { enumerable: true, get() { throw new Error('getter exploded') } })
  expect(templateSecrets(throwing)).toEqual(['abc123secret'])
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  expect(templateSecrets(proxy)).toEqual([])
})

it('export writes template without memory, history, secrets or photo', async () => {
  const paths = await vault()
  const b = await createBot(paths, { name: 'Secretary', purpose: 'my password is hunter22' })
  await updateBot(paths, b.id, { avatar: { image: 'face.png' } })
  await recordFacts(paths, b.id, ['The person likes FACT-MARKER coffee'])
  await appendBotTurn(paths, b.id, { role: 'user', text: 'CHAT-MARKER', at: '2026-01-02T10:00:00Z' })
  expect(await readFile(join(paths.cache, 'bot-memory', `${b.id}.json`), 'utf8')).toContain('FACT-MARKER')
  expect(await readFile(join(paths.cache, 'bot-chats', `${b.id}.jsonl`), 'utf8')).toContain('CHAT-MARKER')
  const out = join(paths.root, 'out.json')
  await exportTemplateTo(paths, b.id, out)
  const text = await readFile(out, 'utf8')
  expect(text.endsWith('\n')).toBe(true)
  for (const marker of ['hunter22', 'FACT-MARKER', 'CHAT-MARKER', 'image', 'createdAt']) expect(text).not.toContain(marker)
  const parsed = JSON.parse(text) as Record<string, unknown>
  for (const key of Object.keys(parsed)) expect(KEYS).toContain(key)
  expect(parsed.purpose).toContain('••••••')

  const drawn = await createBot(paths, { name: 'Drawn' })
  await updateBot(paths, drawn.id, { avatar: { body: 2, face: 4, accessory: 6, palette: 7 } })
  const drawnOut = join(paths.root, 'drawn.json')
  await exportTemplateTo(paths, drawn.id, drawnOut)
  expect(JSON.parse(await readFile(drawnOut, 'utf8')).avatar).toEqual({ body: 2, face: 4, accessory: 6, palette: 7 })

  const skilled = await createBot(paths, { name: 'Skilled' })
  await updateBot(paths, skilled.id, { skills: ['api key: sk-test-123'] })
  const skilledOut = join(paths.root, 'skilled.json')
  await expect(exportTemplateTo(paths, skilled.id, skilledOut)).rejects.toThrow(/password or key/)
  await missing(skilledOut)
  for (const id of ['bot-missing', '../x', 5]) {
    const target = join(paths.root, 'unknown.json')
    await expect(exportTemplateTo(paths, id, target)).rejects.toThrow(/no such comet/)
    await missing(target)
  }
})

it('import fails closed and always makes a new id', async () => {
  const paths = await vault()
  await createBot(paths, { name: 'Existing' })
  const head = '{"id":"research","name":"R","purpose":"'
  const big = head + ' '.repeat(65537 - Buffer.byteLength(head) - 2) + '"}'
  expect(Buffer.byteLength(big)).toBe(65537)
  const files = [
    await writeTemplate(paths, 'big', big),
    paths.root,
    await writeTemplate(paths, 'bad-utf8', Buffer.from([0xff])),
    await writeTemplate(paths, 'not-json', 'not json'),
    await writeTemplate(paths, 'array', '[]'),
    await writeTemplate(paths, 'null', 'null'),
    await writeTemplate(paths, 'image', { id: 'research', name: 'R', purpose: 'p', avatar: { image: 'x.png' } }),
    await writeTemplate(paths, 'body6', { id: 'research', name: 'R', purpose: 'p', avatar: { body: 6, face: 0, accessory: 0, palette: 0 } }),
    await writeTemplate(paths, 'proto', '{"__proto__":{},"id":"research","name":"R","purpose":"p"}'),
  ]
  for (const file of files) await rejectsClean(paths, created => importTemplateFrom(paths, file, created))

  const r = await createFromTemplate(paths, 'research', undefined, () => {})
  const file = join(paths.root, 'round.json')
  await exportTemplateTo(paths, r.id, file)
  const s = spy()
  const copy = await importTemplateFrom(paths, file, s.fn)
  expect(copy.id).not.toBe(r.id)
  expect(copy).toMatchObject({ templateId: 'research', label: '자료 조사' })
  expect(copy.avatar).toMatchObject({ accessory: 4 })
  expect(s.calls).toEqual([copy])

  const masked = await createBot(paths, { name: 'Masked', purpose: 'password is hunter22' })
  const maskedFile = join(paths.root, 'masked.json')
  await exportTemplateTo(paths, masked.id, maskedFile)
  expect(await readFile(maskedFile, 'utf8')).toContain('password is ••••••')
  const again = await importTemplateFrom(paths, maskedFile, () => {})
  expect(again.purpose).toBe('password is ••••••')
})

it('templates lists the five built-ins', () => {
  const list = templateList()
  expect(list.map(t => t.id)).toEqual(['morning-briefing', 'research', 'mail-draft', 'schedule', 'study-helper'])
  expect(list.map(t => t.avatar?.accessory)).toEqual([7, 4, 8, 5, 2])
  list[1]!.name = 'x'
  list[1]!.avatar!.accessory = 0
  expect(BUILTIN_TEMPLATES[1]!.name).toBe('리서치')
  expect(BUILTIN_TEMPLATES[1]!.avatar!.accessory).toBe(4)
  const next = templateList()[1]!
  expect(next.name).toBe('리서치')
  expect(next.avatar!.accessory).toBe(4)
})
