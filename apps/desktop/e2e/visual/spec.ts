import type { Page } from '@playwright/test'

export type Rgba = [number, number, number, number]
export type CheckStatus = 'pass' | 'fail' | 'missing' | 'deferred'
export type RowStatus = CheckStatus | 'partial'
export interface Check { what: string; selector: string; measured: number | string | null; expected: string; status: CheckStatus }
export interface RowRecord { row: number; status: RowStatus; checks: Check[] }

export const STATES = ['chat', 'sidebar-states', 'info-overview', 'info-routines', 'info-past', 'create-dialog', 'empty-bot', 'toast', 'settings-review', 'onboarding-bot', 'avatar-gallery', 'avatar-picker'] as const
export type StateName = typeof STATES[number]
export const ROW_STATUSES: readonly RowStatus[] = ['pass', 'fail', 'missing', 'partial', 'deferred']
export const CHECK_STATUSES: readonly CheckStatus[] = ['pass', 'fail', 'missing', 'deferred']

export interface ChecklistRow { row: number; target: string; assertion: string; states: StateName[] }

const SIDE: StateName[] = ['chat', 'sidebar-states']
export const CHECKLIST: ChecklistRow[] = [
  { row: 1, target: '사이드바', assertion: '폭 240±2, 배경 = `--rail-bg`', states: SIDE },
  { row: 2, target: '대표 봇 영역', assertion: '아바타 64±1(해 실루엣), 배지 18±1, 이름 12px', states: SIDE },
  { row: 3, target: '섹션 머리', assertion: '13px/400, `text-transform: none`', states: SIDE },
  { row: 4, target: '봇 행', assertion: '높이 58±2, 아바타 36±1, 이름 15/500, 미리보기 13, 넘치면 말줄임', states: SIDE },
  { row: 5, target: '선택 행', assertion: '좌우 inset 8±2, 모서리 10±1', states: SIDE },
  { row: 6, target: '위쪽 둥근 버튼', assertion: '34±2, 모서리 50%', states: ['chat'] },
  { row: 7, target: '대화 열', assertion: '폭 `min(960, main−48)`±2, 본문 영역 가운데 ±2', states: ['chat'] },
  { row: 8, target: '봇 말풍선', assertion: '최대 폭 560±4, 모서리 18, 여백 10/14, 15px/22px, 꼬리 없음', states: ['chat'] },
  { row: 9, target: '사용자 말풍선', assertion: '오른쪽 끝이 열 오른쪽 끝 ±2', states: ['chat'] },
  { row: 10, target: '시각 구분선', assertion: '본문 가운데 ±4, 13px', states: ['chat'] },
  { row: 11, target: '질문 카드', assertion: '폭 560±4, 모서리 22, 배지 24, 버튼 높이 36±2', states: ['chat'] },
  { row: 12, target: '입력창', assertion: '높이 44±2, 모서리 ≥22, 보내기 30±1, 열과 왼쪽 끝 일치 ±2', states: ['chat'] },
  { row: 13, target: '제목 알약', assertion: '높이 36±2, 아바타 20±1, 본문 가운데 ±4', states: ['chat'] },
  { row: 14, target: '토스트', assertion: '폭 340±8, 위·오른쪽 16±2, 모서리 18', states: ['toast'] },
  { row: 15, target: '정보 창', assertion: '폭 320±2, 개요 아바타 96±1, 열고 닫을 때 대화 열 넘침 없음', states: ['info-overview'] },
  { row: 16, target: '대비', assertion: '본문·미리보기·시각 ≥4.5:1, 포커스 링 ≥3:1 (light/dark)', states: SIDE },
  { row: 17, target: '넘침', assertion: '보이는 요소 중 말줄임이 아닌데 `scrollWidth > clientWidth`인 것 0개', states: ['chat', 'sidebar-states', 'info-overview', 'info-routines', 'info-past', 'create-dialog', 'empty-bot', 'toast', 'settings-review', 'onboarding-bot', 'avatar-picker'] },
  { row: 18, target: '아바타', assertion: '갤러리의 모든 칸이 20/36/64/96 ±1. 외곽 대비 ≥3:1. 작업 중 애니메이션 속성은 `transform`만. 모션 줄이기 설정이면 `getAnimations()`가 0개', states: ['avatar-gallery'] },
]

function luminance(c: Rgba): number {
  const [r, g, b] = c.slice(0, 3).map(v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

const over = (top: Rgba, under: Rgba): Rgba => {
  const a = top[3] + under[3] * (1 - top[3])
  if (a === 0) return [0, 0, 0, 0]
  const ch = (i: number) => (top[i]! * top[3] + under[i]! * under[3] * (1 - top[3])) / a
  return [ch(0), ch(1), ch(2), a]
}

export function contrastRatio(fg: Rgba, layers: Rgba[]): number | null {
  const opaque = layers.findIndex(layer => layer[3] === 1)
  if (opaque < 0) return null
  let base = layers[opaque]!
  for (let i = opaque - 1; i >= 0; i--) base = over(layers[i]!, base)
  const a = luminance(over(fg, base)), b = luminance(base)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export function overflowCount(items: { scrollWidth: number; clientWidth: number; ellipsis: boolean }[]): number {
  return items.filter(item => !item.ellipsis && item.scrollWidth > item.clientWidth).length
}

export function radiusPx(computed: string, width: number, height: number): number | null {
  const m = /^(-?\d*\.?\d+)(px|%)$/.exec(computed.trim())
  if (!m) return null
  const n = Number(m[1])
  return m[2] === 'px' ? n : n / 100 * Math.min(width, height)
}

export function maxWidthStatus(maxWidth: string, width: number): 'pass' | 'fail' | 'missing' {
  if (maxWidth.trim() === 'none') return 'fail'
  const m = /^(-?\d*\.?\d+)px$/.exec(maxWidth.trim())
  if (!m || !Number.isFinite(width)) return 'missing'
  const px = Number(m[1])
  return px >= 556 && px <= 564 && width <= px ? 'pass' : 'fail'
}

const pxOf = (value: string | undefined): number | null => {
  const m = value === undefined ? null : /^(-?\d*\.?\d+)px$/.exec(value.trim())
  return m ? Number(m[1]) : null
}
const numOf = (value: string | undefined): number | null => (value !== undefined && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : null)

export function rowStatus(checks: Check[]): RowStatus {
  const has = (s: CheckStatus) => checks.some(c => c.status === s)
  if (!checks.length) return 'missing'
  if (checks.every(c => c.status === 'deferred')) return 'deferred'
  return has('missing') ? 'missing' : has('fail') ? 'fail' : has('deferred') ? 'partial' : 'pass'
}

const make = (what: string, selector: string, measured: number | string | null, expected: string, ok: boolean | null): Check =>
  ({ what, selector, measured, expected, status: ok === null || measured === null ? 'missing' : ok ? 'pass' : 'fail' })

export function near(what: string, selector: string, value: number | null, target: number, tol: number, expected?: string): Check {
  return make(what, selector, value, expected ?? `${target}±${tol}`, value === null ? null : Math.abs(value - target) <= tol)
}
export function atLeast(what: string, selector: string, value: number | null, min: number, expected: string): Check {
  return make(what, selector, value, expected, value === null ? null : value >= min)
}

export interface EllipsisStyle { textOverflow: string; overflowX: string }
export interface EllipsisDescendant extends EllipsisStyle { visible: boolean; holdsPreviewText: boolean }
const ellipsized = (s: EllipsisStyle) => s.textOverflow === 'ellipsis' && s.overflowX !== 'visible'
export function hasEllipsis(node: EllipsisStyle, descendants: EllipsisDescendant[]): boolean {
  return ellipsized(node) || descendants.some(d => d.visible && d.holdsPreviewText && ellipsized(d))
}
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
// The holder carries the whole preview text in its own text nodes; a label holding part of it never qualifies.
export function previewHolder(ownText: string, wholeText: string): boolean {
  const whole = squash(wholeText)
  return whole !== '' && squash(ownText) === whole
}
export function equals(what: string, selector: string, value: string | null, want: string): Check {
  return make(what, selector, value, want, value === null ? null : value === want)
}
export const deferred = (what: string, selector: string, reason: string): Check => ({ what, selector, measured: null, expected: reason, status: 'deferred' })

interface Probe { left: number; right: number; width: number; height: number; centerX: number; style: Record<string, string> }
const PROPS = ['fontSize', 'fontWeight', 'lineHeight', 'textTransform', 'textOverflow', 'overflowX', 'borderTopLeftRadius', 'paddingTop', 'paddingBottom', 'paddingLeft', 'paddingRight', 'maxWidth', 'backgroundColor', 'boxSizing', 'borderLeftWidth', 'borderRightWidth'] as const

async function probe(page: Page, selector: string): Promise<Probe | null> {
  return page.evaluate(({ sel, props }) => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(one => one.getClientRects().length > 0 && getComputedStyle(one).visibility !== 'hidden')
    if (!el) return null
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el), style: Record<string, string> = {}
    for (const p of props) style[p] = cs[p as keyof CSSStyleDeclaration] as string
    return { left: r.left, right: r.right, width: r.width, height: r.height, centerX: r.left + r.width / 2, style }
  }, { sel: selector, props: [...PROPS] as string[] })
}

async function rgbaOf(page: Page, colors: string[]): Promise<(Rgba | null)[]> {
  return page.evaluate(list => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (!ctx) return list.map(() => null)
    ctx.canvas.width = 1
    ctx.canvas.height = 1
    ctx.globalCompositeOperation = 'copy'
    return list.map(value => {
      ctx.fillStyle = '#010203'
      ctx.fillStyle = value
      const first = ctx.fillStyle
      ctx.fillStyle = '#040506'
      ctx.fillStyle = value
      if (!value || first !== ctx.fillStyle) return null
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255] as [number, number, number, number]
    })
  }, colors)
}

async function tokenColor(page: Page, name: string): Promise<string | null> {
  return page.evaluate(variable => {
    if (!getComputedStyle(document.documentElement).getPropertyValue(variable).trim()) return null
    const el = document.createElement('div')
    el.style.backgroundColor = `var(${variable})`
    document.body.append(el)
    const value = getComputedStyle(el).backgroundColor
    el.remove()
    return value
  }, name)
}

async function textContrast(page: Page, selector: string): Promise<number | null> {
  const found = await page.evaluate(sel => {
    const el = [...document.querySelectorAll<HTMLElement>(sel)].find(one => one.getClientRects().length > 0 && getComputedStyle(one).visibility !== 'hidden')
    if (!el) return null
    const layers: string[] = []
    for (let node: Element | null = el; node; node = node.parentElement) {
      const cs = getComputedStyle(node)
      if (cs.backgroundImage !== 'none') return null
      layers.push(cs.backgroundColor)
    }
    return { fg: getComputedStyle(el).color, layers }
  }, selector)
  if (!found) return null
  const [fg, ...layers] = await rgbaOf(page, [found.fg, ...found.layers])
  if (!fg || layers.some(l => l === null)) return null
  return contrastRatio(fg, layers as Rgba[])
}

const SIDEBAR = '.app-sidebar', MAIN = '[data-testid="bots-view"]', COLUMN = `${MAIN} .bots-column`
const ROW = '.sidebar-conversations .bots-row', ACTIVE = `${ROW}.active`, PREVIEW = `${ROW} .sidebar-conversation-preview`
const ASSISTANT = `${MAIN} .bots-thread .bubble-msg.assistant`, USER = `${MAIN} .bots-thread .bubble-msg.user`
const DIVIDER = `${MAIN} .bubble-time-divider`, CARD = `${MAIN} .bots-thread .decision-card`, COMPOSER = `${MAIN} .bots-write .chat-write`
const PILL = `${MAIN} .bots-title-pill`, PRIMARY = '.sidebar-primary'

type P = Probe | null
const w = (p: P) => p?.width ?? null, h = (p: P) => p?.height ?? null
const st = (p: P, k: typeof PROPS[number]) => p?.style[k]
const radius = (p: P) => (p ? radiusPx(p.style['borderTopLeftRadius'] ?? '', p.width, p.height) : null)
const size = (row: string, sel: string, p: P, target: number, tol: number) => [near(`${row} width`, sel, w(p), target, tol), near(`${row} height`, sel, h(p), target, tol)]

interface RawDesc extends EllipsisStyle { visible: boolean; ownText: string }
interface RawBox extends EllipsisStyle { scrollWidth: number; clientWidth: number; preview: boolean; wholeText: string; descendants: RawDesc[] }

async function boxes(page: Page, root: string): Promise<RawBox[] | null> {
  return page.evaluate(sel => {
    const top = document.querySelector(sel)
    if (!top) return null
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    return [top, ...top.querySelectorAll('*')].filter(visible).map(el => {
      const cs = getComputedStyle(el), preview = el.matches('.sidebar-conversation-preview')
      const descendants = preview ? [...el.querySelectorAll('*')].map(d => {
        const ds = getComputedStyle(d)
        return { textOverflow: ds.textOverflow, overflowX: ds.overflowX, visible: visible(d), ownText: [...d.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent ?? '').join('') }
      }) : []
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, textOverflow: cs.textOverflow, overflowX: cs.overflowX, preview, wholeText: preview ? el.textContent ?? '' : '', descendants }
    })
  }, root)
}

const STATE_DEFERRED = (row: number, what: string, reason: string): Check[] => [deferred(`row ${row} ${what}`, '-', reason)]

async function measureRow(page: Page, row: number): Promise<Check[]> {
  const q = (sel: string) => probe(page, sel)
  switch (row) {
    case 1: {
      const side = await q(SIDEBAR), token = await tokenColor(page, '--rail-bg')
      const [bg, want] = side && token ? await rgbaOf(page, [st(side, 'backgroundColor') ?? '', token]) : [null, null]
      const same = bg && want ? bg.every((v, i) => v === want[i]) : null
      return [near('sidebar width', SIDEBAR, w(side), 240, 2),
        make('sidebar background', SIDEBAR, bg ? `rgba(${bg.join(',')})` : null, want ? `= --rail-bg rgba(${want.join(',')})` : '= --rail-bg (unresolved)', same)]
    }
    case 2: {
      const avatar = await q(`${PRIMARY} .bot-avatar`), badge = await q(`${PRIMARY}-badge`), name = await q(`${PRIMARY}-name`)
      return [...size('primary avatar', `${PRIMARY} .bot-avatar`, avatar, 64, 1), deferred('primary avatar sun silhouette', `${PRIMARY} .bot-avatar`, 'deferred: sun silhouette is not measurable by geometry'),
        ...size('primary badge', `${PRIMARY}-badge`, badge, 18, 1), near('primary name font-size', `${PRIMARY}-name`, pxOf(st(name, 'fontSize')), 12, 0)]
    }
    case 3: {
      const sel = '.sidebar-folder-head .sidebar-item-main > span', head = await q(sel)
      return [near('section head font-size', sel, pxOf(st(head, 'fontSize')), 13, 0), near('section head font-weight', sel, numOf(st(head, 'fontWeight')), 400, 0),
        equals('section head text-transform', sel, st(head, 'textTransform') ?? null, 'none')]
    }
    case 4: {
      const r = await q(ROW), av = await q(`${ROW} .comet-avatar`), name = await q(`${ROW} .sidebar-conversation-name`)
      const pv = await q(PREVIEW), all = await boxes(page, '.sidebar-conversations'), previews = all?.filter(b => b.preview) ?? []
      const ok = previews.filter(b => hasEllipsis(b, b.descendants.map(d => ({ ...d, holdsPreviewText: previewHolder(d.ownText, b.wholeText) })))).length
      return [near('bot row height', ROW, h(r), 58, 2), ...size('bot row avatar', `${ROW} .comet-avatar`, av, 36, 1),
        near('bot name font-size', `${ROW} .sidebar-conversation-name`, pxOf(st(name, 'fontSize')), 15, 0),
        near('bot name font-weight', `${ROW} .sidebar-conversation-name`, numOf(st(name, 'fontWeight')), 500, 0),
        near('preview font-size', PREVIEW, pxOf(st(pv, 'fontSize')), 13, 0),
        make('preview ellipsis', PREVIEW, previews.length ? `${ok}/${previews.length}` : null, 'every visible preview: text-overflow ellipsis, overflow-x not visible (node or its preview-text holder)', previews.length ? ok === previews.length : null)]
    }
    case 5: {
      const side = await q(SIDEBAR), active = await q(ACTIVE), ok = side && active
      return [near('active row left inset', ACTIVE, ok ? active.left - side.left : null, 8, 2), near('active row right inset', ACTIVE, ok ? side.right - active.right : null, 8, 2),
        near('active row radius', ACTIVE, radius(active), 10, 1)]
    }
    case 6: {
      const sel = `${MAIN} .bots-top-button`, b = await q(sel)
      return [...size('top button', sel, b, 34, 2), b ? atLeast('top button radius', sel, radius(b), Math.min(b.width, b.height) / 2 - 0.5, '50% (≥ min(w,h)/2 − 0.5)') : make('top button radius', sel, null, '50% (≥ min(w,h)/2 − 0.5)', null)]
    }
    case 7: {
      const main = await q(MAIN), col = await q(COLUMN), ok = main && col
      return [main ? near('column width', COLUMN, w(col), Math.min(960, main.width - 48), 2, 'min(960, main−48)±2') : make('column width', COLUMN, w(col), 'min(960, main−48)±2', null),
        near('column center offset', COLUMN, ok ? col.centerX - main.centerX : null, 0, 2, 'main center ±2')]
    }
    case 8: {
      const b = await q(ASSISTANT)
      const sum = (...v: (number | null)[]) => (v.every(x => x !== null) ? (v as number[]).reduce((a, x) => a + x, 0) : null)
      const inset = b && st(b, 'boxSizing') !== 'border-box' ? sum(pxOf(st(b, 'paddingLeft')), pxOf(st(b, 'paddingRight')), pxOf(st(b, 'borderLeftWidth')), pxOf(st(b, 'borderRightWidth'))) : 0
      const boxWidth = b && inset !== null ? b.width - inset : null
      const cap = b && boxWidth !== null ? maxWidthStatus(st(b, 'maxWidth') ?? '', boxWidth) : 'missing'
      return [{ what: 'assistant max-width', selector: ASSISTANT, measured: b ? `${st(b, 'maxWidth')}; width ${boxWidth === null ? '?' : Math.round(boxWidth * 10) / 10}` : null, expected: '560±4px, width ≤ max-width', status: cap }, near('assistant radius', ASSISTANT, radius(b), 18, 0),
        near('assistant padding-top', ASSISTANT, pxOf(st(b, 'paddingTop')), 10, 0), near('assistant padding-bottom', ASSISTANT, pxOf(st(b, 'paddingBottom')), 10, 0),
        near('assistant padding-left', ASSISTANT, pxOf(st(b, 'paddingLeft')), 14, 0), near('assistant padding-right', ASSISTANT, pxOf(st(b, 'paddingRight')), 14, 0),
        near('assistant font-size', ASSISTANT, pxOf(st(b, 'fontSize')), 15, 0), near('assistant line-height', ASSISTANT, pxOf(st(b, 'lineHeight')), 22, 0),
        deferred('assistant no tail', ASSISTANT, 'deferred: tail absence needs the redesigned bubble shape')]
    }
    case 9: {
      const u = await q(USER), col = await q(COLUMN)
      return [near('user bubble right offset', USER, u && col ? u.right - col.right : null, 0, 2, 'column right ±2')]
    }
    case 10: {
      const main = await q(MAIN), d = await q(DIVIDER)
      return [near('divider center offset', DIVIDER, main && d ? d.centerX - main.centerX : null, 0, 4, 'body center ±4'), near('divider font-size', DIVIDER, pxOf(st(d, 'fontSize')), 13, 0)]
    }
    case 11: {
      const card = await q(CARD), badge = await q(`${CARD} .decision-card-badge`), btn = await q(`${CARD} .decision-card-actions button`)
      return [near('card width', CARD, w(card), 560, 4), near('card radius', CARD, radius(card), 22, 0),
        ...size('card badge', `${CARD} .decision-card-badge`, badge, 24, 0), near('card button height', `${CARD} .decision-card-actions button`, h(btn), 36, 2)]
    }
    case 12: {
      const c = await q(COMPOSER), send = await q(`${MAIN} .bots-write .chat-send-btn`), col = await q(COLUMN)
      return [near('composer height', COMPOSER, h(c), 44, 2), atLeast('composer radius', COMPOSER, radius(c), 22, '≥22'),
        ...size('send button', `${MAIN} .bots-write .chat-send-btn`, send, 30, 1), near('composer left offset', COMPOSER, c && col ? c.left - col.left : null, 0, 2, 'column left ±2')]
    }
    case 13: {
      const main = await q(MAIN), pill = await q(PILL), av = await q(`${PILL} .bot-avatar`)
      return [near('title pill height', PILL, h(pill), 36, 2), ...size('title pill avatar', `${PILL} .bot-avatar`, av, 20, 1),
        near('title pill center offset', PILL, main && pill ? pill.centerX - main.centerX : null, 0, 4, 'body center ±4')]
    }
    case 14: return STATE_DEFERRED(14, 'toast', 'deferred: toast state is fixme')
    case 15: return STATE_DEFERRED(15, 'info pane', 'deferred: info pane state is fixme')
    case 16: return [
      atLeast('assistant text contrast', ASSISTANT, await textContrast(page, ASSISTANT), 4.5, '≥4.5:1'),
      atLeast('preview text contrast', `${PREVIEW} > span`, await textContrast(page, `${PREVIEW} > span`), 4.5, '≥4.5:1'),
      atLeast('time divider contrast', DIVIDER, await textContrast(page, DIVIDER), 4.5, '≥4.5:1'),
      deferred('focus ring contrast', ':focus-visible', 'deferred: focus ring ≥3:1 follow-up')]
    case 17: {
      const sel = '[data-testid="shell"]', all = await boxes(page, sel)
      const items = all?.map(b => ({ scrollWidth: b.scrollWidth, clientWidth: b.clientWidth, ellipsis: hasEllipsis(b, b.descendants.map(d => ({ ...d, holdsPreviewText: previewHolder(d.ownText, b.wholeText) }))) }))
      return [items ? near('non-ellipsis horizontal overflow count', `${sel}, ${sel} *`, overflowCount(items), 0, 0, '0') : make('non-ellipsis horizontal overflow count', `${sel}, ${sel} *`, null, '0', null)]
    }
    default: return STATE_DEFERRED(18, 'avatar gallery', 'deferred: avatar gallery state is owned by B3-1')
  }
}

export async function measureChat(page: Page): Promise<RowRecord[]> {
  const rows: RowRecord[] = []
  for (const item of CHECKLIST) {
    const checks = await measureRow(page, item.row)
    rows.push({ row: item.row, status: rowStatus(checks), checks })
  }
  return rows
}

const r1 = (x: number) => Math.round(x * 10) / 10

export function serializeMetrics(rows: RowRecord[]): string {
  const out = rows.map(r => ({ row: r.row, status: r.status, checks: r.checks.map(c => ({ what: c.what, selector: c.selector, measured: typeof c.measured === 'number' ? r1(c.measured) : c.measured, expected: c.expected, status: c.status })) }))
  return JSON.stringify(out, null, 2) + '\n'
}
