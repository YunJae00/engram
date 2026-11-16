import type { AgentTool } from './agent-loop.js'
import type { AuditEntry } from './audit-log.js'

// What used to be rows on the Settings page is said in chat. One tool, and one closed list of plain Korean
// sentences that are answered without a model. Each answer is one line that says the state as it now is.
//
// The rule every path goes through (settle): a change that narrows what Engram may do is made at once;
// a change that widens it is asked about once, and made only when the person's next message says yes.
// The tool cannot carry the yes itself, so a model cannot widen anything on its own.

export const PREFERENCE_ACTIONS = [
  'auto_start', 'app_activity', 'learn_places', 'learn_files', 'learn_apps', 'rescan_work', 'app', 'habits', 'habit',
  'review_rules', 'ask_first', 'auto_allow', 'activity_log', 'export_logs',
  'backup_connect', 'backup_disconnect', 'backup_now', 'backup_auto', 'computer_control', 'theme',
] as const
export type PreferenceAction = typeof PREFERENCE_ACTIONS[number]
export interface PreferenceAsk { do: PreferenceAction; on?: boolean; name?: string }

export interface PreferenceHost {
  autoStart(on: boolean): Promise<void>
  learning(source: 'activity' | 'places' | 'files' | 'apps', on: boolean): Promise<void>
  rescanWork(): Promise<void>
  // Apps seen on this computer and the ones kept off, by process name and the name the app shows.
  // on: false for one the person keeps out of reach.
  apps(): Promise<{ app: string; label: string; on: boolean }[]>
  setApp(app: string, label: string, on: boolean): Promise<void>
  habits(): Promise<{ key: string; title: string }[]>
  answerHabit(key: string, keep: boolean): Promise<void>
  reviewRules(): Promise<{ kind: 'ask-first' | 'allow'; target: string }[]>
  setReviewRule(kind: 'ask-first' | 'allow', site: string, on: boolean): Promise<void>
  // One audit file, by its UTC day (YYYY-MM-DD).
  audit(day: string): Promise<AuditEntry[]>
  // The name of the folder it wrote, inside Downloads.
  exportLogs(): Promise<string>
  backup: {
    // false: this copy of the app keeps no history to back up.
    available(): boolean
    connected(): Promise<boolean>
    connect(url: string): Promise<{ ok: boolean; detail?: string }>
    disconnect(): Promise<void>
    now(): Promise<void>
    auto(on: boolean): Promise<void>
  }
  stopComputerControl(): void
  theme(theme: 'system' | 'light' | 'dark'): Promise<void>
}

const tail = (word: string): number => { const code = word.trim().charCodeAt(word.trim().length - 1) - 0xac00; return code >= 0 && code <= 11171 ? code % 28 : 0 }
const josa = (word: string, closed: string, open: string): string => `${word}${tail(word) ? closed : open}`

const SOURCE = { app_activity: 'activity', learn_places: 'places', learn_files: 'files', learn_apps: 'apps' } as const
const SOURCE_WORDS = { app_activity: '앱 활동', learn_places: '자주 가는 사이트', learn_files: '최근 파일', learn_apps: '쓰는 앱' } as const
const THEME_WORDS = { system: '시스템 설정을 따르는 화면', light: '밝은 화면', dark: '어두운 화면' } as const

// The site a person named, as the host a rule is kept under.
export function siteOf(typed: string): string | undefined {
  const value = typed.trim()
  try {
    const url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`)
    return /^https?:$/.test(url.protocol) && url.hostname.includes('.') ? url.hostname.toLowerCase() : undefined
  } catch { return undefined }
}

// Widening: Engram may see, use or send more than before. Everything else narrows or changes nothing a gate guards.
export function widens(ask: PreferenceAsk): boolean {
  switch (ask.do) {
    case 'app_activity': case 'learn_places': case 'learn_files': case 'learn_apps': case 'app': case 'auto_allow': return ask.on === true
    // Taking an ask-first rule away removes a gate.
    case 'ask_first': return ask.on === false
    case 'backup_connect': return true
    default: return false
  }
}

function question(ask: PreferenceAsk): string {
  const name = ask.name?.trim() ?? ''
  switch (ask.do) {
    case 'app_activity': case 'learn_places': case 'learn_files': case 'learn_apps': return `${josa(SOURCE_WORDS[ask.do], '을', '를')} 다시 참고할까요?`
    case 'app': return `${josa(name, '을', '를')} 다시 써도 될까요?`
    case 'auto_allow': return `${name}에서는 묻지 않고 바로 제출해도 될까요?`
    case 'ask_first': return `${name}에서 먼저 여쭤보는 규칙을 없앨까요?`
    default: return `${name}에 백업을 연결할까요? 노트가 그 저장소로 올라가요.`
  }
}

// The person's day runs midnight to midnight where they are; the audit files are kept by UTC day.
async function dayEntries(host: PreferenceHost, now: Date, back: number): Promise<AuditEntry[]> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  const files = [...new Set([start, new Date(end.getTime() - 1)].map(date => date.toISOString().slice(0, 10)))]
  return (await Promise.all(files.map(file => host.audit(file)))).flat().filter(entry => { const at = Date.parse(entry.at); return at >= start.getTime() && at < end.getTime() })
}

// What the bots did on one day, from the audit files: who, how much, where, and what was asked first.
export function activityLine(entries: readonly AuditEntry[], when: '오늘' | '어제'): string {
  const lead = when === '오늘' ? '오늘은' : '어제는'
  if (!entries.length) return `${lead} 아직 한 일이 없어요.`
  const who = new Map<string, number>()
  for (const entry of entries) if (entry.kind === 'step') who.set(entry.bot ?? 'Engram', (who.get(entry.bot ?? 'Engram') ?? 0) + 1)
  const sites = [...new Set(entries.flatMap(entry => { try { return entry.url ? [new URL(entry.url)] : [] } catch { return [] } }).filter(url => /^https?:$/.test(url.protocol)).map(url => url.origin))].slice(0, 5)
  const asked = entries.filter(entry => entry.kind === 'approval').length
  const people = [...who].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => `${name} ${count}번`).join(', ')
  return [
    people ? `${lead} ${people} 일했어요.` : `${lead} 살펴보기만 했어요.`,
    ...(sites.length ? [`다녀온 곳: ${sites.map(origin => `[${new URL(origin).hostname}](${origin})`).join(', ')}`] : []),
    ...(asked ? [`먼저 여쭤본 일은 ${asked}번이에요.`] : []),
  ].join('\n')
}

async function apply(host: PreferenceHost, ask: PreferenceAsk, now: Date): Promise<string> {
  const name = ask.name?.trim() ?? '', on = ask.on === true
  switch (ask.do) {
    case 'auto_start':
      await host.autoStart(on)
      return on ? '컴퓨터를 켜면 자동으로 실행할게요.' : '컴퓨터를 켜도 자동으로 실행하지 않을게요.'
    case 'app_activity': case 'learn_places': case 'learn_files': case 'learn_apps':
      await host.learning(SOURCE[ask.do], on)
      return on ? `${josa(SOURCE_WORDS[ask.do], '을', '를')} 다시 참고할게요.` : `${josa(SOURCE_WORDS[ask.do], '은', '는')} 이제 참고하지 않을게요.`
    case 'rescan_work':
      await host.rescanWork()
      return '작업하시는 곳을 다시 살펴볼게요.'
    case 'app': {
      if (!name) return '어떤 앱인지 이름을 알려 주세요.'
      const known = (await host.apps()).find(one => one.label.toLowerCase() === name.toLowerCase() || one.app === name.toLowerCase())
      await host.setApp(known?.app ?? name.toLowerCase(), known?.label ?? name, on)
      return on ? `${josa(known?.label ?? name, '을', '를')} 다시 쓸게요.` : `${josa(known?.label ?? name, '은', '는')} 이제 쓰지 않을게요.`
    }
    case 'habits': {
      const list = await host.habits()
      return list.length ? `알아챈 업무 습관은 ${list.length}가지예요.\n${list.map(one => `- ${one.title}`).join('\n')}` : '아직 알아챈 업무 습관이 없어요.'
    }
    case 'habit': {
      const list = await host.habits()
      const found = list.filter(one => name && one.title.toLowerCase().includes(name.toLowerCase()))
      const one = found.length === 1 ? found[0] : !name && list.length === 1 ? list[0] : undefined
      if (!one) return list.length ? `어떤 습관인지 알려 주세요.\n${list.map(item => `- ${item.title}`).join('\n')}` : '아직 알아챈 업무 습관이 없어요.'
      await host.answerHabit(one.key, on)
      return on ? `"${one.title}" 방식을 기억해 둘게요.` : `"${one.title}"${tail(one.title) ? '은' : '는'} 잊었어요.`
    }
    case 'review_rules': {
      const rules = await host.reviewRules()
      const of = (kind: string) => rules.filter(rule => rule.kind === kind).map(rule => rule.target).join(', ')
      return rules.length ? [of('ask-first') && `항상 먼저 여쭤보는 곳: ${of('ask-first')}`, of('allow') && `묻지 않고 제출하는 곳: ${of('allow')}`].filter(Boolean).join('\n') : '따로 정해 둔 곳은 없어요. 보내거나 제출하기 전에는 늘 먼저 여쭤봐요.'
    }
    case 'ask_first': case 'auto_allow': {
      // No site named: sending and submitting already wait for the person everywhere.
      if (!name && ask.do === 'ask_first' && on) return '보내거나 제출하기 전에는 항상 먼저 여쭤볼게요.'
      const site = siteOf(name)
      if (!site) return '어느 사이트인지 주소를 알려 주세요.'
      await host.setReviewRule(ask.do === 'ask_first' ? 'ask-first' : 'allow', site, on)
      if (ask.do === 'ask_first') return on ? `${site}에서는 제출하기 전에 항상 먼저 여쭤볼게요.` : `${site}에서 먼저 여쭤보는 규칙을 없앴어요.`
      return on ? `${site}에서는 묻지 않고 제출할게요.` : `${site}에서도 제출하기 전에 여쭤볼게요.`
    }
    case 'activity_log': {
      const yesterday = name === 'yesterday'
      return activityLine(await dayEntries(host, now, yesterday ? 1 : 0), yesterday ? '어제' : '오늘')
    }
    case 'export_logs': return `로그를 다운로드 폴더에 내보냈어요. ${await host.exportLogs()}`
    case 'backup_connect': case 'backup_disconnect': case 'backup_now': case 'backup_auto': {
      if (!host.backup.available()) return '이 컴퓨터에서는 백업을 쓸 수 없어요.'
      if (ask.do === 'backup_connect') {
        if (!/github\.com[/:][\w.-]+\/[\w.-]+/i.test(name)) return '백업할 깃허브 저장소 주소를 알려 주세요. 아직 없으면 [깃허브](https://github.com/new?visibility=private)에서 비공개로 하나 만들면 돼요.'
        const result = await host.backup.connect(name)
        return result.ok ? '깃허브 백업을 연결했어요.' : '깃허브에 연결하지 못했어요. 저장소 주소와 로그인을 확인해 주세요.'
      }
      if (!(await host.backup.connected())) return '아직 깃허브 백업이 연결되어 있지 않아요.'
      if (ask.do === 'backup_disconnect') { await host.backup.disconnect(); return '깃허브 백업 연결을 해제했어요. 이미 올라간 내용은 그대로 있어요.' }
      if (ask.do === 'backup_now') { await host.backup.now(); return '깃허브에 백업했어요.' }
      await host.backup.auto(on)
      return on ? '자동 백업을 켰어요.' : '자동 백업을 껐어요.'
    }
    case 'computer_control':
      if (on) return '앱을 직접 다뤄야 할 때 그때 한 번 여쭤볼게요.'
      host.stopComputerControl()
      return '컴퓨터 제어를 멈췄어요.'
    case 'theme': {
      const theme = name === 'dark' || name === 'light' ? name : 'system'
      await host.theme(theme)
      return `${THEME_WORDS[theme]}으로 바꿨어요.`
    }
  }
}

const OFF = /(꺼|끄|끊|하지\s*마|보지\s*마|말아|마세요|마$|해제|중지|그만|안\s*해도|빼)/u
const YES = /^(응|ㅇㅇ|ㅇ|네|넵|예|그래|좋아|맞아|어|웅|해\s*줘|해|그렇게\s*해|허용|허용해|연결해|ok|okay|yes|y|sure)\s*(요|줘|주세요)?$/iu
const NO = /^(아니|아니요|아뇨|ㄴㄴ|안\s*돼|하지\s*마|됐어|취소|no|n|nope)\s*(요)?$/iu
const ASK_MAX = 60
// A second request in the same breath ("…꺼주고, 그리고 …") makes it a turn of its own.
const AND_MORE = /그리고|(주|하|끄|켜)고[,\s]|한\s*다음|다음에/u
const DEICTIC = /^(이|그|저|이런|그런)\s*(앱|프로그램|거|것)?$/u

// A plain sentence that is nothing but one of these asks. Anything else (longer, mixed with other work, or
// about something this list does not name) is left to the model, which has the same tool.
export function preferenceAsk(message: string, apps: readonly string[] = []): PreferenceAsk | undefined {
  const line = message.replace(/\s+/g, ' ').trim().replace(/[\s?？!.~]+$/u, '')
  if (!line || line.includes('\n') || [...line].length > ASK_MAX || AND_MORE.test(line)) return undefined
  const off = OFF.test(line)
  if (/(컴퓨터|맥|pc|노트북|부팅|로그인).{0,10}(켜면|켤\s*때|켜질\s*때|시작하면|시작할\s*때|하면|할\s*때).{0,8}자동(으로)?\s*(실행|시작|켜)|^(engram|엔그램)?\s*자동\s*(실행|시작)\s*(을|를)?\s*(켜|꺼|끄|해제|해\s*줘|하지\s*마)/iu.test(line)) return { do: 'auto_start', on: !off }
  if (/자동\s*백업/u.test(line) && /(켜|꺼|끄|해제|하지\s*마|해\s*줘)/u.test(line)) return { do: 'backup_auto', on: !off }
  if (/(깃허브|github)/iu.test(line) && /백업|연결|연동/u.test(line)) {
    const url = /(https?:\/\/github\.com\/[\w.-]+\/[\w.-]+|git@github\.com:[\w.-]+\/[\w.-]+)/i.exec(line)?.[1]
    if (/(해제|끊어|끊기|끊을|끊고)/u.test(line)) return { do: 'backup_disconnect' }
    if (url || /(연결|연동)\s*(해|하고|좀)/u.test(line)) return { do: 'backup_connect', name: url ?? '' }
    if (/백업\s*(해|좀|지금)/u.test(line)) return { do: 'backup_now' }
  }
  if (/^로그\s*(를|좀)?\s*(파일로\s*)?(내보내|저장해|뽑아)/u.test(line)) return { do: 'export_logs' }
  if (/^(오늘|어제)\s*(은|는)?\s*(뭐|뭘|무슨\s*일(을)?)\s*(했는지|했나|했어|한\s*건지)\s*(기록\s*)?(좀\s*)?(보여|알려)\s*(줘|주세요)$/u.test(line) || /^(오늘|어제)?\s*활동\s*기록\s*(좀\s*)?(보여|알려)\s*(줘|주세요)$/u.test(line)) return { do: 'activity_log', ...(line.startsWith('어제') ? { name: 'yesterday' } : {}) }
  if (/(앱|프로그램)\s*(활동|사용\s*(기록|내역))/u.test(line) && /(기억|기록|보지|보면|수집|저장|참고|학습)/u.test(line)) return { do: 'app_activity', on: !off }
  if (/최근\s*(에\s*연\s*)?파일/u.test(line) && /(참고|기억|보지|학습|살펴)/u.test(line)) return { do: 'learn_files', on: !off }
  if (/(방문\s*기록|브라우저\s*기록|인터넷\s*기록|북마크|즐겨찾기)/u.test(line) && /(참고|기억|보지|학습|살펴)/u.test(line)) return { do: 'learn_places', on: !off }
  if (/(내가\s*)?(쓰는|사용하는)\s*앱/u.test(line) && /(참고|기억|학습)/u.test(line)) return { do: 'learn_apps', on: !off }
  if (/작업\s*(폴더|공간|장소|하는\s*곳).{0,6}다시\s*(살펴|확인|찾아|봐)/u.test(line)) return { do: 'rescan_work' }
  if (/(컴퓨터|앱|화면|마우스)\s*(제어|조작|컨트롤)/u.test(line) && /(꺼|끄|멈춰|중지|하지\s*마|켜|허용)/u.test(line)) return { do: 'computer_control', on: !/(꺼|끄|멈춰|중지|하지\s*마)/u.test(line) }
  const theme = /(다크|어두운)\s*(모드|테마|화면)/u.test(line) ? 'dark' : /(라이트|밝은)\s*(모드|테마|화면)/u.test(line) ? 'light' : /(테마|화면\s*색).{0,8}시스템|시스템\s*(설정|테마).{0,6}(따라|맞춰)/u.test(line) ? 'system' : undefined
  if (theme && /(바꿔|해\s*줘|켜|써|으로|로\s*해|따라|맞춰)/u.test(line)) return { do: 'theme', name: theme }
  if (/(업무\s*)?(습관|일하는\s*방식).{0,10}(뭐|뭘|알려|보여|알고)/u.test(line)) return { do: 'habits' }
  const habit = /^["“']?(.+?)["”']?\s*(습관|방식)\s*(은|는|을|를)?\s*(맞아|기억해|유지해|잊어|틀렸어|지워|아니야)/u.exec(line)
  if (habit?.[1]) return { do: 'habit', name: habit[1].trim(), on: /(맞아|기억해|유지해)/u.test(line) }
  if (/(항상|먼저)\s*(물어|여쭤|확인하)\S*\s*(곳|사이트|규칙).{0,8}(뭐|보여|알려|있어)|^(검토|확인)\s*규칙\s*(좀\s*)?(뭐|보여|알려)/u.test(line)) return { do: 'review_rules' }
  const site = /^(\S+\.\S+?)(에서는|에선|에서|은|는)\s/u.exec(line)
  const host = site?.[1] ? siteOf(site[1]) : undefined
  if (host && /(묻지\s*말고|그냥|바로|자동으로)\s*(제출|보내|진행)/u.test(line)) return { do: 'auto_allow', name: host, on: true }
  if (host && /(물어|여쭤|확인|묻지)/u.test(line)) return /(묻지\s*마|물어보지\s*마|안\s*물어|확인하지\s*마|규칙\s*(은|을|를)?\s*(지워|삭제|없애|해제))/u.test(line) ? { do: 'ask_first', name: host, on: false } : { do: 'ask_first', name: host, on: true }
  if (/(메일|메시지|문자|카톡|뭐든|무엇이든)?\s*(을|를)?\s*보내기\s*전(에|엔|에는)\s*(항상|꼭|반드시|먼저)?\s*(물어|여쭤|확인)/u.test(line)) return { do: 'ask_first', on: true }
  // An app by name: only a name this computer has seen, or one the sentence itself calls an app ("존댓말은 쓰지 마" is not one).
  const app = /^(.+?)\s*(앱)?\s*(은|는|을|를|도)?\s*(이제\s*|다시\s*)?(쓰지\s*마|건드리지\s*마|사용하지\s*마|열지\s*마|써도\s*돼|사용해도\s*돼|건드려도\s*돼)(요|세요)?$/u.exec(line)
  const named = app?.[1]?.trim()
  if (named && !DEICTIC.test(named) && (app?.[2] || apps.some(label => label.toLowerCase() === named.toLowerCase()))) return { do: 'app', name: named, on: !/마(요|세요)?$/u.test(line) }
  return undefined
}

const APP_VERB = /(쓰지\s*마|건드리지\s*마|사용하지\s*마|열지\s*마|써도\s*돼|사용해도\s*돼|건드려도\s*돼)(요|세요)?$/u
const PENDING_MS = 10 * 60_000

export interface Preferences {
  // The answer to a message this module takes whole, or undefined when the turn should go on as usual.
  say(channel: string, message: string): Promise<string | undefined>
  tool(channel: string, korean: () => boolean): AgentTool
}

export function preferences(host: PreferenceHost, clock: () => Date = () => new Date()): Preferences {
  const pending = new Map<string, { ask: PreferenceAsk; at: number }>()
  const failed = '바꾸지 못했어요. 잠시 후 다시 말씀해 주세요.'
  const done = (ask: PreferenceAsk) => apply(host, ask, clock()).catch(() => failed)
  // The one door: a widening is held as a question, everything else is done.
  const settle = async (channel: string, said: PreferenceAsk, typed = false): Promise<string> => {
    pending.delete(channel)
    // A call that leaves `on` out never widens: it reads as off, and for an ask-first rule as keeping the rule.
    const ask: PreferenceAsk = { ...said, on: said.do === 'ask_first' ? said.on !== false : said.on === true }
    if (!widens(ask)) return done(ask)
    if ((ask.do === 'app' || ask.do === 'auto_allow') && !ask.name?.trim()) return done(ask)
    if (ask.do === 'app') {
      // Only an app that is off can be widened; one already in reach needs no question.
      const name = ask.name!.trim().toLowerCase(), held = (await host.apps().catch(() => [])).find(one => one.label.toLowerCase() === name || one.app === name)
      if (!held || held.on) return `${josa(held?.label ?? ask.name!.trim(), '은', '는')} 지금도 쓸 수 있어요.`
    }
    if (ask.do === 'backup_connect' && (!host.backup.available() || !/github\.com[/:][\w.-]+\/[\w.-]+/i.test(ask.name ?? ''))) return done(ask)
    if (ask.do === 'auto_allow' && !siteOf(ask.name ?? '')) return done(ask)
    // What lets something leave later with no question (submitting on a site, notes going to a repository) is settled only on the person's
    // own sentence, where the question they answer is this module's own line. A model's call could be worded to them any way it likes.
    if (!typed && ask.do === 'auto_allow') return `그건 직접 말씀해 주셔야 바꿀 수 있어요. "${siteOf(ask.name ?? '')}에서는 묻지 말고 제출해"라고 말씀해 주세요.`
    if (!typed && ask.do === 'backup_connect') return `백업 연결은 직접 말씀해 주셔야 해요. "깃허브 백업 ${ask.name!.trim()} 로 연결해줘"라고 말씀해 주세요.`
    pending.set(channel, { ask: ask.do === 'auto_allow' ? { ...ask, name: siteOf(ask.name ?? '')! } : ask, at: clock().getTime() })
    return question(pending.get(channel)!.ask)
  }
  return {
    async say(channel, message) {
      const line = message.replace(/\s+/g, ' ').trim().replace(/[\s?？!.~]+$/u, '')
      const held = pending.get(channel)
      if (held) {
        pending.delete(channel)
        if (clock().getTime() - held.at <= PENDING_MS) {
          if (YES.test(line)) return done(held.ask)
          if (NO.test(line)) return '그대로 둘게요.'
        }
      }
      // The app list is read only for a sentence shaped like one about an app.
      const ask = preferenceAsk(message) ?? (APP_VERB.test(line) ? preferenceAsk(message, (await host.apps().catch(() => [])).map(one => one.label)) : undefined)
      return ask ? settle(channel, ask, true) : undefined
    },
    tool: (channel, korean) => ({
      name: 'preferences',
      // In a Korean conversation the line it returns is the whole answer.
      closes: () => korean(),
      description: 'Change or show the person\'s Engram preferences, which have no settings screen: say what they asked in ONE call and give its reply to them as it is (it is already one Korean line; in another language, say the same thing in theirs). do = auto_start (open at login; on) | app_activity (remember which apps they use; on) | learn_places / learn_files / learn_apps (learn from browser history and bookmarks / recently opened files / apps in use; on) | rescan_work (look again at where they work) | app (an app Engram may use or must leave alone; name = the app, on) | habits (list the ways of working it noticed) | habit (name = words from its title; on = keep it, false = forget it) | review_rules (list) | ask_first (always ask before submitting on a site; name = site address, on; on=false removes the rule) | auto_allow (submit on a site without asking; name = site, on) | activity_log (what the bots did; name = "yesterday" for the day before) | export_logs | backup_connect (name = GitHub repository address) | backup_disconnect | backup_now | backup_auto (on) | computer_control (on=false stops it) | theme (name = system | light | dark). When the reply is a question, the change has NOT been made: pass the question on and stop; never call again to answer it yourself.',
      argsSchema: { type: 'object', additionalProperties: false, required: ['do'], properties: { do: { type: 'string', enum: [...PREFERENCE_ACTIONS] }, on: { type: 'boolean' }, name: { type: 'string' } } },
      async run(args) {
        const action = PREFERENCE_ACTIONS.find(one => one === args['do'])
        if (!action) return '그건 여기서 바꿀 수 없어요.'
        return settle(channel, { do: action, ...(typeof args['on'] === 'boolean' ? { on: args['on'] } : {}), ...(typeof args['name'] === 'string' ? { name: args['name'].slice(0, 200) } : {}) })
      },
    }),
  }
}
