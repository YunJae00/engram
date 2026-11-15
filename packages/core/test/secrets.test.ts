import { describe, expect, it } from 'vitest'
import { carriesSecret, secretsIn, withoutSecrets, withoutSecretsIn } from '../src/secrets.js'

// A password the person types into the chat is theirs. It must not reach a
// note, a card, or the answer read back to them — the thread outlives the
// moment, and the vault syncs.
describe('secrets the person marked themselves', () => {
  it('reads the value out of the sentence that labelled it', () => {
    expect(secretsIn('비밀번호는 hunter2 야')).toEqual(['hunter2'])
    expect(secretsIn('my password is s3cr3t!')).toContain('s3cr3t!')
    expect(secretsIn('the api key = ak-9931-x')).toContain('ak-9931-x')
  })

  it('finds nothing where nothing was labelled', () => {
    expect(secretsIn('배포는 목요일 오후에 한다')).toEqual([])
    expect(secretsIn('비밀번호를 까먹었어')).toEqual([])
  })

  it('keeps the value out of anything written or said back', () => {
    const asked = '내 비밀번호 노트에 저장해줘. 비밀번호는 hunter2 야'
    expect(withoutSecrets('저장했습니다: hunter2', asked)).not.toContain('hunter2')
    expect(carriesSecret('# 로그인\n\nhunter2', asked)).toBe(true)
    expect(carriesSecret('# 로그인\n\n사람이 직접 로그인해야 합니다', asked)).toBe(false)
  })

  it('ordinary words are not secrets', () => {
    for (const text of ['Reply with exactly the word PINEAPPLE', 'Create shopping-list.md', 'spinach and garlic', 'a footprint of 3MB', 'the tokenizer splits words', '암호화폐 시세 알려줘', 'spin around twice']) expect(secretsIn(text)).toEqual([])
    expect(withoutSecrets('PINEAPPLE', 'say PINEAPPLE')).toBe('PINEAPPLE')
  })

  it('labelled values are still found', () => {
    expect(secretsIn('my pin is 4821')).toEqual(['4821'])
    expect(secretsIn('PIN: 4821')).toEqual(['4821'])
    expect(secretsIn('otp=839201')).toEqual(['839201'])
    expect(secretsIn('token: ghp_abc123')).toEqual(['ghp_abc123'])
    expect(secretsIn('비밀번호는 hunter2 야')).toEqual(['hunter2'])
    expect(secretsIn('비번 qwer1234')).toEqual(['qwer1234'])
    expect(secretsIn('my password is s3cr3t!')).toContain('s3cr3t!')
  })
})

describe('structured redaction (QA 0.8.142 B9)', () => {
  it('cleans every string value and keeps the serialized form valid', () => {
    const source = 'the token ab12\\ and password: worky'
    const value = { pending: ['token ab12\\ now'], context: 'saw ab12\\ "x"', nested: { list: [1, true, null, 'worky work'] } }
    const clean = withoutSecretsIn(value, source)
    const text = JSON.stringify(clean)
    expect(() => JSON.parse(text)).not.toThrow()
    expect(text).not.toContain('ab12')
    expect(Object.keys(clean)).toEqual(['pending', 'context', 'nested'])
    expect(clean).toEqual({ pending: ['token •••••• now'], context: 'saw •••••• "x"', nested: { list: [1, true, null, '•••••• work'] } })
  })
  it('cleans object keys too', () => {
    const text = JSON.stringify(withoutSecretsIn({ 'ab12\\': 'safe' }, 'the token ab12\\ '))
    expect(text).not.toContain('ab12')
    expect(JSON.parse(text)).toEqual({ '••••••': 'safe' })
  })
  it('never renames the caller\'s own field names', () => {
    expect(withoutSecretsIn({ pending: ['pending'], other: { pending: 1 } }, 'token: pending', ['pending'])).toEqual({ pending: ['••••••'], other: { pending: 1 } })
  })
  it('returns the same value when nothing was labelled', () => {
    const value = { a: 'plain' }
    expect(withoutSecretsIn(value, 'nothing here')).toBe(value)
  })
})
