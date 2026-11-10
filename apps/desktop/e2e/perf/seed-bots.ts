import { initVault, type Bot, type BotTurn } from 'core'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const BOT_COUNT = 50
export const TURNS_PER_BOT = 2000
export const MOCK_REPLY_CHARS = 6000
export const REPLY_SENTINEL = 'PERF-REPLY-END'

const id = (i: number) => `perf-bot-${String(i).padStart(2, '0')}`
export const SEEDED = {
  primary: id(0),
  thread: id(1),
  firstOpen: [id(2), id(3), id(4), id(5), id(6)],
  cached: [id(7), id(8), id(9), id(10)],
  streaming: [id(11), id(12), id(13), id(14), id(15)],
  working: [id(20), id(21), id(22), id(23), id(24)],
  all: Array.from({ length: BOT_COUNT }, (_, i) => id(i)),
}

function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = 'note plan garden budget report draft review meeting travel recipe list idea folder letter invoice schedule project summary reading weekly'.split(' ')
const LANGS = ['ts', 'py', 'sh', 'json']

function sentence(rand: () => number, words: number): string {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]!)
  const text = out.join(' ')
  return text[0]!.toUpperCase() + text.slice(1) + '.'
}

function assistantText(rand: () => number, n: number): string {
  const kind = n % 4
  if (kind === 0) return `${sentence(rand, 10)} ${sentence(rand, 8)}`
  if (kind === 1) return `## ${sentence(rand, 3)}\n\n- **${sentence(rand, 4)}**\n- ${sentence(rand, 6)}\n- \`${WORDS[n % WORDS.length]}\` ${sentence(rand, 5)}`
  if (kind === 2) return `${sentence(rand, 7)}\n\n\`\`\`${LANGS[n % LANGS.length]}\nconst value${n} = ${Math.floor(rand() * 1000)}\nfunction run${n}() { return value${n} * 2 }\n\`\`\`\n\n${sentence(rand, 6)}`
  return `> ${sentence(rand, 6)}\n\n1. ${sentence(rand, 5)}\n2. ${sentence(rand, 5)}\n\n| a | b |\n|---|---|\n| ${n} | ${Math.floor(rand() * 100)} |`
}

export function mockReply(): string {
  const rand = prng(6000)
  let text = '# Streaming reply\n\n'
  for (let n = 0; text.length < MOCK_REPLY_CHARS; n++) text += assistantText(rand, n) + '\n\n'
  const end = `\n\n${REPLY_SENTINEL}`
  return text.slice(0, MOCK_REPLY_CHARS - end.length).padEnd(MOCK_REPLY_CHARS - end.length, '.') + end
}

export async function seedPerfVault(root: string, now: number): Promise<void> {
  const paths = await initVault(root, { git: false })
  const created = new Date(now - 30 * 86_400_000).toISOString()
  const bots: Bot[] = SEEDED.all.map((botId, i) => ({
    id: botId, name: `Perf bot ${i}`, purpose: `Benchmark bot ${i}.`, createdAt: created,
    ...(i === 0 ? { primary: true } : {}), avatar: { body: i % 4, face: i % 3, accessory: i % 2, palette: i % 5 },
  }))
  await writeFile(join(paths.cache, 'bots.json'), `${JSON.stringify({ version: 2, bots, dismissed: [] }, null, 2)}\n`)
  const dir = join(paths.cache, 'bot-chats')
  await mkdir(dir, { recursive: true })
  for (const [i, botId] of SEEDED.all.entries()) {
    const rand = prng(1000 + i)
    const last = now - (i + 1) * 10 * 60_000
    const lines: string[] = []
    for (let n = 0; n < TURNS_PER_BOT; n++) {
      const at = new Date(last - (TURNS_PER_BOT - 1 - n) * 15_000).toISOString()
      const turn: BotTurn = n % 2 === 0 ? { role: 'user', text: sentence(rand, 6 + (n % 5)), at } : { role: 'assistant', text: assistantText(rand, n), at }
      lines.push(JSON.stringify(turn))
    }
    await writeFile(join(dir, `${botId}.jsonl`), lines.join('\n') + '\n')
  }
}

export async function writeMockDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const reply = mockReply()
  if (reply.length !== MOCK_REPLY_CHARS) throw new Error(`mock reply is ${reply.length} chars`)
  await writeFile(join(dir, 'default.md'), reply)
  return reply
}
