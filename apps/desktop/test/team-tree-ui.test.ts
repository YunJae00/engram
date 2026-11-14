import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberState } from 'core'

const fake = vi.hoisted(() => ({
  calls: [] as { resolve(tasks: unknown): void; reject(error: Error): void }[],
  handler: (() => undefined) as (event: { type: string }) => void,
}))
vi.mock('../src/renderer/src/api.js', () => ({
  api: {
    tasksList: () => new Promise((resolve, reject) => { fake.calls.push({ resolve, reject }) }),
    onEvent: (handler: (event: { type: string }) => void) => { fake.handler = handler; return () => undefined },
  },
}))
import { SidebarTeamLine, TeamSummary } from '../src/renderer/src/components/TeamSummary.js'
import { TeamTree } from '../src/renderer/src/components/TeamTree.js'
import { teamT } from '../src/renderer/src/i18n-team.js'
import { activeTeams, lineLang, memberChip, memberResult, teamForest, teamSummaryText, type TeamMemberView, type TeamNode } from '../src/renderer/src/lib/teamView.js'

const member = (id: string, parentId: string | null, state: MemberState, extra: Partial<TeamMemberView> = {}): TeamMemberView => ({ id, parentId, role: `역할 ${id.slice(1)}`, state, result: undefined, ...extra })
const task = (botId: string, state: string, members?: unknown, id = `t-${botId}`) => ({ id, botId, state, ...(members ? { team: { members } } : {}) })
const tree = (members: TeamMemberView[], lang: 'ko' | 'en' = 'ko') => renderToStaticMarkup(createElement(TeamTree, { members, lang }))
const summary = (members: TeamMemberView[] | undefined, lang: 'ko' | 'en' = 'ko') => renderToStaticMarkup(createElement(TeamSummary, { team: members && { taskId: 't', members }, lang }))
const line = (members: TeamMemberView[] | undefined, lang: 'ko' | 'en' = 'ko') => renderToStaticMarkup(createElement(SidebarTeamLine, { team: members && { taskId: 't', members }, lang }))
const ids = (nodes: TeamNode[]): unknown[] => nodes.map(node => [node.member.id, ids(node.children)])
const liOf = (html: string, id: string) => html.slice(html.indexOf(`data-member-id="${id}"`)).split('>')[0]!

describe('team summary text', () => {
  it('counts members by state in ko and en', () => {
    const four = [member('m1', null, 'working'), member('m2', null, 'hired'), member('m3', null, 'done'), member('m4', null, 'released')]
    expect(teamSummaryText(four, 'ko')).toBe('팀 4명 · 2명 작업 중')
    expect(teamSummaryText(four, 'en')).toBe('Team of 4 · 2 working')
    expect(teamSummaryText([member('m1', null, 'reviewing'), member('m2', null, 'waiting')], 'en')).toBe('Team of 2 · 2 working')
    const ended = [member('m1', null, 'done'), member('m2', null, 'released')]
    expect(teamSummaryText(ended, 'ko')).toBe('팀 2명 · 모두 끝')
    expect(teamSummaryText(ended, 'en')).toBe('Team of 2 · all finished')
    const failed = [member('m1', null, 'working'), member('m2', null, 'failed')]
    expect(teamSummaryText(failed, 'ko')).toBe('팀 2명 · 1명 작업 중 · 1명 실패')
    expect(teamSummaryText(failed, 'en')).toBe('Team of 2 · 1 working · 1 failed')
  })

  it('shows no English in a Korean thread', () => {
    const members = [member('m1', null, 'done', { result: '부산 숙소 세 곳 비교표' }), member('m2', 'm1', 'released', { result: 'Failed: its lead\'s turn ended.' }), member('m3', null, 'failed'), member('m4', null, 'reviewing'), member('m5', null, 'working')]
    const text = (summary(members) + line(members)).replace(/<[^>]*>/g, '')
    expect(text).toContain('팀 5명')
    expect(text).not.toMatch(/[A-Za-z]/)
    expect(summary(members)).toContain(`aria-label="${teamT('ko', 'treeLabel')}"`)
  })

  it('follows the thread language, then the last message, then the app', () => {
    expect(lineLang([{ role: 'user', text: '숙소 찾아줘' }])).toBe('ko')
    expect(lineLang([{ role: 'user', text: 'find a hotel' }])).toBe('en')
    expect(lineLang([], { role: 'user', text: '숙소 찾아줘' })).toBe('ko')
  })
})

describe('team tree', () => {
  it('nests by parentId to depth 3 and keeps hire order', () => {
    const members = [member('m1', null, 'working'), member('m2', 'm1', 'working'), member('m3', 'm2', 'working'), member('m4', 'm1', 'done'), member('m5', null, 'hired')]
    expect(ids(teamForest(members))).toEqual([['m1', [['m2', [['m3', []]]], ['m4', []]]], ['m5', []]])
    const html = tree(members)
    const at = (id: string) => html.indexOf(`data-member-id="${id}"`)
    const depthAt = (id: string) => html.slice(0, at(id)).split('<ul').length - html.slice(0, at(id)).split('</ul>').length
    expect([depthAt('m1'), depthAt('m2'), depthAt('m3'), depthAt('m4'), depthAt('m5')]).toEqual([1, 2, 3, 2, 1])
    expect(at('m2')).toBeLessThan(at('m4'))
  })

  it('holds on orphans, cycles and over-deep chains', () => {
    expect(ids(teamForest([member('m1', 'gone', 'working')]))).toEqual([['m1', []]])
    const cycle = [member('m1', 'm2', 'working'), member('m2', 'm1', 'working')]
    expect(ids(teamForest(cycle))).toEqual([['m1', [['m2', []]]]])
    expect(tree(cycle).match(/<li/g)).toHaveLength(2)
    const deep = [member('m1', null, 'working'), member('m2', 'm1', 'working'), member('m3', 'm2', 'working'), member('m4', 'm3', 'working')]
    expect(tree(deep).match(/<li/g)).toHaveLength(4)
  })

  it('labels each state with one of five chips', () => {
    const chips: [MemberState, string, string][] = [['hired', '작업 중', 'Working'], ['working', '작업 중', 'Working'], ['waiting', '작업 중', 'Working'], ['reviewing', '검토 중', 'Reviewing'], ['done', '끝', 'Done'], ['failed', '실패', 'Failed'], ['released', '해산', 'Released']]
    for (const [state, ko, en] of chips) {
      expect(teamT('ko', memberChip(state))).toBe(ko)
      expect(teamT('en', memberChip(state))).toBe(en)
      const html = tree([member('m1', null, state)], 'ko')
      expect(html).toContain(`data-state="${state}"`)
      expect(html).toContain(`>${ko}</span>`)
    }
  })

  it('dims released members only', () => {
    const html = tree([member('m1', null, 'released'), member('m2', 'm1', 'working'), member('m3', null, 'done')])
    expect(liOf(html, 'm1')).toContain('data-dim="true"')
    expect(liOf(html, 'm2')).not.toContain('data-dim')
    expect(liOf(html, 'm3')).not.toContain('data-dim')
  })

  it('shows a one-line result only for finished members', () => {
    expect(memberResult(member('m1', null, 'done', { result: '**비교표** 완성' }))).toBe('비교표 완성')
    expect(memberResult(member('m1', null, 'released', { result: '세 곳 정리\n\nNot reviewed by its lead: m4' }))).toBe('세 곳 정리')
    expect(memberResult(member('m1', null, 'released', { result: 'Failed: its lead\'s turn ended.' }))).toBe('')
    for (const state of ['working', 'waiting', 'failed', 'hired', 'reviewing'] as const) expect(memberResult(member('m1', null, state, { result: '어느 도시인가요' }))).toBe('')
    expect(memberResult(member('m1', null, 'done'))).toBe('')
    expect(memberResult(member('m1', null, 'done', { result: '가'.repeat(2000) })).length).toBeLessThanOrEqual(160)
    const html = tree([member('m1', null, 'done', { result: '세 곳 정리' }), member('m2', null, 'waiting', { result: '어느 도시인가요' })])
    expect(html).toContain('<div class="team-member-result" title="세 곳 정리">세 곳 정리</div>')
    expect(html).not.toContain('어느 도시인가요')
  })
})

describe('team card and sidebar line', () => {
  it('is collapsed by default with the tree mounted but hidden', () => {
    const html = summary([member('m1', null, 'working')])
    const button = /<button[^>]*>/.exec(html)![0]
    expect(button).toContain('type="button"')
    expect(button).toContain('aria-expanded="false"')
    const controls = /aria-controls="([^"]+)"/.exec(button)![1]!
    const disclosure = html.slice(html.indexOf(`<div id="${controls}"`)).split('>')[0]!
    expect(disclosure).toContain('data-open="false"')
    expect(disclosure).toContain('aria-hidden="true"')
    expect(html).toContain('data-member-id="m1"')
    expect(html).not.toContain('chat-approval')
  })

  it('renders nothing without a team', () => {
    expect(summary(undefined)).toBe('')
    expect(summary([])).toBe('')
    expect(line(undefined)).toBe('')
    expect(line([])).toBe('')
    expect(tree([])).toBe('')
  })

  it('gives the sidebar one line and no extra rows', () => {
    const html = line([member('m1', null, 'working'), member('m2', 'm1', 'done')], 'en')
    expect(html.match(/class="sidebar-team-line"/g)).toHaveLength(1)
    expect(html).toContain('Team of 2 · 1 working')
    expect(html).not.toMatch(/<li|<ul|<button/)
  })

  it('keeps a team only for the bot\'s latest task while it is live', () => {
    const members = [member('m1', null, 'working')]
    for (const state of ['queued', 'running', 'waiting']) expect(activeTeams([task('b', state, members)]).get('b')?.members).toHaveLength(1)
    for (const state of ['done', 'failed', 'stopped']) expect(activeTeams([task('b', state, members)]).size).toBe(0)
    expect(activeTeams([task('b', 'done', members, 'old'), task('b', 'running', undefined, 'new')]).size).toBe(0)
    const two = activeTeams([task('a', 'running', members), task('b', 'running', [member('m9', null, 'done')])])
    expect([two.get('a')?.members[0]?.id, two.get('b')?.members[0]?.id]).toEqual(['m1', 'm9'])
    expect(two.get('a')?.taskId).toBe('t-a')
  })

  it('drops malformed teams and members', () => {
    expect(activeTeams(undefined).size).toBe(0)
    expect(activeTeams([task('b', 'running', 'x')]).size).toBe(0)
    expect(activeTeams([null, 3, task('b', 'running', [null, { id: 'm1', role: 3, state: 'working' }, { id: 'm2', role: 'r', state: 'napping' }])]).size).toBe(0)
    expect(activeTeams([task('b', 'running', [{ id: 'm1', role: 'r', state: 'done', parentId: 4, result: 9, brief: 'secret' }])]).get('b')?.members).toEqual([{ id: 'm1', parentId: null, role: 'r', state: 'done', result: undefined }])
  })

  it('uses the motion token and respects reduced motion', () => {
    const css = readFileSync(join(import.meta.dirname, '../src/renderer/src/team-tree.css'), 'utf8')
    expect(css).toMatch(/\.team-member-in \{[^}]*animation: team-member-in 180ms var\(--ease-out\)/)
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.team-member-in, \.sidebar-team-line \{ animation: none; \}/)
    expect(reduced).toMatch(/\.team-summary > svg \{ transition: none; \}/)
  })
})

describe('team store', () => {
  type Store = typeof import('../src/renderer/src/lib/teamLive.js')['teamStore']
  let store: Store
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  const running = (state: MemberState = 'working') => [task('b', 'running', [member('m1', null, state)]), task('c', 'running', [member('m2', null, 'working')])]
  const answer = async (index: number, tasks: unknown) => { fake.calls[index]!.resolve(tasks); await settle() }
  beforeEach(async () => {
    fake.calls = []
    vi.resetModules()
    store = (await import('../src/renderer/src/lib/teamLive.js')).teamStore
  })

  it('loads once for any number of readers', async () => {
    const heard = vi.fn()
    store.subscribe(heard)
    store.subscribe(vi.fn())
    expect(fake.calls).toHaveLength(1)
    await answer(0, running())
    expect(store.get('b')?.members[0]?.id).toBe('m1')
    expect(heard).toHaveBeenCalledTimes(1)
    store.subscribe(vi.fn())
    expect(fake.calls).toHaveLength(1)
  })

  it('collapses a burst of events into one trailing read', async () => {
    store.subscribe(vi.fn())
    for (let i = 0; i < 5; i++) fake.handler({ type: 'tasks:changed' })
    expect(fake.calls).toHaveLength(1)
    await answer(0, running('working'))
    expect(fake.calls).toHaveLength(2)
    await answer(1, running('done'))
    expect(fake.calls).toHaveLength(2)
    expect(store.get('b')?.members[0]?.state).toBe('done')
  })

  it('keeps the last good team when a read fails, and reads again later', async () => {
    const heard = vi.fn()
    store.subscribe(heard)
    await answer(0, running())
    const before = store.get('b')
    fake.handler({ type: 'tasks:changed' })
    fake.calls[1]!.reject(new Error('busy'))
    await settle()
    expect(store.get('b')).toBe(before)
    expect(heard).toHaveBeenCalledTimes(1)
    fake.handler({ type: 'vault:ready' })
    expect(fake.calls).toHaveLength(3)
  })

  it('keeps unchanged teams by reference and replaces only what changed', async () => {
    const heard = vi.fn()
    store.subscribe(heard)
    await answer(0, running())
    const [b, c] = [store.get('b'), store.get('c')]
    fake.handler({ type: 'tasks:changed' })
    await answer(1, running())
    expect(store.get('b')).toBe(b)
    expect(heard).toHaveBeenCalledTimes(1)
    fake.handler({ type: 'tasks:changed' })
    await answer(2, running('reviewing'))
    expect(store.get('b')).not.toBe(b)
    expect(store.get('c')).toBe(c)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('drops the team when the task ends', async () => {
    const heard = vi.fn()
    store.subscribe(heard)
    await answer(0, running())
    fake.handler({ type: 'tasks:changed' })
    await answer(1, [task('b', 'done', [member('m1', null, 'done')]), running()[1]])
    expect(store.get('b')).toBeUndefined()
    expect(store.get('c')).toBeDefined()
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('reads again for a new reader after a failed first read', async () => {
    store.subscribe(vi.fn())
    fake.calls[0]!.reject(new Error('busy'))
    await settle()
    store.subscribe(vi.fn())
    expect(fake.calls).toHaveLength(2)
  })
})
