type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const fields = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
const modelFields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'] as const
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function claudeTokenUsage(): (message: unknown) => number {
  const messages = new Map<string, Record<string, number>>()
  const streams = new Map<string, string>()
  let reported = 0, turnReported = 0
  return raw => {
    const message = object(raw), event = object(message['event'])
    const parent = typeof message['parent_tool_use_id'] === 'string' ? message['parent_tool_use_id'] : ''
    let delta = 0
    if (message['type'] === 'result') {
      const models = Object.values(object(message['modelUsage']))
      const counts = models.flatMap(model => modelFields.map(field => object(model)[field]))
      if (counts.length && counts.every(valid)) {
        const total = counts.reduce((sum, count) => sum + count, 0)
        if (Number.isSafeInteger(total)) delta = Math.max(0, total - reported)
      } else if (!models.length) {
        const usage = object(message['usage'])
        const counts = fields.map(field => usage[field] ?? 0)
        if (counts.every(valid)) {
          const total = counts.reduce((sum, count) => sum + count, 0)
          if (Number.isSafeInteger(total)) delta = Math.max(0, total - turnReported)
        }
      }
      messages.clear()
      streams.clear()
      turnReported = 0
    } else {
      const body = object(message['type'] === 'assistant' ? message['message'] : event['message'])
      let id = typeof body['id'] === 'string' ? JSON.stringify([parent, body['id']]) : undefined
      if (message['type'] === 'stream_event' && event['type'] === 'message_start' && id) streams.set(parent, id)
      if (message['type'] === 'stream_event' && event['type'] === 'message_delta') id = streams.get(parent)
      if (!id) return 0
      const usage = object(event['type'] === 'message_delta' ? event['usage'] : body['usage'])
      const previous = { ...messages.get(id) }
      for (const field of fields) {
        const value = usage[field]
        if (!valid(value) || value <= (previous[field] ?? 0)) continue
        delta += value - (previous[field] ?? 0)
        previous[field] = value
      }
      if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(reported + delta)) return 0
      messages.set(id, previous)
      turnReported += delta
    }
    if (!Number.isSafeInteger(reported + delta)) return 0
    reported += delta
    return delta
  }
}
