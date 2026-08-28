import { describe, expect, it } from 'vitest'
import { choiceQuestion, cleanOptions, formatAsk, parseAsk } from '../src/ask.js'

// Choices are ways forward the person taps; anything that hands the work back
// is dropped, and a question with fewer than two real ways forward is free text.
describe('cleanOptions', () => {
  it('keeps short distinct ways forward, at most four', () => {
    expect(cleanOptions(['Staging', 'Production', 'staging ', 'Both', 'Neither', 'Extra'])).toEqual(['Staging', 'Production', 'Both', 'Neither'])
  })
  it('drops off-ramps and junk, and gives up below two', () => {
    expect(cleanOptions(['Cancel', 'Do it yourself', 'Staging'])).toEqual([])
    expect(cleanOptions(['취소', '나중에', '포털', '메일'])).toEqual(['포털', '메일'])
    expect(cleanOptions('Staging')).toEqual([])
    expect(cleanOptions([42, 'a'.repeat(41), 'Fine', 'Also fine'])).toEqual(['Fine', 'Also fine'])
  })
})

describe('formatAsk / parseAsk', () => {
  it('round-trips a question with choices', () => {
    const text = formatAsk('Which one?', ['Staging', 'Production'])
    expect(parseAsk(text)).toEqual({ question: 'Which one?', options: ['Staging', 'Production'] })
  })
  it('reads a bare question as free text', () => {
    expect(parseAsk('ASK: 어떤 걸 말씀하시는 건가요?')).toEqual({ question: '어떤 걸 말씀하시는 건가요?', options: [] })
    expect(parseAsk('nothing in the vault')).toBeNull()
    expect(parseAsk('ASK: Which?\nOPTIONS: not json')).toEqual({ question: 'Which?', options: [] })
  })
})

describe('choiceQuestion', () => {
  it('turns "A or B?" prose into choices', () => {
    expect(choiceQuestion('I found two notes. Do you mean the staging server or the production server?')).toEqual({
      question: 'Do you mean the staging server or the production server?',
      options: ['the staging server', 'the production server'],
    })
    expect(choiceQuestion('포털 공지 아니면 메일 공지?')).toEqual({ question: '포털 공지 아니면 메일 공지?', options: ['포털 공지', '메일 공지'] })
  })
  it('reads a comma list ending in or', () => {
    expect(choiceQuestion('Which form: the daily, the weekly, or the monthly?')).toEqual({
      question: 'Which form: the daily, the weekly, or the monthly?',
      options: ['the daily', 'the weekly', 'the monthly'],
    })
  })
  it('leaves ordinary questions and statements alone', () => {
    expect(choiceQuestion('The deploy is on Thursday.')).toBeNull()
    expect(choiceQuestion('What would you like me to check?')).toBeNull()
    expect(choiceQuestion('Shall I go ahead or not?')).toBeNull()
  })
})
