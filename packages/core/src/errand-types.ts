import type { Card } from './cards.js'
import type { Engine, EngineCwd } from './engine/types.js'

export interface ErrandRetrievedNote {
  id: string
  title: string
  body: string
  created: string
  meaning?: number
}

export interface WebFinding {
  url: string
  title: string
  snippet: string
}

export interface WebPage {
  requestedUrl?: string
  observation?: { page: string; document: number; revision: number }
  url: string
  title: string
  text: string
  links?: { text: string; url: string }[]
  controls?: string[]
  hidden?: string
  dialog?: string
  faults?: string[]
  downloads?: string[]
  wall?: 'login' | 'captcha'
  status?: number
}

export interface PageMove {
  ok: boolean
  refused?: string
  error?: string
  changed?: boolean
  theirs?: boolean
  later?: boolean
  committed?: boolean
}

export interface WebCourier {
  fetchPage(url: string, signal?: AbortSignal): Promise<WebPage>
  readOpen?(signal?: AbortSignal): Promise<WebPage>
  followRedirect?(url: string, signal?: AbortSignal): Promise<string | null>
  typeInto?(field: string, text: string, signal?: AbortSignal): Promise<{ ok: boolean }>
  clickOn?(target: string, signal?: AbortSignal): Promise<{ ok: boolean }>
  press?(target: string, signal?: AbortSignal): Promise<PageMove>
  typeText?(target: string, text: string, enter: boolean, signal?: AbortSignal): Promise<PageMove>
  choose?(target: string, option: string, signal?: AbortSignal): Promise<PageMove>
  scroll?(to: string, signal?: AbortSignal): Promise<PageMove>
  hover?(target: string, signal?: AbortSignal): Promise<PageMove>
  pressKey?(key: string, signal?: AbortSignal): Promise<PageMove>
  askBeforePress?(what: { words: string; url: string }): Promise<'approve' | 'always' | 'cancel'>
  pressPoint?(x: number, y: number, signal?: AbortSignal): Promise<PageMove>
  reveal?(word: string, signal?: AbortSignal): Promise<PageMove>
  look?(signal?: AbortSignal): Promise<{ data: string; mimeType: string } | null>
}

export interface ErrandDeps {
  engine: Engine
  workdir: EngineCwd
  retrieve(query: string, limit: number): Promise<ErrandRetrievedNote[]>
  courier?: WebCourier | null
}

export type ErrandPhase = 'plan' | 'gather' | 'web' | 'distill' | 'compose' | 'done' | 'failed'

export interface ErrandState {
  goal: string
  startedAt: string
  phase: ErrandPhase
  plan?: { queries: string[]; startUrls: string[]; noteTitle: string }
  gathered?: ErrandRetrievedNote[]
  web?: { url: string; title: string; text: string }[]
  skipped?: { url: string; reason: string }[]
  points?: { text: string; sources: string[] }[]
  error?: string
}

export interface ErrandResult {
  ok: boolean
  card?: Card
  title?: string
  sources: string[]
  pages: { url: string; title: string }[]
  skipped: { url: string; reason: string }[]
  error?: string
}

export interface ErrandOptions {
  signal?: AbortSignal
  onPhase?: (state: ErrandState) => void
  onWall?: (page: { url: string; wall: 'login' | 'captcha' }) => Promise<'resolved' | 'skip'>
  resume?: ErrandState
  now?: () => Date
}
