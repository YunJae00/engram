import type { EngramApi } from '../../shared/types.js'

declare global {
  interface Window {
    engram: EngramApi
  }
}

export const api: EngramApi = window.engram
