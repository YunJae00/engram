import type { Page } from 'playwright-core'

export async function scrollDirection(page: Page, direction: string): Promise<boolean | null> {
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) {
      const element = await frame.frameElement().catch(() => null)
      const visible = await element?.isVisible().catch(() => false)
      await element?.dispose()
      if (!visible) continue
    }
    const moved = await frame.evaluate(async (way) => {
      const horizontal = way === 'left' || way === 'right'
      const forward = way === 'down' || way === 'right' || way === 'bottom'
      const visible = (node: Element) => {
        const box = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return style.visibility !== 'hidden' && box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
      }
      const dialogs = [...document.querySelectorAll('dialog[open], [role="dialog"], [aria-modal="true"]')].filter(visible)
      const scope = dialogs.at(-1) ?? document.body
      if (!scope) return null
      const candidates = [scope, ...scope.querySelectorAll('*')].filter((node) => {
        if (!visible(node)) return false
        const style = getComputedStyle(node)
        return /auto|scroll|overlay/.test(horizontal ? style.overflowX : style.overflowY)
          && (horizontal ? node.scrollWidth > node.clientWidth : node.scrollHeight > node.clientHeight)
      })
      const active = document.activeElement
      candidates.sort((a, b) => {
        const score = (node: Element) => {
          const box = node.getBoundingClientRect()
          return (active && active !== document.body && node.contains(active) ? 1e9 : 0) + Math.min(box.width, innerWidth) * Math.min(box.height, innerHeight)
        }
        return score(b) - score(a)
      })
      if (!dialogs.length && document.scrollingElement) {
        if (way === 'top' || way === 'bottom') candidates.unshift(document.scrollingElement)
        else candidates.push(document.scrollingElement)
      }
      for (const node of candidates) {
        const before = horizontal ? node.scrollLeft : node.scrollTop
        const step = Math.max(80, (horizontal ? node.clientWidth : node.clientHeight) * 0.8)
        const next = way === 'top' ? 0 : way === 'bottom' ? node.scrollHeight : before + (forward ? step : -step)
        const limit = horizontal ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight
        const rtl = horizontal && getComputedStyle(node).direction === 'rtl'
        if (Math.max(rtl ? -limit : 0, Math.min(rtl ? 0 : limit, next)) === before) continue
        const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
        await new Promise<void>((resolve) => {
          const events = node === document.scrollingElement ? document : node
          const finish = () => { clearTimeout(timer); events.removeEventListener('scrollend', finish); resolve() }
          // A detached or background surface may never emit scrollend.
          const timer = setTimeout(finish, smooth ? 1200 : 0)
          events.addEventListener('scrollend', finish, { once: true })
          node.scrollTo({ [horizontal ? 'left' : 'top']: next, behavior: smooth ? 'smooth' : 'instant' })
        })
        if ((horizontal ? node.scrollLeft : node.scrollTop) !== before) return true
      }
      return dialogs.length ? false : null
    }, direction).catch(() => null)
    if (moved !== null) return moved
  }
  return null
}
