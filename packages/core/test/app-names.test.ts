import { expect, it } from 'vitest'
import { appNameMatch, similarApps } from '../src/app-names.js'
it('matches English and bundle queries to localized app names', () => {
  const app = { name: '카카오톡', aliases: ['KakaoTalk', 'com.kakao.KakaoTalkMac'] }
  expect(appNameMatch(app, 'kakaotalk', true)).toBe(true)
  expect(appNameMatch(app, 'COM.KAKAO.KAKAOTALKMAC', true)).toBe(true)
  expect(appNameMatch(app, '카카오톡', true)).toBe(true)
  expect(similarApps([app, { name: 'Notes' }, { name: 'Mail' }, { name: 'Calculator' }], 'KakaoTal')[0]).toBe(app)
  expect(similarApps([app, { name: 'Notes' }, { name: 'Mail' }, { name: 'Calculator' }], 'unknown')).toHaveLength(3)
})
