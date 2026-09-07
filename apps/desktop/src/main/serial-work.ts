export function serialWork() {
  let tail: Promise<unknown> = Promise.resolve()
  let pending = 0
  return {
    get pending() { return pending },
    run<T>(work: () => Promise<T>): Promise<T> {
      pending++
      const next = tail.catch(() => undefined).then(work).finally(() => { pending-- })
      tail = next
      return next
    },
  }
}
