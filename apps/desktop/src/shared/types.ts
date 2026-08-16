// DTOs crossing the IPC boundary. The renderer never sees core objects or
// the filesystem — only these.
// MCP hookup (satellites): the generated client config + connect outcomes.
export interface McpInfoDto {
  configJson: string
  desktopConfigPath: string
  scriptExists: boolean
}
export interface McpConnectResultDto {
  ok: boolean
  code?: 'not-installed' | 'no-cli' | 'failed'
  detail?: string
}

export interface NoteDto {
  id: string
  title: string
  status: 'current' | 'superseded' | 'disputed' | 'draft' | 'archived'
  type: string
  decay: 'evergreen' | 'slow' | 'fast' | 'ephemeral'
  badge: string
  happened_at?: string
  timeline: 'pinned' | 'inferred' | 'ignore'
  owner?: string
  created: string
  updated: string
  // lineage/relation edges (the cosmos constellations + connection panels)
  supersedes: string[]
  derived_from: string[]
  // why each derived_from link exists (id → J2's one-line reason); sparse
  link_reasons?: Record<string, string>
  // origin path for imported notes ('import:<relative-path>'); drives topic grouping
  source?: string
  // folder-name label of the session the memory came from ("strata", "novel")
  context?: string
  // recall reinforcement: when this memory was last retrieved (opened / cited)
  last_recalled?: string
  // still wants something from me — drives the Today list and the sheet toggle
  open_loop?: boolean
  // 0..1 memory luminance (retrieval strength): 1 vivid, <0.3 dim — drives the
  // sky's brightness and the Brain's dimming. Computed in main (one curve).
  activation: number
  excerpt: string
}

// Mirrors core's LOOP_URGENCIES, most urgent first. Spelled out here rather
// than imported because this file is the renderer's only vocabulary — main
// asserts core's union into it, so a new bucket in core breaks the build.
export type LoopUrgencyDto = 'overdue' | 'today' | 'this-week' | 'later' | 'no-deadline'

// One open loop (a note that still wants something) for the Today surface.
// The bucket and the day count are computed in main from core's helpers: the
// renderer must not redo the UTC day math that keeps a date-only deadline
// "today" for the whole of that day instead of being born overdue.
export interface OpenLoopDto {
  id: string
  title: string
  urgency: LoopUrgencyDto
  // absent when the loop carries no deadline
  due_at?: string
  // whole days until due — 0 = today, negative = overdue, null = undated
  daysUntilDue: number | null
  // whole days since it was written — what an undated row shows instead of
  // repeating its own group heading
  daysOpen: number
}

export interface CardDto {
  id: string
  cardType: 'new-note' | 'supersede' | 'conflict' | 'stale' | 'merge' | 'chronology'
  targets: string[]
  rationale: string
  proposed: string
  status: 'proposed' | 'approved' | 'rejected' | 'dismissed'
  created: string
}

export interface CardDetailDto {
  card: CardDto
  targets: { id: string; title: string; body: string }[]
}

export interface InboxDto {
  files: { name: string; preview: string }[]
  failures: { kind: string; inputKey: string; error: string }[]
}

// Why an engine is unusable, in the four words a user can act on. Mirrors
// core's EngineErrorKind — spelled out here because this file is the
// renderer's only vocabulary, and main asserts core's union into it, so a new
// kind in core breaks the build instead of silently rendering nothing.
export type EngineHealthReason = 'auth' | 'quota' | 'network' | 'timeout' | 'crash' | 'unknown'

export interface EngineHealthDto {
  healthy: boolean
  reason?: EngineHealthReason
}

export interface LocalModelDto {
  id: string
  label: string
  desc: string
  approxGB: number
  ramGB: number
  tag: 'korean' | 'balanced' | 'light' | 'power'
  downloaded: boolean
  downloading: boolean
  active: boolean
}

export interface LocalModelsStateDto {
  models: LocalModelDto[]
  recommendedId: string
  ramGB: number
  serverReady: boolean
}

export interface EngineStatusDto {
  id: string
  installed: boolean
  loggedIn: boolean
  // live health verdict (boot ping + periodic auth re-check); undefined = not
  // measured yet. Carried on every engines list/change so a renderer reload
  // does not throw the verdict away and repaint a green dot.
  healthy?: boolean
  healthReason?: EngineHealthReason
}

export interface ChatTurnDto {
  role: 'user' | 'assistant'
  text: string
}

export interface ChatRequestDto {
  engineId: string
  message: string
  history: ChatTurnDto[]
  // the note the panel is focused on, if any
  noteId?: string
  // Which surface is asking. Chat events broadcast to every window, so the
  // in-app panel and the floating bubble must be able to ignore each other's
  // streams. Absent = 'panel' (older callers).
  channel?: 'panel' | 'bubble'
}

export interface SweepReportDto {
  executed: number
  skipped: number
  failed: number
  deferred: number
  briefWritten: boolean
  // Set when the librarian STOPPED rather than finished: the deferred work is
  // kept and retried, and the user is told which of the two things happened.
  haltReason?: 'quota' | 'auth'
}

export interface SearchHitDto {
  id: string
  title: string
  status: string
  badge: string
}

export interface MetaPatch {
  type?: string
  decay?: NoteDto['decay']
  happened_at?: string
  owner?: string
  // "this still wants something from me" — set by the librarian on capture and
  // correctable here, because it judges from the text alone and a note written
  // before the field existed can never be judged at all.
  open_loop?: boolean
}

export interface ApproveOptionsDto {
  choice?: 'A' | 'B' | 'both'
  action?: 'keep' | 'retire'
  proposed?: string
}

export interface SyncStatusDto {
  state: 'clean' | 'ahead' | 'behind' | 'diverged' | 'no-remote' | 'error'
  ahead: number
  behind: number
  conflictCards?: number
  // origin's URL when one is set — the backup dialog names the repo it is
  // attached to instead of just asserting "connected"
  remote?: string
}

// What the vault has been TOLD about names (workspace/aliases.md), so the
// Brain groups topics the same way the librarian does. Empty until the user
// or the librarian writes something — and empty means "guess cautiously",
// which is exactly the old behaviour.
// The similarity fabric: unlinked-but-semantically-close pairs, weighted 0..1.
// Empty until the embedding layer has indexed (or when it is off) — consumers
// degrade to the pure link graph.
export interface BrainFabricDto {
  edges: { a: string; b: string; w: number }[]
}

// One fading memory for the Today sheet: worth a glance, quiet for a while.
export interface FadingMemoryDto {
  id: string
  title: string
  daysQuiet: number
}

export interface SubjectKnowledgeDto {
  aliases: string[][]
  umbrella: string[]
}

export interface AbsorbStatusDto {
  pending: number
  total: number
}

// Result of connecting a workspace to a GitHub backup (browser-assisted flow).
// ok:false carries a clean, single-line reason (auth cancelled, empty repo, …);
// the "already connected to a different repo" case throws instead.
export interface GithubConnectResultDto {
  ok: boolean
  detail?: string
}

// Work the librarian hasn't seen yet: raw inbox captures + notes that are
// queued for absorption or were edited after the last sweep. Drives the Tidy
// badge and the no-engine banner ("N captures waiting").
export interface PendingWorkDto {
  inbox: number
  notes: number
  // true while the realtime capture pipeline is filing inbox items — lets a
  // freshly booted window pick up an in-flight run it never saw start.
  filing: boolean
}

export type EngramEvent =
  | { type: 'vault:changed' }
  | { type: 'notes:delta'; upserts: NoteDto[]; removed: string[] }
  // realtime capture pipeline (J1 filing) — distinct from a Tidy sweep so the
  // top bar can say "filing your capture" while it runs
  | { type: 'filing:start' }
  | { type: 'filing:done' }
  // zero-click MCP hookup refreshed a client's registration on boot
  | { type: 'mcp:autoconnected'; targets: string[] }
  // the first engine detection after boot has finished — until this lands the
  // shell must not claim there is no engine, it simply does not know yet
  | { type: 'engines:detected' }
  | { type: 'sweep:start' }
  | { type: 'sweep:job'; job: string; index: number; total: number }
  | { type: 'sweep:done'; report: SweepReportDto }
  | { type: 'sweep:error'; message: string }
  // Chat events broadcast to every window; `channel` says which surface asked
  // (in-app panel or the floating bubble) so the other one can ignore them.
  | { type: 'chat:token'; channel: 'panel' | 'bubble'; text: string }
  | { type: 'chat:done'; channel: 'panel' | 'bubble'; text: string }
  | { type: 'chat:error'; channel: 'panel' | 'bubble'; message: string }
  // The floating bubble asked the shell to open a note (a citation click).
  | { type: 'note:open'; id: string }
  // Settings were saved anywhere — live surfaces (the agent terminal) restyle
  // without a remount or an app restart.
  | { type: 'settings:changed'; settings: AppSettingsDto }
  // Local model download progress / registry state.
  | { type: 'localmodel:progress'; id: string; received: number; total: number }
  | { type: 'localmodels:changed'; state: LocalModelsStateDto }
  | { type: 'import:progress'; done: number; total: number }
  | { type: 'engines:changed'; engines: EngineStatusDto[] }
  // a newer app version was downloaded and will install on next quit
  | { type: 'update:ready'; version: string }
  // live health verdict for one engine — false means it is present but not
  // usable, and `reason` says which sentence (and which button) the user gets
  | { type: 'engine:health'; id: string; healthy: boolean; reason?: EngineHealthReason }
  | { type: 'window:fullscreen'; value: boolean }
  | { type: 'vault:ready' }
  // The floating question asked the shell to open Review instead.
  // Opening the vault failed outright. Without this the shell has no way to
  // distinguish "still opening" from "will never open" and shows its opening
  // state forever (see App.tsx).
  | { type: 'vault:error'; message: string; root: string }

export interface WorkspaceInfoDto {
  id: string
  name: string
  root: string
  kind: 'personal' | 'team'
}

export interface EngramApi {
  // workspace registry/switcher (app-level vaults)
  workspaceList(): Promise<{ current: string | null; vaults: WorkspaceInfoDto[] }>
  workspaceCreate(name: string): Promise<void>
  workspaceJoin(name: string, url: string): Promise<void>
  workspaceSwitch(id: string): Promise<void>
  listNotes(): Promise<NoteDto[]>
  readNote(id: string): Promise<{ note: NoteDto; body: string }>
  saveNoteBody(id: string, body: string): Promise<void>
  updateMeta(id: string, patch: MetaPatch): Promise<NoteDto>
  verifyNote(id: string): Promise<NoteDto>
  // cut a wrong derived_from link (records a counterexample for the librarian)
  unlinkNote(fromId: string, toId: string): Promise<NoteDto>
  lineageChain(id: string): Promise<NoteDto[]>
  readNoteBody(id: string): Promise<string>
  listCards(): Promise<CardDto[]>
  cardDetail(id: string): Promise<CardDetailDto>
  approveCard(id: string, options: ApproveOptionsDto): Promise<void>
  rejectCard(id: string, reason: string): Promise<void>
  capture(text: string): Promise<{ file: string; processed: boolean }>
  captureUndo(file: string): Promise<{ ok: boolean }>
  capturePrivate(text: string): Promise<{ file: string }>
  captureFile(path: string): Promise<{ file: string }>
  // clipboard screenshot paste — PNG bytes; locked routes to private/
  captureImage(data: Uint8Array, locked: boolean): Promise<{ file: string }>
  inboxList(): Promise<InboxDto>
  inboxRetry(): Promise<SweepReportDto>
  sweep(): Promise<SweepReportDto>
  // librarian activity stream — completed sweeps, newest-first (max 20)
  // live open loops from the vault, most urgent first — the Today surface
  subjectKnowledge(): Promise<SubjectKnowledgeDto>
  // meaning-level edges (close-enough-to-link pairs) for the Brain grouping
  brainFabric(): Promise<BrainFabricDto>
  // Stop a running answer on one surface (or every surface when omitted).
  chatAbort(channel?: 'panel' | 'bubble'): Promise<void>
  fadingMemories(): Promise<FadingMemoryDto[]>
  openLoops(): Promise<OpenLoopDto[]>
  latestBrief(): Promise<string | null>
  // re-runs the brief job when an engine is free; falls back to a plain read
  refreshBrief(): Promise<string | null>
  // latest weekly digest (J10) markdown, or null before the first week closes
  latestDigest(): Promise<string | null>
  // strict = precision-first matching (capture echo); default is recall-first
  search(query: string, strict?: boolean): Promise<SearchHitDto[]>
  engines(): Promise<EngineStatusDto[]>
  enginesRefresh(): Promise<EngineStatusDto[]>
  onEvent(listener: (event: EngramEvent) => void): () => void
  // quick-capture floating window helpers
  hideQuickCapture(): void
  pathForFile(file: File): string
  // chat panel & context packs
  chatSend(request: ChatRequestDto): Promise<void>
  // Floating bubble window (its own BrowserWindow, hash #bubble): the window
  // grows into the mini chat and shrinks back to the button.
  bubbleExpand(): Promise<void>
  bubbleCollapse(): Promise<void>
  // A citation clicked in the bubble: surface the main window on that note.
  bubbleOpenNote(id: string): Promise<void>
  // Collapsed-dot drag: screen-pixel deltas, fire-and-forget.
  bubbleDragBy(dx: number, dy: number): void
  // Confirmed quit from the bubble's ✕ — terminates the app like tray Quit.
  bubbleQuit(): Promise<void>
  activityToday(): Promise<{ totalMs: number; apps: { app: string; ms: number; topTitles: string[] }[] }>
  contentFolders(): Promise<string[]>
  contentAddFolder(): Promise<string[]>
  contentRemoveFolder(folder: string): Promise<string[]>
  localModelsState(): Promise<LocalModelsStateDto>
  localModelDownload(id: string): Promise<{ ok: boolean; log?: string }>
  localModelCancel(id: string): Promise<void>
  localModelSetActive(id: string | null): Promise<void>
  // Desk journal switch (settings ⑨ + tray share the same state).
  activityGet(): Promise<boolean>
  activitySet(enabled: boolean): Promise<boolean>
  // promote a chat answer into an artifact note; returns the new note id
  buildPack(query?: string): Promise<{ file: string; content: string }>
  // team sync & bulk import
  syncStatus(): Promise<SyncStatusDto>
  syncNow(): Promise<SyncStatusDto>
  syncBrief(): Promise<string>
  teamJoin(url: string): Promise<void>
  // browser-assisted GitHub backup (no OAuth app): open the create-repo page…
  githubOpenNew(name: string): Promise<void>
  // …then connect the pasted repo URL (add remote + first push via bundled git)
  githubConnect(url: string): Promise<GithubConnectResultDto>
  importPick(): Promise<string | null>
  importScan(folder: string): Promise<{ count: number; totalBytes: number }>
  importRun(folder: string): Promise<{ imported: number }>
  absorbStatus(): Promise<AbsorbStatusDto>
  // aggregate "not yet organized" count for the Tidy badge / connect banner
  librarianPending(): Promise<PendingWorkDto>
  // Ask the running librarian sweep to stop after its current step; the
  // remaining absorb backlog is preserved for a later Resume.
  absorbStop(): Promise<void>
  onboardDefaults(): Promise<{ defaultRoot: string; engines: EngineStatusDto[] }>
  onboardComplete(payload: OnboardPayload): Promise<void>
  // current state of the zero-touch claude auto-install
  // false while the first engine detection is still running
  enginesDetected(): Promise<boolean>
  // first-run guided tour gate (packaged builds, or ENGRAM_TOUR=1)
  tourEligible(): Promise<boolean>
  appVersion(): Promise<string>
  vaultReady(): Promise<boolean>
  // Recovery from a vault that would not open (vault:error). Registered in
  // registerBaseIpc, not with the vault handlers — the vault is the thing that
  // just failed.
  revealVaultRoot(root: string): Promise<void>
  relaunch(): Promise<void>
  // The floating question window (#nudge route) — its own channel, because it
  // is a separate BrowserWindow and gets a targeted send, not a broadcast.
  // apply a downloaded update now — the app quits, installs and reopens
  updateInstall(): Promise<void>
  settingsGet(): Promise<AppSettingsDto>
  settingsSet(settings: AppSettingsDto): Promise<void>
  mcpInfo(): Promise<McpInfoDto>
  mcpConnectDesktop(): Promise<McpConnectResultDto>
  mcpConnectCode(): Promise<McpConnectResultDto>
  semanticStatus(): Promise<SemanticStatusDto>
  diagnostics(): Promise<DiagnosticsDto>
  exportLogs(): Promise<string | null>
  // host platform ('win32' | 'darwin' | 'linux') — for shell pickers etc.
  platform: string
}

export interface OnboardPayload {
  root: string
  importFolder: string | null
  teamUrl: string | null
  firstCapture: string | null
}

export interface AppSettingsDto {
  // stored and used for engine detection, but no longer shown — one option
  defaultEngine: 'claude'
  autoStart: boolean
  teamSync: 'auto' | 'manual'
  semanticModel?: string
}

// Local semantic layer status for the settings screen.
export interface SemanticStatusDto {
  status: 'off' | 'loading' | 'indexing' | 'ready' | 'error'
  detail: string
  model: string
}

export interface DiagnosticsDto {
  engines: {
    id: string
    // display name of the brain behind this light ("Gemma 4 E4B"), not the engine id
    label?: string
    installed: boolean
    loggedIn: boolean
    healthy?: boolean
    healthReason?: EngineHealthReason
    diagnosis: string
  }[]
  sync: SyncStatusDto
  apiKeyEnvWarnings: string[]
  bundledGit: boolean
  logsDir: string
}
