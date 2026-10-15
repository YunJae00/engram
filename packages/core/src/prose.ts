// Repair escaped paragraph breaks in prose, never in code, quoted data or paths.
export function normalizeProse(text: string): string {
  const protectedText = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|(`+)[\s\S]*?(?:\2|$)|(?<!\w)(?:[a-z]:\\|\\\\)[^\r\n<>"`]+|https?:\/\/[^\s<>"`\\]+|"(?:\\.|[^"\\])*"/gi
  const paragraphs = (value: string) => value
    .replace(/(?<!\\)(?:\\r)?\\n(?:(?:\\r)?\\n)+/g, breaks => breaks.replace(/\\r/g, '').replace(/\\n/g, '\n'))
    .replace(/(?<!\\)(?:\\r)?\\n(?=\s*(?:\d+[.)]\s|[-*+]\s|#{1,6}\s|[>|]))/g, '\n')
  let at = 0, result = ''
  for (const match of text.matchAll(protectedText)) {
    result += paragraphs(text.slice(at, match.index)) + match[0]
    at = match.index! + match[0].length
  }
  return result + paragraphs(text.slice(at))
}
