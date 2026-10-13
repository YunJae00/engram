// One deadline for the whole shutdown, including repeated quit requests.
export function quitGuard(retry: () => void, exit: () => void): () => void {
  let started = false
  return () => {
    if (started) return
    started = true
    setTimeout(retry, 25_000).unref()
    setTimeout(exit, 35_000).unref()
  }
}
