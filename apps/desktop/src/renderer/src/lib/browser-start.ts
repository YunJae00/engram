export function browserAddress(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('Enter a website or search term.')
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^/:?#\s]+:\d+(?:[/?#]|$)/.test(value)
  const address = scheme || /^(localhost(?::\d+)?|[^\s/]+\.[^\s/]+)(?:[/:?#]|$)/i.test(value)
  if (!address || /\s/.test(value)) return `https://www.google.com/search?q=${encodeURIComponent(value)}`
  const url = new URL(scheme ? value : `${/^localhost[:/]/i.test(value) ? 'http' : 'https'}://${value}`)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an http or https address without sign-in credentials.')
  return url.href
}

// Origins avoid persisting OAuth codes, search text and private document paths.
export function recentSite(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null
  } catch { return null }
}
