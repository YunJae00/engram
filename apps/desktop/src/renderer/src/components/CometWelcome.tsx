import { useRef, useState } from 'react'
import { api } from '../api.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { ChatComposer } from './ChatComposer.js'
import { ModelPicker } from './ModelPicker.js'
import { t } from '../i18n.js'

export function CometWelcome() {
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const send = async () => {
    const message = draft.trim()
    if (!message || pending.current) return
    pending.current = true
    setCreating(true)
    setError('')
    try {
      const bot = await api.botCreate({ name: t('bots.untitled'), purpose: '' })
      const history = cometThreads.begin(bot.id, message)
      selectComet(bot.id)
      setDraft('')
      try { await api.chatSend({ engineId: '', message, history, channel: cometChannel(bot.id), botId: bot.id }) }
      catch (cause) { if (cometThreads.thread(bot.id).busy) cometThreads.fail(bot.id, String(cause)) }
    } catch (cause) { setError(String(cause)) }
    finally { pending.current = false; setCreating(false) }
  }
  return <section className="comet-welcome" data-testid="comet-welcome">
    <h1>What’s next?</h1>
    <ChatComposer value={draft} onChange={setDraft} onSend={() => void send()} onStop={() => undefined}
      placeholder="Ask Engram…" maxLength={2000} busy={false} disabled={creating} testId="welcome-input" tools={<ModelPicker />} />
    {error && <p role="alert">{error}</p>}
  </section>
}
