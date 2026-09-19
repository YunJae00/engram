import { applyPatch, reversePatch, structuredPatch } from 'diff'

function patch(before: string, after: string) {
  if (before.length > 200_000 || after.length > 200_000 || before.includes('\0') || after.includes('\0')) throw new Error('This file is too large or binary. Review it in your editor.')
  const result = structuredPatch('file', 'file', before, after, undefined, undefined, { context: 3, timeout: 100, maxEditLength: 4000 })
  if (!result) throw new Error('This change is too large to review interactively. Open it in your editor.')
  return result
}

export function changeHunks(before: string, after: string): { index: number; line: number; text: string }[] {
  return patch(before, after).hunks.map((hunk, index) => ({ index, line: hunk.newStart, text: hunk.lines.join('\n') }))
}

export function undoChangeHunk(before: string, after: string, index: number): string {
  const full = patch(before, after)
  if (!Number.isInteger(index) || index < 0 || index >= full.hunks.length) throw new Error('This change is no longer available. Refresh the review.')
  const reverse = reversePatch({ ...full, hunks: [full.hunks[index]!] })
  const result = applyPatch(after, reverse, { fuzzFactor: 0 })
  if (result === false) throw new Error('The file no longer matches this change. Refresh the review.')
  return result
}
