import { collectResult, type Engine, type EngineJobInput } from 'core'

// Only pure draft generation can be retried; never replay tools or auth failures.
export async function habitResult(engine: Engine, job: EngineJobInput): Promise<string> {
  const pure = { ...job, disallowTools: true }
  try { return await collectResult(engine, pure) }
  catch (error) {
    if (job.signal?.aborted || !/stream disconnected before completion|stream closed before response\.completed/i.test(error instanceof Error ? error.message : '')) throw error
    return collectResult(engine, pure)
  }
}
