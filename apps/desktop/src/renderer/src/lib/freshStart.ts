import type { EngramApi } from '../../../shared/types.js'

export async function startOver(api: Pick<EngramApi, 'chatFresh'>, threads: { fresh(id: string): void }, botId: string): Promise<void> {
  await api.chatFresh(botId)
  threads.fresh(botId)
}
