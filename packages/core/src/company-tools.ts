import type { AgentTool } from './agent-loop.js'
import { BOT_LABEL_CHARS } from './bot-fields.js'
import { loadBotMemory, memoryIds, mergeMemory, renderMemory, type BotMemoryFile } from './bot-memory.js'
import { archiveBot, createBot, loadArchivedBots, loadBots, restoreBot, updateBot, type Bot } from './bots.js'
import { listTasks, SOURCE_TITLES_RULE, type DelegatedTask } from './delegated-tasks.js'
import { formatAsk } from './ask.js'
import { recordFacts } from './bot-memory.js'
import { appendBotTurn } from './bots.js'
import { logTask, TEAM_MAX_DEPTH, TEAM_MAX_HIRES, type TeamMember } from './delegated-tasks.js'
import type { TeamHost } from './team-hire-tools.js'
import type { VaultPaths } from './vault.js'

// The person works with ONE flat team of agents by chat: they ask, the right agents do it, one answer comes back in their thread.
// An agent is a bot with a role (label). No ranks, no titles, no groups, and nothing here has a screen of its own.
// (Exported names still say staff / company / employee: they are the same things, kept so the wiring did not move.)
export const employees = (bots: readonly Bot[]): Bot[] => bots.filter(bot => bot.primary !== true && !!bot.label?.trim())

// Korean particles follow the last syllable's final consonant; a name that does not end in Hangul is read as having none.
const tail = (word: string): number => { const code = word.trim().charCodeAt(word.trim().length - 1) - 0xac00; return code >= 0 && code <= 11171 ? code % 28 : 0 }
const josa = (word: string, closed: string, open: string): string => `${word}${tail(word) ? closed : open}`
const ro = (word: string): string => `${word}${tail(word) && tail(word) !== 8 ? '으로' : '로'}`

const said = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []
const names = (value: unknown): string[] => Array.isArray(value) ? value.map(one => said(one, 60)).filter(Boolean) : []

const who = { type: 'string' } as const
const REMOVED = (name: string): string => `${josa(name, '은', '는')} 전에 뺀 팀원이에요. "${name} 다시 불러와"라고 하면 돌아와요.`

export function staffTool(paths: VaultPaths, changed: () => void): AgentTool {
  return {
    name: 'agents',
    closes: true,
    description: 'Manage the person\'s team of agents: one flat team, every agent a bot of its own, all equal. ONE call does the whole sentence, with no confirmation and no question: add (name in their words; role = what the agent is for in a few of their words, such as "리서치 담당"; how = how it should work, only when they said more), rename (who = current name; name for a new name, role or how only if they change; identity, memory and history are kept), remove (taken off the team: hidden but kept, never deleted), restore (bring back someone removed). The reply is shown to the person as your answer and ends the turn; add nothing.',
    argsSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        add: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'role'], properties: { name: who, role: who, how: who } } },
        rename: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who'], properties: { who, name: who, role: who, how: who } } },
        remove: { type: 'array', items: who },
        restore: { type: 'array', items: who },
      },
    },
    async run(args) {
      const active = await loadBots(paths), gone = await loadArchivedBots(paths)
      // Who holds each name once the whole call has run; null is someone this call adds.
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
      const adding: { name: string; role: string; how: string }[] = []
      for (const row of rows(args['add'])) {
        const name = said(row['name'], 60), role = said(row['role'], BOT_LABEL_CHARS)
        if (!name || !role) throw new Error('add needs a name and a role for each agent.')
        if (held.has(name)) refused.push(taken(name))
        else if (gone.some(one => one.name.trim() === name)) refused.push(REMOVED(name))
        else { adding.push({ name, role, how: String(row['how'] ?? '').trim().slice(0, 2000) || role }); held.set(name, null) }
      }
      if (!removing.length && !returning.length && !renaming.length && !adding.length && !refused.length) throw new Error('nothing to do: give add, rename, remove or restore.')
      // All or nothing: a sentence that cannot be done whole changes nothing, and the person is told why.
      if (refused.length) return [...new Set(refused)].join('\n')

      const lines: string[] = []
      for (const bot of removing) { await archiveBot(paths, bot.id); lines.push(`${josa(bot.name, '을', '를')} 뺐어요. 기록은 남겨 뒀으니 다시 부르면 돌아와요.`) }
      for (const bot of returning) { await restoreBot(paths, bot.id); lines.push(`${josa(bot.name, '이', '가')} 돌아왔어요.`) }
      for (const { bot, name, role, how } of renaming) {
        if (!name && !role && !how) continue
        await updateBot(paths, bot.id, { ...(name ? { name } : {}), ...(role ? { label: role } : {}), ...(how ? { purpose: how } : {}) })
        const now = [name, role].filter(Boolean).join(', ')
        lines.push(now ? `${josa(bot.name, '은', '는')} 이제 ${josa(now, '이에요', '예요')}.` : `${bot.name}의 일하는 방식을 바꿨어요.`)
      }
      for (const { name, role, how } of adding) {
        const bot = await createBot(paths, { name, purpose: how })
        await updateBot(paths, bot.id, { label: role })
        lines.push(`${josa(name, '을', '를')} ${ro(role)} 추가했어요.`)
      }
      changed()
      return lines.join('\n')
    },
  }
}

const clip = (text: string, max: number): string => { const line = text.replace(/\s+/g, ' ').trim(); return Array.from(line).length > max ? `${Array.from(line).slice(0, max).join('')}…` : line }
const BUSY = ['hired', 'working', 'reviewing']

// One line per agent, from stored tasks alone: no model is asked. `doing` is the host's live last step for a bot, when it has one.
export function companyStatus(bots: readonly Bot[], tasks: readonly DelegatedTask[], doing: (botId: string) => string | undefined = () => undefined): string {
  const staff = employees(bots)
  if (!staff.length) return '아직 팀원이 없어요. "지민 추가해줘. 리서치 담당이야"처럼 말하면 바로 추가할게요.'
  return staff.map(bot => {
    const own = tasks.filter(task => task.botId === bot.id)
    // An agent also works as a member of the task it was handed a part of (assign).
    const parts = tasks.flatMap(task => (task.team?.members ?? []).filter(member => member.botId === bot.id).map(member => ({ member, open: task.state === 'running' || task.state === 'waiting', at: member.finishedAt ?? task.updatedAt })))
    const working = own.find(task => task.state === 'running' || task.state === 'queued')?.goal ?? parts.find(part => part.open && BUSY.includes(part.member.state))?.member.brief
    const waiting = own.find(task => task.state === 'waiting')?.goal ?? parts.find(part => part.open && part.member.state === 'waiting')?.member.brief
    const last = [...own.filter(task => task.state === 'done').map(task => ({ at: task.updatedAt, what: task.goal })), ...parts.filter(part => part.member.state === 'done' || part.member.state === 'released').map(part => ({ at: part.at, what: part.member.brief }))].sort((a, b) => b.at.localeCompare(a.at))[0]?.what
    const step = working ? doing(bot.id) : undefined
    const state = working ? `일하는 중: ${clip(working, 40)}${step ? ` · ${clip(step, 60)}` : ''}` : waiting ? `답을 기다리는 중: ${clip(waiting, 40)}` : last ? `쉬는 중 · 마지막 일: ${clip(last, 40)}` : '쉬는 중'
    return `- ${bot.name} (${bot.label!.trim()}) — ${state}`
  }).join('\n')
}

export function companyStatusTool(paths: VaultPaths, doing?: (botId: string) => string | undefined): AgentTool {
  return {
    name: 'agents_now',
    closes: true,
    description: 'What every agent on the team is doing right now, one line each (working on what, waiting, or idle with their last job). Use when the person asks what the team is doing. The reply is shown to the person as your answer and ends the turn.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: async () => companyStatus(await loadBots(paths), await listTasks(paths), doing),
  }
}

// A closed list on purpose: these are answered without a model, so only a message that is nothing but the status question matches.
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

// The team lane's whole menu: few enough that the session preloads it (no tool search round).
export const COMPANY_LANE_TOOLS: ReadonlySet<string> = new Set(['agents', 'assign', 'agents_now', 'schedule', 'hire_members', 'review_member', 'team_status', 'search_web', 'read_pages', 'search_chats', 'search_memory', 'read_note', 'ask_person', 'keep_in_mind'])

export const COMPANY_ASK_CHARS = 200
// The lane has no file, office or browser tools, so it takes only sentences it can finish: a change to the team or a question about who someone is or
// what they are doing. Anything that reads like work stays on the normal path, which is slower but has every tool (and the same agents tool).
const WORK = /엑셀|excel|ppt|파워포인트|pdf|워드|파일|문서|자료|보고|메일|요약|정리|조사|검색|번역|작성|문구|고쳐|수정|맡겨|맡기|넘겨|한테|에게|매주|매일|마다/iu
const HIRE = /뽑아|뽑고|채용|고용|추가/u
// Adding someone names an agent to be: the word itself, a head count or a duty. "사람" alone is not one ("사람 사진").
// The endings (사원, 대리, ...) are only names people already gave their agents ("박사원"); nobody has a rank.
const PERSON = /에이전트|직원|팀원|인턴|담당|[한두세네\d]\s*명|(사원|주임|대리|과장|차장|부장|팀장)(?=$|[\s,.!?]|[을를이가은는도랑과와]|하고|으로)/u
// Something to be made or picked out, never an agent: "사람 사진 3장 뽑아줘", "후보 5개 뽑아줘". Counted in pieces, sheets or lines, or named.
const ARTIFACT = /(\d|[한두세네몇]\s|여러\s*)\s*(장|개|줄|건|편|쪽|컷|가지|페이지)|사진|이미지|그림|일러스트|로고|아이콘|영상|동영상|썸네일|배너|포스터|문구|카피|슬로건|제목|시안|초안|(?<![가-힣])표|차트|그래프|목록|리스트|명단|자료|데이터|통계|숫자|번호|이름|키워드|아이디어|후보|예시|샘플|문장|단어|내용|핵심|코드|링크|주소/u
const CHANGE = /내보내|해고|빼\s*(줘|주세요|고)|제외|다시\s*(불러|데려)|복직|이름.{0,12}바꿔/u
// What is left of a question once the names are taken out, spaces removed. Whole-string matches only.
const ABOUT = [
  /^(지금|요즘|최근에?|이번주에?|오늘)?(뭐|뭘|무슨일|어떤일|무슨업무|어떤업무)(을|를)?(해|하니|하나|하고있어|하고있나|하는중이야|하는중이에|하는(사람|직원|에이전트|팀원|분)(이야|이에|인가|이니|입니까)?|했어|했나|맡고있어|맡았어|담당해|담당하고있어)요?$/u,
  /^(누구|어떤(사람|직원|에이전트|팀원|분)|무슨사람)(야|이야|예요|이에요|인가요|니|입니까)?$/u,
  /^(담당|역할|업무|하는일|맡은일)(이|은|는|가)?(뭐|뭔데|무엇)(야|예요|지|죠|인가요|니)?$/u,
  /^(현황|상태|근황)(은|이)?(알려줘|보여줘|어때|뭐야)?요?$/u,
]
const ROSTER = /^(우리|지금|현재)*(에이전트|직원|팀원|팀)(들|이|은|는|에|엔)*(누구누구|누가|누구|몇명|뭐|목록|명단|리스트)(있어|있나|있니|이야|야|보여줘|알려줘)?요?$/u
const AFTER_NAME = '(님|씨)?(에서|으로|이랑|하고|랑|과|와|은|는|이|가|도|을|를|의|로|에)?'
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A short sentence about the team: add, rename, remove, bring back, or "who is X / what is X doing". A work request that only names an agent is not one. When unsure, false. */
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

// Handing work to agents is also a sentence the lane can finish: the lead only hands off (assign), the agents work with their own full tools.
const TO_STAFF = /(사원|주임|대리|과장|차장|부장|팀장|인턴|팀|님|씨)\s*(한테|에게)/u
const DELEGATE = /맡겨|맡기|시켜|시키|넘겨|넘기/u
/** Work is handed to agents by name ("지민한테 맡겨", "지민, 서연, 도윤한테 나눠서 시켜": one known name is enough, the others are added by assign). When unsure, false. */
export function isAssignAsk(message: string, known: readonly string[]): boolean {
  if (message.length > COMPANY_ASK_CHARS || !DELEGATE.test(message)) return false
  return TO_STAFF.test(message) || (/한테|에게/u.test(message) && known.some(name => name.trim().length >= 2 && message.includes(name.trim())))
}

// "이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리": the name is on the team and the brief is the person's own words after the colon, so the
// host makes the assign call itself and the "맡겼어요" line needs no model round (as-e1cf9bfd C5: 5.9 s, bar 3 s).
// shortcut: only this one shape, a read-only lookup for one agent; anything else (a handoff, two agents, a file to make, a result wanted in this answer) is the model's call.
const HANDOFF_MORE = /끝나면|넘겨|넘기|보고|알려|기다|만들|작성|저장|파일|고쳐|수정|바꿔|보내|올려|삭제|지워|한테|에게/u
/** The assign arguments for a plain hand-off to one agent already on the team, or undefined. */
export function plainHandoff(message: string, staff: readonly string[]): { to: { who: string; brief: string }[]; wait: false } | undefined {
  if (message.length > COMPANY_ASK_CHARS || isOutsideAsk(message)) return undefined
  const said = /^(?:(?:이거|이것|이건|이 일)\s*)?(.+?)\s*(?:한테|에게)\s*(?:맡겨|시켜)(?:\s*(?:줘|줘요|주세요|놔|놔줘))?\s*[:：]\s*(.+)$/u.exec(message.trim())
  const who = said?.[1]!.trim(), brief = said?.[2]!.trim()
  if (!who || !brief || brief.includes('\n') || !staff.some(name => name.trim() === who) || HANDOFF_MORE.test(brief)) return undefined
  return { to: [{ who, brief }], wait: false }
}

// "지민 하나 추가해줘. 리서치 담당이야", "카피 담당으로 서연도 추가해": one new name and one duty, so the host makes the agents call itself.
// stack1 C1: the model round only copied those two phrases into the call and took 4.1 s (bar 5 s, measured 5.1 s).
// shortcut: these two word orders only; two agents or a role described in a sentence stay the model's call.
const NEW_NAME = '([가-힣A-Za-z]{2,10}?)(?:도|을|를)?'
const DUTY = '([가-힣A-Za-z0-9 ]{1,20}?\\s*담당)'
const PLEASE_ADD = '\\s*(?:(?:하나|한\\s*명)\\s*)?(?:새로\\s*)?(?:팀에\\s*)?(?:추가해|뽑아|채용해|고용해)\\s*(?:줘|줘요|주세요)?'
const ADD_THEN_DUTY = new RegExp(`^${NEW_NAME}${PLEASE_ADD}[.!,\\s]+${DUTY}(?:이야|야|이에요|예요|입니다)?[.!]?$`, 'u')
const DUTY_THEN_ADD = new RegExp(`^${DUTY}(?:으로|로)?\\s+${NEW_NAME}${PLEASE_ADD}[.!]?$`, 'u')
// A word for what is being added, not somebody's name.
const NOT_A_NAME = /^(에이전트|팀원|직원|사람|인턴|멤버|봇|하나|새로)$/u
/** The agents arguments for adding one named agent with one duty, or undefined. */
export function plainHire(message: string): { add: { name: string; role: string }[] } | undefined {
  const line = message.trim()
  if (line.length > COMPANY_ASK_CHARS || line.includes('\n')) return undefined
  const first = ADD_THEN_DUTY.exec(line), second = first ? null : DUTY_THEN_ADD.exec(line)
  const name = first?.[1] ?? second?.[2], role = (first?.[2] ?? second?.[1])?.replace(/\s+/g, ' ').trim()
  return name && role && !NOT_A_NAME.test(name) && !ARTIFACT.test(name) ? { add: [{ name, role }] } : undefined
}

/** "지우 무슨 일 하는 사람이야?": who one agent is and what they did, from the team list and stored work with no model (stack1 C9: 4.4 s for a model round, bar 5 s). Undefined unless the message names exactly one agent and asks nothing else. */
export function aboutEmployee(message: string, bots: readonly Bot[], tasks: readonly DelegatedTask[]): string | undefined {
  if (message.length > COMPANY_ASK_CHARS) return undefined
  let rest = message
  const named = employees(bots).filter(bot => bot.name.trim().length >= 2).sort((a, b) => b.name.length - a.name.length).filter(bot => { const cut = rest.replace(new RegExp(escaped(bot.name.trim()) + AFTER_NAME, 'gu'), ' '); const hit = cut !== rest; rest = cut; return hit })
  const left = rest.replace(/[\s,]+/g, '').replace(/[?？!.~]+$/u, ''), bot = named[0]
  if (named.length !== 1 || !bot || !ABOUT.slice(0, 3).some(ask => ask.test(left))) return undefined
  const jobs = tasks.flatMap(task => (task.team?.members ?? []).filter(m => m.botId === bot.id).map(m => ({ m, open: task.state === 'running' || task.state === 'waiting', at: m.finishedAt ?? task.updatedAt })))
  const what = (brief: string): string => clip((handedFrom(brief)?.brief ?? brief).split('\n')[0]!, 50)
  const now = tasks.find(task => task.botId === bot.id && (task.state === 'running' || task.state === 'queued'))?.goal ?? jobs.find(job => job.open && BUSY.includes(job.m.state))?.m.brief
  const did = [...new Set([...tasks.filter(task => task.botId === bot.id && task.state === 'done').map(task => ({ at: task.updatedAt, what: what(task.goal) })), ...jobs.filter(job => job.m.state === 'done' || job.m.state === 'released').map(job => ({ at: job.at, what: what(job.m.brief) }))].sort((a, b) => b.at.localeCompare(a.at)).map(one => one.what))].slice(0, 3)
  const label = bot.label!.trim(), role = bot.purpose?.trim()
  return [
    `${josa(bot.name.trim(), '은', '는')} ${josa(label, '이에요', '예요')}.${role && role !== label ? ` ${clip(role, 150)}` : ''}`,
    now ? `지금은 이 일을 하고 있어요: ${what(now)}` : did.length ? '지금은 쉬고 있어요. 최근에 한 일:' : '아직 맡은 일은 없어요.',
    ...(did.length ? [...(now ? ['최근에 한 일:'] : []), ...did.map(one => `- ${one}`)] : []),
  ].join('\n')
}

// Recurring work is an ordinary schedule and needs only the schedule tool; what the team did is in its record (in the lane prompt): both finish in the lane.
const REPEATS = /매주|매일|매달|매월|평일마다|주말마다|[월화수목금토일]요일\s*마다/u
const AT_TIME = /\d{1,2}\s*시|\d{1,2}:\d{2}|아침|오전|오후|점심|저녁|밤|정오|자정/u
const DUTIES = /^(내|제|우리|지금|현재|정기|예약된|잡힌|\s)*(일정|스케줄|정기\s*(업무|보고)|예약)(은|이|들)?\s*(뭐|뭐가|뭐뭐|어떤\s*게|어떤\s*거|목록)?\s*(있어|있나|있니|있지|알려\s*줘|보여\s*줘)요?[?？!.~\s]*$/u
/** Something to do regularly at a time ("매주 월요일 아침 9시에 ... 정리해줘"), or the question what is kept ("내 일정 뭐 있어?"). */
export function isDutyAsk(message: string): boolean {
  if (message.length > COMPANY_ASK_CHARS) return false
  return (REPEATS.test(message) && AT_TIME.test(message)) || DUTIES.test(message.trim())
}
const FILE_WORK = /엑셀|excel|ppt|파워포인트|pdf|워드|파일|문서|메일|보고서|자료|고쳐|수정/iu
const THE_TEAM = /팀|다들|모두|에이전트/u
// "한 일" as its own words ("정한 일" is not it); the report words are what schedules kept before the team was flat ask for.
const TEAM_WORK = /(?<![가-힣])한\s*(일|거|것)|했던\s*일|뭐\s*했|뭘\s*했|주간\s*보고|월간\s*보고|일일\s*보고/u
/** What the team did, asked as words ("이번 주 팀이 한 일 요약해"): answered from the team's record. A file to make or change is not one. */
export function isTeamWorkAsk(message: string): boolean {
  return message.length <= COMPANY_ASK_CHARS && !FILE_WORK.test(message) && THE_TEAM.test(message) && TEAM_WORK.test(message)
}

// Sending, posting or messaging outside, or an app named as the place to put something ("슬랙에", not 슬랙 as a subject to research): the lane has no such tool, and the normal path has it with its approval gate.
const OUTSIDE = /(슬랙|slack|노션|notion|메일|gmail|카톡|카카오톡|문자|디스코드|discord|텔레그램|telegram|팀즈|teams|트위터|인스타|인스타그램|페이스북|링크드인|블로그|유튜브|게시판|채널|단톡방?|드라이브|drive|깃허브|github|지라|jira|컨플루언스|confluence|캘린더|calendar)\s*(에|으로|로)(?!서)|(?<!내)보내|전송|발송|게시|포스팅|트윗|공유|(에|으로|로)\s*(올려|올리|업로드|등록)/iu
export const isOutsideAsk = (message: string): boolean => OUTSIDE.test(message)

/** Whether a message takes the team lane (small menu, fast tier). Going outside is checked before every lane matcher: the lane cannot post, so a sentence that names an outside place keeps the normal path (which has schedule too), even when it also sets a regular time. */
export function takesCompanyLane(message: string, who: { staff: readonly string[]; gone?: readonly string[]; chief: boolean; scheduled?: boolean }): boolean {
  if (isOutsideAsk(message)) return false
  if (who.chief && !who.scheduled && isDutyAsk(message)) return true
  return (who.chief && (isAssignAsk(message, who.staff) || isTeamWorkAsk(message) || !!plainHire(message))) || isCompanyAsk(message, [...who.staff, ...(who.gone ?? [])], who.chief)
}

export const TEAM_MEMORY = '_team'
/** The one team's record. Records kept per group before the team was flat (`_team-<folder id>`) are read with it: nothing is moved or deleted. */
export async function teamRecord(paths: VaultPaths): Promise<BotMemoryFile> {
  const ids = (await memoryIds(paths)).filter(id => id === TEAM_MEMORY || id.startsWith(`${TEAM_MEMORY}-`))
  const all = mergeMemory(...await Promise.all(ids.map(id => loadBotMemory(paths, id))))
  return { facts: all.facts, turns: all.turns }
}

/** The team for a prompt, with what each agent named in the message remembers and last did ("who is 지우" needs no tool), and the team's record when the message asks what the team did. */
export async function companyNote(paths: VaultPaths, input: { bots: readonly Bot[]; message: string; tasks?: readonly DelegatedTask[]; chief: boolean; now?: Date }): Promise<string> {
  const staff = employees(input.bots)
  if (!staff.length && !input.chief) return ''
  const lines = [input.chief
    ? 'The person works with one flat team of agents by chat: each agent below is a bot of its own, all equal, and the person is directly over all of them. You are the one they talk to. Do a change to the team (add, rename, remove, bring back) with ONE agents call for the whole sentence: no question, no confirmation, and never mention bots, tools or the sidebar. Hand work to agents with ONE assign call for the whole sentence (wait false when the person just hands a job off, wait true when they want the result in this answer); someone named who is not on the team yet is added by that same call, and you never do an assigned part yourself. Something to be done regularly or later ("매주 월요일 9시에 AI 뉴스 정리해줘") is kept with ONE schedule add call; "내 일정 뭐 있어?" asks what is kept (schedule list): one line each, when and what. Answer questions about who someone is or what they do from the lines below with no tool call. Short and natural, in the person\'s language, with no titles, ranks or office talk.'
    : 'The person works with a team of agents by chat; each agent below is a bot of its own. Answer questions about who someone is or what they do from these lines with no tool call, short and natural, in the person\'s language.']
  lines.push(staff.length ? 'Team now:' : 'Team now: nobody yet.')
  for (const bot of staff) {
    lines.push(`- ${bot.name} — ${bot.label!.trim()}. How they work: ${clip(bot.purpose || bot.label!, 300)}`)
    if (!input.message.includes(bot.name.trim())) continue
    const memory = renderMemory(await loadBotMemory(paths, bot.id), input.now)
    const recent = (input.tasks ?? []).filter(task => task.botId === bot.id && task.state === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    if (memory) lines.push(`  What ${bot.name} remembers (their own memory, most recent work included):`, ...memory.split('\n').map(line => `  ${line}`))
    if (recent.length) lines.push(`  ${bot.name}'s recent finished work:`, ...recent.map(task => `  - ${task.updatedAt.slice(0, 10)}: ${clip(task.goal, 120)}`))
    if (!memory && !recent.length) lines.push(`  ${bot.name} has no finished work on record yet; say so rather than inventing any.`)
  }
  if (isTeamWorkAsk(input.message)) {
    const memory = renderMemory(await teamRecord(paths), input.now)
    lines.push(memory
      ? `The team's record (one line per finished job: what was asked → what came back, with who did it and the day). Answer from these lines with no tool call unless the person wants more than is here, and cite each point by its agent and day, like "(지민, 11-16)":\n${memory.split('\n').map(line => `  ${line}`).join('\n')}`
      : 'The team has no finished work on record yet; say so rather than inventing any.')
  }
  return lines.join('\n')
}

// --- Handing work to agents (assign) ---

export interface AssignHost extends TeamHost {
  /** Starts these members without waiting for them: the lead's turn may end first, and their report comes back as a turn of its own. */
  later(ids: string[]): Promise<void>
  /** Gives a handoff to the job this agent is doing right now in this thread; false when they are not on one. */
  attach(botId: string, then: NonNullable<TeamMember['then']>): Promise<boolean>
}

/** What the next agent is told when a result is handed to them. job: the brief the earlier agent worked from, so the report can say what their facts were for. */
export const handoffBrief = (brief: string, from: string, result: string, job = ''): string => {
  const what = clip((handedFrom(job)?.brief ?? job).split('\n')[0]!.replace(/[()]/g, ' '), 80)
  return `${brief}\n\nHanded over by ${from}${what ? ` (their job: ${what})` : ''}. Work from this result, and keep the facts and source addresses you use from it in your own result:\n${result}`
}
const HANDED = /\n\nHanded over by (.+?)(?: \(their job: ([^)\n]*)\))?\. Work from this result[^\n]*:\n/
/** A handoff brief taken apart again: what was asked, who handed over, what their job was and what they found. */
export function handedFrom(brief: string): { brief: string; from: string; job: string; result: string } | undefined {
  const at = HANDED.exec(brief)
  return at ? { brief: brief.slice(0, at.index), from: at[1]!, job: at[2] ?? '', result: brief.slice(at.index + at[0].length) } : undefined
}

/** Who the agent is, added to the member persona: they work as themselves, with their own role and memory. */
export async function employeeNote(paths: VaultPaths, botId: string, now?: Date): Promise<string> {
  const bot = (await loadBots(paths)).find(one => one.id === botId)
  if (!bot) return ''
  const memory = renderMemory(await loadBotMemory(paths, botId), now)
  return ` You are ${bot.name}${bot.label?.trim() ? `, ${bot.label.trim()}` : ''}, one of the agents on the person's team; the lead is the one the person talks to and passes your result on. Your role: ${clip(bot.purpose || bot.label || bot.name, 600)} ${MEMO_RULE}${memory ? `\nWhat you remember from your earlier work:\n${memory}` : ''}`
}

// grokbar C3: three reports of 10-20 lines each took the lead 10 s to merge and the merged answer had no table and no link.
const MEMO_RULE = 'Answer like a short memo, in the person\'s language: the findings first, at most four short lines when you only looked things up (a date with each when the page gives one), then the address of each page they came from. No preamble, no headings, no offers.'

/** A finished job goes on the agent's own record: the brief and the result in their conversation, one dated line in their memory and in the team's. No model is asked. */
export async function employeeWriteBack(paths: VaultPaths, job: { botId: string; brief: string; result: string }, now = new Date(), /** The agent's own conversation has a turn under way. */ busy: () => boolean = () => false): Promise<void> {
  const bots = await loadBots(paths), bot = bots.find(one => one.id === job.botId)
  if (!bot) return
  const at = now.toISOString()
  // Ends on the name and the day, so the line is never read as a question, a label or the bot's own "…했습니다" (notAFact).
  const what = clip(job.brief.split('\n')[0]!.replace(/^[#|<`\s]+/, ''), 40), tail = ` (${bot.name}, ${at.slice(0, 10)})`
  const line = `${what} → ${clip(job.result, 150 - Array.from(what).length - tail.length)}${tail}`
  await recordFacts(paths, bot.id, [line], now)
  await recordFacts(paths, TEAM_MEMORY, [line], now)
  // The pair goes in whole and never inside the agent's own exchange: it waits for their turn to end, and both appends are queued in the
  // same tick as the last check, so a turn that starts afterwards writes behind them.
  // shortcut: polls and is not kept across a quit (the memory lines above already are); persist the pending pair if that loss ever matters.
  while (busy()) await new Promise(resolve => setTimeout(resolve, WRITE_BACK_POLL_MS))
  await Promise.all([appendBotTurn(paths, bot.id, { role: 'user', text: job.brief, at }), appendBotTurn(paths, bot.id, { role: 'assistant', text: job.result, at })])
}
const WRITE_BACK_POLL_MS = 500

// --- One merged report, written here and not by a model (GROKBOT rule 7) ---
// grokbar C3 (stack1): the lead's merge round took 11 s and gave three sections with no link; the check turn that
// followed because of that ran another 90 s. Reports that are words only are put together by the host: one table, one row per
// employee with their name and a link, a missing part said in its row. C6: a handoff's report keeps the facts it was made from.
const ADDRESS = /https?:\/\/[^\s)\]>"'|]+/g
const pagesOf = (text: string, read: readonly string[] = []): string[] => [...new Set([...(text.match(ADDRESS) ?? []), ...read].map(url => url.replace(/[.,;:!?]+$/, '')))]
const linkTo = (url: string): string => { try { return `[${new URL(url).host.replace(/^www\./, '')}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})` } catch { return '' } }
const linksOf = (pages: readonly string[], max: number): string => pages.map(linkTo).filter(Boolean).slice(0, max).join(' · ')
// A report as one table cell: its lines side by side, no addresses (they go in the source cell), no list or table marks.
const inCell = (text: string): string => clip(text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(ADDRESS, '').split('\n')
  .map(line => line.replace(/^\s*(?:[-*•>#]+|\d+[.)])\s*/, '').replace(/\*\*|`/g, '').replace(/\|/g, '/').trim())
  .filter(line => line && !/^[\s/:-]+$/.test(line) && !/^(출처|sources?)\s*[:：]?$/i.test(line)).join(' · '), 320)
// What an agent delivered; '' when they delivered nothing ("Failed: ..." is the host's own note, never shown).
// settleMember's closing note for a result cut short is the host's own wording for the lead ("시간 한도에서 멈춤"); the person reads a colleague's.
const CUT_SHORT = /\n\((?:[^()\n]*한도에서 멈춤[^()\n]*|stopped at [^()\n]*)\)$/
const delivered = (m: TeamMember): string => m.state === 'failed' || m.state === 'hired' || m.state === 'working' || !m.result?.trim() || m.result.startsWith('Failed: ') ? '' : m.result.trim().replace(CUT_SHORT, '\n(여기까지만 찾았어요)')
const NOTHING = '조사하지 못했어요.'

/** The agents' results as the one answer the person reads. topics: member id to the short name of its part ("노션"). */
export function mergedReport(members: readonly TeamMember[], topics: ReadonlyMap<string, string> = new Map(), hired: readonly string[] = []): string {
  // A result that was handed on is shown under the agent who finished it, not as a row of its own.
  const passedOn = (m: TeamMember): boolean => !!m.then && members.some(next => next !== m && handedFrom(next.brief)?.from === m.role && !!delivered(next))
  const parts = members.filter(m => !passedOn(m))
  if (!parts.length) return hired.join('\n')
  const lead = (line: string): string => [...hired, line].join('\n')
  if (parts.length > 1 && !parts.some(m => handedFrom(m.brief))) {
    const rows = parts.map(m => {
      const said = delivered(m), topic = topics.get(m.id)?.replace(/[|()]/g, ' ').trim()
      // Two columns on purpose: the thread shows a table of three or more columns as a stack of cards, not as a table.
      return `| ${topic ? `${topic} (${m.role})` : m.role} | ${said ? [inCell(said) || NOTHING, linksOf(pagesOf(said, m.sources), 2)].filter(Boolean).join(' · ') : NOTHING} |`
    })
    return `${lead(`${parts.map(m => m.role).join(', ')} 결과예요.`)}\n\n| 맡은 일 (담당) | 내용과 출처 |\n|---|---|\n${rows.join('\n')}`
  }
  return parts.map((m, i) => {
    const said = delivered(m), from = handedFrom(m.brief)
    const head = `${m.role} 결과예요.${from ? ` ${from.from}한테 받은 내용으로 했어요.` : ''}`
    const body = said || `${m.role}: ${NOTHING}`
    const facts = from ? `${from.from}한테 받은 내용${from.job ? ` (${from.job})` : ''}:\n${from.result.trim()}` : ''
    const shown = [body, facts].filter(Boolean).join('\n\n')
    // An address written out is already a link in the thread; one the agent only read is added.
    const pages = shown.search(ADDRESS) >= 0 ? '' : linksOf(pagesOf('', m.sources), 3)
    return [i ? head : lead(head), shown, pages ? `출처: ${pages}` : ''].filter(Boolean).join('\n\n')
  }).join('\n\n')
}

/** What a task's background agents brought back, for the person's thread; undefined when one of them needs the person or handed in a file (the lead writes that report). */
export function employeesReport(task: DelegatedTask | undefined): string | undefined {
  const members = (task?.team?.members ?? []).filter(m => m.background && !!m.botId)
  if (!members.length || members.some(m => m.state === 'waiting' || !!m.files?.length || /\]\(engram-artifact:/.test(m.result ?? ''))) return undefined
  return mergedReport(members)
}

const ASSIGN_MAX = 4
const ASSIGN_NOTE = 'Each report is accepted as it is: do not call review_member for it. Give the person ONE merged answer in their language: one lead-in line, then ONE table with a row per part, the first cell naming the part and in parentheses the agent who did it, the last cell that agent\'s source as a markdown link copied from sources or from their result, never a site name alone; a file an agent made is named in their row. No sections per agent, no closing offer or question. Mention anyone in "added" in one short line. Where one agent handed their result to the next, the last result is the deliverable; keep the facts it took from the earlier one. Say plainly which part failed or is missing. ' + SOURCE_TITLES_RULE + ' A report with state waiting needs the person: close with its question, and when they answer pass it with review_member({id, ok:false, note:<answer>}).'

export function assignTool(paths: VaultPaths, host: AssignHost, changed: () => void): AgentTool {
  return {
    name: 'assign',
    // Handing off without waiting is answered by the tool's own line; a waited report is written by the lead.
    // So is a waited report when every part only looks things up: the reply is the merged report itself (mergedReport), with no merge round.
    closes: args => args['wait'] === false || rows(args['to']).every(row => row['make'] !== true),
    description: `Hand work to agents on the person's team by name; each does their part as themselves, with their own role and memory, side by side. ONE call for the whole sentence, 1 to ${ASSIGN_MAX} parts, no question and no confirmation. to: who (the agent's name), brief (their whole part, complete on its own, at most 3 short lines; only what the person asked for), topic (the name of their part in the person's own words, a word or two: "노션"). Someone named who is not on the team yet is added by this same call: give their role (a few words from the sentence, or that fit the part: "리니어 조사 담당"). then {who, brief}: when who finishes, their result goes to this second agent, who does brief with it ("지민 조사 끝나면 서연한테 넘겨서 ..."); leave the first brief out to hand over the work that agent is on now or last finished. make true only for a part that creates or changes a file or acts on a page; otherwise the part is a fast read-only lookup. wait false when the person just hands the job off ("맡겨", "시켜 놔"): the reply is shown to the person as your answer and ends the turn, and the result comes back here by itself when the work is done. wait true when they want the result in this answer ("조사해서 알려줘"): when no part has make, the reply is the merged answer itself, shown to the person as your answer, and ends the turn; with a make part it returns every result for you to merge.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['to', 'wait'],
      properties: {
        to: { type: 'array', minItems: 1, maxItems: ASSIGN_MAX, items: { type: 'object', additionalProperties: false, required: ['who'], properties: { who, brief: who, topic: who, role: who, make: { type: 'boolean' }, then: { type: 'object', additionalProperties: false, required: ['who', 'brief'], properties: { who, brief: who, role: who } } } } },
        wait: { type: 'boolean' },
      },
    },
    async run(args, context) {
      const wait = args['wait'] !== false
      const parts = rows(args['to']).map(row => {
        const next = typeof row['then'] === 'object' && row['then'] !== null ? row['then'] as Record<string, unknown> : undefined
        return { who: said(row['who'], 60), brief: String(row['brief'] ?? '').trim().slice(0, 1500), topic: said(row['topic'], 30), title: said(row['role'], BOT_LABEL_CHARS), make: row['make'] === true, ...(next ? { then: { who: said(next['who'], 60), brief: String(next['brief'] ?? '').trim().slice(0, 1500), title: said(next['role'], BOT_LABEL_CHARS) } } : {}) }
      })
      if (!parts.length || parts.length > ASSIGN_MAX) throw new Error(`to needs 1 to ${ASSIGN_MAX} parts, each with who and brief.`)
      if (parts.some(part => !part.who || (!part.brief && !part.then) || (part.then && (!part.then.who || !part.then.brief)))) throw new Error('Each part needs who and brief; then needs who and brief.')
      const active = await loadBots(paths), gone = await loadArchivedBots(paths)
      const staff = new Map(active.filter(bot => !bot.primary).map(bot => [bot.name.trim(), bot]))
      const refused: string[] = [], hiring = new Map<string, string>()
      for (const one of parts.flatMap(part => [part, ...(part.then ? [part.then] : [])])) {
        if (staff.has(one.who) || hiring.has(one.who)) continue
        if (active.some(bot => bot.primary && bot.name.trim() === one.who)) refused.push(`${one.who}한테는 맡길 수 없어요. 팀원 이름을 알려 주세요.`)
        else if (gone.some(bot => bot.name.trim() === one.who)) refused.push(REMOVED(one.who))
        else hiring.set(one.who, one.title || ('topic' in one && one.topic ? `${one.topic} 담당`.slice(0, BOT_LABEL_CHARS) : '팀원'))
      }
      // Work handed over with no new brief comes from the job they are on now, or else the last one they finished.
      // Only work done in this thread (the lead's with the person): a result from another conversation is never passed on.
      const thread = (await host.load())?.botId
      const tasks = parts.some(part => !part.brief) && thread ? (await listTasks(paths)).filter(task => task.botId === thread) : []
      const lastJob = (botId: string): TeamMember | undefined => tasks.flatMap(task => task.team?.members ?? [])
        .filter(m => m.botId === botId && (m.state === 'done' || m.state === 'released') && m.review?.ok !== false && !!m.result && !m.result.startsWith('Failed: '))
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))[0]
      for (const part of parts) if (!part.brief && !staff.has(part.who)) refused.push(`${josa(part.who, '이', '가')} 끝낸 일이 아직 없어서 넘길 게 없어요.`)
      if (refused.length) return [...new Set(refused)].join('\n')

      const lines: string[] = []
      for (const [name, title] of hiring) {
        const bot = await createBot(paths, { name, purpose: title })
        staff.set(name, await updateBot(paths, bot.id, { label: title }))
        lines.push(`${josa(name, '은', '는')} ${ro(title)} 새로 추가했어요.`)
      }
      if (hiring.size) changed()

      const wanted: { bot: Bot; brief: string; topic: string; make: boolean; then?: NonNullable<TeamMember['then']> }[] = []
      for (const part of parts) {
        const bot = staff.get(part.who)!, next = part.then ? { botId: staff.get(part.then.who)!.id, who: part.then.who, brief: part.then.brief } : undefined
        if (part.brief) { wanted.push({ bot, brief: part.brief, topic: part.topic, make: part.make, ...(next ? { then: next } : {}) }); continue }
        if (await host.attach(bot.id, next!)) { lines.push(`${bot.name} 일이 끝나면 ${next!.who}한테 넘길게요.`); continue }
        const last = lastJob(bot.id)
        if (!last) return [...lines, `${josa(bot.name, '이', '가')} 끝낸 일이 아직 없어서 넘길 게 없어요.`].join('\n')
        wanted.push({ bot: staff.get(next!.who)!, brief: handoffBrief(next!.brief, bot.name, last.result!, last.brief), topic: part.topic, make: part.make })
      }
      if (!wanted.length) return lines.join('\n')
      const out = await host.change((task): { refuse: string } | { ids: string[] } => {
        const team = task.team ?? { members: [], hires: 0, maxHires: TEAM_MAX_HIRES, maxDepth: TEAM_MAX_DEPTH, big: false }
        if (task.state !== 'running' || team.hires + wanted.length > team.maxHires) return { refuse: '지금은 더 맡길 수 없어요. 하던 일이 끝난 뒤에 다시 말해 주세요.' }
        task.team = team
        const at = new Date().toISOString()
        const ids = wanted.map(one => {
          const id = `m${team.members.length + 1}`
          team.members.push({ id, parentId: null, depth: 1, role: one.bot.name, brief: one.brief, botId: one.bot.id, ...(one.make ? {} : { lookup: true as const }), ...(wait ? {} : { background: true as const }), ...(one.then ? { then: one.then } : {}), state: 'hired', sessionKey: `team-${task.id}-${id}`, hiredAt: at })
          return id
        })
        team.hires += ids.length
        logTask(task, `Assigned ${wanted.map(one => one.bot.name).join(', ')}`)
        return { ids }
      })
      if (!out || 'refuse' in out) return [...lines, out?.refuse ?? '지금은 맡길 수 없어요. 다시 말해 주세요.'].join('\n')
      const handed = wanted.map(one => `${one.bot.name}한테 맡겼어요.${one.then ? ` 끝나면 ${one.then.who}한테 넘길게요.` : ''}`)
      if (!wait) { await host.later(out.ids); return [...lines, ...handed].join('\n') }

      await host.run(out.ids, context.signal)
      // Everyone this call started, with whoever a result was handed on to (added after them while they ran).
      const mine = (members: readonly TeamMember[]) => members.slice(members.findIndex(m => m.id === out.ids[0])).filter(m => m.parentId === null && !!m.botId)
      // An agent's report stands as their own: nobody reviews it, and the lead says whose it is.
      const settled = await host.change(task => mine(task.team?.members ?? []).filter(m => m.state === 'done' || m.state === 'failed').map(m => { m.review ??= { ok: m.state === 'done', note: 'auto: employee report' }; return m.id })) ?? []
      await host.release(settled)
      const team = (await host.load())?.team, reports = mine(team?.members ?? [])
      const asking = reports.filter(m => m.state === 'waiting')
      if (asking.length && !reports.some(m => m.result && m.review?.ok)) return formatAsk(asking.map(m => `${m.role}: ${m.result ?? ''}`).join('\n'), [])
      // Words only: the host's own merge is the answer (the call closed the turn). Someone still asking is said in their own line.
      if (wanted.every(one => !one.make)) {
        const topics = new Map(out.ids.flatMap((id, i) => wanted[i]!.topic ? [[id, wanted[i]!.topic] as const] : []))
        return [mergedReport(reports.filter(m => m.state !== 'waiting'), topics, lines), ...asking.map(m => `${m.role}: ${m.result ?? ''}`)].join('\n\n')
      }
      return JSON.stringify({
        ...(lines.length ? { added: lines } : {}),
        reports: reports.map(m => ({ who: m.role, state: m.review ? (m.review.ok ? 'done' : 'failed') : m.state, result: m.result ?? '', ...(m.sources?.length ? { sources: m.sources } : {}), ...(m.files?.length ? { files: m.files } : {}), ...(m.state === 'waiting' ? { id: m.id, ask: m.result ?? '' } : {}) })),
        note: ASSIGN_NOTE,
      })
    },
  }
}
