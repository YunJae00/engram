export interface OfficeText { key: string; text: string; [key: string]: unknown }
export interface OfficeEditStep { key: string; before: string; after: string; mode: string; text: string; positions?: number[]; find?: string }

export function planOfficeEdits(state: OfficeText[], edits: Record<string, unknown>[], kind: 'word' | 'ppt'): OfficeEditStep[] {
  const texts = new Map(state.map(item => [item.key, item.text]))
  const plan: OfficeEditStep[] = []
  let work = 0
  const normalize = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 8000 || [...value].some(char => char.charCodeAt(0) < 32 && !'\t\r\n'.includes(char))) throw new Error('Invalid document text.')
    return value.replace(/\r\n|\n/g, '\r')
  }
  if (!Array.isArray(edits) || !edits.length || edits.length > 100) throw new Error('Use 1 to 100 edits.')
  for (const edit of edits) {
    if (edit['kind'] === 'replace') {
      const find = normalize(edit['find']), text = normalize(edit['with'])
      if (!find) throw new Error('Empty replacement search is not allowed.')
      let matches = 0
      for (const [key, before] of texts) {
        const positions: number[] = []
        for (let at = before.indexOf(find); at >= 0; at = before.indexOf(find, at + find.length)) {
          positions.push(at)
          if (++work > 1000) throw new Error('Edit exceeds 1000 text changes.')
        }
        if (!positions.length) continue
        const after = before.split(find).join(text)
        plan.push({ key, before, after, mode: 'replace', find, text, positions })
        texts.set(key, after)
        matches += positions.length
      }
      if (!matches) throw new Error('No literal, case-sensitive match found; no edits applied.')
    } else {
      const mode = edit['kind']
      const key = kind === 'word' && mode === 'append' ? 'body'
        : kind === 'ppt' && mode === 'note' ? `${edit['slide']}:note`
          : kind === 'ppt' && mode === 'text' ? `${edit['slide']}:${edit['shape']}` : undefined
      if (!key || !texts.has(key)) throw new Error('Target was not present in the document read.')
      const before = texts.get(key)!, text = normalize(edit['text'])
      const after = mode === 'append' ? before.replace(/\r$/, '') + '\r' + text + '\r' : text
      plan.push({ key, before, after, mode: String(mode), text })
      texts.set(key, after)
      work++
    }
  }
  if (work > 1000 || [...texts.values()].reduce((n, text) => n + text.length, 0) > 100000) throw new Error('Planned edit exceeds the supported size.')
  return plan
}
