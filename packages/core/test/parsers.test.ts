import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { chatToMarkdown, normalizeCapture, parseChatPaste } from '../src/parsers.js'

const FIXTURES = fileURLToPath(new URL('../../../fixtures/chat/', import.meta.url))
const load = (name: string) => readFile(new URL(name, `file://${FIXTURES}`), 'utf8')

describe('chat paste parsers (golden)', () => {
  it('parses a Slack paste, keeping speaker and time', async () => {
    const parsed = parseChatPaste(await load('slack.txt'))
    expect(parsed.kind).toBe('slack')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0]).toMatchObject({ speaker: 'Jimin Park', time: '10:24 AM' })
    expect(parsed.messages[1]!.text).toContain('QA는 목요일까지')
    expect(parsed.messages[1]!.text).toContain('스테이징은 오늘 오후에') // multi-line body preserved
  })

  it('parses a KakaoTalk PC export with dates', async () => {
    const parsed = parseChatPaste(await load('kakao-pc.txt'))
    expect(parsed.kind).toBe('kakao')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[0]).toMatchObject({ speaker: '박지민', time: '2026년 7월 1일 오후 3:12' })
    expect(parsed.messages[2]!.text).toContain('B동')
  })

  it('parses a KakaoTalk mobile export', async () => {
    const parsed = parseChatPaste(await load('kakao-mobile.txt'))
    expect(parsed.kind).toBe('kakao')
    expect(parsed.messages).toHaveLength(3)
    expect(parsed.messages[1]).toMatchObject({ speaker: '김알렉스', time: '오후 3:14' })
  })

  it('renders markdown that keeps the conversation structure', async () => {
    const raw = await load('slack.txt')
    const md = chatToMarkdown(parseChatPaste(raw), raw)
    expect(md).toContain('# Slack conversation')
    expect(md).toContain('- **Jimin Park** (10:24 AM):')
  })

  it('leaves ordinary prose untouched', () => {
    const prose = '오늘 회의에서 배포일을 금요일로 정했다.\n담당은 지민.'
    expect(parseChatPaste(prose).kind).toBe('plain')
    expect(normalizeCapture(prose)).toBe(prose)
  })
})
