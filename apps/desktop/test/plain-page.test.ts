import { expect, it, vi } from 'vitest'
import { fetchPlainPage, plainPage, tabOrPlain } from '../src/main/plain-page.js'

const noRoom = () => new Error('not enough free memory for another browser tab right now (0.9GB free).')
const long = '서울 맑음 12도. '.repeat(40)

it('reads a page as text and links without a browser', () => {
  const page = plainPage(`<html><head><title>서울 날씨 &amp; 예보</title><script>var hidden = 1</script></head><body><style>.a{}</style><h1>서울</h1><p>맑음&nbsp;12&#8451;</p><a href="/w/busan">부산 <b>날씨</b></a><a href="javascript:void(0)">x</a></body></html>`, 'https://weather.example/w/seoul')
  expect(page.title).toBe('서울 날씨 & 예보')
  expect(page.text).toBe('서울\n맑음 12℃\n부산 날씨 x')
  expect(page.text).not.toContain('hidden')
  expect(page.links).toEqual([{ text: '부산 날씨', url: 'https://weather.example/w/busan' }])
})

it('fetches without cookies and keeps a refusal status', async () => {
  const fetcher = vi.fn(async () => new Response(`<title>없음</title><p>${long}</p>`, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }))
  const page = await fetchPlainPage('https://weather.example/x', undefined, fetcher)
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit' })
  expect(page).toMatchObject({ title: '없음', status: 404, requestedUrl: 'https://weather.example/x' })
  await expect(fetchPlainPage('https://weather.example/a.png', undefined, async () => new Response('x', { headers: { 'content-type': 'image/png' } }))).rejects.toThrow(/not a page of text/)
})

it('answers a read from a plain fetch when there is no room for a tab', async () => {
  const read = { url: 'https://a.example', title: '', text: long }
  expect(await tabOrPlain(async () => { throw noRoom() }, async () => read)).toEqual({ read })
  expect(await tabOrPlain(async () => 'tab', async () => read)).toEqual({ tab: 'tab' })
})

it('waits its turn for a tab, bounded, when the plain read shows nothing', async () => {
  let tries = 0
  const tab = async () => { if (++tries < 3) throw noRoom(); return 'tab' }
  expect(await tabOrPlain(tab, async () => ({ url: 'u', title: '', text: 'Loading…' }), undefined, 1_000, 5)).toEqual({ tab: 'tab' })
  await expect(tabOrPlain(async () => { throw noRoom() }, async () => ({ url: 'u', title: '', text: '' }), undefined, 20, 5)).rejects.toThrow(/not enough free memory/)
  expect(await tabOrPlain(async () => { throw noRoom() }, async () => ({ url: 'u', title: '', text: 'thin' }), undefined, 20, 5)).toMatchObject({ read: { text: 'thin' } })
})

it('passes on every other failure untouched', async () => {
  const plain = vi.fn(async () => ({ url: 'u', title: '', text: long }))
  await expect(tabOrPlain(async () => { throw new Error('profile is locked') }, plain)).rejects.toThrow('profile is locked')
  expect(plain).not.toHaveBeenCalled()
})

it('marks a sign-in or robot-check page as a wall, like a tab read', async () => {
  expect(plainPage('<title>Verify you are human</title><p>captcha required</p>', 'https://example.com/check').wall).toBe('captcha')
  expect(plainPage('<title>Sign in</title><form><input type="password" name="p"></form>', 'https://example.com/account').wall).toBe('login')
  expect(plainPage(`<title>서울 날씨</title><p>${long}</p>`, 'https://weather.example/seoul').wall).toBeUndefined()
  const walled = { url: 'u', title: '', text: long, wall: 'captcha' as const }
  let tries = 0
  expect(await tabOrPlain(async () => { if (++tries < 2) throw noRoom(); return 'tab' }, async () => walled, undefined, 1_000, 5)).toEqual({ tab: 'tab' })
  expect(await tabOrPlain(async () => { throw noRoom() }, async () => ({ ...walled, text: '' }), undefined, 20, 5)).toMatchObject({ read: { wall: 'captcha' } })
})

it('stops reading a page body at the size limit', async () => {
  let pulled = 0
  const chunk = new TextEncoder().encode('가'.repeat(100_000))
  const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += chunk.length; controller.enqueue(chunk) } }, { highWaterMark: 0 })
  const response = new Response(body, { headers: { 'content-type': 'text/html' } })
  response.arrayBuffer = async () => { throw new Error('the whole body was read') }
  const page = await fetchPlainPage('https://example.com/huge', undefined, async () => response)
  expect(page.text.length).toBeGreaterThan(1_000)
  expect(pulled).toBeLessThan(3_000_000)
})
