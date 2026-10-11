import { useCallback, useEffect, useState } from 'react'

export function compactBrowser(width: number, height: number): boolean {
  return width < 960 || height < 560
}

export function useCompactBrowser() {
  const [host, setHost] = useState<Element | null>(null)
  const [compact, setCompact] = useState(() => compactBrowser(window.innerWidth - 290, window.innerHeight))
  const elementRef = useCallback((element: HTMLElement | null) => {
    if (element) setHost(element.closest('.bots-main'))
  }, [])
  useEffect(() => {
    if (!host) return
    const measure = () => {
      const bounds = host.getBoundingClientRect()
      setCompact(compactBrowser(bounds.width, bounds.height))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(host)
    return () => observer.disconnect()
  }, [host])
  return { compact, elementRef }
}
