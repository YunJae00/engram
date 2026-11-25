import { changeStudies, readStudies, type VaultPaths } from 'core'

export interface StudyCheck {
  controller: AbortController
  channel: string
  superseded?: boolean
}

export async function dismissStudyOffers(paths: VaultPaths, botId: string, checks: Iterable<StudyCheck>): Promise<void> {
  for (const check of checks) if (check.channel === `bot-${botId}`) check.superseded = true
  await changeStudies(paths, list => list.map(one => one.botId === botId && one.state === 'offered' ? { ...one, state: 'declined' as const } : one))
}

export async function addStudyOffer(paths: VaultPaths, botId: string, input: { what: string; where: string[] }, ask: string): Promise<void> {
  await changeStudies(paths, list => [...list.filter(one => !(one.botId === botId && one.state === 'offered')), { id: `study-${Date.now().toString(36)}`, botId, ...input, ask, state: 'offered', at: new Date().toISOString() }])
}

export async function openStudies(paths: VaultPaths, botId: string) {
  return (await readStudies(paths)).filter(one => one.botId === botId && (one.state === 'offered' || one.state === 'studying' || one.state === 'review'))
}
