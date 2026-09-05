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

// Answer to the Settings "check for updates" button. `selfInstalls` false
// means the platform cannot swap the app itself (an unsigned macOS build), so
// an available version leads to a download page instead of an install.
// One finished delegation, as the journal remembers it.
export interface ScheduleDto {
  days: number[]
  hour: number
  minute: number
}

export interface BotTaskDto {
  id: string
  name: string
  goal: string
  lastRunAt?: string
  schedule?: ScheduleDto
  routineId?: string
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

// A standing approval: this routine may post to this site without asking.
export interface ApprovalRuleDto {
  fingerprint: string
  routineId: string
  host: string
  createdAt: string
}

// One line a comet remembers about the person.
export interface BotFactDto {
  id: string
  text: string
  at: string
  touchedAt: string
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
  // Which surface is asking. Chat events broadcast to every window, so each
  // surface can ignore the others' streams. Absent = 'panel' (older callers).
  // 'panel', or a per-bot channel like 'bot-<id>'.
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
  // the first engine detection after boot has finished — until this lands the
  // shell must not claim there is no engine, it simply does not know yet
  | { type: 'engines:detected' }
  | { type: 'models:changed' }
  | { type: 'sweep:start' }
  | { type: 'sweep:job'; job: string; index: number; total: number }
  | { type: 'sweep:done'; report: SweepReportDto }
  | { type: 'sweep:error'; message: string }
  // Chat events broadcast to every window; `channel` says which surface asked
  // so the others can ignore them.
  // reset: what streamed so far was said before a tool call and is not the
  // reply; the thread starts the reply again from nothing.
  | { type: 'chat:token'; channel: string; text: string; reset?: boolean }
  // `offer` rides along when the comet identified a saved procedure for this
  // request but did not run it: the thread shows a one-tap Run instead of
  // leaving the person to go find it.
  | {
      type: 'chat:done'
      channel: string
      text: string
      // 'run' — a saved procedure matches this request, one press away.

      offer?:
        | { kind: 'run'; routineId: string; name: string; slots?: Record<string, string> }
        // A job that took real work is worth keeping: the loop says so, the
        // person decides. Nothing here is a form to fill.
        // A button the comet wrote for a job it just did: what it would be
        // called, the job as an instruction it could be given again, and what
        // pressing it would do - shown to the person before anything is kept.
        | { kind: 'keep'; name: string; goal: string; does: string }
        // The same ask on a third morning: a read-only procedure it just ran
        // could run itself at that hour from now on.
        | { kind: 'standing'; name: string; goal: string; count: number; schedule: ScheduleDto; routineId: string }
        // The loop ended on a question; the options are ways forward the
        // thread shows as chips. Only sent when there are some.
        | { kind: 'asked'; question: string; options: string[] }
    }
  | { type: 'chat:error'; channel: string; message: string }
  // The comet's tool loop narrating one step of its work on this channel.
  // The agent browser's mirror: whether there is a page to show, and each
  // frame of it while a view is open. Frames are shown and dropped.
  | { type: 'agent:live'; on: boolean; url?: string; lane?: string }
  // Where the comet's hand is about to land on the mirrored page, as fractions.
  | { type: 'agent:pointer'; x: number; y: number; kind: 'move' | 'press' }
  // An offer written after the answer already went out; same shape the
  // done event carries.
  | { type: 'chat:offer'; channel: string; offer: NonNullable<Extract<EngramEvent, { type: 'chat:done' }>['offer']> }
  | { type: 'agent:frame'; data: string; width: number; height: number; url: string; lane: string }
  | { type: 'comet:step'; channel: string; line: string }
  // The comet wrote something down about the person after a turn.
  | { type: 'comet:remembered'; channel: string; botId: string; added: number; touched: number }
  // A comet was renamed or otherwise changed outside the person's own hand.
  | { type: 'bots:changed' }
  // A procedure is about to post something. The run waits until
  // routineSubmitDone answers with the person's verdict.
  | {
      type: 'routine:submit'
      routineId: string
      name: string
      filled: { label: string; text: string }[]
      // The site being posted to, and whether an approval could be
      // remembered for it (it cannot without a known site).
      host: string | null
      canRemember: boolean
    }
  // A post went through under an approval the person gave for good.
  | { type: 'routine:passed'; routineId: string; host: string }
  // A comet is at a control that would commit something. The person sees the
  // page beside this and says whether it goes, or takes it themselves.
  | { type: 'press:ask'; channel: string; words: string; host: string | null }
  // Another window asked the shell to open a note (a citation click).
  | { type: 'note:open'; id: string }
  | { type: 'brain:setup' }
  // Settings were saved anywhere — live surfaces (the agent terminal) restyle
  // without a remount or an app restart.
  | { type: 'settings:changed'; settings: AppSettingsDto }
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

// A person's move on the browser mirror, in the frame's own fractions —
// the main side maps it onto the page, whatever size the frame was shown at.
export type AgentInputDto =
  | {
      kind: 'mouse'
      type: 'pressed' | 'released' | 'moved' | 'wheel'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle' | 'none'
      clicks?: number
      modifiers?: number
      deltaX?: number
      deltaY?: number
    }
  | { kind: 'key'; type: 'down' | 'up'; key: string; code: string; keyCode: number; text?: string; modifiers?: number }
  | { kind: 'text'; text: string }

export interface EngramApi {
  // The agent browser's mirror: watch (frames flow while at least one view
  // is open), act on it, and call the real window onto the desk or away.
  agentWatch(on: boolean): Promise<{ on: boolean; url?: string }>
  agentInput(input: AgentInputDto): Promise<void>
  agentWindow(show: boolean): Promise<void>
  agentGo(url: string): Promise<void>
  // Take the picture again now: for a view left on a page that went still
  // half-drawn. sharp asks for every device pixel, for a view being read.
  agentRefresh(): Promise<void>
  // How tall the pages should lay themselves out, from the pane showing them.
  agentHeight(height: number): Promise<void>
  // Which comet's tab the pane shows; and a reset that closes that tab.
  agentLane(lane: string): Promise<{ on: boolean; url?: string }>
  agentReset(lane: string): Promise<void>
  // The folder of daily logs of what the comets did, opened for the person.
  auditOpen(): Promise<void>
  // Start a comet's conversation over: stop, put the transcript away, forget.
  chatFresh(botId: string): Promise<void>
  // The models the signed-in plan offers, in the runtime's own words; empty
  // until the runtime has been asked.
  modelsList(): Promise<ModelChoiceDto[]>
  // Whether a window is being mirrored, without joining the watch.
  agentState(): Promise<{ on: boolean; url?: string; lane?: string }>
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
  // Delegate one goal to the on-device librarian (core's runErrand). Runs
  // detached in main — this resolves once it has STARTED (or refused, e.g. no
  // engine); progress and the eventual outcome arrive as errand:phase events.
  errandStart(goal: string, botId?: string): Promise<{ ok: boolean; error?: string }>
  botsList(): Promise<BotDto[]>
  botCreate(input: { name: string; purpose?: string }): Promise<BotDto>
  botRename(id: string, name: string): Promise<void>
  botDelete(id: string): Promise<void>
  botTranscript(id: string): Promise<BotTurnDto[]>
  botTaskAdd(botId: string, input: { name: string; goal: string; schedule?: ScheduleDto; routineId?: string }): Promise<BotTaskDto>
  botStandingDecline(botId: string, goal: string): Promise<void>
  botTaskRemove(botId: string, taskId: string): Promise<void>
  botTaskRan(botId: string, taskId: string): Promise<void>
  botsRecommend(): Promise<BotSuggestionDto[]>
  // A refused suggestion, remembered in the vault so it is never offered again.
  botSuggestionDismiss(name: string): Promise<void>
  botMemory(botId: string): Promise<BotFactDto[]>
  botMemoryForget(botId: string, factId: string): Promise<void>
  // Past runs, newest first — the errand sheet's history.
  errandJournal(): Promise<ErrandRunDto[]>
  errandAbort(): Promise<void>
  // The user's verdict on a walled page ('resolved' after clearing it in the
  // agent window, 'skip' to move on without it).
  errandWallDone(verdict: 'resolved' | 'skip'): Promise<void>
  routinesList(): Promise<RoutineDto[]>
  routineAdd(input: { name: string; steps: RoutineStepDto[] }): Promise<RoutineDto>
  routineRename(id: string, name: string): Promise<void>
  routineRemove(id: string): Promise<void>
  // Detached like errandStart: resolves once the replay has started (or was
  // refused); steps and the outcome arrive as routine:* events.
  routineRun(
    id: string,
    force?: boolean,
    slots?: Record<string, string>,
  ): Promise<{ ok: boolean; error?: string; blocked?: RoutineBlockDto }>
  routineAbort(): Promise<void>
  routineWallDone(routineId: string, verdict: 'resolved' | 'skip'): Promise<void>
  // The person's answer to "may this be posted?" — nothing is submitted
  // until this says approve.
  routineSubmitDone(routineId: string, verdict: 'approve' | 'always' | 'cancel'): Promise<void>
  // The person's word on a press that would commit: it goes, it goes here
  // from now on, or they will do it themselves.
  pressAskDone(channel: string, verdict: 'approve' | 'always' | 'cancel'): Promise<void>
  approvalsList(): Promise<ApprovalRuleDto[]>
  approvalForget(fingerprint: string): Promise<void>
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
  // Sign in to / out of a cloud brain through the vendor's own flow.
  engineConnect(id: 'claude' | 'codex'): Promise<{ ok: boolean; message?: string }>
  engineDisconnect(id: 'claude' | 'codex'): Promise<void>
  // Every brain this build carries, signed in or not.
  engineStates(): Promise<EngineStatusDto[]>
  onEvent(listener: (event: EngramEvent) => void): () => void
  // quick-capture floating window helpers
  hideQuickCapture(): void
  pathForFile(file: File): string
  // chat panel & context packs
  chatSend(request: ChatRequestDto): Promise<void>
  activityToday(): Promise<{ totalMs: number; apps: { app: string; ms: number; topTitles: string[] }[] }>
  // Desk journal switch (settings ⑨ + tray share the same state).
  activityGet(): Promise<boolean>
  activitySet(enabled: boolean): Promise<boolean>
  sessionWatchGet(): Promise<boolean>
  sessionWatchSet(enabled: boolean): Promise<boolean>
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
  // Which brain answers: this disk, or one of the two the person signed in to.
  defaultEngine: 'claude' | 'codex'
  autoStart: boolean
  teamSync: 'auto' | 'manual'
  semanticModel?: string
  // Where the person searches, with {q} standing in for the words. Learned
  // from one address they paste; empty means the comet asks first.
  searchTemplate?: string
  // Which installed browser the agent drives, by executable path. Empty means
  // the person has not picked and, where several are installed, is asked.
  agentBrowser?: string
  // Which model each brain answers with. Empty means the runtime's own
  // default, which follows the person's plan.
  claudeModel?: string
  codexModel?: string
}

// One model the plan offers: the id the runtime takes, the name it shows,
// and its own line about what the model is for.
export interface ModelChoiceDto {
  value: string
  label: string
  detail: string
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
