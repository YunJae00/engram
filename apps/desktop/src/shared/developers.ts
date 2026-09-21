import type { ReasoningEffort } from 'core'

export type DevProvider = 'claude' | 'codex'
export type DevMode = 'review' | 'plan' | 'auto-edit' | 'full-access'
export interface DevPreferences {
  enabled: boolean
  provider: DevProvider
  model: string
  effort?: ReasoningEffort
  mode: DevMode
  isolate: boolean
  loadProjectSettings: boolean
}
export interface DevRepo { id: string; path: string; name: string; archived?: boolean }
export interface DevUsage {
  input?: number
  output?: number
  cached?: number
  cost?: number
  windows?: { name: string; used?: number; resetsAt?: number }[]
  updatedAt?: number
  unavailable?: string
}
export interface DevQuestion { id: string; text: string; options: string[]; multiple?: boolean }
export interface DevApproval {
  id: string
  kind: 'permission' | 'question'
  title: string
  detail: string
  questions?: DevQuestion[]
  changes?: { path: string; before: string; after: string }[]
  remember?: boolean
  rule?: { tool: string; input: string }
}
export interface DevItem {
  id: string
  title?: string
  activity?: 'command' | 'file' | 'search' | 'agent' | 'plan' | 'tool'
  kind: 'user' | 'assistant' | 'tool' | 'plan' | 'agent' | 'error' | 'notice'
  text: string
  status?: 'running' | 'done' | 'failed'
}
export interface DevSession {
  id: string
  repoId: string
  provider: DevProvider
  model: string
  effort?: ReasoningEffort
  mode: DevMode
  cwd: string
  branch?: string
  runtimeId?: string
  accountProfile?: string
  forkOnStart?: boolean
  handoff?: string
  engineEpoch?: string
  loadProjectSettings?: boolean
  title: string
  createdAt: number
  updatedAt: number
  state: 'idle' | 'starting' | 'running' | 'waiting' | 'stopping' | 'failed'
  items: DevItem[]
  pending: DevApproval[]
  usage: DevUsage
}
export interface DevExternalSession { id: string; provider: DevProvider; title: string; cwd: string; updatedAt: number; active?: boolean }
export interface DevCommand { name: string; description: string; prompt: string }
export interface DevState { preferences: DevPreferences; repos: DevRepo[]; sessions: Omit<DevSession, 'items' | 'pending'>[] }
export interface DevGitState { branch: string; files: { path: string; status: string; previousPath?: string }[]; diff: string; truncated: boolean; fingerprint?: string }
export interface DevFileReview { path: string; before: string; after: string; fingerprint: string; readOnly?: boolean; hunks: { index: number; line: number; text: string }[] }
export interface DevFileEntry { path: string; name: string; directory: boolean }
export interface DevFile { path: string; text: string; fingerprint: string }
export interface DevFileMatch { path: string; line?: number; text?: string }
export interface DevLanguageResult { completions?: { name: string; kind: string }[]; definitions?: { path: string; line: number }[]; diagnostics?: { line: number; message: string; error: boolean }[] }
export interface DevWorkspace { repoId: string; sessionId?: string }
export interface DevConsoleState { id: string; cwd: string; command: string; output: string; running: boolean; truncated: boolean; stopped?: boolean; exitCode?: number | null; logPath?: string }
export interface DevRule { id: string; repoId: string; provider: DevProvider; tool: string; input: string; decision: 'allow' | 'deny' }
export interface DevUpdate { id: string; items: DevItem[]; state: DevSession['state']; pending: DevApproval[]; usage: DevUsage; provider?: DevProvider; accountProfile?: string; runtimeId?: string; title?: string; updatedAt?: number }
export interface DevelopersApi {
  devOpenLink(url: string): Promise<void>
  devConsole(workspace: DevWorkspace): Promise<DevConsoleState | null>
  devRunCommand(workspace: DevWorkspace, command: string): Promise<DevConsoleState>
  devStopCommand(workspace: DevWorkspace): Promise<void>
  devFiles(workspace: DevWorkspace, path: string): Promise<{ entries: DevFileEntry[]; truncated: boolean }>
  devReadFile(workspace: DevWorkspace, path: string): Promise<DevFile>
  devSaveFile(workspace: DevWorkspace, path: string, fingerprint: string, text: string): Promise<DevFile>
  devCreateFile(workspace: DevWorkspace, path: string): Promise<DevFile>
  devSearchFiles(workspace: DevWorkspace, query: string): Promise<{ matches: DevFileMatch[]; truncated: boolean }>
  devLanguage(workspace: DevWorkspace, path: string, text: string, position: number, kind: 'check' | 'complete' | 'definition'): Promise<DevLanguageResult>
  devState(): Promise<DevState>
  devPreferences(patch: Partial<DevPreferences>): Promise<DevPreferences>
  devAddRepo(): Promise<DevRepo | null>
  devRemoveRepo(id: string): Promise<void>
  devCreate(request: { repoId: string; provider: DevProvider; accountProfile?: string; model: string; effort?: ReasoningEffort; mode: DevMode; isolate: boolean; fullAccessConfirmed?: boolean; resume?: string; fork?: boolean; resumeConfirmed?: boolean; allFolders?: boolean }): Promise<DevSession>
  devSession(id: string): Promise<DevSession>
  devSend(id: string, text: string): Promise<void>
  devStop(id: string): Promise<void>
  devRespond(id: string, requestId: string, response: { decision: 'allow' | 'deny'; remember?: boolean; answers?: Record<string, string[]> }): Promise<void>
  devExternal(repoId: string, provider: DevProvider, allFolders?: boolean, profile?: string): Promise<DevExternalSession[]>
  devExternalRead(repoId: string, provider: DevProvider, id: string, allFolders?: boolean, profile?: string): Promise<DevItem[]>
  devFork(id: string, isolate?: boolean): Promise<DevSession>
  devGit(id: string): Promise<DevGitState>
  devStage(id: string, paths: string[], staged: boolean, fingerprint: string): Promise<DevGitState>
  devCommit(id: string, paths: string[], message: string): Promise<void>
  devFileReview(id: string, path: string): Promise<DevFileReview>
  devUndoHunk(id: string, path: string, fingerprint: string, index: number): Promise<{ review: DevFileReview; backup: string }>
  devRules(): Promise<DevRule[]>
  devRemoveRule(id: string): Promise<void>
  devUsage(provider: DevProvider, profile?: string): Promise<DevUsage>
  devCommands(id: string): Promise<DevCommand[]>
  devProjectCommands(repoId: string, provider: DevProvider): Promise<DevCommand[]>
  devConfigure(id: string, change: { provider?: DevProvider; model: string; effort?: ReasoningEffort; mode: DevMode; fullAccessConfirmed?: boolean }): Promise<DevSession>
}
