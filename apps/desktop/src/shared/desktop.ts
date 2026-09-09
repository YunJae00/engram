export interface DesktopWindowDto { id: string; name: string; foreground?: boolean }
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
  focusedControl?: string | null
  truncated?: boolean
  captureSafe?: boolean
}
// The brain that holds the computer, named for the person: the banner on the
// screen says who is moving the mouse.
export type DesktopEngineId = 'claude' | 'codex'
export interface DesktopControlStatusDto {
  state: 'idle' | 'ready' | 'running' | 'paused' | 'needs-person'
  lane?: string
  name?: string
  reason?: string
  expiresAt?: number
  engine?: DesktopEngineId
  engineLabel?: string
  inputActive?: boolean
  // Paused because a hand touched the mouse or keyboard: the comet carries on
  // once that hand has been still for a moment. Esc and Stop are not resumable.
  resumable?: boolean
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
  // Ends a hands-on pause early, from the on-screen pill.
  desktopControlResume(): Promise<void>
  // What the on-screen overlay is showing; the overlay windows prime from it.
  desktopOverlayStatus(): Promise<DesktopControlStatusDto>
}
