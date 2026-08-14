// Given the REAL pairs the vault is currently asking about, how many does J12
// settle by itself, and does it escalate the ones a person genuinely owns?
//
// The claim being tested is not "fewer questions" — a resolver that resolves
// everything would score perfectly and be useless. It is: settle the machine's
// duplicate summaries, and hand over the three that were independently judged
// to need a person (two measurements that will not reconcile, dev-versus-prod,
// and the pair that breaks only when combined).
//
// Nothing is written: the prompt is run and the verdict read, `apply` is never
// called.
import { AGENTS_MD_V1 } from '../src/agents-template.js'
import { createEngine } from '../src/engine/registry.js'
import { engineCwd, extractJson } from '../src/engine/types.js'
import { buildJ12 } from '../src/jobs/resolve.js'
import { readNote } from '../src/notes.js'
import type { Note } from '../src/schema.js'
import { vaultPaths } from '../src/vault.js'

const paths = vaultPaths(process.env['ENGRAM_VAULT'] ?? 'C:/Users/ykwon060/Engram')
const engine = createEngine('claude')

// The open conflict pairs, straight off disk, with a verdict I reached by
// reading all 22 by hand. HUMAN = only a person can answer.
const PAIRS: { a: string; b: string; human: boolean; what: string }[] = [
  { a: 'n-ms6wzzk9-8ep11u', b: 'n-mrx7y2ky-7m0eea', human: false, what: '자동 업데이트 미도입 → 가동 중' },
  { a: 'n-ms6vzor3-1bwm4i', b: 'n-mrxl0hby-ey851y', human: false, what: '백로그 "하나뿐" → 항목 추가됨' },
  // Labelled `human` in the first pass and that was WRONG — the engine caught
  // it and I had not read the notes. One measures "64 active in the last two
  // hours", the other "2,202 of 2,235 are self-generated", and the second
  // note's own closing line says it EXPLAINS the first. Two different things
  // measured, both true. Left here as the case that exposed the missing
  // keep-both verdict.
  { a: 'n-ms5rxgb6-fr6ukh', b: 'n-ms5qxi0c-b01v6t', human: false, what: '실측 2,235/64 vs 2,202 — 실은 보완 관계' },
  { a: 'n-ms6upwr6-2qfmfy', b: 'n-ms5rxgb6-64yzpg', human: false, what: 'installer.ts 미수정 → 수정됨' },
  { a: 'n-ms5u4c9x-908av2', b: 'n-ms5ssbvv-ragici', human: false, what: 'session-watch WIP 에러 → 해결' },
  { a: 'n-ms6vv77t-c30xq8', b: 'n-ms6tclr2-yilnxk', human: false, what: 'DB 마이그레이션 부재 → 도입' },
  { a: 'n-ms6x1xoj-r3y6jd', b: 'n-ms6x3p28-166trl', human: false, what: '국제화 포팅 진행중 vs 완료' },
  { a: 'n-ms6vihrf-q57k1a', b: 'n-ms6tclr2-x3jh6z', human: true, what: 'dev DB vs 운영 DB 지목 상충' },
  { a: 'n-ms6wkxw4-of8d59', b: 'n-ms6vv77t-h9f5b5', human: true, what: 'alembic 자동실행 + prod 파싱 버그 = 조합 파손' },
]

async function verdictFor(a: Note, b: Note, rationale: string): Promise<{ verdict: string; reason: string }> {
  const job = buildJ12(
    paths,
    AGENTS_MD_V1,
    { card: { id: 'probe', cardType: 'conflict', targets: [a.front.id, b.front.id], rationale, proposed: '', status: 'proposed', created: new Date(0).toISOString() }, notes: [a, b] },
    new Date(0),
  )
  // A 529 killed the first full run on pair 1 of 9 and threw away the other
  // eight. Server-side overload says nothing about the rule being measured, so
  // it is retried rather than reported.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let text = ''
    let failure = ''
    for await (const event of engine.run({
      prompt: job.prompt,
      workdir: engineCwd(paths),
      disallowTools: true,
      modelHint: job.modelHint,
    })) {
      if (event.type === 'result') text = event.text
      else if (event.type === 'error') failure = event.message
    }
    if (!failure) {
      const parsed = extractJson(text) as { verdict?: string; reason?: string }
      return { verdict: parsed.verdict ?? '?', reason: parsed.reason ?? '' }
    }
    if (attempt === 4) return { verdict: 'ERROR', reason: failure.slice(0, 100) }
    await new Promise((r) => setTimeout(r, attempt * 15_000))
  }
  return { verdict: 'ERROR', reason: 'unreachable' }
}

let correct = 0
let wrongResolve = 0
for (const pair of PAIRS) {
  const a = await readNote(paths, pair.a)
  const b = await readNote(paths, pair.b)
  const { verdict, reason } = await verdictFor(a, b, pair.what)
  const escalated = verdict === 'escalate'
  const right = escalated === pair.human
  if (right) correct += 1
  // Only `resolve` retires anything. keep-both settles the question while
  // leaving both notes standing, so mislabelling it costs the user nothing —
  // which is why it is tracked apart from the mistake that does cost them.
  if (verdict === 'resolve' && pair.human) wrongResolve += 1
  const got = verdict === 'escalate' ? 'ASK ' : verdict === 'keep-both' ? 'both' : verdict === 'resolve' ? 'pick' : verdict
  console.log(`${right ? ' ok ' : 'MISS'}  want ${pair.human ? 'ASK ' : 'auto'} got ${got}  ${pair.what}`)
  console.log(`        ${reason.slice(0, 130)}`)
}

console.log(`\n${correct}/${PAIRS.length} judged as a human reader would`)
console.log(`questions reaching the user: ${PAIRS.filter((p) => p.human).length} genuine, was ${PAIRS.length}`)
console.log(`RESOLVED SOMETHING A PERSON OWNS: ${wrongResolve}  <- must be 0`)
