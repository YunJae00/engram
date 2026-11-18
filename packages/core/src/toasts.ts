import { appKey } from './habit-chains.js'

export interface Toast {
  id: string
  app: string
  aumid: string
  at: string
  title: string
  text: string
}

export function toastApp(toast: Pick<Toast, 'app' | 'aumid'>, paths: Record<string, string>): string {
  const aumid = toast.aumid.toLowerCase()
  const family = /^([^!/\\]+)_([a-z0-9]{13})!/.exec(aumid)
  const words = new Set(aumid.split(/[^a-z0-9-]+/))
  for (const [key, path] of Object.entries(paths)) {
    if (!family) { if (words.has(key)) return key; continue }
    const program = path.toLowerCase().split('\\').join('/')
    if (program.includes(`/windowsapps/${family[1]}_`) && program.includes(`__${family[2]}/`)) return key
  }
  return appKey(toast.app)
}

export function toastUse(toasts: Toast[], paths: Record<string, string>): Map<string, { label: string; count: number }> {
  const use = new Map<string, { label: string; count: number }>()
  for (const toast of toasts) {
    const key = toastApp(toast, paths)
    const entry = use.get(key) ?? { label: toast.app, count: 0 }
    entry.count++
    use.set(key, entry)
  }
  return use
}

export function toastFrom(toast: Toast, key: string, named: string, label = ''): boolean {
  const want = appKey(named)
  return !want || key === want || [toast.app, label].some(name => name && appKey(name).includes(want))
}
