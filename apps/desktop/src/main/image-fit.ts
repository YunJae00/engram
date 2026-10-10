import { nativeImage } from 'electron'

const MAX_SIDE = 4096
const MAX_BYTES = 4_000_000

export function fitImage(image: { data: string; mimeType: string }): { data: string; mimeType: string } {
  const bytes = Buffer.from(image.data, 'base64')
  let source = nativeImage.createFromBuffer(bytes)
  if (source.isEmpty()) throw new Error('This image could not be read.')
  const size = source.getSize()
  if (bytes.length <= MAX_BYTES && size.width <= MAX_SIDE && size.height <= MAX_SIDE) return image
  const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height))
  if (scale < 1) source = source.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' })
  let quality = 85
  let out = source.toJPEG(quality)
  while (out.length > MAX_BYTES && quality > 40) { quality -= 15; out = source.toJPEG(quality) }
  while (out.length > MAX_BYTES) {
    const { width, height } = source.getSize()
    if (width <= 1 && height <= 1) throw new Error('This image could not be reduced to 4 MB.')
    source = source.resize({ width: Math.max(1, Math.floor(width / 2)), height: Math.max(1, Math.floor(height / 2)), quality: 'good' })
    out = source.toJPEG(quality)
  }
  return { data: out.toString('base64'), mimeType: 'image/jpeg' }
}
