import { appKey } from './habit-chains.js'

// A notification copied out of the system's list the moment it showed, so it
// stays Engram's after the person clears it there.
export interface Toast {
  id: string
  // The name the app shows itself by, and the id the system knows it by.
  app: string
  aumid: string
  at: string
  title: string
  text: string
}

// Which recorded app sent a notification, by where its programs live. A store
// app's id names its package ("Name_publisher!App"), whose folder holds the
// program; a desktop app's id mostly carries its program's name
// ("Microsoft.Office.OUTLOOK.EXE.15"). With neither, it goes by its shown name.
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

// The app a request names, by its recorded key or any name it goes by.
export function toastFrom(toast: Toast, key: string, named: string, label = ''): boolean {
  const want = appKey(named)
  return !want || key === want || [toast.app, label].some(name => name && appKey(name).includes(want))
}
