// Whether words written mid-work read as Korean: some Hangul, and no run of four or more English words outside code, links (a source's title is its name) and quotes.
export function readsKorean(text: string): boolean {
  const prose = text.replace(/`[^`]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|"[^"]*"|“[^”]*”/g, ' ')
  return /[가-힣]/.test(text) && !/(?:[A-Za-z][A-Za-z'’-]*[\s,;:]+){3}[A-Za-z]/.test(prose)
}
