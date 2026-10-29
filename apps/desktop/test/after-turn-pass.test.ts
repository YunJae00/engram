import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ studies: [] as { ask: string; what: string }[], broadcast: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/comet-checkpoint.js', () => ({ changeCheckpoint: vi.fn(async () => undefined) }))
vi.mock('core', async (original) => ({
  ...await original<typeof import('core')>(),
  readBotTranscript: vi.fn(async () => [{ role: 'assistant', text: 'earlier' }]),
  changeStudies: async (_paths: unknown, change: (list: { ask: string; what: string }[]) => { ask: string; what: string }[]) => { fake.studies = change(fake.studies) },
}))

const { registerStudyIpc } = await import('../src/main/study-ipc.js')
const { offeredIn } = await import('../src/main/turn-state.js')
const { readBotTranscript } = await import('core')

const undone = async () => '{"left":[],"done":false,"only_person":false,"blocked":"날짜를 고르지 못함"}'
const turn = (asked: string, voice = undone) => ({ channel: 'bot-b1', botId: 'b1', asked, answer: '날짜를 고르지 못해 신청하지 못했어요.', incomplete: '날짜를 고르지 못함', handed: [], signal: new AbortController().signal, voice })

beforeEach(() => { fake.studies = []; offeredIn.clear() })

it('does not ask a judge to invent more work after a completed request', async () => {
  const voice = vi.fn(undone)
  const sendQuiet = vi.fn(async () => undefined)
  const { checkAfterTurn } = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop: () => undefined })
  checkAfterTurn({ ...turn('Read the mail', voice), incomplete: undefined, answer: 'Summary.\n```replies\nDraft a reply\n```' })
  await new Promise(resolve => setTimeout(resolve, 10))
  expect(voice).not.toHaveBeenCalled()
  expect(sendQuiet).not.toHaveBeenCalled()
})

it('does not start another pass when stopped while loading history', async () => {
  const input = turn('Read the report')
  const controller = new AbortController()
  input.signal = controller.signal
  vi.mocked(readBotTranscript).mockImplementationOnce(async () => { controller.abort(); return [] })
  const sendQuiet = vi.fn(async () => undefined)
  const { checkAfterTurn } = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop: () => undefined })
  checkAfterTurn(input)
  await vi.waitFor(() => expect(controller.signal.aborted).toBe(true))
  expect(sendQuiet).not.toHaveBeenCalled()
})

it('sends an undone job on once more, then offers another way when that pass is undone too', async () => {
  const sendQuiet = vi.fn(async () => undefined)
  const { checkAfterTurn } = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop: () => undefined })
  checkAfterTurn(turn('H-Link에서 연차 신청해줘'))
  await vi.waitFor(() => expect(sendQuiet).toHaveBeenCalledTimes(1))
  const pass = (sendQuiet.mock.calls[0] as unknown as [{ message: string; history: unknown[] }])[0]
  expect(pass.message).toContain('Request: H-Link에서 연차 신청해줘')
  expect(pass.message).toContain('날짜를 고르지 못함')
  expect(pass.history).toEqual([{ role: 'assistant', text: 'earlier' }])
  expect(fake.studies).toEqual([])

  checkAfterTurn(turn(pass.message))
  await vi.waitFor(() => expect(fake.studies).toHaveLength(1))
  expect(fake.studies[0]).toMatchObject({ ask: 'H-Link에서 연차 신청해줘', what: '날짜를 고르지 못함' })
  expect(sendQuiet).toHaveBeenCalledTimes(1)
})

it('offers another way at once when the conversation is busy, and leaves a done or person-only job alone', async () => {
  const sendQuiet = vi.fn(async () => undefined)
  const { checkAfterTurn } = registerStudyIpc({ paths: {} as never, busy: () => true, sendQuiet, stop: () => undefined })
  checkAfterTurn(turn('팀 TMS 정리해줘'))
  await vi.waitFor(() => expect(fake.studies).toHaveLength(1))
  expect(sendQuiet).not.toHaveBeenCalled()

  fake.studies = []
  offeredIn.clear()
  const idle = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop: () => undefined })
  idle.checkAfterTurn(turn('로그인 해줘', async () => '{"left":[],"done":false,"only_person":true,"blocked":"로그인 필요"}'))
  idle.checkAfterTurn(turn('날씨 알려줘', async () => '{"left":[],"done":true}'))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(sendQuiet).not.toHaveBeenCalled()
  expect(fake.studies).toEqual([])
})

it('treats a later message as new work even when a pass never came back', async () => {
  const sendQuiet = vi.fn(async () => { throw new Error('This conversation is still working.') })
  const { checkAfterTurn } = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop: () => undefined })
  checkAfterTurn(turn('첫 번째 일'))
  await vi.waitFor(() => expect(sendQuiet).toHaveBeenCalledTimes(1))
  checkAfterTurn(turn('두 번째 일'))
  await vi.waitFor(() => expect(sendQuiet).toHaveBeenCalledTimes(2))
  expect((sendQuiet.mock.calls[1] as unknown as [{ message: string }])[0].message).toContain('Request: 두 번째 일')
})

it('gives way the moment the person writes while the extra pass runs', async () => {
  let finish!: () => void
  const sendQuiet = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const stop = vi.fn(() => finish())
  const { checkAfterTurn, yieldPass } = registerStudyIpc({ paths: {} as never, busy: () => false, sendQuiet, stop })
  checkAfterTurn(turn('Workday 연차 확인'))
  await vi.waitFor(() => expect(sendQuiet).toHaveBeenCalledTimes(1))
  expect(fake.broadcast).toHaveBeenCalledWith({ type: 'comet:continue', channel: 'bot-b1', botId: 'b1' })
  await yieldPass('bot-b1')
  expect(stop).toHaveBeenCalledWith('bot-b1')
  await yieldPass('bot-b1')
  expect(stop).toHaveBeenCalledTimes(1)
  checkAfterTurn(turn('다른 일'))
  await vi.waitFor(() => expect(sendQuiet).toHaveBeenCalledTimes(2))
})
