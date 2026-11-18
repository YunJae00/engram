export function readsKorean(text: string): boolean {
  const prose = text.replace(/`[^`]*`|\[[^\]]*\]\([^)]*\)|https?:\/\/\S+|"[^"]*"|“[^”]*”/g, ' ')
  return /[가-힣]/.test(text) && !/(?:[A-Za-z][A-Za-z'’-]*[\s,;:]+){3}[A-Za-z]/.test(prose)
}
