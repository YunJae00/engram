import { AlertTriangle, Play, Repeat, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApprovalRuleDto, RoutineDto, RoutineStepDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { ApprovalChips } from '../components/ApprovalChips.js'
import { LiveView } from '../components/LiveView.js'
import { RoutineProgress } from '../components/RoutineProgress.js'
import { SubmitGate } from '../components/SubmitGate.js'
import { agentMirror } from '../lib/agentMirrorLive.js'
import { useApp } from '../state.js'
import { stepLabel } from '../lib/pendingStatus.js'

function RecordedStep({ step }: { step: RoutineStepDto }) {
  if (step.kind === 'open') return <><h3>Open page</h3><p>{step.url}</p></>
  if (step.kind === 'read') return <><h3>Read page</h3><p>Collect the readable text from the current page.</p></>
  if (step.kind === 'key') return <h3>Press {step.key}</h3>
  return <>
    <h3>{step.kind === 'click' ? 'Click' : 'Type into'} {step.target.text || 'the recorded element'}</h3>
    {step.kind === 'type' && <pre className="routine-step-value" data-testid="routine-step-value">{step.text}</pre>}
    {!!step.target.css?.length && <details className="routine-step-selectors"><summary>Recorded selectors</summary>{step.target.css.map((selector, index) => <code key={index}>{selector}</code>)}</details>}
  </>
}

export function RoutinesView({ selectedId }: { selectedId: string | null }) {
  const { t, routine, routineWall, answerRoutineWall, startRoutine, showToast, vaultReady } = useApp()
  const [data, setData] = useState<{ routines: RoutineDto[]; rules: ApprovalRuleDto[]; selectedId: string | null; body: string; bodyError: boolean } | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [starting, setStarting] = useState(false)
  const scheduled = routine.running && !routine.channel
  useEffect(() => {
    if (!scheduled) return
    agentMirror.select('default')
    void api.agentLane('default').catch(failure => showToast(String(failure)))
  }, [scheduled, showToast])
  useEffect(() => {
    if (!vaultReady) return
    let generation = 0
    const reload = async () => {
      const current = ++generation
      try {
        const [routines, rules] = await Promise.all([api.routinesList(), api.approvalsList()])
        if (current !== generation) return
        setData({ routines, rules, selectedId, body: '', bodyError: false }); setError('')
        if (selectedId && routines.some(one => one.id === selectedId)) {
          const body = await api.readNoteBody(selectedId).catch(() => null)
          if (current === generation) setData({ routines, rules, selectedId, body: body ?? '', bodyError: body === null })
        }
      } catch (failure) {
        if (current === generation) setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void reload()
    const off = api.onEvent(event => { if (event.type === 'routine:logged' || event.type === 'vault:changed') void reload() })
    return () => { generation++; off() }
  }, [selectedId, revision, vaultReady])
  const selected = data?.selectedId === selectedId ? data.routines.find(one => one.id === selectedId) : undefined
  const rules = data?.rules.filter(rule => rule.routineId === selectedId) ?? []
  const run = async () => {
    if (!selected || starting) return
    setStarting(true)
    try { await startRoutine(selected.id, selected.name) }
    finally { setStarting(false) }
  }
  const forget = (fingerprint: string) => {
    void api.approvalForget(fingerprint).then(() => setRevision(value => value + 1)).catch(failure => showToast(String(failure)))
  }
  return <section className="routines-view" data-testid="routines-view" aria-label="Routines">
    <div className="routine-workspace-content">
      {scheduled && <section className="routine-scheduled" data-testid="scheduled-routine" aria-label="Scheduled routine">
        <div className="routine-scheduled-head"><h2>Scheduled run</h2><button className="secondary" data-testid="scheduled-routine-stop" onClick={() => void api.routineAbort().catch(failure => showToast(String(failure)))}><Square size={12} aria-hidden />Stop</button></div>
        <RoutineProgress />
        <LiveView open={routineWall !== null && !routineWall.channel}>
          {routineWall && !routineWall.channel && <button className="errand-wall-done" data-testid="scheduled-routine-wall-done" onClick={() => answerRoutineWall('resolved')}>{t('routines.wallDone')}</button>}
        </LiveView>
        <SubmitGate />
      </section>}
      {error && <div className="routine-workspace-error" role="alert"><p>{error}</p><button className="secondary" onClick={() => setRevision(value => value + 1)}>Try again</button></div>}
      {!selectedId ? <div className="routine-overview" data-testid="routines-overview">
        <Repeat size={32} strokeWidth={1.4} aria-hidden />
        <h1>Saved routines</h1>
        <p>Keep a useful task with its instructions and starting pages, ready for next time.</p>
        <p>{data?.routines.length ? 'Choose a routine in the sidebar to see its description and recorded steps.' : data ? t('routines.empty') : 'Loading saved routines…'}</p>
        <p className="routine-run-hint">Run opens a new chat. Progress, approvals and results stay with that conversation.</p>
      </div> : selected ? <article className="routine-detail" data-testid={`routine-detail-${selected.id}`}>
        <header className="routine-detail-head">
          <div><span className="routine-eyebrow">Saved routine</span><h1>{selected.name}</h1></div>
          <button className="primary" data-testid={`routine-run-${selected.id}`} disabled={starting || routine.running} onClick={() => void run()}><Play size={14} aria-hidden />Run in new chat</button>
        </header>
        <div className="routine-detail-meta"><span>{selected.task ? selected.task.surface === 'web' ? 'Browser task' : 'Comet task' : t('routines.steps', { n: selected.steps.length })}</span>{selected.lastRunAt && <span>Last run <time dateTime={selected.lastRunAt}>{new Date(selected.lastRunAt).toLocaleString('en-US')}</time>{selected.lastOutcome && ` · ${selected.lastOutcome}`}</span>}</div>
        {selected.pendingWrite && <p className="routine-pending-warning" role="status"><AlertTriangle size={15} aria-hidden />{t('routines.unfinishedHint')}</p>}
        <section className="routine-description" aria-label="Routine description"><h2>{selected.task ? 'What it does' : 'How it runs'}</h2><p>{selected.task?.goal ?? 'Start in a new chat. Saved steps run first; if a control has moved, your connected comet checks the page and continues unfinished work when safe. Login, approval and Stop stay in your hands.'}</p>{selected.task && <p>Your comet checks the current state, adapts the saved method and verifies the result. Login and approval still need you.</p>}{!selected.task && data?.body && <details className="routine-saved-description"><summary>Saved description</summary><p data-testid="routine-description">{data.body.replace(/^# [^\n]+\n*/, '').trim()}</p></details>}{data?.bodyError && <div className="routine-workspace-error" data-testid="routine-description-error" role="status"><p>The saved description is unavailable. You can still review and run the recorded steps.</p><button className="secondary" onClick={() => setRevision(value => value + 1)}>Reload description</button></div>}</section>
        {!!selected.task?.urls.length && <section><h2>Starting pages</h2><div className="routine-starting-pages">{selected.task.urls.map(url => <a key={url} href={url}>{url}</a>)}</div></section>}
        {selected.task?.execution && <section aria-label="Saved execution settings"><h2>Run settings</h2><p>{selected.task.execution.engine === 'claude' ? 'Claude' : 'ChatGPT'} · {selected.task.execution.model || 'Default model'} · {selected.task.execution.effort || 'Auto'} effort</p><p>The new conversation starts with these settings. You can change them there.</p></section>}
        {!!selected.task?.checks?.length && <section><h2>Result checks</h2><ul>{selected.task.checks.map(check => <li key={check}>{check}</li>)}</ul></section>}
        {rules.length > 0 && <section aria-label="Standing approvals"><h2>Standing approvals</h2><ApprovalChips rules={rules} onForget={forget} /></section>}
        {selected.task ? !!selected.task.method.length && <section aria-label="Saved method"><h2>Saved method</h2><ol className="routine-recorded-steps">{selected.task.method.map((line, index) => <li key={index}>{stepLabel(t, line.includes(': ') ? line : `${line}: `)}</li>)}</ol></section> : <section aria-label="Recorded steps"><h2>Recorded steps</h2><ol className="routine-recorded-steps" data-testid="routine-recorded-steps">{selected.steps.map((step, index) => <li key={index} data-kind={step.kind}><RecordedStep step={step} /></li>)}</ol></section>}
      </article> : !error ? <p className="routine-workspace-empty" role="status">{data?.selectedId === selectedId ? 'This routine is no longer available. Choose another one in the sidebar.' : 'Loading routine…'}</p> : null}
    </div>
  </section>
}
