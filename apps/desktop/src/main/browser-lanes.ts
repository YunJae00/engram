import type { Page } from 'playwright-core'

export class BrowserLanes {
  private current = new Map<string, Page>()
  private members = new Map<string, Set<Page>>()
  private owners = new WeakMap<Page, string>()

  constructor(private restored: (page: Page, lane: string) => void) {}

  get size(): number { return this.current.size }
  get(lane: string): Page | undefined { return this.current.get(lane) }
  owner(page: Page): string | null { return this.owners.get(page) ?? null }
  pages(lane: string): Page[] { return [...(this.members.get(lane) ?? [])] }

  set(lane: string, page: Page): void {
    this.current.set(lane, page)
    if (this.owners.has(page)) return
    this.owners.set(page, lane)
    const members = this.members.get(lane) ?? new Set<Page>()
    members.add(page)
    this.members.set(lane, members)
    page.once('close', () => {
      if (this.owners.get(page) !== lane) return
      this.owners.delete(page)
      members.delete(page)
      if (this.current.get(lane) !== page) return
      const previous = [...members].reverse().find((one) => !one.isClosed())
      if (previous) {
        this.current.set(lane, previous)
        this.restored(previous, lane)
      } else {
        this.current.delete(lane)
        this.members.delete(lane)
      }
    })
  }

  delete(lane: string): void {
    for (const page of this.members.get(lane) ?? []) this.owners.delete(page)
    this.members.delete(lane)
    this.current.delete(lane)
  }

  clear(): void {
    this.current.clear()
    this.members.clear()
    this.owners = new WeakMap()
  }
}
