export * from './ipc-types-1.js'
export * from './ipc-types-2.js'
export * from './ipc-types-3.js'
export * from './ipc-types-4.js'
export type { SidebarLayout, SidebarChange, SidebarKind } from 'core'
export type { DesktopWindowDto, DesktopBindingDto, DesktopObservationDto, DesktopControlStatusDto } from './desktop.js'

export interface PermissionCardDto {
  permission: 'accessibility' | 'screenRecording' | 'inputMonitoring'
  lang: 'ko' | 'en'
  label: string
  title: string
  why: string
  button: string
}
declare module './ipc-types-3.js' {
  interface EngramApi {
    desktopPermissionCard(lane: string): Promise<PermissionCardDto | null>
    desktopPermissionPane(permission: PermissionCardDto['permission']): Promise<void>
    onPermissionCard(listener: (lane: string, card: PermissionCardDto | null) => void): () => void
  }
}
