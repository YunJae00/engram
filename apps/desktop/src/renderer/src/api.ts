import type { EngramApi } from '../../shared/types.js'

declare global {
  interface Window {
    engram: EngramApi
  }
}

export const api: EngramApi = window.engram

export const apiErrorText = (message: string): string => message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
