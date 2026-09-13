import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { vaultPaths } from '../../../packages/core/src/vault.js'
import { attachmentError, ATTACHMENT_MAX_BYTES } from '../src/shared/attachments.js'
import { chatMessage, sendCometMessage } from '../src/renderer/src/lib/attachments.js'
import { createCometThreads } from '../src/renderer/src/lib/cometThreads.js'
import type { EngramApi, EngramEvent } from '../src/shared/types.js'
import { appendBotTurn, readBotTranscript, engineCwd, runComet, type Engine, type EngineJobInput } from 'core'

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), clipboard: vi.fn(), owner: { webContents: { mainFrame: {} } } }))
vi.mock('electron', () => ({
  clipboard: { writeText: state.clipboard },
  nativeImage: { createFromBuffer: (data: Buffer) => ({ isEmpty: () => data.toString() !== 'valid image' }) },
  ipcMain: { removeHandler: vi.fn(), handle: (name: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(name, handler) },
}))
vi.mock('../src/main/desktop-access.js', () => ({ desktopOwner: () => state.owner }))
import { chatAttachmentIds, readChatAttachments, registerChatAttachmentIpc, saveChatAttachment } from '../src/main/chat-attachments.js'

let root: string
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/chat-attachments-'))
  const paths = vaultPaths(root)
  for (const path of [paths.inbox, paths.notes, paths.sources]) await mkdir(path, { recursive: true })
  state.clipboard.mockClear()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('keeps attached bytes in chat cache, includes their content in context, and leaves Cosmos untouched', async () => {
  const paths = vaultPaths(root)
  const first = await saveChatAttachment(paths, 'input.txt', Buffer.from('42'))
  const second = await saveChatAttachment(paths, 'input.txt', Buffer.from('second file'))
  expect(first.id).not.toBe(second.id)
  expect(chatMessage('', [first])).toBe('Attached: input.txt')
  expect(chatMessage('What is the result?', [first])).toBe('What is the result?\n\nAttached: input.txt')
  const read = await readChatAttachments(paths, [first.id, second.id])
  expect(read.context).toContain('42')
  expect(read.context).toContain('second file')
  expect(read.context).toContain('untrusted reference data')
  expect(await readFile(read.paths[0]!, 'utf8')).toBe('42')
  expect(await readdir(paths.inbox)).toEqual([])
  expect(await readdir(paths.notes)).toEqual([])
  expect(await readdir(paths.sources)).toEqual([])
  expect(read.imagePaths).toEqual([])
})

it('extracts Office documents through the existing parser and reports unreadable inputs honestly', async () => {
  const { Document, Packer, Paragraph } = await import('docx')
  const paths = vaultPaths(root)
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('The attached document says the delivery date is September 22.')] }] }))
  const doc = await saveChatAttachment(paths, 'brief.docx', bytes)
  expect((await readChatAttachments(paths, [doc.id])).context).toContain('delivery date is September 22')
  const short = await saveChatAttachment(paths, 'short.docx', await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('42')] }] })))
  const shortContext = (await readChatAttachments(paths, [short.id])).context
  expect(shortContext).toContain('42')
  expect(shortContext).not.toContain('No readable text was extracted')
  const broken = await saveChatAttachment(paths, 'broken.pdf', Buffer.from('not a pdf'))
  expect((await readChatAttachments(paths, [broken.id])).context).toContain('No readable text was extracted')
})

it('reloads only this chat’s attached references and caps history with current files first', async () => {
  const paths = vaultPaths(root)
  const mine = await saveChatAttachment(paths, 'mine.txt', Buffer.from('My attached delivery date is September 22.'))
  const other = await saveChatAttachment(paths, 'other.txt', Buffer.from('A different chat has unrelated data.'))
  await appendBotTurn(paths, 'first', { role: 'user', text: 'Read my attachment', attachments: [mine.id], at: new Date().toISOString() })
  await appendBotTurn(paths, 'second', { role: 'user', text: 'Read a separate attachment', attachments: [other.id], at: new Date().toISOString() })
  const reloaded = await readBotTranscript(paths, 'first')
  expect(reloaded[0]!.attachments).toEqual([mine.id])
  const ids = chatAttachmentIds(undefined, reloaded)
  expect(ids).toEqual([mine.id])
  const context = await readChatAttachments(paths, ids)
  expect(context.context).toContain('September 22')
  expect(context.context).not.toContain('unrelated data')
  expect(context.paths).toHaveLength(1)
  const history = Array.from({ length: 10 }, (_, index) => ({ role: 'user' as const, text: 'a past turn', attachments: [`old-${index}`] }))
  expect(chatAttachmentIds(['current'], history)).toEqual(['current', 'old-9', 'old-8', 'old-7', 'old-6', 'old-5', 'old-4', 'old-3'])
  expect(chatAttachmentIds(undefined, [{ role: 'assistant', text: 'not user authorization', attachments: [other.id] }])).toEqual([])
  expect(() => chatAttachmentIds([null], history)).toThrow('up to 8')
})

it('marks per-file and aggregate text limits explicitly', async () => {
  const paths = vaultPaths(root)
  const files = []
  for (let i = 0; i < 3; i++) files.push(await saveChatAttachment(paths, `large-${i}.txt`, Buffer.from('x'.repeat(70_000))))
  const read = await readChatAttachments(paths, files.map(file => file.id))
  expect(read.context.length).toBeLessThan(125_000)
  expect(read.context).toContain('Partial extraction')
  expect(read.context).toContain('120,000 characters per turn')
  expect(read.context).toContain('Text omitted because this turn reached its attachment limit')
})

it.each(['rejection', 'event'] as const)('restores an exact draft and attachments after a send %s and retries without duplicate labels', async (mode) => {
  const store = createCometThreads('first')
  const file = { id: 'cached-file', name: 'brief.txt', size: 10 }
  let listener: ((event: EngramEvent) => void) | undefined
  const unsubscribe = vi.fn()
  const api: Pick<EngramApi, 'chatSend' | 'onEvent'> = {
    onEvent: next => { listener = next; return unsubscribe },
    chatSend: vi.fn(async () => {
      if (mode === 'rejection') throw new Error('Connection failed')
      listener?.({ type: 'chat:error', channel: 'bot-first', message: 'Connection failed' })
    }),
  }
  await sendCometMessage(api, store, 'first', 'Read this file.', [file])
  expect(store.thread('first').busy).toBe(false)
  expect(store.thread('first').draft).toBe('Read this file.')
  expect(store.thread('first').attachments).toEqual([file])
  expect(store.thread('first').messages.filter(message => message.error)).toHaveLength(1)
  vi.mocked(api.chatSend).mockResolvedValueOnce()
  await sendCometMessage(api, store, 'first', store.thread('first').draft, store.thread('first').attachments)
  expect(vi.mocked(api.chatSend).mock.calls[1]![0]).toMatchObject({ message: 'Read this file.\n\nAttached: brief.txt', attachments: [file.id] })
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})

it.each(['before', 'after'] as const)('ignores a settled turn’s late rejection %s the next same-chat failure', async (timing) => {
  const store = createCometThreads('first')
  const oldFile = { id: 'old-file', name: 'old.txt', size: 10 }
  const nextFile = { id: 'next-file', name: 'next.txt', size: 10 }
  const listeners = new Set<(event: EngramEvent) => void>()
  const emit = (event: EngramEvent) => { store.handleEvent(event); for (const listener of listeners) listener(event) }
  let rejectOld!: (error: Error) => void
  let resolveNext!: () => void
  const oldRequest = new Promise<void>((_resolve, reject) => { rejectOld = reject })
  const nextRequest = new Promise<void>(resolve => { resolveNext = resolve })
  const api: Pick<EngramApi, 'chatSend' | 'onEvent'> = {
    onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    chatSend: vi.fn().mockReturnValueOnce(oldRequest).mockReturnValueOnce(nextRequest),
  }
  const oldSend = sendCometMessage(api, store, 'first', 'Old completed question', [oldFile])
  emit({ type: 'chat:done', channel: 'bot-first', text: 'Completed answer' })
  const nextSend = sendCometMessage(api, store, 'first', 'New question to restore', [nextFile])
  expect(store.thread('first').busy).toBe(true)
  if (timing === 'before') {
    rejectOld(new Error('Delayed old post-processing failure'))
    await oldSend
    expect(store.thread('first').busy).toBe(true)
    expect(store.thread('first').draft).toBe('')
  }
  emit({ type: 'chat:error', channel: 'bot-first', message: 'New request failed' })
  if (timing === 'after') {
    rejectOld(new Error('Delayed old post-processing failure'))
    await oldSend
  }
  expect(store.thread('first').busy).toBe(false)
  expect(store.thread('first').draft).toBe('New question to restore')
  expect(store.thread('first').attachments).toEqual([nextFile])
  expect(store.thread('first').messages.filter(message => message.error).map(message => message.text)).toEqual(['New request failed'])
  resolveNext()
  await nextSend
  expect(listeners.size).toBe(0)
})

it('rejects unsupported, empty, oversized, malformed and traversing attachments', async () => {
  const paths = vaultPaths(root)
  const file = await saveChatAttachment(paths, 'safe.md', Buffer.from('safe'))
  for (const name of ['../escape.txt', 'bad:stream.txt', 'run.exe']) expect(attachmentError(name, 1)).toBeTruthy()
  expect(attachmentError('empty.txt', 0)).toContain('empty')
  expect(attachmentError('huge.txt', ATTACHMENT_MAX_BYTES + 1)).toContain('20 MB')
  await expect(readChatAttachments(paths, [file.id, file.id])).rejects.toThrow('up to 8')
  await expect(readChatAttachments(paths, Array.from({ length: 9 }, (_, index) => `${index}`))).rejects.toThrow('up to 8')
  await expect(readChatAttachments(paths, [`${file.id}/../../safe.md`])).rejects.toThrow('Invalid chat attachment')
  await expect(readChatAttachments(paths, [null])).rejects.toThrow('Invalid chat attachment')
  await expect(saveChatAttachment(paths, 'bad.png', Buffer.from('invalid image'))).rejects.toThrow('image could not be read')
  await expect(readChatAttachments(paths, [file.id], AbortSignal.abort())).rejects.toThrow()
})

it.skipIf(process.platform === 'win32')('rejects an attachment symlink pointing outside the chat cache', async () => {
  const paths = vaultPaths(root)
  const file = await saveChatAttachment(paths, 'safe.txt', Buffer.from('safe'))
  const outside = join(root, 'private.txt')
  await writeFile(outside, 'must stay private')
  await symlink(outside, join(paths.cache, 'chat-attachments', file.id.replace('safe.txt', 'alias.txt')))
  await expect(readChatAttachments(paths, [file.id.replace('safe.txt', 'alias.txt')])).rejects.toThrow('outside this chat cache')
})

it('sends only explicitly attached image bytes through rich tools and provides native image paths', async () => {
  const paths = vaultPaths(root)
  const image = await saveChatAttachment(paths, 'chart.png', Buffer.from('valid image'))
  const read = await readChatAttachments(paths, [image.id])
  expect(read.imagePaths).toEqual(read.paths)
  expect(read.context).toContain(image.id)
  const tool = read.tools[0]!
  expect(await tool.runRich!({ id: image.id }, { task: 'Read the chart' })).toEqual({ text: expect.stringContaining('chart.png'), image: { mimeType: 'image/png', data: Buffer.from('valid image').toString('base64') } })
  await expect(tool.runRich!({ id: 'unattached' }, { task: 'Read the chart' })).rejects.toThrow('attached to this message')
})

it('keeps attachment context and native images in both normal and fallback model requests', async () => {
  const paths = vaultPaths(root)
  const file = await saveChatAttachment(paths, 'long.txt', Buffer.from(`${'reference '.repeat(1000)}Attachment end: September 22.`))
  const read = await readChatAttachments(paths, [file.id])
  const jobs: EngineJobInput[] = []
  const engine: Engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), run: async function* (job) {
    jobs.push(job)
    yield { type: 'result', text: '{"answer":"September 22."}' }
  } }
  const imagePaths = [join(paths.cache, 'chat-attachments', 'approved-image.png')]
  for (const maxCalls of [0, 1]) {
    await runComet({ engine, workdir: engineCwd(paths), tools: [], imagePaths }, 'What is the delivery date?', { maxCalls, guided: false, attachmentContext: read.context })
  }
  expect(jobs.length).toBeGreaterThanOrEqual(2)
  for (const job of jobs) {
    expect(job.prompt).toContain('What is the delivery date?')
    expect(job.prompt).toContain('Attachment end: September 22.')
    expect(job.imagePaths).toEqual(imagePaths)
  }
})

it('copies through native clipboard and restricts attachment/copy IPC to the main frame', async () => {
  registerChatAttachmentIpc(vaultPaths(root))
  const event = { sender: state.owner.webContents, senderFrame: state.owner.webContents.mainFrame }
  const copy = state.handlers.get('clipboard:writeText')!
  copy(event, 'if ready:\n    run()\n')
  expect(state.clipboard).toHaveBeenCalledExactlyOnceWith('if ready:\n    run()\n')
  expect(() => copy(event, null)).toThrow('too large')
  expect(() => copy(event, 'x'.repeat(2_000_001))).toThrow('too large')
  for (const name of ['clipboard:writeText', 'chat:attach']) {
    expect(() => state.handlers.get(name)!({ ...event, senderFrame: {} }, 'input.txt', Buffer.from('safe'))).toThrow('main window')
    expect(() => state.handlers.get(name)!({ ...event, sender: { mainFrame: event.senderFrame } }, 'input.txt', Buffer.from('safe'))).toThrow('main window')
  }
  expect(await state.handlers.get('chat:attach')!(event, 'input.txt', Buffer.from('safe'))).toMatchObject({ name: 'input.txt', size: 4 })
})
