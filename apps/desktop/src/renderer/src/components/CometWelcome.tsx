import { useRef, useState } from 'react'
import { api } from '../api.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { ChatComposer } from './ChatComposer.js'
import { ModelPicker } from './ModelPicker.js'
import { t } from '../i18n.js'
import { Comet } from './Icon.js'
import { Globe } from 'lucide-react'
import type { ChatAttachmentDto } from '../../../shared/types.js'
import { chatMessage, sendCometMessage } from '../lib/attachments.js'
import { webPane } from '../lib/webPane.js'
import { selectDesktopSurface } from '../lib/desktopSession.js'

export function CometWelcome() {
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachmentDto[]>([])
  const [attaching, setAttaching] = useState(false)
  const pending = useRef(false)
  const send = async () => {
    const message = chatMessage(draft, attachments)
    if (!message || pending.current || attaching) return
    pending.current = true
    setCreating(true)
    setError('')
    try {
      const bot = await api.botCreate({ name: t('bots.untitled'), purpose: '' })
      const sending = sendCometMessage(api, cometThreads, bot.id, draft, attachments)
      selectComet(bot.id)
      setDraft('')
      setAttachments([])
      await sending
    } catch (cause) { setError(String(cause)) }
    finally { pending.current = false; setCreating(false) }
  }
  const openWeb = async () => {
    if (pending.current || attaching) return
    pending.current = true; setCreating(true); setError('')
    try {
      const bot = await api.botCreate({ name: t('bots.untitled'), purpose: '' })
      cometThreads.setDraft(bot.id, draft)
      cometThreads.setAttachments(bot.id, attachments)
      const lane = cometChannel(bot.id)
      selectDesktopSurface(lane, 'browser'); webPane.open(lane); selectComet(bot.id)
    } catch (cause) { setError(String(cause)) }
    finally { pending.current = false; setCreating(false) }
  }
  return <section className="comet-welcome" data-testid="comet-welcome">
    <div className="comet-welcome-mark" aria-hidden><span /><Comet size={38} /></div>
    <div className="comet-welcome-heading"><h1>A spark starts here.</h1><p>Ask, explore, or put a comet to work.</p></div>
    <ChatComposer value={draft} onChange={setDraft} onSend={() => void send()} onStop={() => undefined}
      placeholder="Ask Engram…" maxLength={2000} busy={false} disabled={creating} testId="welcome-input" attachments={attachments} onAttachmentsChange={setAttachments} onAttachingChange={setAttaching}
      tools={<><button className="composer-web" data-testid="welcome-web" aria-label="Open the page panel" title="Open the page panel" disabled={creating || attaching} onClick={() => void openWeb()}><Globe size={15} strokeWidth={1.9} aria-hidden /></button><ModelPicker /></>} />
    {error && <p role="alert">{error}</p>}
  </section>
}
