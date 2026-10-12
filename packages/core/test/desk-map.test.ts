import { describe, expect, it } from 'vitest'
import { appLabel, appsNote, DESK_NOTES, DESK_TYPE, downloadsNote, filesNote, parseUserAssist } from '../src/desk-map.js'
import { NOTE_ID_PATTERN } from '../src/id.js'

const now = new Date('2026-10-12T09:00:00Z')
const rot13 = (text: string) => text.replace(/[a-z]/gi, ch => String.fromCharCode((ch <= 'Z' ? 65 : 97) + (ch.toLowerCase().charCodeAt(0) - 97 + 13) % 26))
function record(name: string, runs: number, focusMs: number, lastRun?: Date): string {
  const data = Buffer.alloc(72)
  data.writeUInt32LE(runs, 4)
  data.writeUInt32LE(focusMs, 12)
  if (lastRun) data.writeBigUInt64LE((BigInt(lastRun.getTime()) + 11_644_473_600_000n) * 10_000n, 60)
  return `    ${rot13(name)}    REG_BINARY    ${data.toString('hex').toUpperCase()}`
}

describe('the desk this computer already records', () => {
  it('reads app usage, merges one app recorded several ways, and leaves out installers and the shell', () => {
    const output = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{CEBFF5CD}\\Count',
      record('UEME_CTLSESSION', 1, 0),
      record('{6D809377-6AF0-444B-8957-A3773F02200E}\\Microsoft Office\\root\\Office16\\EXCEL.EXE', 10, 3_600_000, new Date('2026-10-10T08:00:00Z')),
      record('Microsoft.Office.EXCEL.EXE.15', 2, 600_000, new Date('2026-10-11T08:00:00Z')),
      record('Chrome.work.Default', 5, 7_200_000),
      record('C:\\Users\\me\\Downloads\\Tool Setup.exe', 1, 1000),
      record('Microsoft.Windows.ShellExperienceHost_cw5n1h2txyewy!App', 3, 5000),
      record('dev.engram.app', 0, 0),
      '    Version    REG_DWORD    0x5',
    ].join('\r\n')
    expect(parseUserAssist(output)).toEqual([
      { name: 'Chrome', runs: 5, focusMs: 7_200_000 },
      { name: 'EXCEL', runs: 12, focusMs: 4_200_000, lastRun: Date.parse('2026-10-11T08:00:00Z') },
    ])
  })

  it('names apps from paths, app ids and browser profiles', () => {
    expect(appLabel('{GUID}\\WindowsApps\\Claude_2.1_x64__pzs8sxrjxfjjc\\app\\Claude.exe')).toBe('Claude')
    expect(appLabel('Chrome.agentprofile.Default')).toBe('Chrome')
    expect(appLabel('dev.engram.app')).toBe('engram')
    expect(appLabel('OpenAI.Codex_2p2nqsd0c76g0!App')).toBe('Codex')
  })

  it('writes each source as its own note, keeping what the person added', () => {
    const files = filesNote([
      { path: 'C:\\Work\\Reports\\Q3.xlsx', at: Date.parse('2026-10-10T00:00:00Z') },
      { path: 'C:\\Work\\Reports\\Q2.xlsx', at: Date.parse('2026-09-10T00:00:00Z') },
      { path: 'C:\\Users\\me\\Desktop\\memo.docx', at: Date.parse('2026-10-11T00:00:00Z') },
    ], now)!
    expect(files.front).toMatchObject({ id: DESK_NOTES.files, type: DESK_TYPE, status: 'current' })
    expect(files.body).toContain('- C:\\Work\\Reports: 2 files, such as Q3.xlsx, Q2.xlsx')
    expect(files.body.indexOf('memo.docx (2026-10-11)')).toBeLessThan(files.body.indexOf('Q3.xlsx (2026-10-10)'))
    expect(files.body).toContain('Names only; nothing was opened.')
    const edited = { ...files, body: files.body.replace(/## Your notes[^]*$/, '## Your notes\n\nQuarterly reports live here.') }
    expect(filesNote([{ path: 'C:\\Work\\a.xlsx', at: now.getTime() }], new Date('2026-10-13T00:00:00Z'), edited)!.body).toContain('Quarterly reports live here.')

    const apps = appsNote([{ name: 'EXCEL', runs: 12, focusMs: 4_200_000, lastRun: Date.parse('2026-10-11T08:00:00Z') }, { name: 'Idle', runs: 0, focusMs: 0 }], now)!
    expect(apps.body).toContain('- EXCEL: opened 12 times, about 1.2 h in front, last on 2026-10-11')
    expect(apps.body).not.toContain('Idle')

    const downloads = downloadsNote([
      { file: 'timesheet.xlsx', host: 'hr.example.com', at: Date.parse('2026-10-09T00:00:00Z') },
      { file: 'timesheet.xlsx', host: 'hr.example.com', at: Date.parse('2026-10-02T00:00:00Z') },
      { file: 'invoice.pdf', host: 'erp.example.com', at: Date.parse('2026-10-05T00:00:00Z') },
    ], now)!
    expect(downloads.body).toContain('- hr.example.com: 2 files, such as timesheet.xlsx; last on 2026-10-09')
    for (const id of Object.values(DESK_NOTES)) expect(id).toMatch(NOTE_ID_PATTERN)
    expect(filesNote([], now)).toBeNull()
    expect(appsNote([], now)).toBeNull()
    expect(downloadsNote([], now)).toBeNull()
  })
})
