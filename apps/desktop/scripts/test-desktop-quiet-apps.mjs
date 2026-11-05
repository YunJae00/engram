import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { nativeProbe, appPatterns, appMatches } from './quiet-app-probe.mjs'

if (process.argv.includes('--self-test')) {
  assert(appMatches({ name: 'Claude' }, /claude/i))
  assert(appMatches({ name: 'Window', aliases: ['com.openai.chat'] }, /com\.openai\.chat/))
  assert(!appMatches({ name: 'Other app' }, /outlook/i))
  assert(!appMatches({ title: 'Claude document', aliases: ['TextEdit'] }, /claude/i))
  assert.equal(new Set(appPatterns.map(([name]) => name)).size, 5)
  console.log(JSON.stringify({ selfTest: 'passed' }))
  process.exit(0)
}

const configIndex = process.argv.indexOf('--safe-targets')
const safeTargets = configIndex < 0 ? {} : JSON.parse(await readFile(process.argv[configIndex + 1], 'utf8'))
const keys = process.argv.includes('--keys')
const actions = keys ? ['Enter', 'Control+Enter', 'Escape', 'Tab', 'Shift+Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] : ['read', 'set', 'find-send', 'menu', 'scroll']
const helper = nativeProbe()
const emit = row => console.log(JSON.stringify(row))
let catalog = [], windows = [], unavailable
try {
  await helper.ready
  catalog = await helper.request('listApps')
  try { windows = (await helper.request('listWindows')).windows } catch (error) { unavailable = String(error) }
  for (const [app, pattern] of appPatterns.filter(([name]) => !(!keys && ['Notepad', 'TextEdit'].includes(name)))) {
    const installed = catalog.some(item => appMatches(item, pattern))
    const config = safeTargets[app]
    let window = [...windows].sort((a, b) => (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) - (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0)).find(item => appMatches(item, pattern) && (!config?.window || item.window === String(config.window)))
    for (const action of actions) {
      const started = performance.now()
      let foregroundChanged = null
      try {
        if (!installed) throw new Error('not_installed')
        if (unavailable) throw new Error(unavailable)
        if (!window) throw new Error('No running app window; open a safe empty target in the background before measuring')
        if (window.foreground) throw new Error('Target is foreground; inactive-window measurement requires a background target')
        if (window.minimized || window.hidden) throw new Error('Target hidden or minimized; no window state was changed')
        const target = { window: window.window, pid: window.pid }
        const before = windows.find(item => item.foreground)?.window
        const scan = await helper.request('quietScan', { ...target, ...(action === 'find-send' ? { find: config?.sendName ?? 'Send' } : {}) })
        let receipt = scan
        if (!['read', 'find-send'].includes(action)) {
          const safe = config?.safe === (app === 'Outlook' ? 'draft' : app === 'Teams' ? 'self-chat' : ['TextEdit', 'Notepad'].includes(app) ? 'empty-document' : 'new-chat')
          if (!safe) throw new Error('No verified safe target configuration; provide --safe-targets with window and safe:new-chat/self-chat/draft/empty-document')
          const field = scan.controls.find(item => item.can.set && /TextArea|TextField|Edit|Document/.test(item.type) && !item.secret && item.enabled && !item.offscreen && !item.value?.trim())
          if (action === 'set' || keys) {
            if (!field) throw new Error('No empty editable control; existing text was preserved')
            // Key probes use an empty editor so Enter cannot submit a message.
            receipt = await helper.request(keys ? 'quietPress' : 'quietSet', { ...target, snapshot: scan.snapshot, control: field.id, ...(keys ? { key: action } : { text: 'Engram quiet lane probe' }) })
          } else {
            const control = scan.controls.find(item => action === 'menu' ? item.can.press && /^(menu|more|more options)$/i.test(item.name) : item.can.scroll)
            if (!control) throw new Error(`No quiet ${action} provider control`)
            receipt = await helper.request('quietPress', { ...target, snapshot: scan.snapshot, control: control.id, ...(action === 'scroll' ? { action: 'scroll_down' } : {}) })
          }
        }
        windows = (await helper.request('listWindows')).windows
        foregroundChanged = receipt.foregroundChanged === true || before !== windows.find(item => item.foreground)?.window
        const ok = action === 'find-send' ? scan.controls.length > 0 : receipt.landed !== false && receipt.satisfied !== false
        emit({ app, action, ok: ok && !foregroundChanged, lane: 'quiet', ms: Math.round(performance.now() - started), foregroundChanged, reason: ok ? (foregroundChanged ? 'Provider changed foreground; stopped' : 'observed') : receipt.message ?? (scan.searchComplete === true ? 'No send control' : 'search did not reach the whole app') })
        if (foregroundChanged) { window = undefined; break }
      } catch (error) {
        emit({ app, action, ok: false, lane: 'quiet', ms: Math.round(performance.now() - started), foregroundChanged, reason: String(error).replace(/^Error: /, '') })
      }
    }
  }
} catch (error) {
  for (const [app] of appPatterns) for (const action of actions) emit({ app, action, ok: false, lane: 'quiet', ms: 0, foregroundChanged: null, reason: String(error) })
} finally { helper.close() }
