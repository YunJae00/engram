import { useRef, useState } from 'react'
import { FileText, Search, PencilLine, ListChecks } from 'lucide-react'
import { api } from '../api.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { ChatComposer } from './ChatComposer.js'
import { ModelPicker } from './ModelPicker.js'
import { t } from '../i18n.js'

const STARTERS = [
  { label: 'Create a document', text: 'Help me create a document about ', icon: FileText },
  { label: 'Research a topic', text: 'Research and summarize ', icon: Search },
  { label: 'Refine my writing', text: 'Help me improve this draft: ', icon: PencilLine },
  { label: 'Plan my work', text: 'Help me plan the steps for ', icon: ListChecks },
]

export function CometWelcome() {
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
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
    <h1>What would you like to work on?</h1>
    <p>Bring an idea, a question, or something to get done.</p>
    <ChatComposer ref={input} value={draft} onChange={setDraft} onSend={() => void send()} onStop={() => undefined}
      placeholder="Ask Engram…" maxLength={2000} busy={false} disabled={creating} testId="welcome-input" tools={<ModelPicker />} />
    <div className="welcome-starters">{STARTERS.map(({ label, text, icon: Icon }) => <button key={label} onClick={() => { setDraft(text); input.current?.focus() }}><Icon size={16} aria-hidden />{label}</button>)}</div>
    {error && <p role="alert">{error}</p>}
  </section>
}
