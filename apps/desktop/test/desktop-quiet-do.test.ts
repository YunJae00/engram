import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuietControlDto, QuietObservationDto } from '../src/shared/desktop.js'

const fake = vi.hoisted(() => ({ scan: vi.fn(), set: vi.fn(), press: vi.fn(), flog: vi.fn() }))
vi.mock('../src/main/desktop-quiet.js', () => ({ quietScan: fake.scan, quietSet: fake.set, quietPress: fake.press }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.flog }))
vi.mock('../src/main/decision-provider.js', () => ({ decideChoice: vi.fn() }))
import { buildOptions, formatDo, irreversibleName, quietDo } from '../src/main/desktop-quiet-do.js'

const control = (id: string, name: string, over: Partial<QuietControlDto> = {}): QuietControlDto => ({
  id, type: 'Button', name, value: null, placeholder: null, can: { set: false, press: true, text: false }, enabled: true, offscreen: false, focused: false, secret: false, ...over,
})
const composer = control('c9', 'Prompt', { type: 'Edit', can: { set: true, press: false, text: true }, placeholder: 'Prompt' })
const screen = (controls: QuietControlDto[], texts: string[], snapshot = 'a'.repeat(32)): QuietObservationDto => ({
  window: '7', pid: 70, title: 'Claude', snapshot, controls, texts: texts.map((text, index) => ({ id: `t${index}`, text })), skippedControls: 0, skippedTexts: 0, ms: 50,
  state: { foreground: false, idleMs: 9000, minimized: false },
})
const request = { lane: 'bot-one', app: 'Claude', goal: 'Start a new chat and ask about the mail', text: 'What did the mail say?', maxSteps: 8 }
const decided = (choice: string, confidence = 0.9) => async () => ({ choice, confidence, probabilities: { [choice]: confidence }, ms: 120 })

beforeEach(() => {
  vi.clearAllMocks()
  fake.set.mockResolvedValue({ landed: true, exact: true, value: request.text, ms: 300, control: 'c9' })
  fake.press.mockResolvedValue({ pressed: 'invoke', control: 'c1' })
})

describe('a short goal run by a decision model', () => {
  it('offers the model only controls it can act on, done and blocked', () => {
    const { criteria, controls } = buildOptions(screen([control('c1', 'New chat'), control('c2', 'Hidden', { offscreen: true }), control('c3', 'Off', { enabled: false }), composer, control('c4', 'Password', { secret: true })], []), true)
    expect(Object.keys(criteria)).toEqual(['done', 'blocked', 'set c9', 'press c1'])
    expect(criteria['press c1']).toContain('"New chat"')
    expect(controls.get('set c9')?.id).toBe('c9')
    expect(Object.keys(buildOptions(screen([composer], []), false).criteria)).toEqual(['done', 'blocked'])
  })

  it('sets the text, presses what the model picks, and stops when the screen shows the goal met', async () => {
    fake.scan.mockResolvedValueOnce(screen([control('c1', 'New chat'), composer], ['Welcome']))
      .mockResolvedValueOnce(screen([control('c1', 'New chat'), composer], ['New conversation'], 'b'.repeat(32)))
      .mockResolvedValueOnce(screen([control('c1', 'New chat'), { ...composer, value: request.text }], ['New conversation'], 'c'.repeat(32)))
    const decide = vi.fn().mockImplementationOnce(decided('press c1')).mockImplementationOnce(decided('set c9')).mockImplementationOnce(decided('done'))
    const result = await quietDo(request, decide)
    expect(result.status).toBe('done')
    expect(result.steps.map(step => step.action)).toEqual(['press c1', 'set c9', 'done'])
    expect(fake.press).toHaveBeenCalledWith('bot-one', 'Claude', 'a'.repeat(32), 'c1', expect.any(AbortSignal))
    expect(fake.set).toHaveBeenCalledWith('bot-one', 'Claude', 'b'.repeat(32), 'c9', request.text, undefined, expect.any(AbortSignal))
    expect(decide.mock.calls[1]![0]).toContain('1. press c1 "New chat" -> pressed (invoke)')
    expect(result.pressed).toBe(true)
    expect(JSON.parse(formatDo(result))).toMatchObject({ status: 'done', requiresVerification: true })
  })

  it('leaves recognized irreversible controls for a separate explicitly requested action', async () => {
    fake.scan.mockResolvedValue(screen([control('c5', '보내기'), composer], ['draft']))
    const stopped = await quietDo(request, vi.fn().mockImplementation(decided('press c5')))
    expect(stopped.status).toBe('needs-person')
    expect(fake.press).not.toHaveBeenCalled()
    expect(JSON.parse(formatDo(stopped)).steps[0].outcome).toContain('irreversible')
    fake.scan.mockResolvedValueOnce(screen([control('c5', 'Send'), composer], ['draft'])).mockResolvedValueOnce(screen([composer], ['sent'], 'd'.repeat(32)))
    const allowed = await quietDo({ ...request, goal: 'Send the message' }, vi.fn().mockImplementationOnce(decided('press c5')).mockImplementationOnce(decided('done')))
    expect(allowed.status).toBe('needs-person')
    expect(fake.press).not.toHaveBeenCalled()
    expect(irreversibleName('Submit form')).toBe(true)
    expect(irreversibleName('Save changes')).toBe(true)
    expect(irreversibleName('Apply')).toBe(true)
    expect(irreversibleName('저장')).toBe(true)
    expect(irreversibleName('New chat')).toBe(false)
  })

  it('stops when unsure, when the screen stops changing, and at the step limit', async () => {
    fake.scan.mockResolvedValue(screen([control('c1', 'Next'), composer], ['same']))
    expect((await quietDo(request, vi.fn().mockImplementation(decided('press c1', 0.2)))).status).toBe('unsure')
    const looping = await quietDo(request, vi.fn().mockImplementation(decided('press c1')))
    expect(looping.status).toBe('blocked')
    expect(looping.steps.at(-1)!.outcome).toContain('has not changed')
    let serial = 0
    fake.scan.mockImplementation(async () => screen([control('c1', 'Next'), composer], [`page ${++serial}`], serial.toString(16).padStart(32, '0')))
    const exhausted = await quietDo({ ...request, maxSteps: 3 }, vi.fn().mockImplementation(decided('press c1')))
    expect(exhausted.status).toBe('steps-exhausted')
    expect(exhausted.steps).toHaveLength(3)
    const failing = await quietDo(request, vi.fn().mockRejectedValue(new Error('The decision endpoint is rate limited right now.')))
    expect(failing.status).toBe('blocked')
    expect(failing.steps[0]!.outcome).toContain('rate limited')
  })
  it('stops at an uncertain mutation rather than sending or trying it again', async () => {
    fake.scan.mockResolvedValue(screen([composer, control('c1', 'Next')], ['draft']))
    fake.set.mockResolvedValueOnce({ landed: true, exact: false, value: 'someone else added text' })
    const decide = vi.fn().mockImplementationOnce(decided('set c9')).mockImplementation(decided('press c1'))
    expect((await quietDo(request, decide)).status).toBe('blocked')
    expect(fake.press).not.toHaveBeenCalled()
    expect(decide).toHaveBeenCalledTimes(1)
    fake.press.mockRejectedValueOnce(new Error('Receipt timed out after dispatch'))
    expect((await quietDo(request, vi.fn().mockImplementation(decided('press c1')))).status).toBe('blocked')
    expect(fake.press).toHaveBeenCalledTimes(1)
  })
  it('does not act after cancellation or a low-confidence done verdict', async () => {
    fake.scan.mockResolvedValue(screen([control('c1', 'Next')], ['draft']))
    expect((await quietDo(request, vi.fn().mockImplementation(decided('done', 0.1)))).status).toBe('unsure')
    const abort = new AbortController()
    await expect(quietDo({ ...request, signal: abort.signal }, async () => { abort.abort(); return decided('press c1')() })).rejects.toThrow()
    expect(fake.press).not.toHaveBeenCalled()
  })
})
