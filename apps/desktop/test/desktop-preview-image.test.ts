import { expect, it, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
const fake = vi.hoisted(() => ({ bitmap: Buffer.alloc(16), binding: undefined as unknown, jpeg: vi.fn(() => Buffer.from('safe')) }))
vi.mock('electron', () => ({ nativeImage: {
  createFromBuffer: () => ({ isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toBitmap: () => fake.bitmap }),
  createFromBitmap: () => ({ toJPEG: fake.jpeg }),
} }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopBinding: () => fake.binding }))
import { previewImage } from '../src/main/desktop-image.js'

it('refuses fully transparent hidden surfaces while allowing a rendered frame through the existing safe geometry checks', async () => {
  const bounds = { x: 0, y: 0, width: 200, height: 200 }
  const binding = { lane: 'bot-hidden', window: '42', pid: 200, readable: true, revision: 0, name: 'Hidden app', host: {
    request: vi.fn(async (method: string) => method === 'observe'
      ? { snapshot: 'fresh', bounds, captureBounds: bounds, protectedBounds: [], truncated: false, captureSafe: true }
      : { basis: 'client-physical', bounds, width: 2, height: 2, data: 'AQ==' }),
  } } as unknown as DesktopBinding
  fake.binding = binding
  await expect(previewImage(binding, new AbortController().signal)).rejects.toThrow('has not drawn a preview yet')
  expect(fake.jpeg).not.toHaveBeenCalled()
  expect(binding.host.request).toHaveBeenCalledWith('capture', expect.objectContaining({ preview: true }), expect.any(AbortSignal), {})
  fake.bitmap.fill(255)
  await expect(previewImage(binding, new AbortController().signal)).resolves.toMatchObject({ image: { mimeType: 'image/jpeg' } })
})
