import type { AgentTool } from './agent-loop.js'
import { BOT_LABEL_CHARS } from './bot-fields.js'
import { loadBotMemory, memoryIds, mergeMemory, renderMemory, type BotMemoryFile } from './bot-memory.js'
import { archiveBot, createBot, loadArchivedBots, loadBots, restoreBot, updateBot, type Bot, type BotTask } from './bots.js'
import { listTasks, SOURCE_TITLES_RULE, type DelegatedTask } from './delegated-tasks.js'
import { formatAsk } from './ask.js'
import { recordFacts } from './bot-memory.js'
import { appendBotTurn, readBotTranscript } from './bots.js'
import { logTask, TEAM_MAX_DEPTH, TEAM_MAX_HIRES, type MemberData, type TeamMember } from './delegated-tasks.js'
import { datedQuery, pointQueries, sourceName, TAKEN_OFF, withoutRelativeTime, type TeamHost } from './team-hire-tools.js'
import type { VaultPaths } from './vault.js'
import { scheduleWordsKo } from './schedule-tools.js'

export const employees = (bots: readonly Bot[]): Bot[] => bots.filter(bot => bot.primary !== true && !!bot.label?.trim())

const tail = (word: string): number => { const code = word.trim().charCodeAt(word.trim().length - 1) - 0xac00; return code >= 0 && code <= 11171 ? code % 28 : 0 }
const josa = (word: string, closed: string, open: string): string => `${word}${tail(word) ? closed : open}`
const ro = (word: string): string => `${word}${tail(word) && tail(word) !== 8 ? '으로' : '로'}`

const NAME_TAIL = /^이?\s*(님|씨)?(이?(한테|에게|랑|는|가|도|의)|은|는|이|가|과|와|을|를|야|아|하고)?$/u
export function teamName(word: string, known: readonly string[]): string | undefined {
  const said = word.trim()
  return known.map(name => name.trim()).filter(name => name && said.startsWith(name) && NAME_TAIL.test(said.slice(name.length))).sort((a, b) => b.length - a.length)[0]
}
const bareName = (word: string): string => { const name = word.trim().replace(/\s*(님|씨)$/u, ''); return Array.from(name).length >= 3 && name.endsWith('이') && tail(name.slice(0, -1)) ? name.slice(0, -1) : name }

const said = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []
const names = (value: unknown): string[] => Array.isArray(value) ? value.map(one => said(one, 60)).filter(Boolean) : []

const who = { type: 'string' } as const

const VOICES = ['차분하고 또박또박', '밝고 시원시원하게', '담백하고 짧게']
const VOICE_LINE = /\n?^말투: (.+)$/mu
export const voiceOf = (bot: Pick<Bot, 'purpose'>): string | undefined => VOICE_LINE.exec(bot.purpose)?.[1]?.trim() || undefined
const workOf = (purpose: string): string => purpose.replace(VOICE_LINE, '').trim()
const withVoice = (work: string, voice: string): string => `${work.trim().slice(0, 1900)}\n말투: ${voice.replace(/\s+/g, ' ').trim().slice(0, 80)}`.trim()
const nextVoice = (team: readonly Pick<Bot, 'purpose'>[], taken: readonly string[] = []): string => { const used = [...team.map(voiceOf), ...taken]; return VOICES.find(voice => !used.includes(voice)) ?? VOICES[used.length % VOICES.length]! }
const SPEAKS = /말투|말해|말하|말을|어투|톤으로|목소리/u
const REMOVED = (name: string): string => `${josa(name, '은', '는')} 전에 뺀 팀원이에요. "${name} 다시 불러와"라고 하면 돌아와요.`

export function staffTool(paths: VaultPaths, changed: () => void): AgentTool {
  return {
    name: 'agents',
    closes: true,
    description: 'Manage the person\'s team of agents: one flat team, every agent a bot of its own, all equal. ONE call does the whole sentence, with no confirmation and no question: add (name in their words; role = what the agent is for in a few of their words, such as "리서치 담당"; how = how it should work, only when they said more, or how they should speak ("지민은 좀 더 차분하게 말해": rename with who 지민 and how "좀 더 차분하게 말하기"); also true when they said "…도", as in "서연도 추가해줘"), rename (who = current name; name for a new name, role or how only if they change; identity, memory and history are kept), remove (taken off the team: hidden but kept, never deleted), restore (bring back someone removed). The reply is shown to the person as your answer and ends the turn; add nothing.',
    argsSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        add: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'role'], properties: { name: who, role: who, how: who, also: { type: 'boolean' } } } },
        rename: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who'], properties: { who, name: who, role: who, how: who } } },
        remove: { type: 'array', items: who },
        restore: { type: 'array', items: who },
      },
    },
    async run(args) {
      const active = await loadBots(paths), gone = await loadArchivedBots(paths)
      const held = new Map<string, Bot | null>(active.map(bot => [bot.name.trim(), bot]))
      const refused: string[] = [], nobody = (name: string) => `${josa(name, '이라는', '라는')} 팀원은 없어요.`
      const taken = (name: string) => `${josa(name, '이라는', '라는')} 이름은 이미 쓰고 있어요. 다른 이름을 알려 주세요.`

      const removing: Bot[] = []
      for (const name of names(args['remove'])) {
        const bot = held.get(name)
        if (!bot) refused.push(nobody(name))
        else if (bot.primary) refused.push(`${josa(name, '은', '는')} 뺄 수 없어요.`)
        else { removing.push(bot); held.delete(name) }
      }
      const returning: Bot[] = []
      for (const name of names(args['restore'])) {
        const bot = gone.filter(one => one.name.trim() === name).at(-1)
        if (!bot) refused.push(`뺀 팀원 중에 ${josa(name, '은', '는')} 없어요.`)
        else if (held.has(name)) refused.push(taken(name))
        else { returning.push(bot); held.set(name, bot) }
      }
      const renaming: { bot: Bot; name?: string; role?: string; how?: string }[] = []
      for (const row of rows(args['rename'])) {
        const from = said(row['who'], 60), bot = held.get(from)
        const name = said(row['name'], 60), role = said(row['role'], BOT_LABEL_CHARS), how = String(row['how'] ?? '').trim().slice(0, 2000)
        if (!bot) { refused.push(nobody(from)); continue }
        if (name && name !== from) {
          if (held.has(name)) { refused.push(taken(name)); continue }
          held.delete(from); held.set(name, bot)
        }
        renaming.push({ bot, ...(name && name !== from ? { name } : {}), ...(role && role !== bot.label ? { role } : {}), ...(how ? { how } : {}) })
      }
      const adding: { name: string; role: string; how: string; back?: Bot; also?: boolean }[] = []
      for (const row of rows(args['add'])) {
        const name = said(row['name'], 60), role = said(row['role'], BOT_LABEL_CHARS)
        if (!name || !role) throw new Error('add needs a name and a role for each agent.')
        if (held.has(name)) refused.push(taken(name))
        else { const back = gone.filter(one => one.name.trim() === name).at(-1); adding.push({ name, role, how: String(row['how'] ?? '').trim().slice(0, 2000) || role, ...(back ? { back } : {}), ...(row['also'] === true ? { also: true } : {}) }); held.set(name, back ?? null) }
      }
      if (!removing.length && !returning.length && !renaming.length && !adding.length && !refused.length) throw new Error('nothing to do: give add, rename, remove or restore.')
      if (refused.length) return [...new Set(refused)].join('\n')

      const lines: string[] = [], given: string[] = []
      for (const bot of removing) await archiveBot(paths, bot.id)
      for (const bot of returning) { await restoreBot(paths, bot.id); lines.push(`${josa(bot.name, '이', '가')} 돌아왔어요.`) }
      for (const { bot, name, role, how } of renaming) {
        if (!name && !role && !how) continue
        const speaks = !!how && SPEAKS.test(how), purpose = !how ? undefined : speaks ? withVoice(workOf(bot.purpose), how) : withVoice(how, voiceOf(bot) ?? nextVoice(employees(active).filter(one => one.id !== bot.id), given))
        if (purpose && !speaks) given.push(voiceOf({ purpose })!)
        await updateBot(paths, bot.id, { ...(name ? { name } : {}), ...(role ? { label: role } : {}), ...(purpose ? { purpose } : {}) })
        const now = [name, role].filter(Boolean).join(', ')
        lines.push(now ? `${josa(bot.name, '은', '는')} 이제 ${josa(now, '이에요', '예요')}.` : speaks ? `${bot.name}한테 그렇게 전했어요.` : `${bot.name}의 일하는 방식을 바꿨어요.`)
      }
      for (const { name, role, how, back } of adding) {
        if (back) await restoreBot(paths, back.id)
        const voice = (back && voiceOf(back)) ?? nextVoice(employees(active).filter(one => !removing.includes(one)), given), purpose = withVoice(how, voice)
        given.push(voice)
        await updateBot(paths, (back ?? await createBot(paths, { name, purpose })).id, { label: role, ...(back ? { purpose } : {}) })
      }
      if (adding.length) lines.push(addedLine(adding))
      changed()
      const out = josa(removing.map(bot => bot.name).join(', '), '은', '는')
      return !removing.length ? lines.join(' ') : lines.length ? `${out} 뺐고, ${lines.join(' ')}` : `${out} 뺐어요. 다시 부르면 돌아와요.`
    },
  }
}

function addedLine(added: readonly { name: string; role: string; back?: unknown; also?: boolean }[]): string {
  const fresh = added.filter(one => !one.back), back = added.filter(one => one.back)
  if (added.length === 1) return fresh.length ? added[0]!.also ? `${added[0]!.name}도 ${ro(added[0]!.role)} 넣었어요.` : `${josa(added[0]!.name, '을', '를')} ${ro(added[0]!.role)} 추가했어요.` : `${josa(added[0]!.name, '은', '는')} ${ro(added[0]!.role)} 다시 불렀어요.`
  const list = (some: typeof added): string => some.map((one, i) => `${josa(one.name, '은', '는')} ${i === some.length - 1 ? ro(one.role) : one.role}`).join(', ')
  return !back.length ? `${list(fresh)} 넣었어요.` : !fresh.length ? `${list(back)} 다시 불렀어요.` : `${list(fresh)} 넣고, ${list(back)} 다시 불렀어요.`
}

const clip = (text: string, max: number): string => { const line = text.replace(/\s+/g, ' ').trim(); return Array.from(line).length > max ? `${Array.from(line).slice(0, max).join('')}…` : line }
const BUSY = ['hired', 'working', 'reviewing']

const VERB_NOUNS: [RegExp, string][] = [[/찾아\s*(봐|보고)?$/u, '찾기'], [/알아\s*(봐|보고)$|알려$/u, '알아보기'], [/(써|쓰고)$/u, '쓰기'], [/(뽑아|뽑고)$/u, '뽑기'], [/(만들어|만들고)$/u, '만들기'], [/(골라|고르고)$/u, '고르기']]
export function jobTitle(brief: string): string {
  let line = (handedFrom(brief)?.brief ?? brief).split('\n')[0]!.replace(/^[#|<`\s-]+/, '').replace(/\s*\([^()]*\)/g, '').replace(/[\s.!?~。]+$/u, '')
  line = line.replace(/(\S+?)게\s*(?:해|시켜)(?:\s*(?:줘요?|주세요))?$/u, '$1기')
  const asked = line.replace(/\s*(?:줘요?|주세요|줄래요?|주라)$/u, '').replace(/해서\s*(?:\S+\s+){0,2}(?:정리|알려|전달|말|보여)(?:해)?$/u, '해')
  if (asked !== line || /(하고|해서|하기)$/u.test(line)) line = asked.replace(/([가-힣])\s*(?:해|하고|해서|하기)$/u, '$1')
  for (const [verb, noun] of VERB_NOUNS) line = line.replace(verb, noun)
  return clip(line.replace(/([가-힣]{2,})[을를]\s+(\S+)$/u, '$1 $2'), 40)
}
export const topicOf = (brief: string): string => clip(withoutRelativeTime(jobTitle(brief).replace(/\s*(?:찾기|알아보기|쓰기|뽑기|만들기|고르기)$/u, '').replace(DOING_NOUN, '')).replace(/(?:이번|다음|지난|저번)\s?(?:주말|주|달)\s*/gu, '').trim(), 20).replace(/…$/u, '')
const OWN_BOX = /날씨|기온|미세먼지|환율|주가|시세/u
const UPDATES = /\s*(?:신기능|새(?:로운)?\s*기능|(?:기능\s*)?업데이트)(?:\s*(?:발표|소식))?/u
const KIND = /앱|어플|서비스|툴|도구|플랫폼|프로그램|소프트웨어|사이트/u
export function searchWords(brief: string, now = new Date(), about = ''): string | undefined {
  const title = jobTitle(brief)
  if (title.endsWith('…') || handedFrom(brief)) return undefined
  let words = title.replace(/\s*(?:조사|정리|찾기|알아보기|확인|검색)$/u, '').trim()
  if (!OWN_BOX.test(words)) words = withoutRelativeTime(words)
  if (UPDATES.test(words)) {
    const what = words.replace(new RegExp(UPDATES.source, 'gu'), ' ').replace(/([가-힣A-Za-z])의(?=\s|$)/gu, '$1').replace(/\s+/g, ' ').trim()
    if (!what) return undefined
    const kind = KIND.test(what) ? '' : KIND.exec(about)?.[0] ?? (/경쟁사/u.test(about) ? '앱' : '')
    words = [what, kind, '새 기능 업데이트'].filter(Boolean).join(' ')
  }
  return Array.from(words).length < 4 ? undefined : datedQuery(words, brief, now)
}
const MAKERS: [RegExp, string, string][] = [[/노션/u, 'Notion', 'Notion releases'], [/슬랙/u, 'Slack', 'Slack release notes'], [/리니어/u, 'Linear', 'Linear changelog'], [/피그마/u, 'Figma', 'Figma release notes'], [/지라/u, 'Jira', 'Jira Cloud release notes'], [/깃허브|깃헙/u, 'GitHub', 'GitHub changelog'], [/디스코드/u, 'Discord', 'Discord patch notes'], [/(?<![가-힣])줌(?![가-힣])/u, 'Zoom', 'Zoom release notes'], [/트렐로/u, 'Trello', 'Trello what\'s new'], [/아사나/u, 'Asana', 'Asana what\'s new'], [/챗지피티|챗GPT/u, 'ChatGPT', 'ChatGPT release notes'], [/클로드/u, 'Claude', 'Claude release notes'], [/커서(?![가-힣])/u, 'Cursor', 'Cursor changelog'], [/팀즈/u, 'Microsoft Teams', 'Microsoft Teams what\'s new'], [/드롭박스/u, 'Dropbox', 'Dropbox release notes'], [/에어테이블/u, 'Airtable', 'Airtable what\'s new']]
const PERIOD_JOB = /(?:이번|지난|저번)\s?(?:주|달)|요즘|최근|오늘|어제/u
const LIST_JOB = /일정|목록|리스트|[가-힣]들(?:\s|$)/u
const OTHER_WORDS: [RegExp, string][] = [[/행사/u, '컨퍼런스 세미나 밋업'], [/맛집/u, '식당 추천'], [/전시회?/u, '박람회 전시'], [/공연/u, '콘서트 뮤지컬'], [/축제/u, '페스티벌'], [/카페/u, '카페 추천 모음']]
export interface FirstSearch { query: string; news?: true; maker?: string }
export function makerOf(words: string, about = '', latin = true): { name: string; query: string } | undefined {
  for (const text of [words, about]) {
    const given = /([가-힣]{2,})\s*\(\s*([A-Za-z][A-Za-z0-9.&' -]{1,30}?)\s*\)/u.exec(text)
    if (given && words.includes(given[1]!)) return { name: given[2]!, query: `${given[2]!} changelog` }
  }
  const known = MAKERS.find(([ko]) => ko.test(words))
  if (known) return { name: known[1], query: known[2] }
  const named = latin ? /(?<![A-Za-z])([A-Z][A-Za-z0-9]{2,})(?![A-Za-z])/.exec(words)?.[1] : undefined
  return named ? { name: named, query: `${named} changelog` } : undefined
}
export function firstSearches(member: Pick<TeamMember, 'brief' | 'query'>, about = ''): FirstSearch[] {
  const query = member.query?.trim(), line = (handedFrom(member.brief)?.brief ?? member.brief).split('\n')[0]!
  if (!query || handedFrom(member.brief)) return []
  const title = jobTitle(member.brief), updates = UPDATES.test(title)
  const maker = makerOf(withoutRelativeTime(updates ? title.replace(new RegExp(UPDATES.source, 'gu'), ' ') : title), about, updates)
  const news: FirstSearch = { query, ...(PERIOD_JOB.test(line) ? { news: true as const } : {}) }
  if (maker && maker.query.toLowerCase() !== query.toLowerCase()) return [news, { query: /[가-힣]/.test(maker.query) ? maker.query : `${maker.query} 업데이트`, maker: maker.name }]
  if (updates) return [news]
  if (!LIST_JOB.test(line)) return pointQueries(query).map(one => ({ query: one }))
  const plain = query.replace(/\s*(?:일정|목록|리스트)(?=\s|$)/u, '').trim(), other = OTHER_WORDS.find(([kind]) => kind.test(plain))
  const second = other ? plain.replace(other[0], other[1]) : `${plain} 모음`
  return second.toLowerCase() === query.toLowerCase() ? [{ query }] : [{ query }, { query: second }]
}
const makersOwn = (row: string, maker: string): boolean => {
  const url = row.slice(2).split(' — ')[1] ?? ''
  try {
    const host = new URL(url).hostname.toLowerCase(), name = maker.toLowerCase().replace(/\s+/g, '')
    return host.split('.').includes(name) || [sourceName(url), sourceName(url, true)].some(said => said.toLowerCase() === maker.toLowerCase())
  } catch { return false }
}
export function makerFirst(found: string, maker: string): { found: string; own: boolean } {
  const lines = found.split('\n'), at = lines.flatMap((line, i) => line.startsWith('- ') ? [i] : []), rows = at.map(i => lines[i]!)
  const own = rows.filter(row => makersOwn(row, maker)), sorted = [...own, ...rows.filter(row => !own.includes(row))]
  at.forEach((i, k) => { lines[i] = sorted[k]! })
  return { found: lines.join('\n'), own: own.length > 0 }
}
export function firstFound(founds: readonly (FirstSearch & { found: string; own?: boolean })[]): string {
  if (founds.length === 1) return `\n\nResults of the search already run for you ("${founds[0]!.query}"). When they hold what your part asks, answer from them now; search once more in other words only when they do not.\n${founds[0]!.found}`
  const maker = founds.find(one => one.own)
  return `\n\nResults of the searches already run for you, side by side. Answer from them; search again only when none holds what your part asks.${maker ? ` The first row under "${maker.query}" is ${maker.maker}'s own updates page. When your part is about what ${maker.maker} has put out or changed, read that one page (read_pages) and answer from its newest dated entry, ${MAKER_NOTE} Otherwise answer from the other results, and from that page only what it says about your part.` : ''}${founds.map(one => `\n\n[${one.query}]\n${one.found}`).join('')}`
}
const MAKER_NOTE = 'in Korean, with its date and that page as your one address. When the entry is inside the time your part asks about, say it as the news. When it is not, say that, then the newest one: "이번 주엔 새로 낸 게 없어요. 최근엔 <date>에 <thing>이 나왔어요." with that page\'s address.'
const jobOf = (member: TeamMember): string => { const title = member.title?.trim() || jobTitle(member.brief); return title.endsWith('…') && member.topic?.trim() ? member.topic.trim() : title }
const DOING_NOUN = /(정리|조사|요약|번역|분석|비교|검토|확인|작성|추천|계산|취합)$/u
const COUNT_WORDS: Record<string, number> = { 두: 2, 세: 3, 네: 4, 다섯: 5 }
export function askedCount(brief: string): number {
  const said = /(\d{1,2}|두|세|네|다섯)\s*(?:개|가지|줄|건|편|문장)(?![가-힣]*월)/u.exec((handedFrom(brief)?.brief ?? brief).split('\n')[0]!)?.[1]
  const n = said ? COUNT_WORDS[said] ?? Number(said) : 0
  return n >= 2 && n <= 10 ? n : 0
}
const listed = (items: readonly string[]): string => items.length < 2 ? items.join('') : `${items.slice(0, -2).map(one => `${one}, `).join('')}${josa(items.at(-2)!, '이랑', '랑')} ${items.at(-1)!}`

const NOW_DOING: [RegExp, string][] = [[/찾기$/u, '찾고'], [/알아보기$/u, '알아보고'], [/쓰기$/u, '쓰고'], [/뽑기$/u, '뽑고'], [/만들기$/u, '만들고'], [/고르기$/u, '고르고']]
const doing = (job: string): string => { const verb = NOW_DOING.find(([ending]) => ending.test(job)); return verb ? `${job.replace(verb[0], '').trim()} ${verb[1]} 있`.trim() : DOING_NOUN.test(job) ? `${job}하고 있` : `${job} 하고 있` }
const byJob = (people: readonly { name: string; job: string }[]): { names: string[]; job: string }[] => {
  const groups = new Map<string, string[]>()
  for (const one of people) groups.set(one.job, [...(groups.get(one.job) ?? []), one.name])
  return [...groups].map(([job, names]) => ({ names, job }))
}
function finished(groups: readonly { names: string[]; job: string }[], recent: boolean): string {
  const who = (names: readonly string[]): string => josa(listed(names), '은', '는'), words = groups.map(group => group.job.split(' ')), short = Math.min(...words.map(one => one.length))
  const done = recent ? '방금 끝냈어요.' : '끝낸 게 마지막이에요.'
  let tail = 0, head = 0
  while (tail < short - 1 && words.every(one => one.at(-1 - tail) === words[0]!.at(-1 - tail))) tail++
  while (head < short - 1 - tail && words.every(one => one[head] === words[0]![head])) head++
  if (groups.length > 1 && tail) return `${groups.map((group, i) => `${who(group.names)} ${words[i]!.slice(head, words[i]!.length - tail).join(' ')}`).join(', ')} ${josa(words[0]!.slice(-tail).join(' '), '을', '를')} ${done}`
  return `${groups.map((group, i) => `${who(group.names)} ${i === groups.length - 1 ? josa(group.job, '을', '를') : group.job}`).join(', ')} ${done}`
}
export function companyStatus(bots: readonly Bot[], tasks: readonly DelegatedTask[], now = Date.now(), previous = ''): string {
  const first = statusSaid(bots, tasks, now, false)
  return first === previous.trim() ? statusSaid(bots, tasks, now, true) : first
}
function liveWork(bot: Bot, tasks: readonly DelegatedTask[]): { name: string; working?: string | undefined; waiting?: string | undefined; last?: { at: string; what: string; unfinished: boolean } | undefined } {
  const own = tasks.filter(task => task.botId === bot.id)
  const parts = tasks.flatMap(task => (task.team?.members ?? []).filter(member => member.botId === bot.id).map(member => ({ member, open: task.state === 'running' || task.state === 'waiting', at: member.finishedAt ?? task.updatedAt })))
  const part = (state: (member: TeamMember) => boolean): string | undefined => { const hit = parts.find(one => one.open && state(one.member)); return hit && jobOf(hit.member) }
  const goal = (...states: string[]): string | undefined => { const hit = own.find(task => states.includes(task.state)); return hit && jobTitle(hit.goal) }
  const working = goal('running', 'queued') ?? part(member => BUSY.includes(member.state))
  const waiting = working ? undefined : goal('waiting') ?? part(member => member.state === 'waiting')
  const last = [...own.filter(task => task.state === 'done').map(task => ({ at: task.updatedAt, what: jobTitle(task.goal), unfinished: false })), ...parts.filter(one => one.member.state === 'done' || one.member.state === 'released').map(one => ({ at: one.at, what: jobOf(one.member), unfinished: !!one.member.unfinished }))].sort((a, b) => b.at.localeCompare(a.at))[0]
  return { name: bot.name.trim(), working, waiting, last }
}
function statusSaid(bots: readonly Bot[], tasks: readonly DelegatedTask[], now: number, again: boolean): string {
  const staff = employees(bots)
  if (!staff.length) return '아직 팀원이 없어요. "지민 추가해줘. 리서치 담당이야"처럼 말하면 바로 추가할게요.'
  const team = staff.map(bot => liveWork(bot, tasks))
  const who = (names: readonly string[]): string => josa(listed(names), '은', '는')
  const idle = team.filter(one => !one.working && !one.waiting), names = idle.map(one => one.name)
  if (idle.length < team.length) {
    const clauses = [
      ...byJob(team.flatMap(one => one.working ? [{ name: one.name, job: one.working }] : [])).map(group => `${who(group.names)} ${doing(group.job)}`),
      ...byJob(team.flatMap(one => one.waiting ? [{ name: one.name, job: one.waiting }] : [])).map(group => `${who(group.names)} ${group.job} 건으로 답을 기다리고 있`),
      ...(idle.length ? [`${who(names)} ${again ? '맡은 일이 없' : '지금 하는 일 없'}`] : []),
    ]
    return clauses.map((clause, i) => `${clause}${i === clauses.length - 1 ? again && !idle.length ? '는 중이에요.' : '어요.' : '고'}`).join(', ')
  }
  const did = idle.filter(one => one.last && !one.last.unfinished), jobs = byJob(did.map(one => ({ name: one.name, job: one.last!.what })))
  const cut = byJob(idle.filter(one => one.last?.unfinished).map(one => ({ name: one.name, job: one.last!.what }))).map(group => `${who(group.names)} ${josa(group.job, '을', '를')} 다 못 끝냈어요.`).join(' ')
  if (!did.length) return cut ? `${cut} 지금은 ${names.length > 1 ? '다들 ' : ''}하는 일 없어요.` : again ? `${listed(names)}한테 맡긴 일이 아직 없어요.` : `아직 ${listed(names)}한테 맡긴 일이 없어요.`
  const everyone = did.length < idle.length ? `${listed(names)} 모두 ` : names.length > 2 ? '다들 ' : names.length === 2 ? '둘 다 ' : ''
  const recent = did.some(one => now - Date.parse(one.last!.at) < 3_600_000)
  const words = jobs.map(group => group.job.split(' ')), at = words[0]!.findIndex((word, i) => words.some(one => one[i] !== word))
  const same = jobs.length > 1 && at >= 0 && words.every(one => one.length === words[0]!.length && one.every((word, i) => i === at || word === words[0]![i]))
  const tail = same ? words[0]!.slice(at + 1).join(' ') : ''
  if (!again && recent && tail && did.length === idle.length && jobs.every(group => group.names.length === 1)) return `${jobs.map(group => group.names[0]!).join(', ')} 다 방금 ${words.map(one => one[at]!).join('·')} ${tail} 끝내서 지금은 한가해요.`
  return `${cut ? `${cut} ` : ''}${finished(jobs, recent)} ${again ? `아직 ${everyone}새로 맡은 일은 없어요.` : `지금은 ${everyone}${did.length === idle.length && everyone ? '한가해요.' : '하는 일 없어요.'}`}`
}

export function companyStatusTool(paths: VaultPaths): AgentTool {
  return {
    name: 'agents_now',
    closes: true,
    description: 'What everyone on the team is doing right now, in a sentence or two (who is working on what, who is waiting, who is idle and what they last did). Use when the person asks what the team is doing. The reply is shown to the person as your answer and ends the turn.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: async () => companyStatus(await loadBots(paths), await listTasks(paths)),
  }
}

const STATUS_ASKS = [
  /^(다들|모두|전부|에이전트들?|직원들?|팀원들?|애들|지금 누가)\s*(지금\s*)?(뭐|뭘|무슨\s*일)\s*(하고\s*있(어|어요|나|나요|니|습니까)|해|해요|하니|하나요|하는\s*중(이야|이에요|인가요)?)$/u,
  /^(에이전트|직원|팀)?\s*현황(\s*(알려|보여)\s*(줘|주세요))?$/u,
  /^status$/i,
  /^what(['’]s| is) every(one|body) doing$/i,
]
export function isStatusAsk(message: string): boolean {
  const line = message.replace(/\s+/g, ' ').trim().replace(/[\s?？!.~]+$/u, '')
  return line.length <= 40 && STATUS_ASKS.some(ask => ask.test(line))
}

export const COMPANY_LANE_TOOLS: ReadonlySet<string> = new Set(['agents', 'assign', 'agents_now', 'schedule', 'hire_members', 'review_member', 'team_status', 'search_web', 'read_pages', 'search_chats', 'search_memory', 'read_note', 'ask_person', 'keep_in_mind'])

export const COMPANY_ASK_CHARS = 200
const WORK = /엑셀|excel|ppt|파워포인트|pdf|워드|파일|문서|자료|보고|메일|요약|정리|조사|검색|번역|작성|문구|고쳐|수정|맡겨|맡기|넘겨|한테|에게|매주|매일|마다/iu
const HIRE = /뽑아|뽑고|채용|고용|추가/u
const PERSON = /에이전트|직원|팀원|인턴|담당|[한두세네\d]\s*명|(사원|주임|대리|과장|차장|부장|팀장)(?=$|[\s,.!?]|[을를이가은는도랑과와]|하고|으로)/u
const ARTIFACT = /(\d|[한두세네몇]\s|여러\s*)\s*(장|개|줄|건|편|쪽|컷|가지|페이지)|사진|이미지|그림|일러스트|로고|아이콘|영상|동영상|썸네일|배너|포스터|문구|카피|슬로건|제목|시안|초안|(?<![가-힣])표|차트|그래프|목록|리스트|명단|자료|데이터|통계|숫자|번호|이름|키워드|아이디어|후보|예시|샘플|문장|단어|내용|핵심|코드|링크|주소/u
const CHANGE = /내보내|해고|빼\s*(줘|주세요|고)|제외|다시\s*(불러|데려)|복직|이름.{0,12}바꿔/u
const ABOUT = [
  /^(지금|요즘|최근에?|이번주에?|오늘)?(뭐|뭘|무슨일|어떤일|무슨업무|어떤업무)(을|를)?(해|하니|하나|하고있어|하고있나|하는중이야|하는중이에|하는(사람|직원|에이전트|팀원|분)(이야|이에|인가|이니|입니까)?|했어|했나|맡고있어|맡았어|담당해|담당하고있어)요?$/u,
  /^(누구|어떤(사람|직원|에이전트|팀원|분)|무슨사람)(야|이야|예요|이에요|인가요|니|입니까)?$/u,
  /^(담당|역할|업무|하는일|맡은일)(이|은|는|가)?(뭐|뭔데|무엇)(야|예요|지|죠|인가요|니)?$/u,
  /^(현황|상태|근황)(은|이)?(알려줘|보여줘|어때|뭐야)?요?$/u,
]
const ROSTER = /^(우리|지금|현재)*(에이전트|직원|팀원|팀)(들|이|은|는|에|엔)*(누구누구|누가|누구|몇명|뭐|목록|명단|리스트)(있어|있나|있니|이야|야|보여줘|알려줘)?요?$/u
const AFTER_NAME = '(이(?=[는가랑도의]))?\\s?(님|씨)?(에서|으로|이랑|하고|랑|과|와|은|는|이|가|도|을|를|의|로|에)?'
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export function isCompanyAsk(message: string, known: readonly string[], chief: boolean): boolean {
  if (message.length > COMPANY_ASK_CHARS) return false
  const names = [...new Set(known.map(name => name.trim()).filter(name => name.length >= 2))].sort((a, b) => b.length - a.length)
  let rest = message, named = 0
  for (const name of names) { const cut = rest.replace(new RegExp(escaped(name) + AFTER_NAME, 'gu'), ' '); if (cut !== rest) { named++; rest = cut } }
  const left = rest.replace(/[\s,]+/g, '').replace(/[?？!.~]+$/u, '')
  if (named && ABOUT.some(ask => ask.test(left))) return true
  if (!chief) return false
  if (ROSTER.test(left)) return true
  if (WORK.test(message)) return false
  return (HIRE.test(message) && PERSON.test(rest) && !ARTIFACT.test(rest)) || (CHANGE.test(message) && (named > 0 || PERSON.test(rest)))
}

const TO_STAFF = /(사원|주임|대리|과장|차장|부장|팀장|인턴|팀|님|씨)\s*(한테|에게)/u
const DELEGATE = /맡겨|맡기|시켜|시키|넘겨|넘기|(?:라고|달라고)\s*(?:해|전해)/u
export function isAssignAsk(message: string, known: readonly string[]): boolean {
  if (message.length > COMPANY_ASK_CHARS || !DELEGATE.test(message)) return false
  return TO_STAFF.test(message) || (/한테|에게/u.test(message) && known.some(name => name.trim().length >= 2 && message.includes(name.trim())))
}

const NEW_NAME = '([가-힣A-Za-z]{2,10}?)(?:도|을|를)?'
const DUTY = '([가-힣A-Za-z0-9 ]{1,20}?\\s*담당)'
const PLEASE_ADD = '\\s*(?:(?:하나|한\\s*명)\\s*)?(?:새로\\s*)?(?:팀에\\s*)?(?:추가해|뽑아|채용해|고용해)\\s*(?:줘|줘요|주세요)?'
const ADD_THEN_DUTY = new RegExp(`^${NEW_NAME}${PLEASE_ADD}[.!,\\s]+${DUTY}(?:이야|야|이에요|예요|입니다)?[.!]?$`, 'u')
const DUTY_THEN_ADD = new RegExp(`^${DUTY}(?:으로|로)?\\s+${NEW_NAME}${PLEASE_ADD}[.!]?$`, 'u')
const NOT_A_NAME = /^(에이전트|팀원|직원|사람|인턴|멤버|봇|하나|새로)$/u
const ADD_SOME = new RegExp(`^(.+?)(?:을|를)?${PLEASE_ADD}[.!,\\s]+(.+?)[.!]?$`, 'u')
const HAS_DUTY = new RegExp(`^(\\S+?)[은는]\\s+${DUTY}(?:이야|야|이에요|예요|이고|고)?$`, 'u')
function namesDuties(line: string): boolean {
  const said = ADD_SOME.exec(line)
  const people = said?.[1]!.split(/\s*,\s*|(?:이랑|랑|하고|과|와)\s+|\s+/u).filter(Boolean).map(bareName) ?? []
  if (!said || people.length < 2 || people.length > 3 || new Set(people).size !== people.length || people.some(name => !/^[가-힣A-Za-z]{2,10}$/u.test(name) || NOT_A_NAME.test(name) || ARTIFACT.test(name))) return false
  const dutied = new Set<string>()
  for (const clause of said[2]!.split(/\s*[,.]\s*|\s+(?=\S+[은는]\s)/u).filter(Boolean)) {
    const duty = HAS_DUTY.exec(clause.trim()), name = duty && teamName(duty[1]!, people)
    if (!duty || !name || dutied.has(name)) return false
    dutied.add(name)
  }
  return dutied.size === people.length
}
export function isHireAsk(message: string): boolean {
  const line = message.trim()
  if (line.length > COMPANY_ASK_CHARS || line.includes('\n')) return false
  const first = ADD_THEN_DUTY.exec(line), second = first ? null : DUTY_THEN_ADD.exec(line)
  const name = first?.[1] ?? second?.[2], role = first?.[2] ?? second?.[1]
  return (!!name && !!role && !NOT_A_NAME.test(name) && !ARTIFACT.test(name)) || namesDuties(line)
}

const REPEATS = /매주|매일|매달|매월|평일마다|주말마다|[월화수목금토일]요일\s*마다/u
const AT_TIME = /\d{1,2}\s*시|\d{1,2}:\d{2}|아침|오전|오후|점심|저녁|밤|정오|자정/u
const DUTIES = /^(내|제|우리|지금|현재|정기|예약된|잡힌|\s)*(일정|스케줄|정기\s*(업무|보고)|예약)(은|이|들)?\s*(뭐|뭐가|뭐뭐|어떤\s*게|어떤\s*거|목록)?\s*(있어|있나|있니|있지|알려\s*줘|보여\s*줘)요?[?？!.~\s]*$/u
export function isDutyAsk(message: string): boolean {
  if (message.length > COMPANY_ASK_CHARS) return false
  return (REPEATS.test(message) && AT_TIME.test(message)) || DUTIES.test(message.trim())
}
const CANCELS = /^(?:그거|그건|그\s*일정|방금\s*(?:그거|거|일정)|일정)\s*(?:은|는|을|를)?\s*(?:취소|없애|지워|삭제|빼)\s*(?:해|해\s*줘요?|줘요?|해\s*주세요|주세요)?[.!~\s]*$/u
export function isDutyCancel(message: string, tasks: readonly BotTask[], lastReply: string | undefined): boolean {
  const kept = tasks.filter(task => task.schedule && !task.routineId)
  return CANCELS.test(message.trim()) && kept.length === 1 && !!lastReply?.includes(scheduleWordsKo(kept[0]!.schedule!))
}
const FILE_WORK = /엑셀|excel|ppt|파워포인트|pdf|워드|파일|문서|메일|보고서|자료|고쳐|수정/iu
const THE_TEAM = /팀|다들|모두|에이전트/u
const TEAM_WORK = /(?<![가-힣])한\s*(일|거|것)|했던\s*일|뭐\s*했|뭘\s*했|주간\s*보고|월간\s*보고|일일\s*보고/u
export function isTeamWorkAsk(message: string): boolean {
  return message.length <= COMPANY_ASK_CHARS && !FILE_WORK.test(message) && THE_TEAM.test(message) && TEAM_WORK.test(message)
}

const OUTSIDE = /(슬랙|slack|노션|notion|메일|gmail|카톡|카카오톡|문자|디스코드|discord|텔레그램|telegram|팀즈|teams|트위터|인스타|인스타그램|페이스북|링크드인|블로그|유튜브|게시판|채널|단톡방?|드라이브|drive|깃허브|github|지라|jira|컨플루언스|confluence|캘린더|calendar)\s*(에|으로|로)(?!서)|(?<!내)보내|전송|발송|게시|포스팅|트윗|공유|(에|으로|로)\s*(올려|올리|업로드|등록)/iu
export const isOutsideAsk = (message: string): boolean => OUTSIDE.test(message)

const DOES = /(줘요?|주세요|해|해요|해라|시켜|써|봐|하자)[\s.!~]*$/u
export function isPartsAsk(message: string, known: readonly string[]): boolean {
  if (message.length > COMPANY_ASK_CHARS || !DOES.test(message.trim())) return false
  const marked = (mark: string): number => known.filter(name => name.trim().length >= 2 && new RegExp(`(^|[\\s,，])${escaped(name.trim())}${mark}\\s+\\S`, 'u').test(message)).length
  return marked('(이는|은|는)') >= 1 || marked('(이는|이가|은|는|이|가)') >= 2
}

export function takesCompanyLane(message: string, who: { staff: readonly string[]; gone?: readonly string[]; chief: boolean; scheduled?: boolean; kept?: readonly BotTask[]; lastReply?: string }): boolean {
  if (isOutsideAsk(message)) return false
  if (who.chief && isStatusAsk(message)) return true
  if (who.chief && !who.scheduled && (isDutyAsk(message) || isDutyCancel(message, who.kept ?? [], who.lastReply))) return true
  return (who.chief && (isAssignAsk(message, who.staff) || isPartsAsk(message, who.staff) || isTeamWorkAsk(message) || isHireAsk(message))) || isCompanyAsk(message, [...who.staff, ...(who.gone ?? [])], who.chief)
}

export const TEAM_MEMORY = '_team'
export async function teamRecord(paths: VaultPaths): Promise<BotMemoryFile> {
  const ids = (await memoryIds(paths)).filter(id => id === TEAM_MEMORY || id.startsWith(`${TEAM_MEMORY}-`))
  const all = mergeMemory(...await Promise.all(ids.map(id => loadBotMemory(paths, id))))
  return { facts: all.facts, turns: all.turns }
}

export async function companyNote(paths: VaultPaths, input: { bots: readonly Bot[]; message: string; tasks?: readonly DelegatedTask[]; chief: boolean; now?: Date }): Promise<string> {
  const staff = employees(input.bots)
  if (!staff.length && !input.chief) return ''
  const lines = [input.chief
    ? 'The person works with one flat team of agents by chat: each agent below is a bot of its own, all equal, and the person is directly over all of them. You are the one they talk to. Do a change to the team (add, rename, remove, bring back) with ONE agents call for the whole sentence: no question, no confirmation, and never mention bots, tools or the sidebar. Hand work to agents with ONE assign call for the whole sentence (wait false when the person just hands a job off, wait true when they want the result in this answer); someone named who is not on the team yet is added by that same call, and you never do an assigned part yourself. Something to be done regularly or later ("매주 월요일 9시에 AI 뉴스 정리해줘") is kept with ONE schedule add call; "내 일정 뭐 있어?" asks what is kept (schedule list): one line each, when and what. Answer questions about who someone is or what they do from the lines below with no tool call. Short and natural, in the person\'s language, with no titles, ranks or office talk.'
    : 'The person works with a team of agents by chat; each agent below is a bot of its own. Answer questions about who someone is or what they do from these lines with no tool call, short and natural, in the person\'s language.']
  lines.push(staff.length ? 'Team now:' : 'Team now: nobody yet.')
  for (const bot of staff) {
    const live = liveWork(bot, input.tasks ?? [])
    lines.push(`- ${bot.name} — ${bot.label!.trim()}. How they work: ${clip(workOf(bot.purpose) || bot.label!, 300)}. Right now: ${live.working ? `working on ${live.working}` : live.waiting ? `waiting for an answer on ${live.waiting}` : 'no work in hand'}.`)
    if (!input.message.includes(bot.name.trim())) continue
    const memory = renderMemory(await loadBotMemory(paths, bot.id), input.now)
    const recent = (input.tasks ?? []).filter(task => task.botId === bot.id && task.state === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    if (memory) lines.push(`  What ${bot.name} remembers (their own memory, most recent work included):`, ...memory.split('\n').map(line => `  ${line}`))
    if (recent.length) lines.push(`  ${bot.name}'s recent finished work:`, ...recent.map(task => `  - ${task.updatedAt.slice(0, 10)}: ${clip(task.goal, 120)}`))
    if (!memory && !recent.length) lines.push(`  ${bot.name} has no finished work on record yet; say so rather than inventing any.`)
  }
  if (isTeamWorkAsk(input.message)) {
    const renamed = new Map((input.tasks ?? []).flatMap(task => task.team?.members ?? []).flatMap(m => { const bot = staff.find(one => one.id === m.botId)?.name.trim(); return bot && bot !== m.role && !staff.some(one => one.name.trim() === m.role) ? [[m.role, bot] as const] : [] }))
    const memory = [...renamed].reduce((text, [was, is]) => text.replace(new RegExp(`${escaped(was)}(?=, \\d{4}-\\d\\d-\\d\\d\\)|한테 받아서\\))`, 'g'), is), renderMemory(await teamRecord(paths), input.now))
      .replace(/, \d{4}-(\d\d)-(\d\d)\)/g, (_, month: string, day: string) => `, ${Number(month)}월 ${Number(day)}일)`).replace(/^- \(\d{4}-\d\d-\d\d\) /gm, '- ')
    lines.push(memory
      ? `The team's record (one line per finished job: what the job was → what came back, with who did it and the day). Answer from these lines with no tool call unless the person wants more than is here: two to four sentences in polite -요 Korean (해요체), no list and no table, each point with who and the day in parentheses, like "(name, M월 D일)"; a day is always written as 월 and 일 or as its weekday, never as digits with a dash, and when everything was on one day that day is said once. A job done from a teammate's work is said that way ("B가 A 조사로 문구 3개를 썼어요", with their real names). Jobs that found nothing take one clause together, never a sentence per person ("A, B 쪽은 아직 못 찾았고", with the real topics); never write 실패, 확인 실패 or 오류. Call everyone by the name in "Team now" only.\n${memory.split('\n').map(line => `  ${line}`).join('\n')}`
      : 'The team has no finished work on record yet; say so rather than inventing any.')
  }
  return lines.join('\n')
}

const ymd = (day: Date): string => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`

export interface AssignHost extends TeamHost {
  later(ids: string[]): Promise<void>
  running(): Promise<Array<Pick<AssignHost, 'change' | 'later' | 'release'> & { parts: TeamMember[] }>>
  attach(botId: string, then: NonNullable<TeamMember['then']>): Promise<boolean>
  write?: ReportWriter
}

const READS_WEB = /조사|검색|찾아|알아\s*[봐보]|최신|뉴스|확인/u
export const writesFromHandover = (brief: string): boolean => !READS_WEB.test(brief)

export const handoffBrief = (brief: string, from: string, result: string, job = ''): string => {
  const what = clip((handedFrom(job)?.brief ?? job).split('\n')[0]!.replace(/[()]/g, ' '), 80)
  return `${brief}\n\nHanded over by ${from}${what ? ` (their job: ${what})` : ''}. Work from this result, and keep the facts you use from it as they are:\n${result.replace(CUT_SHORT, '')}`
}
const HANDED = /\n\nHanded over by (.+?)(?: \(their job: ([^)\n]*)\))?\. Work from this result[^\n]*:\n/
export function handedFrom(brief: string): { brief: string; from: string; job: string; result: string } | undefined {
  const at = HANDED.exec(brief)
  return at ? { brief: brief.slice(0, at.index), from: at[1]!, job: at[2] ?? '', result: brief.slice(at.index + at[0].length) } : undefined
}

export async function employeeNote(paths: VaultPaths, botId: string, now?: Date, kind?: 'writer' | 'lookup'): Promise<string> {
  const bots = await loadBots(paths), bot = bots.find(one => one.id === botId)
  if (!bot) return ''
  let voice = voiceOf(bot)
  if (!voice && bot.label?.trim() && !bot.primary) {
    voice = VOICES[Math.max(0, employees(bots).indexOf(bot)) % VOICES.length]!
    await updateBot(paths, bot.id, { purpose: withVoice(bot.purpose, voice) }).catch(() => undefined)
  }
  const temper = voice && kind !== 'writer' ? ` Your temperament: ${JSON.stringify(voice)}. Speak naturally in it in your own chat sentence ("note"); never a fixed catchphrase or ending, and never describe it.` : ''
  const memory = renderMemory(await loadBotMemory(paths, botId), now)
  return ` You are ${bot.name}${bot.label?.trim() ? `, ${bot.label.trim()}` : ''}, one of the agents on the person's team; the lead is the one the person talks to and passes your result on. Your role: ${clip(workOf(bot.purpose) || bot.label || bot.name, 600)}${temper}${kind === 'lookup' ? ` ${REPORT_RULE}` : ''}${memory ? `\nWhat you remember from your earlier work:\n${memory}` : ''}`
}

const REPORT_RULE = 'Your whole answer is one fenced block, ```report, holding JSON and nothing before or after it: {"facts":[{"text":"…","url":"…","site":"…","date":"…"}],"nothing_in_period":{"latest":{"text":"…","name":"…","url":"…","site":"…","date":"…"}},"note":"…"}. facts: what you found for your part, each one short plain sentence in the person\'s language (polite -요 form in Korean) that names what it is about and states its own day or period when it has one ("11월 8일 저녁에 열려요"), with no address in it; url: the page it came from, copied exactly (a result\'s own page, never a search-results page unless the figure is read from that page\'s own box); site: that page\'s site or publication name as its result shows it; date: that same day once more as a label, in words ("10월 19일", with the year when it is not this year), and only the day the fact itself happens or holds: never the day its page or result was posted or updated; a fact with no day of its own has no date. For a schedule or a list, one fact per item, only items that really are the kind of thing asked (judge by what each one is), each with its own page. Everything the rules above say to report goes into facts. nothing_in_period: only when nothing is there for the time your part asks; then facts is [] and latest is the newest such thing you did see, when you saw one; its text says only what that thing is, never that nothing is there, and name is that thing in a few words (what it is, at most 30 characters). note: optional, one short sentence to your colleagues in your own words, no address. Nothing about searching, tools, time or limits anywhere.'
export const WRITER_RULE = 'Everything this part needs is in the brief: you have no tools and look nothing up. Your whole answer is one fenced block, ```report, holding JSON and nothing before or after it: {"items":["…"],"note":"…"}. items: the finished deliverable, one entry per piece, exactly as many as the job asks ("문구 3개" is 3), each final text only, written in the register the deliverable needs (ad copy reads as ad copy), in the person\'s language: no draft, no alternative, no remark about it, no number in front. Work made from a teammate\'s find uses at least one of its facts as it is (a figure, a date or a name). note: optional, one short sentence to your colleagues, no address.'

export async function employeeWriteBack(paths: VaultPaths, job: { botId: string; brief: string; result: string; title?: string; data?: MemberData | undefined }, now = new Date(), busy: () => boolean = () => false): Promise<void> {
  const bots = await loadBots(paths), bot = bots.find(one => one.id === job.botId)
  if (!bot) return
  const at = now.toISOString(), from = handedFrom(job.brief)
  const result = job.result.startsWith('Failed: ') ? '' : job.result.trim()
  const found = result.replace(CUT_SHORT, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(ADDRESS, '').replace(/\s+[—–-]\s*(?=\n|$)/g, '').replace(/\s+/g, ' ').trim()
  const what = `${job.title?.trim() || jobTitle(job.brief)}${from ? ` (${from.from}한테 받아서)` : ''}`, tail = ` (${bot.name}, ${ymd(now)})`
  const line = `${what} → ${job.data ? brought(job.data) : found ? clip(found, Math.max(20, 150 - Array.from(what).length - tail.length)) : UNFINISHED}${tail}`
  await recordFacts(paths, bot.id, [line], now)
  await recordFacts(paths, TEAM_MEMORY, [line], now)
  if (!found) return
  while (busy()) await new Promise(resolve => setTimeout(resolve, WRITE_BACK_POLL_MS))
  await Promise.all([appendBotTurn(paths, bot.id, { role: 'user', text: job.brief, at }), appendBotTurn(paths, bot.id, { role: 'assistant', text: result.replace(CUT_SHORT, ''), at })])
}
const WRITE_BACK_POLL_MS = 500
const UNFINISHED = '다 못 끝냈어요'
const NOTHING_NEW = '새로 나온 게 없었어요'
const brought = (d: MemberData): string => {
  const items = d.facts.filter(f => !f.listing && !f.rest), first = items[0]?.name?.trim()
  if (d.items?.length) return `${d.items.length}개 써 왔어요`
  if (d.nothing || !d.facts.length) return d.nothing ? NOTHING_NEW : '못 찾았어요'
  return items.length > 1 ? `${first ? `${first} 등 ` : ''}${items.length}개 찾았어요` : first ? `${josa(first, '을', '를')} 찾았어요` : '찾았어요'
}

const ADDRESS = /https?:\/\/[^\s)\]>"'|]+/g
export const CUT_SHORT = /\n\((?:[^()\n]*한도에서 멈춤[^()\n]*|stopped at [^()\n]*)\)$/
const delivered = (m: TeamMember): string => m.state === 'failed' || m.state === 'hired' || m.state === 'working' || !m.result?.trim() || m.result.startsWith('Failed: ') ? '' : m.result.trim()
const atWork = (m: TeamMember): boolean => m.state === 'hired' || m.state === 'working'
const named = (m: TeamMember, name: string): boolean => m.parentId === null && (name === m.id || name === m.topic || name === m.role)
const runningNow = (members: readonly TeamMember[]): string => members.filter(m => m.parentId === null && atWork(m)).map(m => `${m.role}${m.topic ? ` (${m.topic})` : ''}`).join(', ')
export type PartOutcome = 'found' | 'nothing-in-period' | 'working' | 'unfinished'
export const partOutcome = (m: TeamMember): PartOutcome => atWork(m) ? 'working' : m.data?.nothing ? 'nothing-in-period' : m.data?.facts.length || m.data?.items?.length || (!m.unfinished && !m.data && !!delivered(m)) ? 'found' : 'unfinished'

function partsOf(task: DelegatedTask | undefined, background: boolean): TeamMember[] {
  const posted = task?.team?.posted ?? []
  const all = (task?.team?.members ?? []).filter(m => (!background || m.background) && !!m.botId && !(m.state === 'released' && !m.result) && !posted.includes(m.id))
  const givers = background ? handingOn(all) : []
  if (givers.length) return givers
  if (!all.some(m => m.late)) return all
  if (task!.team!.lateTold) return all.filter(m => m.late)
  return all.map(m => { if (!m.late) return m; const still: TeamMember = { ...m, state: 'working' }; delete still.result; return still })
}
const handingOn = (members: readonly TeamMember[]): TeamMember[] => members.filter(m => !!m.then && !!delivered(m) && members.some(next => atWork(next) && handedFrom(next.brief)?.from === m.role))
export function handoffShown(task: DelegatedTask): void {
  const team = task.team, givers = handingOn((team?.members ?? []).filter(m => m.background && !team?.posted?.includes(m.id)))
  if (team && givers.length) team.posted = [...(team.posted ?? []), ...givers.map(m => m.id)]
}
const handsIn = (members: readonly TeamMember[]): boolean => members.some(m => m.state === 'waiting' || !!m.files?.length || /\]\(engram-artifact:/.test(m.result ?? ''))
const reportable = (task: DelegatedTask | undefined): TeamMember[] | undefined => {
  const members = partsOf(task, true)
  return !members.length || handsIn(members) ? undefined : members
}
export const followsLate = (m: TeamMember): boolean => !m.then && !handedFrom(m.brief)
export function lateParts(task: DelegatedTask): string[] {
  const parts = (task.team?.members ?? []).filter(m => m.background && !!m.botId && m.parentId === null)
  const open = parts.filter(atWork)
  return task.team?.lateTold || parts.some(m => m.late) || !open.some(followsLate) ? [] : open.map(m => m.id)
}
export function markLate(task: DelegatedTask): string[] { const ids = lateParts(task); for (const m of task.team?.members ?? []) if (ids.includes(m.id)) m.late = true; return ids }
export function lateShown(task: DelegatedTask): void {
  const team = task.team
  if (!team?.members.some(m => m.late)) return
  if (!team.lateTold) team.lateTold = true
  else if (!team.members.some(m => m.late && atWork(m))) team.lateDone = true
}
export const lateOwed = (task: DelegatedTask): boolean => !!task.team?.members.some(m => m.late) && !task.team.lateDone

const handBack = (m: TeamMember): Record<string, unknown> => ({ who: m.role, ...(m.topic ? { part: m.topic } : {}), state: atWork(m) ? 'working' : m.review ? (m.review.ok ? 'done' : 'failed') : m.state, result: m.result ?? '', ...(m.sources?.length ? { sources: m.sources } : {}), ...(m.files?.length ? { files: m.files } : {}), ...(m.state === 'waiting' ? { id: m.id, ask: m.result ?? '' } : {}) })
export function handBacks(members: readonly TeamMember[], added: readonly string[] = []): string {
  return JSON.stringify({ ...(added.length ? { added } : {}), reports: members.map(handBack), note: ASSIGN_NOTE })
}
export function employeesAnswer(task: DelegatedTask | undefined): string | undefined {
  const members = reportable(task)
  return members && handBacks(members)
}

export type ReportWriter = (prompt: string, ms?: number) => Promise<string | undefined>
export const REPORT_WRITER_MS = 4000

const ASSIGN_MAX = 4
const ASSIGN_NOTE = 'Each report is accepted as it is: do not call review_member for it. Give the person ONE merged answer in their language that reads as the teammates talking: one short lead-in line, then who did what in natural sentences that name each agent (never a line that starts with a name and a colon), their part named, each agent\'s source right after what it backs as a markdown link copied from sources or from their result, never a site name alone; a file an agent made is named in their line. A table only when the person asked to compare or for a table. No sections per agent, no closing offer or question. Mention anyone in "added" in one short line. Where one agent handed their result to the next, the last result is the deliverable; keep the facts it took from the earlier one. Say plainly which part failed or is missing. ' + SOURCE_TITLES_RULE + ' A report with state waiting needs the person: close with its question, and when they answer pass it with review_member({id, ok:false, note:<answer>}).'

export function assignTool(paths: VaultPaths, host: AssignHost, changed: () => void): AgentTool {
  return {
    name: 'assign',
    closes: args => args['wait'] === false || !!said(args['steer'], 60),
    description: `Hand work to agents on the person's team by name; each does their part as themselves, with their own role and memory, side by side. ONE call for the whole sentence, 1 to ${ASSIGN_MAX} parts, no question and no confirmation. to: who (the agent's name as it is on the team: "지민이는" names 지민), brief (their whole part, complete on its own, at most 3 short lines; only what the person asked for), topic (the name of their part in the person's own words, a word or two). Someone named who is not on the team yet is added by this same call, with role (a few words that fit the part). then {who, brief}: when who finishes, their result goes to this second agent, who does brief with it; leave the first brief out to hand over the work that agent is on now or last finished. make true only for a part that creates or changes a file or acts on a page; otherwise the part is a fast read-only lookup. wait false when the person just hands the job off: the reply is shown to the person as your answer and ends the turn, and the result comes back here by itself when the work is done. wait true when they want the result in this answer: it returns what every agent handed back, and you write the one merged answer from that. steer (a topic or agent name in it) when the person changes work handed off earlier that is still running: to joins that work and its one result, stop lists its parts taken off.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['to', 'wait'],
      properties: {
        to: { type: 'array', maxItems: ASSIGN_MAX, items: { type: 'object', additionalProperties: false, required: ['who'], properties: { who, brief: who, topic: who, role: who, make: { type: 'boolean' }, then: { type: 'object', additionalProperties: false, required: ['who', 'brief'], properties: { who, brief: who, role: who } } } } },
        wait: { type: 'boolean' }, steer: who, stop: { type: 'array', items: who },
      },
    },
    async run(args, context) {
      const steer = said(args['steer'], 60), wait = !steer && args['wait'] !== false
      const stop = steer ? names(args['stop']) : []
      const jobs = steer ? await host.running() : []
      const job = jobs.find(one => one.parts.some(m => [steer, ...stop].some(name => named(m, name))))
      if (steer && !job) throw new Error(jobs.length ? `No work still running has a part named ${steer}. Running now: ${runningNow(jobs.flatMap(one => one.parts))}.` : 'No work handed off earlier is still running in this thread; call assign without steer.')
      const on = job ?? host
      const parts = rows(args['to']).map(row => {
        const next = typeof row['then'] === 'object' && row['then'] !== null ? row['then'] as Record<string, unknown> : undefined
        return { who: said(row['who'], 60), brief: String(row['brief'] ?? '').trim().slice(0, 1500), topic: said(row['topic'], 30), title: said(row['role'], BOT_LABEL_CHARS), make: row['make'] === true, ...(next ? { then: { who: said(next['who'], 60), brief: String(next['brief'] ?? '').trim().slice(0, 1500), title: said(next['role'], BOT_LABEL_CHARS) } } : {}) }
      })
      if ((!parts.length && !stop.length) || parts.length > ASSIGN_MAX) throw new Error(`to needs 1 to ${ASSIGN_MAX} parts, each with who and brief.`)
      if (parts.some(part => !part.who || (!part.brief && !part.then) || (part.then && (!part.then.who || !part.then.brief)))) throw new Error('Each part needs who and brief; then needs who and brief.')
      const active = await loadBots(paths), gone = await loadArchivedBots(paths)
      const staff = new Map(active.filter(bot => !bot.primary).map(bot => [bot.name.trim(), bot]))
      const known = [...staff.keys(), ...active.filter(bot => bot.primary).map(bot => bot.name.trim()), ...gone.map(bot => bot.name.trim())]
      for (const one of parts.flatMap(part => [part, ...(part.then ? [part.then] : [])])) one.who = teamName(one.who, known) ?? bareName(one.who)
      const refused: string[] = [], hiring = new Map<string, string>()
      for (const one of parts.flatMap(part => [part, ...(part.then ? [part.then] : [])])) {
        if (staff.has(one.who) || hiring.has(one.who)) continue
        if (active.some(bot => bot.primary && bot.name.trim() === one.who)) refused.push(`${one.who}한테는 맡길 수 없어요. 팀원 이름을 알려 주세요.`)
        else if (gone.some(bot => bot.name.trim() === one.who)) refused.push(REMOVED(one.who))
        else hiring.set(one.who, one.title || ('topic' in one && one.topic ? `${one.topic} 담당`.slice(0, BOT_LABEL_CHARS) : '팀원'))
      }
      const thread = (await host.load())?.botId
      const tasks = parts.some(part => !part.brief) && thread ? (await listTasks(paths)).filter(task => task.botId === thread) : []
      const lastJob = (botId: string): TeamMember | undefined => tasks.flatMap(task => task.team?.members ?? [])
        .filter(m => m.botId === botId && (m.state === 'done' || m.state === 'released') && m.review?.ok !== false && !!m.result && !m.result.startsWith('Failed: '))
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0]
      for (const part of parts) if (!part.brief && !staff.has(part.who)) refused.push(`${josa(part.who, '이', '가')} 끝낸 일이 아직 없어서 넘길 게 없어요.`)
      if (refused.length) return [...new Set(refused)].join('\n')

      const voices: string[] = []
      for (const [name, title] of hiring) {
        voices.push(nextVoice(employees(active), voices))
        const bot = await createBot(paths, { name, purpose: withVoice(title, voices.at(-1)!) })
        staff.set(name, await updateBot(paths, bot.id, { label: title }))
      }
      if (hiring.size) changed()
      const joined = [...hiring.keys()].join('·')

      const lines: string[] = []
      const wanted: { bot: Bot; brief: string; topic: string; make: boolean; writer?: true; from?: string; then?: NonNullable<TeamMember['then']> }[] = []
      for (const part of parts) {
        const bot = staff.get(part.who)!, next = part.then ? { botId: staff.get(part.then.who)!.id, who: part.then.who, brief: part.then.brief, ...(voiceOf(staff.get(part.then.who)!) ? { voice: voiceOf(staff.get(part.then.who)!)! } : {}) } : undefined
        if (part.brief) { wanted.push({ bot, brief: part.brief, topic: part.topic, make: part.make, ...(next ? { then: next } : {}) }); continue }
        if (await host.attach(bot.id, next!)) { lines.push(`${josa(bot.name, '이', '가')} 끝내면 ${next!.who}한테 넘길게요.`); continue }
        const last = lastJob(bot.id)
        if (!last) return [...lines, `${josa(bot.name, '이', '가')} 끝낸 일이 아직 없어서 넘길 게 없어요.`].join(' ')
        wanted.push({ bot: staff.get(next!.who)!, brief: handoffBrief(next!.brief, bot.name, last.result!, last.brief), topic: part.topic, make: part.make, from: bot.name, ...(!part.make && writesFromHandover(next!.brief) ? { writer: true as const } : {}) })
      }
      if (!wanted.length && !stop.length) return lines.join(' ')
      const out = await on.change((task): { refuse: string } | { missing: string } | { ids: string[]; off: TeamMember[] } => {
        const team = task.team ?? { members: [], hires: 0, maxHires: TEAM_MAX_HIRES, maxDepth: TEAM_MAX_DEPTH, big: false }
        if ((task.state !== 'running' && !steer) || team.hires + wanted.length > team.maxHires) return { refuse: '지금은 더 맡길 수 없어요. 하던 일이 끝난 뒤에 다시 말해 주세요.' }
        const off = team.members.filter(m => m.parentId === null && atWork(m) && stop.some(name => named(m, name)))
        if (stop.length && !off.length) return { missing: `Nothing still running matches stop. Running now: ${runningNow(team.members)}.` }
        task.team = team
        const at = new Date().toISOString()
        const ids = wanted.map(one => {
          const id = `m${team.members.length + 1}`
          team.members.push({ id, parentId: null, depth: 1, ...(team.lateTold && !team.lateDone ? { late: true as const } : {}), role: one.bot.name, brief: one.brief, botId: one.bot.id, ...(voiceOf(one.bot) ? { voice: voiceOf(one.bot)! } : {}), title: jobTitle(one.brief), ...(one.topic || topicOf(one.brief) ? { topic: one.topic || topicOf(one.brief) } : {}), ...(one.writer ? { writer: true as const } : one.make ? {} : { lookup: true as const, ...(searchWords(one.brief, undefined, context.task) ? { query: searchWords(one.brief, undefined, context.task)! } : {}) }), ...(wait ? {} : { background: true as const }), ...(one.then ? { then: one.then } : {}), state: 'hired', sessionKey: `team-${task.id}-${id}`, hiredAt: at })
          return id
        })
        team.hires += ids.length
        logTask(task, steer ? `Changed while working: added ${wanted.map(one => one.bot.name).join(', ') || 'nobody'}, took off ${off.map(m => m.role).join(', ') || 'nothing'}` : `Assigned ${wanted.map(one => one.bot.name).join(', ')}`)
        return { ids, off: structuredClone(off) }
      })
      if (out && 'missing' in out) throw new Error(out.missing)
      if (!out || 'refuse' in out) return [...lines, out?.refuse ?? '지금은 맡길 수 없어요. 다시 말해 주세요.'].join(' ')
      if (steer) {
        if (out.ids.length) await on.later(out.ids)
        const offIds = out.off.map(m => m.id)
        await on.release(offIds)
        await on.change(task => { for (const m of task.team?.members ?? []) if (offIds.includes(m.id)) { m.review = { ok: false, note: TAKEN_OFF }; delete m.result; delete m.data } })
        const added = listed(wanted.map(one => one.topic || one.bot.name)), taken = listed(out.off.map(m => m.topic || m.role))
        const line = added && taken ? `${taken} 말고 ${ro(added)} 바꿀게요.` : added ? `${added}도 넣을게요.` : `${josa(taken, '은', '는')} 뺄게요.`
        return [...lines, joined ? `${josa(joined, '은', '는')} 새로 넣고, ${line}` : line].join(' ')
      }
      if (!wait) {
        await host.later(out.ids)
        const names = [...new Set(wanted.map(one => one.bot.name))], only = wanted.length === 1 ? wanted[0]! : undefined
        const said = thread ? (await readBotTranscript(paths, thread, 40).catch(() => [])).filter(turn => turn.role === 'assistant').map(turn => turn.text).join('\n') : ''
        const pick = (forms: readonly (readonly [string, string])[]): string => (forms.find(([, words]) => !said.includes(words)) ?? forms[0]!)[0]
        const who = names.join(', ')
        const handed = only?.from ? pick([[`${josa(only.from, '이', '가')} 한 걸 ${only.bot.name}한테 넘겼어요.`, '넘겼어요'], [`${josa(only.bot.name, '이', '가')} ${only.from} 걸 이어서 할 거예요.`, '이어서 할']])
          : only?.then ? pick([[`${only.bot.name}한테 맡기고, 끝나면 ${only.then.who}한테 넘길게요.`, '넘길게요'], [`${josa(only.bot.name, '이', '가')} 먼저 하고 ${josa(only.then.who, '이', '가')} 이어서 할 거예요.`, '이어서 할']])
          : `${names.length > 1 ? pick([[`${who}한테 나눠 맡겼어요.`, '나눠 맡겼어요'], [`${who}한테 하나씩 넘겨 놨어요.`, '넘겨 놨어요'], [`${josa(who, '이', '가')} 나눠서 볼 거예요.`, '볼 거예요']])
            : pick([[`${who}한테 맡겼어요.`, '맡겼어요'], [`${who}한테 넘겨 놨어요.`, '넘겨 놨어요'], [`${josa(who, '이', '가')} 바로 볼 거예요.`, '볼 거예요']])}${wanted.filter(one => one.then).map(one => ` ${josa(one.bot.name, '이', '가')} 끝내면 ${one.then!.who}한테 넘길게요.`).join('')}`
        return [...lines, joined ? `${josa(joined, '은', '는')} 새로 넣고, ${handed}` : handed].join(' ')
      }
      if (joined) lines.unshift(`${josa(joined, '은', '는')} 새로 넣었어요.`)

      await host.run(out.ids, context.signal)
      const mine = (members: readonly TeamMember[]) => members.slice(members.findIndex(m => m.id === out.ids[0])).filter(m => m.parentId === null && !!m.botId)
      const settled = await host.change(task => mine(task.team?.members ?? []).filter(m => m.state === 'done' || m.state === 'failed').map(m => { m.review ??= { ok: m.state === 'done', note: 'auto: employee report' }; return m.id })) ?? []
      await host.release(settled)
      const team = (await host.load())?.team, reports = mine(team?.members ?? [])
      const asking = reports.filter(m => m.state === 'waiting')
      if (asking.length && !reports.some(m => m.result && m.review?.ok)) return formatAsk(asking.map(m => `${m.role}: ${m.result ?? ''}`).join('\n'), [])
      return handBacks(reports, lines)
    },
  }
}
