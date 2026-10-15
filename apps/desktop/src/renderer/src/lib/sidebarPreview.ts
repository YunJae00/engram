import { normalizeProse } from '../../../../../../packages/core/src/prose.js'

export function sidebarPreview(text: string): string {
  // A sidebar excerpt never needs to parse an entire pasted document.
  return normalizeProse(text.slice(0, 2048)).replace(/!?\[([^[\]]+)\]\([^)]*\)/g, '$1').replace(/[`#*_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)
}
