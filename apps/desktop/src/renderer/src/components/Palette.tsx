import { Command } from 'cmdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHitDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useApp } from '../state.js'
import { freshTone } from '../lib/grouping.js'

export type PaletteMode = 'search' | 'commands' | null
export type PaletteAction = 'team-join' | 'import'

export function Palette({ mode, onClose, onAction }: { mode: PaletteMode; onClose(): void; onAction(action: PaletteAction): void }) {
  const { notes, openNote, openReview, openInbox, showToast, t } = useApp()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHitDto[]>([])
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  useEffect(() => {
    setQuery('')
    setHits([])
    setSearching(false)
  }, [mode])

  useEffect(() => {
    if (mode !== 'search' || query.trim().length === 0) {
      setHits([])
      setSearching(false)
      return
    }
    setSearching(true)
    // Sequence guard: a slow answer for an earlier keystroke must not overwrite
    // the results for what the user has actually typed by now.
    const stamp = ++searchSeq.current
    const timer = window.setTimeout(() => {
      void api
        .search(query)
        .then((found) => {
          if (stamp !== searchSeq.current) return
          setHits(found)
          setSearching(false)
        })
        .catch(() => {
          if (stamp === searchSeq.current) setSearching(false)
        })
    }, 150)
    return () => window.clearTimeout(timer)
  }, [mode, query])

  const titleMatches = useMemo(() => {
    const living = notes.filter((n) => n.status === 'current' || n.status === 'draft')
    if (!query.trim()) return living.slice(0, 12)
    return living.filter((n) => n.title.toLowerCase().includes(query.toLowerCase())).slice(0, 12)
  }, [notes, query])

  // full-text hits that are not already shown as title matches
  const contentHits = useMemo(() => {
    const shown = new Set(titleMatches.map((n) => n.id))
    return hits.filter((h) => !shown.has(h.id)).slice(0, 12)
  }, [hits, titleMatches])

  if (!mode) return null

  const pick = (fn: () => void) => {
    fn()
    onClose()
  }

  return (
    <Command.Dialog open onOpenChange={(open) => !open && onClose()} label={t('palette.label')} shouldFilter={mode === 'commands'} className="palette">
      <Command.Input
        data-testid="palette-input"
        placeholder={mode === 'search' ? t('palette.searchPlaceholder') : t('palette.commandPlaceholder')}
        value={query}
        onValueChange={setQuery}
        autoFocus
      />
      <Command.List data-testid="palette-list">
        <Command.Empty>{searching ? t('palette.searching') : t('palette.empty')}</Command.Empty>

        {mode === 'search' && (
          <>
            {titleMatches.map((n) => {
              const tone = freshTone(n.badge)
              return (
                <Command.Item key={n.id} value={`${n.title} ${n.id}`} onSelect={() => pick(() => openNote(n.id))}>
                  <span className="list-dot-slot">{tone && <span className={`fresh-dot fresh-${tone}`} />}</span> {n.title}
                </Command.Item>
              )
            })}
            {contentHits.length > 0 && (
              <Command.Group heading={t('palette.contentMatches')}>
                {contentHits.map((hit) => {
                  const tone = freshTone(hit.badge)
                  return (
                    <Command.Item key={hit.id} value={hit.id} onSelect={() => pick(() => openNote(hit.id))}>
                      <span className="list-dot-slot">{tone && <span className={`fresh-dot fresh-${tone}`} />}</span> {hit.title}
                    </Command.Item>
                  )
                })}
              </Command.Group>
            )}
          </>
        )}

        {mode === 'commands' && (
          <>
            <Command.Item onSelect={() => pick(openReview)}>{t('palette.openReview')}</Command.Item>
            <Command.Item onSelect={() => pick(openInbox)}>{t('palette.openInbox')}</Command.Item>
            {/* The weekly digest's only door since it left the Today sheet —
                same window-intent idiom as the GitHub backup below. */}
            <Command.Item onSelect={() => pick(() => window.dispatchEvent(new Event('engram:open-digest')))}>{t('palette.openDigest')}</Command.Item>
            <Command.Item
              onSelect={() =>
                pick(() =>
                  void api
                    .buildPack()
                    .then((p) => navigator.clipboard.writeText(p.content).then(() => showToast(t('toast.contextPack', { file: p.file }))))
                    .catch((err: unknown) => showToast(t('toast.actionFailed', { reason: String((err as Error).message ?? err).slice(0, 120) }))),
                )
              }
            >
              {t('palette.copyPack')}
            </Command.Item>
            {/* 'team-create' now routes to the browser-assisted GitHub backup —
                the device-OAuth path threw without ENGRAM_GITHUB_CLIENT_ID set. */}
            <Command.Item onSelect={() => pick(() => window.dispatchEvent(new Event('engram:open-github')))}>{t('palette.teamCreate')}</Command.Item>
            <Command.Item onSelect={() => pick(() => onAction('team-join'))}>{t('palette.teamJoin')}</Command.Item>
            <Command.Item onSelect={() => pick(() => onAction('import'))}>{t('palette.import')}</Command.Item>
            {/* Delegate a goal to the on-device librarian — same window-intent
                idiom as the digest/GitHub items above. */}
            <Command.Item onSelect={() => pick(() => window.dispatchEvent(new Event('engram:open-errand')))}>{t('palette.errand')}</Command.Item>
          </>
        )}
      </Command.List>
    </Command.Dialog>
  )
}
