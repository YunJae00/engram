import { describe, expect, it } from 'vitest'
import { toastApp, toastFrom, toastUse, type Toast } from '../src/toasts.js'

const paths = {
  'ms-teams': 'C:\\Program Files\\WindowsApps\\MSTeams_25198.1112.3855.1505_x64__8wekyb3d8bbwe\\ms-teams.exe',
  codex: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1020.1.0_x64__2p2nqsd0c76g0\\app\\Codex.exe',
  outlook: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE',
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
}
const toast = (app: string, aumid: string): Toast => ({ id: aumid, app, aumid, at: '2026-10-25T01:00:00.000Z', title: 't', text: '' })

describe('which app sent a notification', () => {
  it('finds a store app by its package folder, under the program name its windows carry', () => {
    expect(toastApp(toast('Microsoft Teams', 'MSTeams_8wekyb3d8bbwe!MSTeams'), paths)).toBe('ms-teams')
    // An app may show itself under another name than its program's.
    expect(toastApp(toast('ChatGPT', 'OpenAI.Codex_2p2nqsd0c76g0!App'), paths)).toBe('codex')
  })

  it('finds a desktop app by the program name in its id, and names the rest as they show', () => {
    expect(toastApp(toast('Outlook', 'Microsoft.Office.OUTLOOK.EXE.15'), paths)).toBe('outlook')
    expect(toastApp(toast('Google Chrome', 'Chrome'), paths)).toBe('chrome')
    expect(toastApp(toast('Slack', 'com.squirrel.slack.slack'), paths)).toBe('slack')
    expect(toastApp(toast('Claude', 'Claude_pzs8sxrjxfjjc!Claude'), paths)).toBe('claude')
  })

  it('counts each app once under one key, and matches the name a request uses', () => {
    const use = toastUse([toast('Microsoft Teams', 'MSTeams_8wekyb3d8bbwe!MSTeams'), toast('Microsoft Teams', 'MSTeams_8wekyb3d8bbwe!MSTeams'), toast('Claude', 'Claude_pzs8sxrjxfjjc!Claude')], paths)
    expect([...use]).toEqual([['ms-teams', { label: 'Microsoft Teams', count: 2 }], ['claude', { label: 'Claude', count: 1 }]])
    const teams = toast('Microsoft Teams', 'MSTeams_8wekyb3d8bbwe!MSTeams')
    expect(toastFrom(teams, 'ms-teams', 'Teams')).toBe(true)
    expect(toastFrom(teams, 'ms-teams', 'ms-teams')).toBe(true)
    expect(toastFrom(teams, 'ms-teams', 'Outlook')).toBe(false)
  })
})
