export interface DesktopWindowDto { id: string; name: string }
export interface DesktopBindingDto { lane: string; source: string; name: string; readable: boolean; stopped?: boolean }
export interface DesktopNodeDto {
  id: string
  name: string
  controlType: string
  value?: string | null
  bounds: { x: number; y: number; width: number; height: number }
}
export interface DesktopObservationDto {
  snapshot: string
  nodes: DesktopNodeDto[]
  bounds: { x: number; y: number; width: number; height: number }
  captureBounds?: { x: number; y: number; width: number; height: number }
  protectedBounds?: { x: number; y: number; width: number; height: number }[]
  focusedEditable?: boolean
  truncated?: boolean
}
export interface DesktopControlStatusDto {
  state: 'idle' | 'ready' | 'running' | 'paused' | 'needs-person'
  lane?: string
  name?: string
  reason?: string
  expiresAt?: number
}
export interface DesktopApi {
  desktopAvailable(): Promise<boolean>
  desktopVisible(): Promise<boolean>
  desktopWindows(): Promise<DesktopWindowDto[]>
  desktopBindings(): Promise<DesktopBindingDto[]>
  desktopChoose(lane: string, source: string): Promise<DesktopBindingDto>
  desktopRelease(lane: string): Promise<void>
  desktopReadAccess(lane: string, enabled: boolean): Promise<DesktopBindingDto>
  desktopPrepareCapture(lane: string): Promise<string>
  desktopCancelCapture(token: string): Promise<void>
  desktopObserve(lane: string): Promise<DesktopObservationDto>
  desktopControlStatus(): Promise<DesktopControlStatusDto>
  desktopControlStart(lane: string): Promise<DesktopControlStatusDto>
  desktopControlStop(): Promise<void>
}
