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
    const act = vi.fn(async () => '{}')
    const action = desktopTools({ observe: async () => '{}', act, sequence: async () => '{}' } as never).find(tool => tool.name === 'desktop_action')!
    await expect(action.run({ kind: 'type', snapshot: SNAPSHOT, text: FORM }, { task: 'open the form' })).rejects.toThrow(/external browser/)
    expect(act).not.toHaveBeenCalled()
  })

  it('holds the form\'s own submit for approval', () => {
    expect(pressCommits({ role: 'button', submits: true, posts: false, words: '문의 보내기' })).toBe(true)
  })
})
