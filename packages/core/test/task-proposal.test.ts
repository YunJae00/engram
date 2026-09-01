import { describe, expect, it } from 'vitest'
import { answerLanguageLine, NAME_CHARS, parseProposal, proposalPrompt } from '../src/task-proposal.js'

describe('the button a finished job proposes', () => {
  it('reads the three lines, quotes and all', () => {
    const kept = parseProposal('NAME: "Check the week\'s hours"\nGOAL: Open the time report and read this week back to me\nDOES: Opens the report and reads the week back')
    expect(kept).toEqual({
      name: "Check the week's hours",
      goal: 'Open the time report and read this week back to me',
      does: 'Opens the report and reads the week back',
    })
  })

  it('keeps nothing when the job is not worth repeating', () => {
    expect(parseProposal('NONE')).toBeNull()
    expect(parseProposal('  none  ')).toBeNull()
  })

  it('keeps nothing from an answer that is only prose', () => {
    expect(parseProposal('Sure, I could make a button for that if you like!')).toBeNull()
  })

  it('falls back to the goal when the model skipped the last line', () => {
    const kept = parseProposal('NAME: Morning news\nGOAL: Read the top five stories and summarise them')
    expect(kept?.does).toBe('Read the top five stories and summarise them')
  })

  it('cuts a label that would not fit in a row of buttons', () => {
    const kept = parseProposal(`NAME: ${'x'.repeat(80)}\nGOAL: something repeatable`)
    expect(kept?.name.length).toBe(NAME_CHARS)
  })

  it('asks for the work, never for the words that were typed', () => {
    const prompt = proposalPrompt({ user: 'go in here and check', answer: 'It is the time report.', steps: ['open_page: https://example.test'] })
    expect(prompt).toContain('naming the WORK')
    expect(prompt).toContain('open_page: https://example.test')
    expect(prompt).toContain('language the person wrote in')
  })
})

describe('which language the answer comes back in', () => {
  it('names the language the ask was written in', () => {
    expect(answerLanguageLine('오늘 뉴스 세 개만 읽어줘')).toContain('Korean')
    expect(answerLanguageLine('read me the top three stories')).toContain('English')
  })

  it('says it plainly when the script names no language', () => {
    expect(answerLanguageLine('123 456')).toContain('the language this task is written in')
  })

  it('is said against the pages, which are usually in another language', () => {
    expect(answerLanguageLine('read me the top three stories')).toContain('whatever language the pages you read are in')
  })
})
