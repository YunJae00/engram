import { MissionPreview } from './MissionPreview.js'

// One surface per tile: the comet's page. The computer has no pane of its
// own - when a comet uses an app, the app itself is on the screen, under the
// overlay's banner, and this tile keeps showing the conversation's page.
export function OrbitSurface({ lane, name, open }: { lane: string; name: string; open(): void }) {
  return <div className="orbit-surface" data-testid="orbit-surface">
    <MissionPreview lane={lane} name={name} open={open} />
  </div>
}
