// The person's side of a scenario: what they type, what they do in the
// agent window with their own hands, and what they answer when asked.
import { chromium, type Browser, type Page } from 'playwright-core'
import type { Page as AppPage } from '@playwright/test'

export interface Outcome {
  answer: string
  tools: string[]
  steps: string[]
  offer: string | null
  options: string[]
  gates: number
  seconds: number
  // Pieces of the reply that arrived while it was being written.
  tokens: number
  error: string | null
}

export type GateAnswer = 'approve' | 'always' | 'cancel'

export class Person {
  private readonly trace: string[] = []
  private history: { role: 'user' | 'assistant'; text: string }[] = []
  gate: GateAnswer = 'approve'
  // Every turn of the scenario under way, kept even when it ends in an error.
  turns: Outcome[] = []

  constructor(
    readonly app: AppPage,
    readonly cdpPort: number,
  ) {}

  // Wires the events once per app window: steps, answers, gates.
  async attach(): Promise<void> {
    await this.app.exposeFunction('__probe', (line: string) => {
      this.trace.push(line)
    })
    await this.app.exposeFunction('__gateAnswer', () => this.gate)
    await this.app.evaluate(() => {
      // An exposed function answers with a promise on this side of the bridge.
      const w = window as unknown as { __probe(line: string): void; __gateAnswer(): Promise<'approve' | 'always' | 'cancel'> }
      window.engram.onEvent((event) => {
        if (event.type === 'comet:step') w.__probe(`step ${event.line}`)
        if (event.type === 'routine:step') w.__probe(`hands ${event.label}`)
        if (event.type === 'routine:submit') {
          w.__probe('GATE')
          setTimeout(() => void w.__gateAnswer().then((verdict) => window.engram.routineSubmitDone(verdict)), 400)
        }
        if (event.type === 'chat:token') w.__probe('TOKEN')
        if (event.type === 'chat:done') w.__probe(`ANSWER ${JSON.stringify({ text: event.text, offer: event.offer ?? null })}`)
        if (event.type === 'chat:error') w.__probe(`ERROR ${event.message}`)
      })
    })
  }

  async newComet(name: string): Promise<string> {
    this.history = []
    const bot = (await this.app.evaluate((n) => window.engram.botCreate({ name: n, purpose: '' }), name)) as { id: string }
    return bot.id
  }

  // Types a message to the comet and waits for its answer. The conversation
  // carries on inside one comet; a new comet starts it over.
  async say(botId: string, text: string, limitS = 300): Promise<Outcome> {
    this.trace.length = 0
    const started = Date.now()
    await this.app.evaluate(
      ({ botId, message, turns }) => window.engram.chatSend({ engineId: '', message, history: turns, channel: `bot-${botId}`, botId }),
      { botId, message: text, turns: this.history },
    )
    for (let waited = 0; waited < limitS; waited += 1) {
      if (this.trace.some((l) => l.startsWith('ANSWER') || l.startsWith('ERROR'))) break
      await new Promise((r) => setTimeout(r, 1_000))
    }
    const answerLine = this.trace.find((l) => l.startsWith('ANSWER'))
    const parsed = answerLine
      ? (JSON.parse(answerLine.slice(7)) as { text: string; offer: { kind: string; options?: string[] } | null })
      : null
    const answer = parsed?.text ?? ''
    if (answer) this.history.push({ role: 'user', text }, { role: 'assistant', text: answer })
    const outcome: Outcome = {
      answer,
      tools: this.trace.filter((l) => l.startsWith('step ') && !l.startsWith('step   <-')).map((l) => l.slice(5).split(':')[0]!.trim()),
      steps: this.trace.filter((l) => l.startsWith('step ') || l.startsWith('hands ') || l === 'GATE'),
      offer: parsed?.offer?.kind ?? null,
      options: parsed?.offer?.options ?? [],
      gates: this.trace.filter((l) => l === 'GATE').length,
      seconds: Math.round((Date.now() - started) / 1000),
      tokens: this.trace.filter((l) => l === 'TOKEN').length,
      error: this.trace.find((l) => l.startsWith('ERROR'))?.slice(6) ?? (answerLine ? null : 'no answer within the time limit'),
    }
    this.turns.push(outcome)
    return outcome
  }

  async stop(botId: string): Promise<void> {
    await this.app.evaluate((botId) => window.engram.chatAbort(`bot-${botId}`), botId)
  }

  // Their own hands in the agent window: the page the comet left open.
  async hands<T>(work: (page: Page) => Promise<T>): Promise<T> {
    let browser: Browser | null = null
    let last: unknown
    for (let i = 0; i < 30; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.cdpPort}`)
        const page = browser.contexts()[0]?.pages().find((one) => one.url() !== 'about:blank') ?? browser.contexts()[0]?.pages()[0]
        if (page) {
          try {
            return await work(page)
          } finally {
            await browser.close().catch(() => undefined)
          }
        }
        await browser.close().catch(() => undefined)
      } catch (err) {
        last = err
        await browser?.close().catch(() => undefined)
      }
      await new Promise((r) => setTimeout(r, 1_000))
    }
    throw last ?? new Error('the agent window never answered on the debug port')
  }

  // Shows the comet a job once, by doing it in the teach window, then keeps
  // it under a name.
  async teach(name: string, work: (page: Page) => Promise<void>, readAtEnd = false): Promise<string> {
    await this.app.evaluate(() => window.engram.routineTeachStart())
    await this.hands(work)
    if (readAtEnd) await this.app.evaluate(() => window.engram.routineTeachRead())
    const steps = (await this.app.evaluate(() => window.engram.routineTeachStop())) as unknown[]
    const routine = (await this.app.evaluate(({ name, steps }) => window.engram.routineAdd({ name, steps: steps as never }), { name, steps })) as { id: string }
    return routine.id
  }
}
