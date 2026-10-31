import type { McpInfoDto, McpConnectResultDto, McpClientDto, BookmarkDto, NoteDto, OpenLoopDto, CardDto, CardDetailDto, InboxDto, MissionFrameDto, ScheduleDto, BotTaskDto, BotDto, BotTurnDto, BotSuggestionDto, ApprovalRuleDto, BotFactDto, RoutineStepDto, RoutineBlockDto, RoutineDto, ErrandRunDto, UpdateCheckDto, EngineStatusDto, DelegatedTaskDto, ChatRequestDto, ChatAttachmentDto, ChatAttachmentPreviewDto, SweepReportDto, SearchHitDto, MetaPatch, ApproveOptionsDto, SyncStatusDto, BrainFabricDto, FadingMemoryDto, SubjectKnowledgeDto, AbsorbStatusDto, GithubConnectResultDto, PendingWorkDto, BrowserTabDto, EngramEvent, WorkspaceInfoDto, AgentInputDto, NativeSurfaceDto, SemanticStatusDto, DiagnosticsDto } from './types.js'
import type { DesktopApi } from './desktop.js'
import type { DevelopersApi } from './developers.js'
import type { SidebarLayout } from 'core'
import type { SidebarChange } from 'core'
import type { SidebarKind } from 'core'

export interface EngramApi extends DesktopApi, DevelopersApi {
  artifactReveal(id: string): Promise<void>
  artifactOpen(id: string): Promise<void>
  artifactRead(id: string): Promise<ArtifactViewDto>
  nativeEnabled(): Promise<boolean>
  nativeFocusShell(): void
  nativeLayout(surfaces: NativeSurfaceDto[]): Promise<void>
  nativeSnapshot(lane: string): Promise<string | null>
  agentWatch(on: boolean): Promise<{ on: boolean; url?: string }>
  agentInput(input: AgentInputDto, lane: string): Promise<void>
  agentWindow(show: boolean): Promise<void>
  agentGo(url: string, lane?: string): Promise<void>
  agentRefresh(): Promise<void>
  agentHistory(lane: string): Promise<{ back: boolean; forward: boolean }>
  agentNavigate(lane: string, direction: 'back' | 'forward' | 'reload'): Promise<void>
  agentResize(lane: string, width: number, height: number): Promise<void>
  bookmarksSources(): Promise<{ id: string; name: string }[]>
  bookmarksList(): Promise<BookmarkDto[]>
  bookmarksImport(id: string): Promise<BookmarkDto[]>
  agentHeight(height: number, lane?: string): Promise<void>
  missionFrames(lanes: string[]): Promise<MissionFrameDto[]>
  missionWatch(lanes: string[]): Promise<void>
  agentLane(lane: string): Promise<{ on: boolean; url?: string }>
  agentReset(lane: string): Promise<void>
  browserTabs(lane: string): Promise<BrowserTabDto[]>
  browserTab(lane: string, action: 'add' | 'select' | 'close', id?: string): Promise<BrowserTabDto[]>
  auditOpen(): Promise<void>
  chatFresh(botId: string): Promise<void>
  modelsList(id?: 'claude' | 'codex', profile?: string): Promise<ModelChoiceDto[]>
  aiCheck(): Promise<void>
  agentState(): Promise<{ on: boolean; url?: string; lane?: string }>
  workspaceList(): Promise<{ current: string | null; vaults: WorkspaceInfoDto[] }>
  workspaceCreate(name: string): Promise<void>
  workspaceJoin(name: string, url: string): Promise<void>
  workspaceSwitch(id: string): Promise<void>
  workspaceDelete(id: string): Promise<boolean>
  listNotes(): Promise<NoteDto[]>
  readNote(id: string): Promise<{ note: NoteDto; body: string }>
  saveNoteBody(id: string, body: string): Promise<void>
  updateMeta(id: string, patch: MetaPatch): Promise<NoteDto>
  verifyNote(id: string): Promise<NoteDto>
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
  captureImage(data: Uint8Array, locked: boolean): Promise<{ file: string }>
  inboxList(): Promise<InboxDto>
  inboxRetry(): Promise<SweepReportDto>
  sweep(): Promise<SweepReportDto>
  subjectKnowledge(): Promise<SubjectKnowledgeDto>
  brainFabric(): Promise<BrainFabricDto>
  chatAbort(channel?: string): Promise<void>
  chatActive(): Promise<string[]>
  studyList(botId: string): Promise<StudyDto[]>
  studyAnswer(id: string, answer: 'go' | 'later' | 'keep' | 'wrong'): Promise<{ ask?: string }>
  chatSay(channel: string, text: string): Promise<{ ok: boolean; reply?: string; action?: 'relay' | 'stop' | 'later' | 'none'; instruction?: string }>
  chatQueued(botId: string, pending: boolean): Promise<void>
  errandStart(goal: string, botId?: string): Promise<{ ok: boolean; error?: string }>
  botsList(): Promise<BotDto[]>
  siteIcon(origin: string, shortcut?: boolean): Promise<string | null>
  sidebarLayout(kind?: SidebarKind): Promise<SidebarLayout>
  sidebarChange(request: SidebarChange): Promise<SidebarLayout>
  botCreate(input: { name: string; purpose?: string }): Promise<BotDto>
  botRename(id: string, name: string): Promise<void>
  botDelete(id: string): Promise<void>
  botTranscript(id: string): Promise<BotTurnDto[]>
  botTaskAdd(botId: string, input: { name: string; goal: string; schedule?: ScheduleDto; routineId?: string }): Promise<BotTaskDto>
  botStandingDecline(botId: string, goal: string): Promise<void>
  botTaskRemove(botId: string, taskId: string): Promise<void>
  botTaskRan(botId: string, taskId: string): Promise<void>
  botsRecommend(): Promise<BotSuggestionDto[]>
  botSuggestionDismiss(name: string): Promise<void>
  botMemory(botId: string): Promise<BotFactDto[]>
  botMemoryForget(botId: string, factId: string): Promise<void>
  errandJournal(): Promise<ErrandRunDto[]>
  errandAbort(): Promise<void>
  errandWallDone(verdict: 'resolved' | 'skip'): Promise<void>
  routinesList(): Promise<RoutineDto[]>
  tasksList(): Promise<DelegatedTaskDto[]>
  workMapStatus(): Promise<WorkMapStatusDto>
  firstSetupStatus(): Promise<FirstSetupDto>
  firstSetupSkip(): Promise<void>
  workMapRefresh(): Promise<WorkMapStatusDto>
  appsList(): Promise<AppUseDto[]>
  appsSet(app: string, label: string, on: boolean): Promise<void>
  habitsList(): Promise<HabitDraftDto[]>
  habitsScan(): Promise<HabitDraftDto[]>
  habitsAnswer(key: string, keep: boolean): Promise<HabitDraftDto[]>
  noticesList(): Promise<NoticesDto>
  noticesOpen(id: string): Promise<string>
  noticesClear(): Promise<NoticesDto>
  noticesUnschedule(id: string): Promise<NoticesDto>
  taskDecide(id: string, approvalId: string, answer: 'approve' | 'decline'): Promise<void>
  routineAdd(input: { name: string; steps: RoutineStepDto[] }): Promise<RoutineDto>
  routineRename(id: string, name: string): Promise<void>
  routineUpdateGoal(id: string, goal: string): Promise<void>
  routineRemove(id: string): Promise<void>
  routineRun(
    id: string,
    force?: boolean,
    slots?: Record<string, string>,
  ): Promise<{ ok: boolean; error?: string; blocked?: RoutineBlockDto; botId?: string }>
  routineAbort(): Promise<void>
  routineWallDone(routineId: string, verdict: 'resolved' | 'skip'): Promise<void>
  routineSubmitDone(routineId: string, verdict: 'approve' | 'always' | 'cancel'): Promise<void>
  pressAskDone(channel: string, verdict: 'approve' | 'always' | 'cancel'): Promise<void>
  approvalsList(): Promise<ApprovalRuleDto[]>
  approvalForget(fingerprint: string): Promise<void>
  browsersList(): Promise<{ id: string; name: string; userData: string; running: boolean }[]>
  browserImport(id: string): Promise<{ ok: boolean; copied?: number; error?: string }>
  browserForget(): Promise<void>
  browserImportedAt(): Promise<string | null>
  fadingMemories(): Promise<FadingMemoryDto[]>
  openLoops(): Promise<OpenLoopDto[]>
  latestBrief(): Promise<string | null>
  refreshBrief(): Promise<string | null>
  latestDigest(): Promise<string | null>
  search(query: string, strict?: boolean): Promise<SearchHitDto[]>
  engines(): Promise<EngineStatusDto[]>
  enginesRefresh(): Promise<EngineStatusDto[]>
  engineConnect(id: 'claude' | 'codex', profile?: string): Promise<{ ok: boolean; message?: string }>
  installClaude(): Promise<void>
  claudeInstallHelp(): Promise<void>
  engineLogins(): Promise<EngineLoginDto[]>
  engineCancelLogin(id: 'claude' | 'codex', profile?: string): Promise<void>
  engineOpenLogin(id: 'claude' | 'codex', profile?: string): Promise<void>
  engineDisconnect(id: 'claude' | 'codex'): Promise<void>
    engineStates(ids?: ('claude' | 'codex')[]): Promise<EngineStatusDto[]>
    brainConnectionGet(provider: BrainConnectionProvider): Promise<BrainConnectionDto | null>
    brainConnectionSet(provider: BrainConnectionProvider, input: BrainConnectionInput): Promise<BrainConnectionDto>
    brainConnectionClear(provider: BrainConnectionProvider): Promise<void>
    accountProfiles(): Promise<import('./account-profiles.js').AccountProfiles>
    accountProfileStates(): Promise<import('./account-profiles.js').AccountProfileState[]>
    accountProfileAdd(provider: 'claude' | 'codex', name: string): Promise<import('./account-profiles.js').AccountProfiles>
    accountProfileUse(provider: 'claude' | 'codex', id: string): Promise<void>
  onEvent(listener: (event: EngramEvent) => void): () => void
  hideQuickCapture(): void
  quickComet(message: string, attachments?: string[]): Promise<string>
  quickLayout(height: number): Promise<void>
  quickOpenApp(): Promise<void>
  quickPickFiles(count: number): Promise<ChatAttachmentDto[]>
  resetApp(): Promise<boolean>
  showQuickComet(): Promise<void>
  readonly developerUiEnabled: boolean
  pathForFile(file: File): string
  chatSend(request: ChatRequestDto): Promise<void>
  chatAttach(name: string, data: Uint8Array): Promise<ChatAttachmentDto>
  chatAttachmentPreview(id: string): Promise<ChatAttachmentPreviewDto>
  chatAttachmentCopy(id: string): Promise<void>
  copyText(text: string): Promise<void>
  activityToday(): Promise<{ totalMs: number; apps: { app: string; ms: number; topTitles: string[] }[] }>
  activityGet(): Promise<boolean>
  activitySet(enabled: boolean): Promise<boolean>
  sessionWatchGet(): Promise<boolean>
  sessionWatchSet(enabled: boolean): Promise<boolean>
  sendFeedback(): Promise<void>
  reportLongTask(ms: number): void
  buildPack(query?: string): Promise<{ file: string; content: string }>
  syncStatus(): Promise<SyncStatusDto>
  syncNow(): Promise<SyncStatusDto>
  syncBrief(): Promise<string>
  teamJoin(url: string): Promise<void>
  githubOpenNew(name: string): Promise<void>
  githubConnect(url: string): Promise<GithubConnectResultDto>
  importPick(): Promise<string | null>
  importScan(folder: string): Promise<{ count: number; totalBytes: number }>
  importRun(folder: string): Promise<{ imported: number }>
  absorbStatus(): Promise<AbsorbStatusDto>
  librarianPending(): Promise<PendingWorkDto>
  absorbStop(): Promise<void>
  onboardDefaults(): Promise<{ defaultRoot: string }>
  onboardComplete(payload: OnboardPayload): Promise<void>
  enginesDetected(): Promise<boolean>
  tourEligible(): Promise<boolean>
  appVersion(): Promise<string>
  vaultReady(): Promise<boolean>
  revealVaultRoot(root: string): Promise<void>
  relaunch(): Promise<void>
  updateInstall(): Promise<{ started: boolean; reason?: string }>
  updateCheck(): Promise<UpdateCheckDto>
  updateState(): Promise<UpdateCheckDto>
  searchTemplateLearn(pasted: string): Promise<{ ok: boolean; template?: string }>
  browsersInstalled(): Promise<InstalledBrowserDto[]>
  browserChoose(path: string): Promise<void>
  settingsGet(): Promise<AppSettingsDto>
  settingsSet(settings: Partial<AppSettingsDto>): Promise<void>
  aiSelectionSet(scope: string, selection: { engine: 'claude' | 'codex'; model: string; effort?: import('core').ReasoningEffort }): Promise<void>
  aiPermissionSet(scope: string, mode: import('core').PermissionMode): Promise<void>
  mcpInfo(): Promise<McpInfoDto>
  mcpClients(): Promise<McpClientDto[]>
  mcpConnectDesktop(): Promise<McpConnectResultDto>
  mcpConnectCode(): Promise<McpConnectResultDto>
  mcpConnectCodex(): Promise<McpConnectResultDto>
  mcpStatus(): Promise<{ enabled: boolean; active: boolean; connected: number }>
  mcpEnable(enabled: boolean): Promise<{ enabled: boolean; active: boolean; connected: number }>
  mcpStop(): Promise<void>
  semanticStatus(): Promise<SemanticStatusDto>
  diagnostics(): Promise<DiagnosticsDto>
  exportLogs(): Promise<string | null>
  platform: string
}

export interface OnboardPayload {
  root: string
  importFolder: string | null
  teamUrl: string | null
  firstCapture: string | null
}

export interface AppSettingsDto {
  aiSelections?: Record<string, { engine: 'claude' | 'codex'; model: string; effort?: import('core').ReasoningEffort; permission?: import('core').PermissionMode }>
  claudeEffort?: import('core').ReasoningEffort
  codexEffort?: import('core').ReasoningEffort
  theme?: 'system' | 'light' | 'dark'
  defaultEngine: 'claude' | 'codex'
  autoStart: boolean
  teamSync: 'auto' | 'manual'
  semanticModel?: string
  searchTemplate?: string
  agentBrowser?: string
  claudeModel?: string
  codexModel?: string
  computerUse?: boolean
  workMap?: boolean
  workFiles?: boolean
  workApps?: boolean
  nativeTools?: boolean
  appsOff?: { app: string; label: string }[]
}

export interface WorkMapStatusDto { builtAt: string | null; places: number }

export interface FirstSetupDto {
  waiting: boolean
  phase: 'ai' | 'map' | 'filing' | 'retrying' | 'done'
  done: number
  total: number
  stage?: 'capture' | 'organize'
  reason?: string
  retryAt?: number
  startedAt: number
}

export interface ScheduledDto { id: string; botId: string; name: string; goal: string; when: string; lastRunAt?: string }

export interface StudyDto { id: string; botId: string; what: string; where: string[]; ask: string; state: 'offered' | 'studying' | 'review'; findings?: { title: string; description: string; body: string } }

export interface NoticesDto { items: { id: string; kind: 'scheduled' | 'habit'; title: string; text: string; at: string; read: boolean; running: boolean }[]; scheduled: ScheduledDto[] }

export interface AppUseDto { app: string; label: string; hours: number; days: number; notes: number; on: boolean; icon?: string }

export interface HabitDraftDto { key: string; labels: string[]; times: number; title: string; description: string; body: string; botId?: string }

export interface ArtifactViewDto { name: string; text: string | null }

export interface ModelChoiceDto {
  value: string
  label: string
  detail: string
  efforts?: import('core').ReasoningEffort[]
}

export type BrainConnectionProvider = 'claude' | 'codex' | 'decision'

export interface BrainConnectionInput { baseUrl: string; key: string; model: string }

export interface BrainConnectionDto { provider: BrainConnectionProvider; baseUrl: string; model: string; keyHint: string; usable: boolean }

export interface EngineLoginDto {
  id: 'claude' | 'codex'
  profile?: string
  phase: 'idle' | 'opening' | 'browser' | 'connected' | 'error'
  canOpen: boolean
  message?: string
}

export interface InstalledBrowserDto {
  id: string
  name: string
  path: string
  chosen: boolean
}
