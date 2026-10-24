// The gate experiments read back: for each condition, how often runs reached
// the goal, how often they claimed a goal they had not reached, what they
// cost, and - from each run's own trace - which way the failures went wrong.
//
//   node ../../packages/core/node_modules/tsx/dist/cli.mjs scripts/research/gate-report.mts <run dir> [<run dir> ...]
// Prints a markdown report.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const dirs = process.argv.slice(2)
const runs: any[] = []
for (const dir of dirs) for (const line of (await readFile(join(dir, 'runs.jsonl'), 'utf8')).trim().split('\n')) runs.push({ ...JSON.parse(line), dir: basename(dir) })

const pathOf = (url: string) => { try { const at = new URL(url); return at.pathname + at.search } catch { return url } }
// How a run went wrong, read from its steps; a run can go wrong more than one way.
function failures(run: any): string[] {
  const kinds = new Set<string>()
  const steps: any[] = run.trace ?? []
  const pages = steps.map(step => pathOf(step.url))
  if (pages.some((page, at) => pages.indexOf(page) < at && steps[at]?.choice === steps[pages.indexOf(page)]?.choice)) kinds.add('circling')
  if (steps.some(step => step.moved === false)) kinds.add('move did not go through')
  if (steps.some((step, at) => at > 0 && steps.slice(Math.max(0, at - 2), at).some(before => new URL(before.url).pathname === new URL(step.url).pathname && before.choice === step.choice && before.choice !== 'done'))) kinds.add('repeat before the page settled')
  if (steps.some(step => step.top?.length > 1 && step.top[0][1] - step.top[1][1] < 0.4 && !['done', 'blocked'].includes(step.choice))) kinds.add('close call')
  if (run.status === 'done' && !run.success) kinds.add('claimed a goal not reached')
  if (/rate limited/.test(run.note ?? '')) kinds.add('rate limited')
  if (run.status === 'steps-exhausted') kinds.add('ran out of steps')
  return [...kinds]
}

const key = (run: any) => `${run.gate}${run.margin ? ` (margin ${run.margin})` : ''}`
const conditions = [...new Set(runs.map(key))]
const sets = [...new Set(runs.map(run => run.dir.split('-')[5] ?? ''))]
const pct = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '-'
const mean = (values: number[]) => values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : '-'

console.log(`# Step gate results (${sets.join(', ')})\n`)
console.log('| condition | runs | reached the goal | claimed a goal not reached | decisions / run | seconds / run |')
console.log('|---|---|---|---|---|---|')
for (const condition of conditions) {
  const mine = runs.filter(run => key(run) === condition)
  console.log(`| ${condition} | ${mine.length} | ${mine.filter(r => r.success).length} (${pct(mine.filter(r => r.success).length, mine.length)}) | ${mine.filter(r => r.status === 'done' && !r.success).length} | ${mean(mine.map(r => r.decisions))} | ${mean(mine.map(r => r.ms / 1000))} |`)
}
console.log('\n## By task (reached / runs)\n')
console.log(`| task | trap | ${conditions.join(' | ')} |`)
console.log(`|---|---|${conditions.map(() => '---').join('|')}|`)
for (const task of [...new Set(runs.map(run => run.task))]) {
  const trap = runs.find(run => run.task === task)?.trap ?? ''
  console.log(`| ${task} | ${trap} | ${conditions.map(condition => { const mine = runs.filter(r => r.task === task && key(r) === condition); return `${mine.filter(r => r.success).length}/${mine.length}` }).join(' | ')} |`)
}
console.log('\n## How failed runs went wrong (count of failed runs showing each)\n')
console.log(`| way | ${conditions.join(' | ')} |`)
console.log(`|---|${conditions.map(() => '---').join('|')}|`)
const ways = [...new Set(runs.filter(r => !r.success).flatMap(failures))]
for (const way of ways) console.log(`| ${way} | ${conditions.map(condition => runs.filter(r => key(r) === condition && !r.success && failures(r).includes(way)).length).join(' | ')} |`)
console.log('\n## What the gate did (count of steps)\n')
console.log(`| action | ${conditions.join(' | ')} |`)
console.log(`|---|${conditions.map(() => '---').join('|')}|`)
const actions = (run: any) => (run.trace ?? []).flatMap((step: any) => (step.gate ?? []).map((one: string) => one.split(':')[0]))
for (const action of [...new Set(runs.flatMap(actions))]) console.log(`| ${action} | ${conditions.map(condition => runs.filter(r => key(r) === condition).flatMap(actions).filter((one: string) => one === action).length).join(' | ')} |`)
