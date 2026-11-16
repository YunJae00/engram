import { expect, it, vi } from 'vitest'
import type { AgentTool } from 'core'
import { desktopOptIn, type DesktopActionContext } from '../src/main/desktop-opt-in.js'
import { appGateTitle, commandGate } from '../src/renderer/src/lib/threadLang.js'

function fixture() {
  let enabled = false
  const run = vi.fn(async () => 'App text')
  const rich = vi.fn(async () => ({ text: 'App image' }))
  const tool: AgentTool = { name: 'read_desktop', description: 'Read app', argsSchema: {}, run, runRich: rich }
  const consent = { enabled: vi.fn(async () => enabled), enable: vi.fn(async () => { enabled = true }), ask: vi.fn(async () => 'approve' as 'approve' | 'cancel' | 'later') }
  return { tools: desktopOptIn([tool], consent), consent, run, rich }
}
it('asks before any desktop read, then reuses explicit consent for rich and text calls', async () => {
  const f = fixture()
  await expect(f.tools[0]!.run({}, { task: 'Find my app session' })).resolves.toBe('App text')
  await f.tools[0]!.runRich!({}, { task: 'Find my app session' })
  expect(f.consent.ask).toHaveBeenCalledTimes(1)
  expect(f.consent.enable).toHaveBeenCalledOnce()
  expect(f.consent.ask.mock.calls[0]?.[0]).toMatchObject({ url: 'engram://settings/computer-use' })
  expect(f.rich).toHaveBeenCalledOnce()
})
it.each(['cancel', 'later'] as const)('never reads, opens or enables apps after %s and does not repeat the card', async answer => {
  const f = fixture(); f.consent.ask.mockResolvedValue(answer)
  await expect(f.tools[0]!.run({}, { task: 'Find session' })).rejects.toThrow('not approved')
  await expect(f.tools[0]!.runRich!({}, { task: 'Find session' })).rejects.toThrow('App control is off')
  expect(f.consent.ask).toHaveBeenCalledOnce()
  expect(f.consent.enable).not.toHaveBeenCalled()
  expect(f.run).not.toHaveBeenCalled(); expect(f.rich).not.toHaveBeenCalled()
})
it('does not grant control after Stop while approval is pending', async () => {
  const f = fixture(); const abort = new AbortController()
  f.consent.ask.mockImplementation(async () => { abort.abort(); return 'approve' })
  await expect(f.tools[0]!.run({}, { task: 'Find session', signal: abort.signal })).rejects.toThrow()
  expect(f.consent.enable).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
})
it('does not access apps without an approval route and checks revocation on every call', async () => {
  const run = vi.fn(async () => 'text')
  let enabled = true
  const [tool] = desktopOptIn([{ name: 'list_apps', description: '', argsSchema: {}, run }], { enabled: async () => enabled, enable: vi.fn() })
  await tool!.run({}, { task: 'Find app' })
  enabled = false
  await expect(tool!.run({}, { task: 'Find app' })).rejects.toThrow('Control apps in Settings')
  expect(run).toHaveBeenCalledOnce()
})

it('uses a separate one-shot structured approval for consequential actions while reads remain allowed', async () => {
  const ask = vi.fn(async () => 'approve' as const)
  let delivered = 0
  const tool: AgentTool = { name: 'app_press', description: '', argsSchema: {}, run: async (_args, context) => {
    if (await (context as import('../src/main/desktop-opt-in.js').DesktopActionContext).approveAppAction?.('Fixture', 'Send', 'observed-snapshot', 'private-scope-hash')) delivered++
    return 'checked'
  } }
  const [wrapped] = desktopOptIn([tool], { enabled: async () => true, enable: vi.fn(), ask })
  await wrapped!.run({}, { task: 'Read only' })
  await wrapped!.run({}, { task: 'Send if approved' })
  expect(ask).toHaveBeenCalledTimes(2)
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ url: 'engram://app/Fixture#Send', scope: 'private-scope-hash' }))
  expect(delivered).toBe(2)
})

it('never delivers after Stop while a consequential approval is pending', async () => {
  const abort = new AbortController(), delivered = vi.fn()
  const tool: AgentTool = { name: 'app_press', description: '', argsSchema: {}, run: async (_args, context) => {
    if (await (context as import('../src/main/desktop-opt-in.js').DesktopActionContext).approveAppAction?.('Fixture', 'Send', 'observed-snapshot')) delivered()
    return 'checked'
  } }
  const [wrapped] = desktopOptIn([tool], { enabled: async () => true, enable: vi.fn(), ask: async () => { abort.abort(); return 'approve' } })
  await expect(wrapped!.run({}, { task: 'Send if approved', signal: abort.signal })).rejects.toThrow()
  expect(delivered).not.toHaveBeenCalled()
})

// qa142 B13: the send gate said `Allow "Send" in "window:85669:0"?` in a Korean thread, and after "no" the bot asked for computer control to do the same thing.
function gated(answers: ('approve' | 'cancel')[]) {
  const ask = vi.fn<(what: { words: string; url: string }) => Promise<'approve' | 'cancel'>>(async () => answers.shift() ?? 'cancel')
  const seen: boolean[] = []
  const tool: AgentTool = { name: 'app_press', description: '', argsSchema: {}, run: async (args, context) => {
    const c = context as DesktopActionContext
    seen.push(args['hands'] ? !!await c.approveComputerControl?.('bot-1') : !!await c.approveAppAction?.('window:85669:0', 'Send', 'snap', undefined, { app: 'Safari', sending: 'file:///tmp/form.html' }))
    return ''
  } }
  return { tool: desktopOptIn([tool], { enabled: async () => true, enable: vi.fn(), ask })[0]!, ask, seen }
}
it('words the send gate with the app name and what is being sent, keyed by the same app and control', async () => {
  const g = gated(['approve'])
  await g.tool.run({}, { task: 'Submit the form' })
  const asked = g.ask.mock.calls[0]![0]
  expect(asked.url).toBe('engram://app/window%3A85669%3A0#Send')
  expect(asked.words).toBe('Allow "Send" in "Safari"? Sending: file:///tmp/form.html. This may send or change data.')
  const card = appGateTitle(asked.words.slice(0, 120), 'ko')!
  expect(card).toBe('Safari에서 보내기(Enter)를 진행할까요? 보낼 내용: “file:///tmp/form.html”')
  expect(card).not.toMatch(/window:|Allow|Send/)
  expect(appGateTitle('Allow "Send" in "window:85669:0"? This may send or change data.', 'ko')).toBe('이 앱에서 보내기(Enter)를 진행할까요? 내용이 전송되거나 바뀔 수 있어요.')
  expect(appGateTitle('Run this command outside the sandbox?', 'ko')).toBeNull()
  expect(g.seen).toEqual([true])
})
it('does not ask for computer control after the person declined an action in the same turn', async () => {
  const g = gated(['cancel', 'approve'])
  await g.tool.run({}, { task: 'Submit the form' })
  await g.tool.run({ hands: true }, { task: 'Submit the form' })
  expect(g.seen).toEqual([false, false])
  expect(g.ask).toHaveBeenCalledTimes(1)
})
it('still asks for computer control when nothing was declined', async () => {
  const g = gated(['approve'])
  await g.tool.run({ hands: true }, { task: 'Type the note' })
  expect(g.seen).toEqual([true])
  expect(g.ask.mock.calls[0]![0].url).toBe('engram://computer-control/bot-1')
})

it('a command approval card asks once in the conversation language and keeps the whole command', () => {
  const long = `${'echo safe; '.repeat(30)}rm report.txt`
  expect(commandGate(`Run this command outside the sandbox?\n${long}`, 'ko')).toEqual({ title: '제 작업 폴더 밖에서 해야 하는 일이에요. 실행해도 될까요?', body: long })
  expect(commandGate('Run this command outside the sandbox?\nls\npwd', 'en')).toEqual({ title: 'Run this command outside the sandbox?', body: 'ls\npwd' })
  expect(commandGate('Run this command? pwd && ls', 'ko')).toEqual({ title: '이 명령을 실행할까요?', body: 'pwd && ls' })
  // A command that quotes the question is still shown whole.
  expect(commandGate('Run this command? echo "x: Run this command outside the sandbox?"', 'ko').body).toBe('echo "x: Run this command outside the sandbox?"')
  expect(commandGate('Researcher: Run this command outside the sandbox?\ncurl example.com', 'ko')).toEqual({ title: 'Researcher: 제 작업 폴더 밖에서 해야 하는 일이에요. 실행해도 될까요?', body: 'curl example.com' })
  const open = commandGate('Allow commands for this comet? They can read or change any accessible file and use the network; not sandboxed.', 'ko')
  expect(open.title).toBe('이 봇이 명령을 실행해도 될까요?')
  expect(open.body).toContain('보호 장치 없이')
  expect(commandGate('Allow commands for this comet? They can read files; writes stay in the task folder and network access is blocked.', 'ko').body).toContain('작업 폴더 안에서만')
  expect(commandGate('이 파일을 읽어도 될까요? 내용이 연결된 AI에 전달돼요. 원본 파일은 바뀌지 않아요.\n/tmp/a.txt', 'ko')).toEqual({ title: '이 파일을 읽어도 될까요? 내용이 연결된 AI에 전달돼요. 원본 파일은 바뀌지 않아요.', body: '/tmp/a.txt' })
  expect(commandGate('Something else', 'ko')).toEqual({ title: 'Something else', body: '' })
})
