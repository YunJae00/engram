import type { AgentTool } from './agent-loop.js'
import { BOT_LABEL_CHARS } from './bot-fields.js'
import { loadBotMemory, renderMemory } from './bot-memory.js'
import { archiveBot, createBot, loadArchivedBots, loadBots, restoreBot, updateBot, type Bot } from './bots.js'
import { listTasks, type DelegatedTask } from './delegated-tasks.js'
import { changeSidebarLayout, readSidebarLayout } from './sidebar-layout.js'
import type { VaultPaths } from './vault.js'

// The person runs a company by chat: they are the CEO, the primary bot is their chief of staff, and an employee is a
// bot with a job title (label). A team is a sidebar folder. Nothing here has a screen of its own.
export const employees = (bots: readonly Bot[]): Bot[] => bots.filter(bot => bot.primary !== true && !!bot.label?.trim())

// Korean particles follow the last syllable's final consonant; a name that does not end in Hangul is read as having none.
const tail = (word: string): number => { const code = word.trim().charCodeAt(word.trim().length - 1) - 0xac00; return code >= 0 && code <= 11171 ? code % 28 : 0 }
const josa = (word: string, closed: string, open: string): string => `${word}${tail(word) ? closed : open}`
const ro = (word: string): string => `${word}${tail(word) && tail(word) !== 8 ? '으로' : '로'}`

const said = (value: unknown, max: number): string => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter((one): one is Record<string, unknown> => typeof one === 'object' && one !== null) : []
const names = (value: unknown): string[] => Array.isArray(value) ? value.map(one => said(one, 60)).filter(Boolean) : []

const who = { type: 'string' } as const

export function staffTool(paths: VaultPaths, changed: () => void): AgentTool {
  return {
    name: 'staff',
    closes: true,
    description: 'Manage the person\'s staff (they are the CEO, you are their chief of staff; an employee is a bot of its own). ONE call does the whole sentence, with no confirmation and no question: hire (name in their words, title = the job title they gave such as "리서치 담당", role = what the employee does and how, complete enough to work alone; team to also put them in a team), rename (who = current name; name for a new name or promotion, title/role only if they change; identity, memory and history are kept), fire (let go: hidden but kept, never deleted), rehire (bring back someone let go), team (create the team if it is new and put the members in it; members are names, including ones hired in this same call). The reply is shown to the person as your answer and ends the turn; add nothing.',
    argsSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        hire: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'title'], properties: { name: who, title: who, role: who, team: who } } },
        rename: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['who'], properties: { who, name: who, title: who, role: who } } },
        fire: { type: 'array', items: who },
        rehire: { type: 'array', items: who },
        team: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: who, members: { type: 'array', items: who } } } },
      },
    },
    async run(args) {
      const active = await loadBots(paths), gone = await loadArchivedBots(paths)
      // Who holds each name once the whole call has run; null is someone this call hires.
      const held = new Map<string, Bot | null>(active.map(bot => [bot.name.trim(), bot]))
      const refused: string[] = [], nobody = (name: string) => `${josa(name, '이라는', '라는')} 직원은 없어요.`
      const taken = (name: string) => `${josa(name, '이라는', '라는')} 이름은 이미 쓰고 있어요. 다른 이름을 알려 주세요.`

      const firing: Bot[] = []
      for (const name of names(args['fire'])) {
        const bot = held.get(name)
        if (!bot) refused.push(nobody(name))
        else if (bot.primary) refused.push('비서실장은 내보낼 수 없어요.')
        else { firing.push(bot); held.delete(name) }
      }
      const returning: Bot[] = []
      for (const name of names(args['rehire'])) {
        const bot = gone.filter(one => one.name.trim() === name).at(-1)
        if (!bot) refused.push(`내보낸 직원 중에 ${josa(name, '은', '는')} 없어요.`)
        else if (held.has(name)) refused.push(taken(name))
        else { returning.push(bot); held.set(name, bot) }
      }
      const renaming: { bot: Bot; name?: string; title?: string; role?: string }[] = []
      for (const row of rows(args['rename'])) {
        const from = said(row['who'], 60), bot = held.get(from)
        const name = said(row['name'], 60), title = said(row['title'], BOT_LABEL_CHARS), role = String(row['role'] ?? '').trim().slice(0, 2000)
        if (!bot) { refused.push(nobody(from)); continue }
        if (name && name !== from) {
          if (held.has(name)) { refused.push(taken(name)); continue }
          held.delete(from); held.set(name, bot)
        }
        renaming.push({ bot, ...(name && name !== from ? { name } : {}), ...(title && title !== bot.label ? { title } : {}), ...(role ? { role } : {}) })
      }
      const teams = new Map<string, string[]>()
      const hiring: { name: string; title: string; role: string }[] = []
      for (const row of rows(args['hire'])) {
        const name = said(row['name'], 60), title = said(row['title'], BOT_LABEL_CHARS), team = said(row['team'], 80)
        if (!name || !title) throw new Error('hire needs a name and a job title for each person.')
        if (held.has(name)) refused.push(taken(name))
        else if (gone.some(one => one.name.trim() === name)) refused.push(`${josa(name, '은', '는')} 전에 내보낸 직원이에요. "${name} 다시 불러와"라고 하면 돌아와요.`)
        else { hiring.push({ name, title, role: String(row['role'] ?? '').trim().slice(0, 2000) || title }); held.set(name, null) }
        if (team) teams.set(team, [...(teams.get(team) ?? []), name])
      }
      for (const row of rows(args['team'])) {
        const name = said(row['name'], 80)
        if (!name) throw new Error('a team needs a name.')
        teams.set(name, [...new Set([...(teams.get(name) ?? []), ...names(row['members'])])])
      }
      for (const members of teams.values()) for (const name of members) if (!held.has(name)) refused.push(nobody(name))
      if (!firing.length && !returning.length && !renaming.length && !hiring.length && !teams.size && !refused.length) throw new Error('nothing to do: give hire, rename, fire, rehire or team.')
      // All or nothing: a sentence that cannot be done whole changes nothing, and the person is told why.
      if (refused.length) return [...new Set(refused)].join('\n')

      const lines: string[] = []
      for (const bot of firing) { await archiveBot(paths, bot.id); lines.push(`${josa(bot.name, '을', '를')} 내보냈어요. 기록은 남겨 뒀으니 다시 부르면 돌아와요.`) }
      for (const bot of returning) { await restoreBot(paths, bot.id); lines.push(`${josa(bot.name, '이', '가')} 돌아왔어요.`) }
      for (const { bot, name, title, role } of renaming) {
        if (!name && !title && !role) continue
        await updateBot(paths, bot.id, { ...(name ? { name } : {}), ...(title ? { label: title } : {}), ...(role ? { purpose: role } : {}) })
        const now = [name, title].filter(Boolean).join(', ')
        lines.push(now ? `${josa(bot.name, '은', '는')} 이제 ${josa(now, '이에요', '예요')}.` : `${name ?? bot.name}의 역할을 바꿨어요.`)
      }
      const ids = new Map<string, string>()
      for (const { name, title, role } of hiring) {
        const bot = await createBot(paths, { name, purpose: role })
        await updateBot(paths, bot.id, { label: title })
        ids.set(name, bot.id)
        lines.push(`${josa(name, '을', '를')} ${ro(title)} 뽑았어요.`)
      }
      if (teams.size) {
        const chat = (await loadBots(paths)).map(bot => bot.id), layout = await readSidebarLayout(paths, { chat })
        for (const [team, members] of teams) {
          let folder = layout.chat.folders.find(one => one.name === team)
          const made = !folder
          if (!folder) folder = (await changeSidebarLayout(paths, { kind: 'chat', change: { action: 'create-folder', name: team } }, { chat })).chat.folders.filter(one => one.name === team).at(-1)
          const into = folder!.id
          for (const name of members) await changeSidebarLayout(paths, { kind: 'chat', change: { action: 'move-item', id: ids.get(name) ?? held.get(name)!.id, folder: into } }, { chat })
          const list = members.join(', ')
          lines.push(made ? (list ? `${josa(team, '을', '를')} 만들고 ${josa(list, '을', '를')} 넣었어요.` : `${josa(team, '을', '를')} 만들었어요.`) : `${team}에 ${josa(list, '을', '를')} 넣었어요.`)
        }
      }
      changed()
      return lines.join('\n')
    },
  }
}

const clip = (text: string, max: number): string => { const line = text.replace(/\s+/g, ' ').trim(); return Array.from(line).length > max ? `${Array.from(line).slice(0, max).join('')}…` : line }
const BUSY = ['hired', 'working', 'reviewing']

// One line per employee, from stored tasks alone: no model is asked. `doing` is the host's live last step for a bot, when it has one.
export function companyStatus(bots: readonly Bot[], tasks: readonly DelegatedTask[], doing: (botId: string) => string | undefined = () => undefined): string {
  const staff = employees(bots)
  if (!staff.length) return '아직 직원이 없어요. "김대리 뽑아줘. 리서치 담당이야"처럼 말하면 바로 뽑을게요.'
  return staff.map(bot => {
    const own = tasks.filter(task => task.botId === bot.id)
    // An employee also works as a member of someone else's task (assigned by the chief of staff).
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
    name: 'company_status',
    closes: true,
    description: 'What every employee is doing right now, one line each (working on what, waiting, or idle with their last job). Use when the person asks what the staff or a team is doing. The reply is shown to the person as your answer and ends the turn.',
    argsSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: async () => companyStatus(await loadBots(paths), await listTasks(paths), doing),
  }
}

// A closed list on purpose: these are answered without a model, so only a message that is nothing but the status question matches.
const STATUS_ASKS = [
  /^(다들|모두|전부|직원들?|팀원들?|애들|지금 누가)\s*(지금\s*)?(뭐|뭘|무슨\s*일)\s*(하고\s*있(어|어요|나|나요|니|습니까)|해|해요|하니|하나요|하는\s*중(이야|이에요|인가요)?)$/u,
  /^(직원|회사|팀)?\s*현황(\s*(알려|보여)\s*(줘|주세요))?$/u,
  /^status$/i,
  /^what(['’]s| is) every(one|body) doing$/i,
]
export function isStatusAsk(message: string): boolean {
  const line = message.replace(/\s+/g, ' ').trim().replace(/[\s?？!.~]+$/u, '')
  return line.length <= 40 && STATUS_ASKS.some(ask => ask.test(line))
}

// The company lane's whole menu: few enough that the session preloads it (no tool search round).
export const COMPANY_LANE_TOOLS: ReadonlySet<string> = new Set(['staff', 'company_status', 'schedule', 'hire_members', 'review_member', 'team_status', 'search_web', 'read_pages', 'search_chats', 'search_memory', 'read_note', 'ask_person', 'keep_in_mind'])

export const COMPANY_ASK_CHARS = 200
// The lane has no file, office or browser tools, so it takes only sentences it can finish: a roster change or a question about who someone is or
// what they are doing. Anything that reads like work stays on the normal path, which is slower but has every tool (and the same staff tool).
const WORK = /엑셀|excel|ppt|파워포인트|pdf|워드|파일|문서|자료|보고|메일|요약|정리|조사|검색|번역|작성|문구|고쳐|수정|맡겨|맡기|넘겨|한테|에게|매주|매일|마다/iu
const HIRE = /뽑아|뽑고|채용|고용/u
// A hire names a person to be: a head count, a duty, or a job title standing as a word ("박사원", not "과장된").
const PERSON = /직원|사람|팀원|인턴|담당|[한두세네\d]\s*명|(사원|주임|대리|과장|차장|부장|팀장)(?=$|[\s,.!?]|[을를이가은는도랑과와]|하고|으로)/u
const CHANGE = /내보내|해고|승진|다시\s*(불러|데려)|복직|(이름|직함|직급|호칭).{0,12}바꿔/u
const NEW_TEAM = /팀\s*(을|를)?\s*(하나\s*)?(새로\s*)?만들/u
// What is left of a question once the names are taken out, spaces removed. Whole-string matches only.
const ABOUT = [
  /^(지금|요즘|최근에?|이번주에?|오늘)?(뭐|뭘|무슨일|어떤일|무슨업무|어떤업무)(을|를)?(해|하니|하나|하고있어|하고있나|하는중이야|하는중이에|하는(사람|직원|팀|분)(이야|이에|인가|이니|입니까)?|했어|했나|맡고있어|맡았어|담당해|담당하고있어)요?$/u,
  /^(누구|어떤(사람|직원|팀|분)|무슨(사람|팀))(야|이야|예요|이에요|인가요|니|입니까)?$/u,
  /^(담당|역할|직함|직급|업무|하는일|맡은일)(이|은|는|가)?(뭐|뭔데|무엇)(야|예요|지|죠|인가요|니)?$/u,
  /^(현황|상태|근황)(은|이)?(알려줘|보여줘|어때|뭐야)?요?$/u,
  /^(누구누구|누가|누구)(있어|있나|있니|있지)요?$/u,
]
const MOVE = /^(옮겨|넣어|이동시켜|빼)(줘|줘요|주세요)?$/u
const ROSTER = /^(우리|지금|현재|회사)*(직원|팀원|사원|팀)(들|이|은|는)*(누구누구|누가|누구|몇명|뭐|목록|명단|리스트)(있어|있나|있니|이야|야|보여줘|알려줘)?요?$/u
const AFTER_NAME = '(님|씨)?(에서|으로|이랑|하고|랑|과|와|은|는|이|가|도|을|를|의|로|에)?'
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A short roster or status sentence: hire, promote or rename, let go, bring back, make or change a team, or "who is X / what is X doing". A work request that only names staff is not one. When unsure, false. */
export function isCompanyAsk(message: string, known: readonly string[], chief: boolean): boolean {
  if (message.length > COMPANY_ASK_CHARS) return false
  const names = [...new Set(known.map(name => name.trim()).filter(name => name.length >= 2))].sort((a, b) => b.length - a.length)
  let rest = message, named = 0
  for (const name of names) { const cut = rest.replace(new RegExp(escaped(name) + AFTER_NAME, 'gu'), ' '); if (cut !== rest) { named++; rest = cut } }
  const left = rest.replace(/[\s,]+/g, '').replace(/[?？!.~]+$/u, '')
  if (named && ABOUT.some(ask => ask.test(left))) return true
  if (!chief) return false
  if (ROSTER.test(left) || (named >= 2 && MOVE.test(left))) return true
  if (WORK.test(message)) return false
  return NEW_TEAM.test(message) || (HIRE.test(message) && PERSON.test(rest)) || (CHANGE.test(message) && (named > 0 || PERSON.test(rest)))
}

/** The roster for a prompt, with what each employee named in the message remembers and last did: "who is 김과장" needs no tool. */
export async function companyNote(paths: VaultPaths, input: { bots: readonly Bot[]; message: string; teams?: ReadonlyMap<string, string>; tasks?: readonly DelegatedTask[]; chief: boolean; now?: Date }): Promise<string> {
  const staff = employees(input.bots)
  if (!staff.length && !input.chief) return ''
  const lines = [input.chief
    ? 'The person runs a company by chat: they are the CEO, you are their chief of staff, and each employee below is a bot of its own. Do a staffing request (hire, promote or rename, let go, bring back, make a team) with ONE staff call for the whole sentence: no question, no confirmation, and never mention bots, tools or the sidebar. Answer questions about who someone is or what they do from the lines below with no tool call. Speak as a chief of staff would to their CEO: short, natural, in the person\'s language.'
    : 'The person runs a company by chat: they are the CEO and each employee below is a bot of its own. Answer questions about who someone is or what they do from these lines with no tool call, short and natural, in the person\'s language.']
  lines.push(staff.length ? 'Staff now:' : 'Staff now: nobody yet.')
  for (const bot of staff) {
    const team = input.teams?.get(bot.id)
    lines.push(`- ${bot.name} — ${bot.label!.trim()}${team ? ` (team ${team})` : ''}. Role: ${clip(bot.purpose || bot.label!, 300)}`)
    if (!input.message.includes(bot.name.trim())) continue
    const memory = renderMemory(await loadBotMemory(paths, bot.id), input.now)
    const recent = (input.tasks ?? []).filter(task => task.botId === bot.id && task.state === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5)
    if (memory) lines.push(`  What ${bot.name} remembers (their own memory, most recent work included):`, ...memory.split('\n').map(line => `  ${line}`))
    if (recent.length) lines.push(`  ${bot.name}'s recent finished work:`, ...recent.map(task => `  - ${task.updatedAt.slice(0, 10)}: ${clip(task.goal, 120)}`))
    if (!memory && !recent.length) lines.push(`  ${bot.name} has no finished work on record yet; say so rather than inventing any.`)
  }
  return lines.join('\n')
}
