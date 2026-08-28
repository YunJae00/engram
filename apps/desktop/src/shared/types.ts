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
  // What the last download attempt said when it did not finish.
  lastError?: string
}

export interface LocalModelsStateDto {
  models: LocalModelDto[]
  recommendedId: string
  ramGB: number
  serverReady: boolean
}

// Answer to the Settings "check for updates" button. `selfInstalls` false
// means the platform cannot swap the app itself (an unsigned macOS build), so
// an available version leads to a download page instead of an install.
// One finished delegation, as the journal remembers it.
export interface BotTaskDto {
  id: string
  name: string
  goal: string
  lastRunAt?: string
}

export interface BotDto {
  id: string
  name: string
  purpose: string
  createdAt: string
  // The work this comet repeats — saved once, run with one click.
  tasks?: BotTaskDto[]
}

export interface BotTurnDto {
  role: 'user' | 'assistant'
  text: string
  at: string
}

export interface BotSuggestionDto {
  name: string
  purpose: string
  reason: string
}

// A saved browser sequence, replayed verbatim — no model involved.
export interface RoutineTargetDto {
  css?: string[]
  text?: string
}

export type RoutineStepDto =
  | { kind: 'open'; url: string }
  | { kind: 'click'; target: RoutineTargetDto }
  | { kind: 'type'; target: RoutineTargetDto; text: string }
  | { kind: 'read' }

// Why a rerun was refused. Not a failure — a question for the person.
export type RoutineBlockDto = 'already-ran-today' | 'unfinished-write'

export interface RoutineDto {
  id: string
  name: string
  steps: RoutineStepDto[]
  createdAt: string
  lastRunAt?: string
  lastOutcome?: 'done' | 'failed' | 'aborted'
  lastSuccessAt?: string
  // Present when a run died between "about to submit" and the outcome.
  pendingWrite?: { at: string; step: number; label: string }
}

export interface ErrandRunDto {
  id: string
  goal: string
  botId?: string
  startedAt: string
  endedAt: string
  outcome: 'done' | 'failed' | 'aborted'
  title?: string
  cardId?: string
  noteSources: number
  pages: { url: string; title: string }[]
  error?: string
}

export interface UpdateCheckDto {
  // 'available' = a newer version exists; 'downloading' = it is being fetched
  // and cannot be installed yet; 'ready' = the bytes are on disk.
  state: 'current' | 'downloading' | 'ready' | 'available' | 'checking-unavailable' | 'error'
  version?: string
  selfInstalls: boolean
  percent?: number
  message?: string
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
  // 'panel', 'bubble', or a per-bot channel like 'bot-<id>'.
  channel?: string
  // Answer as this bot: its charter rides ahead of the chat rules.
  botId?: string
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
  // the semantic layer fell over (model download/load failed) — said once per
  // transition, so search quietly degrading to lexical is not fully silent
  | { type: 'semantic:error'; detail: string }
  // local inference warm state: the chat panel shows a warming banner while
  // the model loads and arms the composer when it lands
  | { type: 'localllm:warm'; state: 'cold' | 'loading' | 'ready' }
  // What the model is doing right now, from the inference worker's own
  // counters: prompt tokens read so far while it evaluates, then tokens (and
  // words) written as they land. `kind` tells a grammar-bound call - choosing
  // between moves - from free prose. 'done' closes the line on every exit.
  | {
      type: 'localllm:progress'
      phase: 'reading' | 'writing' | 'done'
      kind: 'choice' | 'prose'
      done: number
      total?: number
      words?: number
    }
  // the first engine detection after boot has finished — until this lands the
  // shell must not claim there is no engine, it simply does not know yet
  | { type: 'engines:detected' }
  | { type: 'sweep:start' }
  | { type: 'sweep:job'; job: string; index: number; total: number }
  | { type: 'sweep:done'; report: SweepReportDto }
  | { type: 'sweep:error'; message: string }
  // Chat events broadcast to every window; `channel` says which surface asked
  // (in-app panel or the floating bubble) so the other one can ignore them.
  | { type: 'chat:token'; channel: string; text: string }
  // `offer` rides along when the comet identified a saved procedure for this
  // request but did not run it: the thread shows a one-tap Run instead of
  // leaving the person to go find it.
  | {
      type: 'chat:done'
      channel: string
      text: string
      // 'run' — a saved procedure matches this request, one press away.
      // 'teach' — nothing has been shown to it yet, so the offer is to watch.
      offer?:
        | { kind: 'run'; routineId: string; name: string; slots?: Record<string, string> }
        | { kind: 'teach' }
        // A job that took real work is worth keeping: the loop says so, the
        // person decides. Nothing here is a form to fill.
        | { kind: 'keep'; name: string; goal: string }
        | { kind: 'asked' }
    }
  | { type: 'chat:error'; channel: string; message: string }
  // The comet's tool loop narrating one step of its work on this channel.
  | { type: 'comet:step'; channel: string; line: string }
  // A procedure is about to post something. The run waits until
  // routineSubmitDone answers with the person's verdict.
  | { type: 'routine:submit'; routineId: string; name: string; filled: { label: string; text: string }[] }
  // The floating bubble asked the shell to open a note (a citation click).
  | { type: 'note:open'; id: string }
  | { type: 'brain:setup' }
  // Settings were saved anywhere — live surfaces (the agent terminal) restyle
  // without a remount or an app restart.
  | { type: 'settings:changed'; settings: AppSettingsDto }
  // Local model download progress / registry state.
  | { type: 'localmodel:progress'; id: string; received: number; total: number }
  | { type: 'localmodels:changed'; state: LocalModelsStateDto }
  | { type: 'import:progress'; done: number; total: number }
  | { type: 'engines:changed'; engines: EngineStatusDto[] }
  // a newer app version was downloaded and will install on next quit
  // selfInstalls false = the platform cannot swap the app itself (an unsigned
  // macOS build), so the action is a download rather than an install
  | { type: 'update:ready'; version: string; selfInstalls: boolean }
  // live health verdict for one engine — false means it is present but not
  // usable, and `reason` says which sentence (and which button) the user gets
  | { type: 'engine:health'; id: string; healthy: boolean; reason?: EngineHealthReason }
  | { type: 'window:fullscreen'; value: boolean }
  // A delegated errand (core's runErrand) moving through its fixed phases — the
  // top bar narrates it and the toast fires on done/failed. `error` rides only
  // on 'failed'; `goal` labels the run so a late subscriber knows what it is.
  | {
      type: 'errand:phase'
      phase: 'plan' | 'gather' | 'web' | 'distill' | 'compose' | 'done' | 'failed'
      goal: string
      // What the run has in hand so far — the sheet narrates from these.
      queries?: string[]
      notes?: number
      pages?: { url: string; title: string }[]
      points?: number
      error?: string
    }
  | { type: 'errand:logged' }
  // The errand met a page only a human can pass (login screen, human check).
  // The run is parked until errandWallDone answers — clear it in the agent's
  // Chrome window and continue, or skip that page.
  | { type: 'errand:wall'; url: string; wall: 'login' | 'captcha' }
  // Routine replay progress: one event per step, then one logged event with
  // the outcome. A wall parks the run until routineWallDone answers.
  | { type: 'routine:step'; routineId: string; index: number; total: number; label: string }
  | { type: 'routine:wall'; routineId: string; wall: 'login' | 'captcha' }
  | { type: 'routine:logged'; routineId: string; name: string; outcome: 'done' | 'failed' | 'aborted'; cardId?: string; error?: string }
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
  chatAbort(channel?: string): Promise<void>
  // Channels with an answer still running, for a surface that mounted after
  // the send and needs to know a done is on its way.
  chatActive(): Promise<string[]>
  // Would the vault answer this, or does it need the web? Retrieval decides;
  // no inference runs, so it is safe to call before every send.
  chatRoute(message: string): Promise<{ kind: 'chat' | 'errand'; notes: number }>
  // Delegate one goal to the on-device librarian (core's runErrand). Runs
  // detached in main — this resolves once it has STARTED (or refused, e.g. no
  // engine); progress and the eventual outcome arrive as errand:phase events.
  errandStart(goal: string, botId?: string): Promise<{ ok: boolean; error?: string }>
  botsList(): Promise<BotDto[]>
  botCreate(input: { name: string; purpose: string }): Promise<BotDto>
  botDelete(id: string): Promise<void>
  botTranscript(id: string): Promise<BotTurnDto[]>
  botTaskAdd(botId: string, input: { name: string; goal: string }): Promise<BotTaskDto>
  botTaskRemove(botId: string, taskId: string): Promise<void>
  botTaskRan(botId: string, taskId: string): Promise<void>
  botsRecommend(): Promise<BotSuggestionDto[]>
  // A refused suggestion, remembered in the vault so it is never offered again.
  botSuggestionDismiss(name: string): Promise<void>
  // Past runs, newest first — the errand sheet's history.
  errandJournal(): Promise<ErrandRunDto[]>
  errandAbort(): Promise<void>
  // The user's verdict on a walled page ('resolved' after clearing it in the
  // agent window, 'skip' to move on without it).
  errandWallDone(verdict: 'resolved' | 'skip'): Promise<void>
  routinesList(): Promise<RoutineDto[]>
  routineAdd(input: { name: string; steps: RoutineStepDto[] }): Promise<RoutineDto>
  routineRemove(id: string): Promise<void>
  // Detached like errandStart: resolves once the replay has started (or was
  // refused); steps and the outcome arrive as routine:* events.
  routineRun(
    id: string,
    force?: boolean,
    slots?: Record<string, string>,
  ): Promise<{ ok: boolean; error?: string; blocked?: RoutineBlockDto }>
  routineAbort(): Promise<void>
  routineWallDone(verdict: 'resolved' | 'skip'): Promise<void>
  // The person's answer to "may this be posted?" — nothing is submitted
  // until this says approve.
  routineSubmitDone(verdict: 'approve' | 'cancel'): Promise<void>
  // Teach mode: open the agent Chrome and record the person's moves, then hand
  // them back as steps to name and save. teachStart resolves once the window
  // is up (or refused); teachStop returns the recorded steps.
  routineTeachStart(): Promise<{ ok: boolean; error?: string }>
  routineTeachRead(): Promise<void>
  routineTeachStop(): Promise<RoutineStepDto[]>
  // Browsers whose sessions can be inherited, and the one-press inherit.
  browsersList(): Promise<{ id: string; name: string; userData: string; running: boolean }[]>
  browserImport(id: string): Promise<{ ok: boolean; copied?: number; error?: string }>
  browserForget(): Promise<void>
  browserImportedAt(): Promise<string | null>
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
  bubbleSetup(): Promise<void>
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
  // Frees the multi-gigabyte file. Refused while that model downloads —
  // cancel is the action there.
  localModelDelete(id: string): Promise<{ ok: boolean; reason?: string }>
  localModelSetActive(id: string | null): Promise<void>
  // Desk journal switch (settings ⑨ + tray share the same state).
  activityGet(): Promise<boolean>
  activitySet(enabled: boolean): Promise<boolean>
  sessionWatchGet(): Promise<boolean>
  sessionWatchSet(enabled: boolean): Promise<boolean>
  llmWarm(): Promise<'cold' | 'loading' | 'ready' | 'none'>
  sendFeedback(): Promise<void>
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
  // Reports whether the install actually started — a click that cannot work
  // has to say so rather than appear to do nothing.
  updateInstall(): Promise<{ started: boolean; reason?: string }>
  updateCheck(): Promise<UpdateCheckDto>
  // The updater's cached knowledge — no network; safe to poll while downloading.
  updateState(): Promise<UpdateCheckDto>
  // What the person pasted becomes the search shape; the app never picks.
  searchTemplateLearn(pasted: string): Promise<{ ok: boolean; template?: string }>
  // The browsers on this machine, and which one drives the work.
  browsersInstalled(): Promise<InstalledBrowserDto[]>
  browserChoose(path: string): Promise<void>
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
  defaultEngine: 'claude' | 'local'
  autoStart: boolean
  teamSync: 'auto' | 'manual'
  semanticModel?: string
  // Where the person searches, with {q} standing in for the words. Learned
  // from one address they paste; empty means the comet asks first.
  searchTemplate?: string
  // Which installed browser the agent drives, by executable path. Empty means
  // the person has not picked and, where several are installed, is asked.
  agentBrowser?: string
}

// One browser found on this machine, offered rather than assumed.
export interface InstalledBrowserDto {
  id: string
  name: string
  path: string
  chosen: boolean
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
    // display name of the brain behind this light ("Gemma 4 E2B"), not the engine id
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
