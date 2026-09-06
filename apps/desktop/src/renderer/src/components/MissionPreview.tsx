import { Monitor } from 'lucide-react'
import { useCallback, useState } from 'react'
import { FrameScreen } from './FrameScreen.js'
import { onMissionFrame } from '../lib/missionFramesLive.js'
import { t } from '../i18n.js'

export function MissionPreview({ lane, name, open }: { lane: string; name: string; open(): void }) {
  const [painted, setPainted] = useState(false)
  const source = useCallback((paint: (data: string) => void) => {
    let started = false
    return onMissionFrame(lane, (frame) => {
      if (!frame.data) return
      paint(frame.data)
      if (!started) { started = true; setPainted(true) }
    })
  }, [lane])
  return (
    <button className="mission-preview" aria-label={t('mission.open', { name })} onClick={open}>
      <FrameScreen source={source} />
      {!painted && <div className="mission-text"><Monitor size={26} strokeWidth={1.4} /><p>{t('mission.chat')}</p></div>}
    </button>
  )
}
