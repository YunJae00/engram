import { useDesktopSurface } from '../lib/desktopSession.js'
import { ComputerSurface } from './ComputerSurface.js'
import { MissionPreview } from './MissionPreview.js'
import { SurfaceTabs } from './SurfaceTabs.js'

export function OrbitSurface({ lane, name, open }: { lane: string; name: string; open(): void }) {
  const surface = useDesktopSurface(lane)
  return <div className="orbit-surface" data-testid="orbit-surface">
    <SurfaceTabs lane={lane} />
    {surface === 'computer' ? <ComputerSurface key={lane} lane={lane} /> : <MissionPreview lane={lane} name={name} open={open} />}
  </div>
}
