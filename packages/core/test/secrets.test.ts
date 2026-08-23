import { describe, expect, it } from 'vitest'
import { carriesSecret, secretsIn, withoutSecrets } from '../src/secrets.js'

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
})
