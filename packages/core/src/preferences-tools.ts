import type { AgentTool } from './agent-loop.js'
import type { AuditEntry } from './audit-log.js'

export const PREFERENCE_ACTIONS = [
  'auto_start', 'app_activity', 'learn_places', 'learn_files', 'learn_apps', 'rescan_work', 'app', 'habits', 'habit',
  'review_rules', 'ask_first', 'auto_allow', 'activity_log', 'export_logs',
  'backup_connect', 'backup_disconnect', 'backup_now', 'backup_auto', 'computer_control', 'theme',
] as const
type PreferenceAction = typeof PREFERENCE_ACTIONS[number]
export interface PreferenceAsk { do: PreferenceAction; on?: boolean; name?: string }

export interface PreferenceHost {
  autoStart(on: boolean): Promise<void>
  learning(source: 'activity' | 'places' | 'files' | 'apps', on: boolean): Promise<void>
  rescanWork(): Promise<void>
  apps(): Promise<{ app: string; label: string; on: boolean }[]>
  setApp(app: string, label: string, on: boolean): Promise<void>
  habits(): Promise<{ key: string; title: string }[]>
  answerHabit(key: string, keep: boolean): Promise<void>
  reviewRules(): Promise<{ kind: 'ask-first' | 'allow'; target: string }[]>
  setReviewRule(kind: 'ask-first' | 'allow', site: string, on: boolean): Promise<void>
  audit(day: string): Promise<AuditEntry[]>
  exportLogs(): Promise<string>
  backup: {
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

function siteOf(typed: string): string | undefined {
  const value = typed.trim()
  try {
    const url = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`)
    return /^https?:$/.test(url.protocol) && url.hostname.includes('.') ? url.hostname.toLowerCase() : undefined
  } catch { return undefined }
}

export function widens(ask: PreferenceAsk): boolean {
  switch (ask.do) {
    case 'app_activity': case 'learn_places': case 'learn_files': case 'learn_apps': case 'app': case 'auto_allow': return ask.on === true
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

async function dayEntries(host: PreferenceHost, now: Date, back: number): Promise<AuditEntry[]> {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back), end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  const files = [...new Set([start, new Date(end.getTime() - 1)].map(date => date.toISOString().slice(0, 10)))]
  return (await Promise.all(files.map(file => host.audit(file)))).flat().filter(entry => { const at = Date.parse(entry.at); return at >= start.getTime() && at < end.getTime() })
}

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

export interface Preferences {
  tool(ask?: (words: string) => Promise<boolean>): AgentTool
}

export function preferences(host: PreferenceHost, clock: () => Date = () => new Date()): Preferences {
  const failed = '바꾸지 못했어요. 잠시 후 다시 말씀해 주세요.'
  const done = (ask: PreferenceAsk) => apply(host, ask, clock()).catch(() => failed)
  const settle = async (said: PreferenceAsk, confirm?: (words: string) => Promise<boolean>): Promise<string> => {
    const ask: PreferenceAsk = { ...said, on: said.do === 'ask_first' ? said.on !== false : said.on === true }
    if (!widens(ask)) return done(ask)
    if ((ask.do === 'app' || ask.do === 'auto_allow') && !ask.name?.trim()) return done(ask)
    if (ask.do === 'app') {
      const name = ask.name!.trim().toLowerCase(), found = (await host.apps().catch(() => [])).find(one => one.label.toLowerCase() === name || one.app === name)
      if (!found || found.on) return `${josa(found?.label ?? ask.name!.trim(), '은', '는')} 지금도 쓸 수 있어요.`
    }
    if (ask.do === 'backup_connect' && (!host.backup.available() || !/github\.com[/:][\w.-]+\/[\w.-]+/i.test(ask.name ?? ''))) return done(ask)
    if (ask.do === 'auto_allow') { const site = siteOf(ask.name ?? ''); if (!site) return done(ask); ask.name = site }
    return confirm && await confirm(question(ask)).catch(() => false) ? done(ask) : '그대로 둘게요.'
  }
  return {
    tool: confirm => ({
      name: 'preferences',
      description: 'Change or show the person\'s Engram preferences, which have no settings screen: say what they asked in ONE call, then tell them in your own words what it returned. do = auto_start (open at login; on) | app_activity (remember which apps they use; on) | learn_places / learn_files / learn_apps (learn from browser history and bookmarks / recently opened files / apps in use; on) | rescan_work (look again at where they work) | app (an app Engram may use or must leave alone; name = the app, on) | habits (list the ways of working it noticed) | habit (name = words from its title; on = keep it, false = forget it) | review_rules (list) | ask_first (always ask before submitting on a site; name = site address, on; on=false removes the rule) | auto_allow (submit on a site without asking; name = site, on) | activity_log (what the bots did; name = "yesterday" for the day before) | export_logs | backup_connect (name = GitHub repository address) | backup_disconnect | backup_now | backup_auto (on) | computer_control (on=false stops it) | theme (name = system | light | dark). A change that lets Engram do more waits for the person\'s answer on a card; never ask it in chat.',
      argsSchema: { type: 'object', additionalProperties: false, required: ['do'], properties: { do: { type: 'string', enum: [...PREFERENCE_ACTIONS] }, on: { type: 'boolean' }, name: { type: 'string' } } },
      async run(args) {
        const action = PREFERENCE_ACTIONS.find(one => one === args['do'])
        if (!action) return '그건 여기서 바꿀 수 없어요.'
        return settle({ do: action, ...(typeof args['on'] === 'boolean' ? { on: args['on'] } : {}), ...(typeof args['name'] === 'string' ? { name: args['name'].slice(0, 200) } : {}) }, confirm)
      },
    }),
  }
}
