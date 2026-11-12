import { describe, expect, it } from 'vitest'
import { tIn } from '../src/renderer/src/i18n'
import { withParticles } from '../src/renderer/src/lib/koParticle'

describe('Korean particles after a filled value', () => {
  it('picks 이 or 가 for the details pane memory title', () => {
    const title = (name: string) => tIn('ko', 'bots.memoryTitle', { name })
    expect(title('리서치')).toBe('리서치가 나에 대해 기억하는 것')
    expect(title('아침 날씨')).toBe('아침 날씨가 나에 대해 기억하는 것')
    expect(title('새 코멧')).toBe('새 코멧이 나에 대해 기억하는 것')
    expect(title('일정 비서')).toBe('일정 비서가 나에 대해 기억하는 것')
    expect(title('Engram')).toBe('Engram이(가) 나에 대해 기억하는 것')
    expect(title('')).toBe('이(가) 나에 대해 기억하는 것')
  })

  it('handles 을(를), 은(는), 과(와) and (으)로, also after a closing quote', () => {
    expect(tIn('ko', 'card.press', { words: '보내기' })).toBe('“보내기”를 눌러도 될까요?')
    expect(tIn('ko', 'card.press', { words: '저장' })).toBe('“저장”을 눌러도 될까요?')
    expect(tIn('ko', 'card.press', { words: 'Send' })).toBe('“Send”을(를) 눌러도 될까요?')
    expect(tIn('ko', 'routines.askRanToday', { name: '아침 날씨' }).startsWith('"아침 날씨"는 오늘')).toBe(true)
    expect(tIn('ko', 'routines.askRanToday', { name: '뉴스 요약본' }).startsWith('"뉴스 요약본"은 오늘')).toBe(true)
    expect(withParticles('{a}과(와) {b}과(와)', { a: '사과', b: '수박' })).toBe('사과와 수박과')
    expect(withParticles('{a}을(를)', { a: '“리서치”' })).toBe('“리서치”를')
    expect(tIn('ko', 'sidebar.moveTo', { name: '서울' })).toBe('서울로 이동')
    expect(tIn('ko', 'sidebar.moveTo', { name: '집' })).toBe('집으로 이동')
    expect(tIn('ko', 'sidebar.moveTo', { name: '바다' })).toBe('바다로 이동')
    expect(tIn('ko', 'sidebar.moveTo', { name: '폴더 3' })).toBe('폴더 3으로 이동')
    expect(tIn('ko', 'sidebar.moveTo', { name: '폴더 1' })).toBe('폴더 1로 이동')
    expect(tIn('ko', 'sidebar.moveTo', { name: '폴더 2' })).toBe('폴더 2로 이동')
    expect(withParticles('{n}이(가)', { n: 6 })).toBe('6이')
    expect(withParticles('{n}이(가)', { n: 9 })).toBe('9가')
  })

  it('leaves unknown placeholders and English untouched', () => {
    expect(withParticles('{missing}이(가) {name}', { name: '리서치' })).toBe('{missing}이(가) 리서치')
    expect(tIn('en', 'bots.memoryTitle', { name: '리서치' })).toBe('What 리서치 remembers about you')
    expect(tIn('en', 'sidebar.moveTo', { name: '집' })).not.toContain('으로')
  })
})
