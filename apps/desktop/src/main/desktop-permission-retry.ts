import { permissionFailure } from './desktop-permission.js'
import { korean, stillOffHint, waitForPermission } from './desktop-permission-state.js'

export async function retryOnPermission<T>(lane: string, error: unknown, context: { task?: string; signal?: AbortSignal }, again: () => Promise<T>, wrap: (json: string) => T): Promise<T> {
  context.signal?.throwIfAborted()
  const failure = await permissionFailure(error, lane, { ask: context.task })
  const waited = await waitForPermission(lane, failure, context)
  if (waited === 'on') {
    try { return await again() }
    catch (retry) { context.signal?.throwIfAborted(); return wrap(JSON.stringify(await permissionFailure(retry, lane, { ask: context.task }))) }
  }
  return wrap(JSON.stringify(waited === 'off' ? { ...failure, hint: stillOffHint(failure.permission!, korean(context.task)) } : failure))
}
