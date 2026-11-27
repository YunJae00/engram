import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { COLLEAGUE_RULE } from '../../../packages/core/src/prompt.js'
import { openRuleLines } from '../../../packages/core/test/rules.js'
import { SAFETY_LINE } from '../src/main/first-line.js'
import { quickPrompt } from './ack-prompt.js'
import { errorLine } from '../src/renderer/src/components/ErrorAnswer.js'
import { teamKo } from '../src/renderer/src/i18n-ko-team.js'
import { pendingStatus, stepLabel, workLabel } from '../src/renderer/src/lib/pendingStatus.js'
import { displayTaskAnswer, threadT } from '../src/renderer/src/lib/threadLang.js'
import { GROUP_KO, KO, KO_STOP, KO_WORDS, WORK_KO } from '../src/renderer/src/lib/threadLangKo.js'

(globalThis as { window?: unknown }).window ??= { engram: {} }
const { CometWork } = await import('../src/renderer/src/components/CometWork.js')

const JARGON: [string, RegExp][] = [
  ['tool name', /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[A-Za-z_$][\w$]*\(\)/],
  ['id', /\b[0-9a-f]{8}-[0-9a-f]{4}-|\b(?:task|bot|lane|channel)[-_:][a-z0-9]/i],
  ['path', /(?:^|[\s"'(])(?:~|\/Users|\/tmp|\/var|[A-Za-z]:\\)[/\\]|\.engram|node_modules/],
  ['raw state', /\b(?:running|idle|queued|exhausted|pending|NONE|null|undefined|NaN)\b|\bHTTP \d{3}\b|\bE[A-Z]{4,}\b/],
  ['model name', /\b(?:claude|gpt|gemini)-[\w.]+|\b(?:sonnet|haiku|opus|fable)\b/i],
  ['dump', /\{\s*"|\bat \S+:\d+:\d+|\b[A-Z][a-z]+Error\b/],
  ['trade word', /에이전트|세션|토큰|프롬프트|런타임|컨텍스트|샌드박스|(?<![가-힣])턴(?![가-힣])|(?<![가-힣])(?:리드|멤버)(?:가|는|를|에게)/],
]
const jargon = (text: string): string[] => JARGON.filter(([, re]) => re.test(text)).map(([kind]) => kind)

function strings(value: unknown, sample: unknown[] = ['보고서.docx', 2]): string[] {
  if (typeof value === 'string') return [value]
  if (typeof value === 'function') { const fn = value as (...args: unknown[]) => unknown; return strings(fn(...sample.slice(0, Math.max(1, fn.length))), sample) }
  if (Array.isArray(value)) return value.flatMap(one => strings(one, sample))
  if (value && typeof value === 'object') return Object.values(value).flatMap(one => strings(one, sample))
  return []
}

function toolNames(): string[] {
  const found = new Set<string>()
  for (const dir of ['packages/core/src', 'apps/desktop/src/main']) for (const file of readdirSync(resolve(dir))) {
    if (!file.endsWith('.ts')) continue
    for (const hit of readFileSync(join(resolve(dir), file), 'utf8').matchAll(/\bname: '([a-z][a-z_]+)'/g)) found.add(hit[1]!)
  }
  return [...found]
}

describe('fixed copy a person reads in a conversation', () => {
  it('has no jargon in any Korean conversation string', () => {
    const tables = { KO, KO_WORDS, WORK_KO, GROUP_KO, KO_STOP, teamKo }
    for (const [table, value] of Object.entries(tables)) for (const text of strings(value)) expect(jargon(text), `${table}: ${text}`).toEqual([])
  })

  it('says every step in plain Korean, also one nobody wrote a line for', () => {
    const t = threadT('ko'), tools = toolNames()
    expect(tools.length).toBeGreaterThan(60)
    for (const tool of [...tools, 'Bash', 'Read', 'Grep', 'Glob', 'made_up_tool']) {
      const arg = /^(Read|Write|Edit|MultiEdit|Glob|Grep|Bash|file_|artifact_read)/.test(tool) ? '/Users/kim/vault/workspace/tasks/bot-ab12cd34/보고서.docx' : '보고서'
      for (const line of [`${tool}: ${arg}`, `${tool}: `]) {
        const status = stepLabel(t, line), group = workLabel(line, 'ko')
        expect(jargon(status), `${tool} → ${status}`).toEqual([])
        expect(status, tool).toMatch(/[가-힣]/)
        expect(status, tool).not.toContain(tool)
        expect(group, `${tool} group`).toMatch(/[가-힣]/)
        expect(group, `${tool} group`).not.toMatch(/[A-Za-z]{4,}/)
      }
    }
    expect(stepLabel(t, 'made_up_tool: x')).toBe('일하는 중')
    expect(pendingStatus(t)).toBe('생각하는 중')
    expect(stepLabel(t, 'search_memory: 민호')).not.toMatch(/기억|메모리/)
  })

  it('turns any failure into one human line that says what to do next', () => {
    const raw = ['API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"model: claude-sonnet-4 not found"}}', 'TypeError: Cannot read properties of undefined (reading \'x\')\n    at run (/Users/kim/app/main.js:12:3)', '[claude] {"type":"error","error":{"message":"overloaded_error"}}', 'ECONNRESET', 'spawn ENOENT', '']
    for (const text of raw) for (const kind of [undefined, 'outage']) {
      const { line } = errorLine(text, kind, 'ko')
      expect(jargon(line), line).toEqual([])
      expect(line).toMatch(/[가-힣]/)
      expect(line).toMatch(/보내 주세요|말씀해 주시면/)
      expect(line.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(2)
      expect(line).not.toMatch(/[A-Za-z]{4,}/)
    }
  })

  it('says a model-facing stop note for the person instead of showing it', () => {
    const stop = 'Not verified as complete.\n\nThe last batch stopped before all pages were read. Inspect the current state and continue only unfinished reads.'
    expect(displayTaskAnswer(`${stop}\n\nUnverified response:\n엔비디아 주가는 162.85달러예요.`, 'ko')).toBe('엔비디아 주가는 162.85달러예요.')
    const shown = displayTaskAnswer(stop, 'ko')
    expect(shown).toContain('몇 군데는 끝까지 읽지 못했어요.')
    expect(shown).not.toMatch(/[A-Za-z]{4,}/)
  })

  it('keeps English notes the model made to itself out of a Korean thread', () => {
    const lines = ['said: Now I have solid sources for all 5 items.', 'said: 확인했어요. Searching the web for results', 'said: 서울·부산 날씨는 정리했어요.', 'said: `npm run build`로 돌렸고 [Naver Finance stock quote page today](https://finance.naver.com)도 봤어요.', 'you: 대구도 추가해']
    const ko = renderToStaticMarkup(createElement(CometWork, { busy: true, lines, lang: 'ko' }))
    expect(ko).not.toContain('solid sources')
    expect(ko).not.toContain('Searching the web')
    expect(ko).toContain('finance.naver.com')
    expect(ko).toContain('서울·부산 날씨는 정리했어요.')
    expect(ko).toContain('대구도 추가해')
    expect(renderToStaticMarkup(createElement(CometWork, { busy: true, lines, lang: 'en' }))).toContain('solid sources')
  })
})

describe('how the bot is told to talk', () => {
  it('gives every turn the coworker rule: register, no jargon, memory of the thread, decisions, one next step, team voice, small talk', () => {
    expect(openRuleLines().join('\n')).toContain(COLLEAGUE_RULE.split('When the ask is loose')[0]!.trim())
    for (const kind of ['short', 'lookup', 'work'] as const) expect(openRuleLines({ kind, tools: [] }).join('\n')).toMatch(/coworker on a messenger/)
    for (const part of [/coworker on a messenger/, /-요 form/, /never switch to -습니다/, /no tool or function names/, /에이전트/, /without asking for it again/, /Keeping what they tell you is silent/, /react to what it means for them/, /never what you did or will do with it, and no promise about later conversations/, /without mentioning memory, records or notes/, /아 그거 말고 지난주 걸로/, /never offer a menu of options/, /one short offer line of something new/, /a summary or document turn may end with one only when no earlier reply ended with an offer/, /told as a team would, who did what in a natural sentence, no labels/, /Small talk, thanks or a complaint gets one short human line/, /at most one apology/, /no offer of help/])
      expect(COLLEAGUE_RULE).toMatch(part)
    for (const example of COLLEAGUE_RULE.match(/\("[^"]+"\)/g) ?? []) expect(jargon(example), example).toEqual([])
  })

  it('asks for a first line that names the first step in -요 form, not an echo of the request', () => {
    const prompt = quickPrompt('엔비디아 오늘 주가 알려줘', true)
    expect(prompt).toContain('naming the first concrete step ("종류별 폴더로 옮길게요."')
    expect(prompt).toMatch(/never -습니다/)
    expect(prompt).toMatch(/No restating, refusal, filler/)
    expect(prompt).not.toMatch(/restates the job/)
  })

  it('asks the same one prompt to answer a greeting, a thanks or a one-step question in full itself and to hand off anything to look up or do, whatever the wording', () => {
    for (const said of ['오후도 힘내요', '덕분에 살았어요', '광년은 몇 킬로미터야?']) {
      const prompt = quickPrompt(said, true)
      expect(prompt).toMatch(/a greeting, thanks, small talk, a complaint, something they only tell you, a definition, a calculation, a well-known fact/)
      expect(prompt).toMatch(/Hand off everything else: anything to look up or check as it is now/)
      expect(prompt).toContain(JSON.stringify(said))
    }
  })

  it('has one plain safety line with no jargon', () => {
    expect(jargon(SAFETY_LINE.ko)).toEqual([])
    expect(SAFETY_LINE.ko).toMatch(/요\.$/)
    expect([...SAFETY_LINE.ko].length).toBeLessThanOrEqual(60)
  })
})
