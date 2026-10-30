import type { EngineHealthReason, SyncStatusDto } from './types.js'

export interface SemanticStatusDto {
  status: 'off' | 'loading' | 'indexing' | 'ready' | 'error'
  detail: string
  model: string
}

export interface DiagnosticsDto {
  engines: {
    id: string
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
