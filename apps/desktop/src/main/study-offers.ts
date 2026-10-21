import { changeStudies, type VaultPaths } from 'core'

export interface StudyCheck {
  controller: AbortController
  channel: string
  superseded?: boolean
}

export async function dismissStudyOffers(paths: VaultPaths, botId: string, checks: Iterable<StudyCheck>): Promise<void> {
  // Discard stale offers, but keep checks that recover unhandled user messages.
  for (const check of checks) if (check.channel === `bot-${botId}`) check.superseded = true
  await changeStudies(paths, list => list.map(one => one.botId === botId && one.state === 'offered' ? { ...one, state: 'declined' as const } : one))
}
