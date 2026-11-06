import { describe, expect, it } from 'vitest'
import { crc32, inflateSync } from 'node:zlib'
import { pageScene, pngFrame } from '../../../scripts/verify-scenarios/lib/frame-fixture.mjs'
import { packedBlocks } from '../../../scripts/verify-scenarios/lib/chat-layout.mjs'

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, right: left + width, bottom: top + height, width, height })

function chunks(png: Buffer): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = []
  let at = 8
  while (at < png.length) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    const data = png.subarray(at + 8, at + 8 + length)
    expect(png.readUInt32BE(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)))
    out.push({ type, data })
    at += 12 + length
  }
  return out
}

describe('frame fixture', () => {
  it('encodes a real RGB png the renderer recognizes as one', () => {
    const frame = pngFrame({ width: 40, height: 20 })
    expect(frame.data.startsWith('iVBOR')).toBe(true)
    const png = Buffer.from(frame.data, 'base64')
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const parts = chunks(png)
    expect(parts.map((part) => part.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const header = parts[0]!.data
    expect([header.readUInt32BE(0), header.readUInt32BE(4), ...header.subarray(8)]).toEqual([40, 20, 8, 2, 0, 0, 0])
    const raw = inflateSync(parts[1]!.data)
    expect(raw.length).toBe((1 + 40 * 3) * 20)
    expect(raw[0]).toBe(0)
    expect([...raw.subarray(1, 4)]).toEqual(pageScene(0, 0, 40, 20))
    const lastRow = 19 * (1 + 40 * 3)
    expect([...raw.subarray(lastRow + 1 + 39 * 3, lastRow + 1 + 40 * 3)]).toEqual(pageScene(39, 19, 40, 20))
  })

  it('paints the scene with a header band, a red card, a blue button and a light body', () => {
    expect(pageScene(0, 0, 100, 100)).toEqual([24, 40, 72])
    expect(pageScene(30, 40, 100, 100)).toEqual([220, 60, 60])
    expect(pageScene(75, 78, 100, 100)).toEqual([40, 90, 220])
    expect(pageScene(99, 99, 100, 100)).toEqual([248, 250, 252])
  })
})

describe('packed blocks', () => {
  const packed = () => ({
    viewport: { width: 1400, height: 900 },
    main: box(200, 40, 1200, 860), chat: box(200, 40, 1200, 860),
    card: box(1060, 48, 320, 200), thread: box(200, 256, 1200, 500), input: box(260, 800, 1080, 80),
    controls: [{ ...box(260, 800, 1080, 80), inThread: false }, { ...box(260, 300, 600, 60), inThread: true }],
    cardOnTop: true, pane: false,
  })

  it('accepts a card inside the chat, above the thread, beside a full-width chat', () => {
    expect(packedBlocks(packed())).toEqual({ ok: true, reasons: [] })
  })

  it('names what is missing', () => {
    expect(packedBlocks(null)).toEqual({ ok: false, reasons: ['chat, card, thread or composer is missing'] })
  })

  it('refuses a card over the thread or over a control', () => {
    const over = packed()
    over.card = box(1060, 48, 320, 300)
    over.controls.push({ ...box(1100, 260, 100, 30), inThread: true })
    expect(packedBlocks(over).reasons).toEqual(['card covers the thread', 'card covers a control'])
  })

  it('refuses a chat narrowed beside a pane, a card that leaves the chat and a covered card', () => {
    const split = packed()
    split.chat = box(200, 40, 700, 860)
    split.card = box(900, 48, 320, 200)
    split.input = box(260, 800, 580, 80)
    split.pane = true
    split.cardOnTop = false
    expect(packedBlocks(split).reasons).toEqual(['card leaves the chat', 'chat is narrowed beside the card', 'a web pane is open beside the chat', 'something paints over the card'])
  })

  it('ignores the part of a thread control that is scrolled out of the thread', () => {
    const scrolled = packed()
    scrolled.controls.push({ ...box(1100, 100, 100, 150), inThread: true })
    expect(packedBlocks(scrolled)).toEqual({ ok: true, reasons: [] })
  })
})
