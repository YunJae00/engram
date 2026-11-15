import { describe, expect, it, vi } from 'vitest'
import { navigationTools } from '../src/comet-navigation-tools.js'
import type { CometToolDeps } from '../src/comet-tools.js'
import { desktopTools } from '../src/desktop-tools.js'
import { quietDesktopTools, type QuietCourier } from '../src/desktop-quiet-tools.js'
import { pressCommits } from '../src/press-guard.js'
import { localPageUrl, requireNoLocalPage } from '../src/tool-args.js'

// qa143 B13: a local form was refused by the in-app browser, so the bot drove the real Safari and the only gate
// reached was the address bar's Enter.
const FORM = 'file:///Users/someone/qa/form.html'
const SNAPSHOT = 'a'.repeat(32)

describe('local pages', () => {
  it('names a local HTML file by its file address, and nothing else', () => {
    expect(localPageUrl(FORM)).toBe(FORM)
    expect(localPageUrl('/Users/someone/qa/form.html')).toBe(FORM)
    expect(localPageUrl('/Users/someone/내 문서/문의 폼.htm')).toBe(`file:///Users/someone/${encodeURI('내 문서/문의 폼.htm')}`)
    expect(localPageUrl('C:\\qa\\form.html')).toBe('file:///C:/qa/form.html')
    for (const other of ['https://example.com/form.html', 'file:///etc/passwd', 'file://fileserver/share/form.html', '/Users/someone/.ssh/id_rsa', 'form.html', '']) expect(localPageUrl(other)).toBeNull()
  })

  it.each([FORM, '/Users/someone/qa/form.html'])('open_page opens %s in the in-app browser', async (asked) => {
    const page = { url: FORM, title: '사내 문의 접수', text: '사내 문의 접수 (QA 로컬 폼)', controls: ['#1 [input:text] 이름', '#2 [textarea] 메시지', '#3 [button] 문의 보내기'] }
    const fetchPage = vi.fn(async () => page)
    const open = navigationTools({ courier: { fetchPage }, guided: false } as unknown as CometToolDeps).find(tool => tool.name === 'open_page')!
    const report = await open.run({ url: asked }, { task: '폼 열어줘' })
    expect(fetchPage).toHaveBeenCalledWith(FORM, undefined)
    expect(report).toContain('문의 보내기')
    expect(report).not.toMatch(/needs a full web address/)
  })

  it('open_page fails closed on a local file that is not a page or does not open', async () => {
    const fetchPage = vi.fn(async () => { throw new Error('net::ERR_FILE_NOT_FOUND') })
    const open = navigationTools({ courier: { fetchPage }, guided: false } as unknown as CometToolDeps).find(tool => tool.name === 'open_page')!
    expect(await open.run({ url: 'file:///etc/passwd' }, { task: 'open' })).toMatch(/not opened in a browser, here or in another app/)
    expect(fetchPage).not.toHaveBeenCalled()
    expect(await open.run({ url: FORM }, { task: 'open' })).toMatch(/do not open it in another app or an external browser/)
    expect(fetchPage).toHaveBeenCalledOnce()
  })

  it('never types a local file address into another app', async () => {
    for (const text of [FORM, ' file:///etc/passwd', '/Users/someone/qa/form.html']) expect(() => requireNoLocalPage(text)).toThrow(/open_page/)
    for (const text of ['문의 테스트입니다', '/Users/someone/Documents', 'see https://example.com/form.html']) expect(() => requireNoLocalPage(text)).not.toThrow()
    const courier: QuietCourier = { scan: vi.fn(async () => '{}'), set: vi.fn(async () => '{"landed":true}'), press: vi.fn(async () => '{}'), text: vi.fn(async () => '{}') }
    const set = quietDesktopTools(courier).find(tool => tool.name === 'app_set')!
    await expect(set.run({ app: 'Safari', snapshot: SNAPSHOT, control: 'c63', text: FORM }, { task: 'open the form' })).rejects.toThrow(/external browser/)
    expect(courier.set).not.toHaveBeenCalled()
    // qa143 p2 r10 (B13): a home path standing alone passed the default mode, so the text fields could type it into another app.
    for (const text of ['~/qa/form.html', ' ~/qa/contact form.htm ', '~someone/qa/form.xhtml', '~\\qa\\form.html', '~/qa/form.html?name=a#top']) expect(() => requireNoLocalPage(text), text).toThrow(/open_page/)
    for (const text of ['~/Documents', '~/qa/form.html.txt', '~form.html', '~', 'about ~5 pages of form.html', 'https://example.com/~someone/form.html']) expect(() => requireNoLocalPage(text), text).not.toThrow()
    await expect(set.run({ app: 'Safari', snapshot: SNAPSHOT, control: 'c63', text: '~/qa/form.html' }, { task: 'open the form' })).rejects.toThrow(/external browser/)
    expect(courier.set).not.toHaveBeenCalled()
    const act = vi.fn(async () => '{}')
    const action = desktopTools({ observe: async () => '{}', act, sequence: async () => '{}' } as never).find(tool => tool.name === 'desktop_action')!
    await expect(action.run({ kind: 'type', snapshot: SNAPSHOT, text: FORM }, { task: 'open the form' })).rejects.toThrow(/external browser/)
    await expect(action.run({ kind: 'type', snapshot: SNAPSHOT, text: '~/qa/form.html' }, { task: 'open the form' })).rejects.toThrow(/external browser/)
    expect(act).not.toHaveBeenCalled()
  })

  // qa143 p2 r8 (B13): app_do fenced only its text; the goal went to the decision model unchecked.
  it('never takes a goal that puts a local file address into another app', async () => {
    const refused = ['Type file:///tmp/form.html in the address bar and open it', 'Open "file://localhost/tmp/form.html" in Safari', 'Go to /Users/someone/qa/form.html and press Enter', 'Enter ~/qa/contact form.htm in the address bar', 'Type C:\\qa\\form.html into the address bar', 'open FILE:/etc/passwd', 'Enter ~someone/qa/form.html in the address bar']
    const allowed = ['Open the Downloads folder and select form.html', 'Open https://example.com/qa/form.html in a new tab', 'Rename the file: report', 'Open /Users/someone/Documents', '문의 양식에 이름을 입력']
    for (const goal of refused) expect(() => requireNoLocalPage(goal, true), goal).toThrow(/open_page/)
    for (const goal of allowed) expect(() => requireNoLocalPage(goal, true), goal).not.toThrow()
    const run = vi.fn(async () => '{"status":"done"}')
    const courier: QuietCourier = { scan: vi.fn(async () => '{}'), set: vi.fn(async () => '{}'), press: vi.fn(async () => '{}'), text: vi.fn(async () => '{}'), do: run }
    const tool = quietDesktopTools(courier).find(tool => tool.name === 'app_do')!
    // Whatever the browser mode: the fence is not read from the environment.
    for (const env of [{}, { ENGRAM_HIDDEN: '1' }, { ENGRAM_BROWSER_EXTERNAL: '1' }]) {
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
      for (const goal of refused) await expect(tool.run({ app: 'Safari', goal }, { task: 'open the form' }), goal).rejects.toThrow(/external browser/)
      await expect(tool.run({ app: 'Safari', goal: 'Fill the address bar', text: FORM }, { task: 'open the form' })).rejects.toThrow(/external browser/)
      vi.unstubAllEnvs()
    }
    expect(run).not.toHaveBeenCalled()
    await tool.run({ app: 'Safari', goal: allowed[1]! }, { task: 'open the page' })
    expect(run).toHaveBeenCalledOnce()
  })

  it('holds the form\'s own submit for approval', () => {
    expect(pressCommits({ role: 'button', submits: true, posts: false, words: '문의 보내기' })).toBe(true)
  })
})
