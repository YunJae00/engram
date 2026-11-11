export type TurnKeys = { message: unknown; live: boolean; divider: string | null; lang: string; anchor: string; work: readonly string[]; retry: boolean }

export function sameTurn(a: TurnKeys, b: TurnKeys): boolean {
  if (a.message !== b.message || a.live !== b.live || a.divider !== b.divider || a.lang !== b.lang || a.anchor !== b.anchor || a.retry !== b.retry) return false
  if (a.work.length !== b.work.length) return false
  for (let i = 0; i < a.work.length; i++) if (a.work[i] !== b.work[i]) return false
  return true
}
