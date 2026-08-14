import type { ClipboardEvent } from 'react'

// Pastes above this size are refused — far beyond any screenshot, and more
// than the ingest pipeline (engine vision ≤10MB, OCR) wants to chew on.
export const PASTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024

// Clipboard paste helper shared by the capture composers. The image item must
// be pulled out synchronously (clipboardData is only valid during the event);
// reading the bytes can then happen async.
export function imageFromPaste(e: ClipboardEvent): File | null {
  const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'))
  return item?.getAsFile() ?? null
}

export async function blobBytes(blob: File): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}
