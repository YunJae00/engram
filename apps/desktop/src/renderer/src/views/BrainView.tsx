import { Network, PanelLeftClose, PanelLeftOpen, Unlink } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { EmptyState } from '../components/EmptyState.js'
import { MemoryRow, TopicPage } from '../components/TopicPage.js'
import { stripEmoji } from '../lib/grouping.js'
import { buildBrain, type Topic } from '../lib/topics.js'
import { useApp } from '../state.js'

const UNCONNECTED_KEY = '__unconnected'

// The "not yet connected" bucket can hold most of a big vault — cap the
// mounted rows behind a quiet reveal instead of thousands of DOM nodes.
const UNCONNECTED_CAP = 120

// Same guard for the topic rail (a 30k-note vault grew 6,400 topics): only
// this many tiles mount; the rail filter is the way to reach the rest.
const RAIL_CAP = 150

export function BrainView() {
  const { notes, openNote, setActivity, t , subjectKnowledge, fabric } = useApp()
  const [showAllUnconnected, setShowAllUnconnected] = useState(false)
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('engram.brain.rail') !== '0')
  const live = useMemo(
    () => notes.filter((n) => n.status === 'current' || n.status === 'disputed'),
    [notes],
  )
  const brain = useMemo(() => buildBrain(live, subjectKnowledge, fabric.edges), [live, subjectKnowledge, fabric])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [railQuery, setRailQuery] = useState('')
  const warmTopics = useMemo(
    () =>
      [...brain.topics].sort((a, b) => {
        const warm = (tp: Topic) => Math.max(...tp.members.map((m) => m.activation), tp.hub?.activation ?? 0)
        return warm(b) - warm(a) || b.members.length - a.members.length || (a.key < b.key ? -1 : 1)
      }),
    [brain.topics],
  )
  const matchedTopics = useMemo(() => {
    const q = railQuery.trim().toLowerCase()
    if (!q) return warmTopics
    return warmTopics.filter((tp) => tp.title.toLowerCase().includes(q))
  }, [warmTopics, railQuery])
  const shownTopics = matchedTopics.length > RAIL_CAP ? matchedTopics.slice(0, RAIL_CAP) : matchedTopics
  const railOverflow = matchedTopics.length - shownTopics.length
  const topic: Topic | null =
    selectedKey === UNCONNECTED_KEY
      ? null
      : warmTopics.find((tp) => tp.key === selectedKey) ?? warmTopics[0] ?? null
  const showUnconnected = selectedKey === UNCONNECTED_KEY || (!topic && brain.unconnected.length > 0)

  if (live.length === 0) {
    return <EmptyState icon={Network} title={t('brain.empty')} hint={t('brain.emptyHint')} />
  }

  useEffect(() => {
    localStorage.setItem('engram.brain.rail', railOpen ? '1' : '0')
  }, [railOpen])

  return (
    <div className="brain-view" data-testid="brain-view">
      <aside className={`brain-rail${railOpen ? '' : ' folded'}`}>
        <div className="section-label brain-rail-head">
          {railOpen && <span>{t('brain.railTitle', { count: brain.topics.length })}</span>}
          <button
            className="rail-toggle"
            data-testid={railOpen ? 'brain-rail-close' : 'brain-rail-open'}
            title={railOpen ? t('rail.hide') : t('rail.show')}
            onClick={() => setRailOpen(!railOpen)}
          >
            {railOpen ? (
              <PanelLeftClose size={15} strokeWidth={1.8} aria-hidden />
            ) : (
              <PanelLeftOpen size={15} strokeWidth={1.8} aria-hidden />
            )}
          </button>
        </div>
        {brain.topics.length > 8 && (
          <input
            className="brain-rail-filter"
            data-testid="brain-rail-filter"
            placeholder={t('brain.railFilter')}
            value={railQuery}
            onChange={(e) => setRailQuery(e.target.value)}
          />
        )}
        {shownTopics.map((tp) => (
          <button
            key={tp.key}
            className={`brain-item${topic?.key === tp.key && !showUnconnected ? ' selected' : ''}`}
            data-testid="brain-topic"
            onClick={() => setSelectedKey(tp.key)}
          >
            <span className="brain-item-title">{stripEmoji(tp.title)}</span>
            <span className="brain-item-meta">
              {t(tp.members.length === 1 ? 'brain.memberOne' : 'brain.memberCount', { count: tp.members.length })}
              {tp.agingCount > 0 && <span className="brain-item-aging"> · {t('brain.aging', { count: tp.agingCount })}</span>}
            </span>
          </button>
        ))}
        {railOverflow > 0 && <div className="empty-hint">{t('brain.railMore', { count: railOverflow })}</div>}
        {brain.topics.length === 0 && <div className="empty-hint">{t('brain.noTopics')}</div>}
        {brain.topics.length > 0 && shownTopics.length === 0 && (
          <div className="empty-hint">{t('brain.railNoMatch')}</div>
        )}
        {brain.unconnected.length > 0 && (
          <button
            className={`brain-item unconnected${showUnconnected ? ' selected' : ''}`}
            data-testid="brain-unconnected"
            onClick={() => setSelectedKey(UNCONNECTED_KEY)}
          >
            <span className="brain-item-title">
              <Unlink size={11} strokeWidth={1.8} aria-hidden /> {t('brain.unconnected')}
            </span>
            <span className="brain-item-meta">
              {t(brain.unconnected.length === 1 ? 'brain.memberOne' : 'brain.memberCount', { count: brain.unconnected.length })}
            </span>
          </button>
        )}
      </aside>

      <div className="brain-scroll">
        {showUnconnected ? (
          <article className="brain-page" data-testid="brain-page">
            <header className="brain-header">
              <h1 className="brain-title">{t('brain.unconnected')}</h1>
              <div className="brain-header-row">
                <div className="brain-meta">{t('brain.unconnectedHint')}</div>
              </div>
            </header>
            <section className="brain-section">
              <div className="brain-section-head">{t('brain.memoriesPlain', { count: brain.unconnected.length })}</div>
              <div className="brain-memories">
                {(showAllUnconnected ? brain.unconnected : brain.unconnected.slice(0, UNCONNECTED_CAP)).map((n) => (
                  <MemoryRow key={n.id} note={n} onOpen={() => openNote(n.id)} />
                ))}
              </div>
              {!showAllUnconnected && brain.unconnected.length > UNCONNECTED_CAP && (
                <button className="brain-more" onClick={() => setShowAllUnconnected(true)}>
                  {t('brain.showMore', { count: brain.unconnected.length - UNCONNECTED_CAP })}
                </button>
              )}
            </section>
          </article>
        ) : topic ? (
          <TopicPage
            data={{ title: topic.title, hubId: topic.hub?.id ?? null, members: topic.members, agingCount: topic.agingCount }}
            t={t}
            onOpen={openNote}
            onCosmos={() => {
              // Tell the sky which stars this topic owns (hub included) so the
              // jump lands with the constellation spotlit, then switch tabs.
              const ids = topic.members.map((m) => m.id)
              if (topic.hub) ids.push(topic.hub.id)
              window.dispatchEvent(new CustomEvent('engram:sky-focus', { detail: { ids } }))
              setActivity('sky')
            }}
          />
        ) : (
          <EmptyState icon={Network} title={t('brain.empty')} hint={t('brain.emptyHint')} />
        )}
      </div>
    </div>
  )
}
