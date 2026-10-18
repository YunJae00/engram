import { expect, it } from 'vitest'
import { noteScript, takeTurnScripts } from '../src/main/turn-scripts.js'

it('keeps the last version of each script a turn ran, and hands them over once', () => {
  noteScript('bot-a', 'PowerShell', { command: '$o = New-Object -ComObject Outlook.Application\n$broken' })
  noteScript('bot-a', 'PowerShell', { command: '$o = New-Object -ComObject Outlook.Application\n$fixed' })
  noteScript('bot-a', 'PowerShell', { command: 'Get-ChildItem attachments' })
  noteScript('bot-a', 'Write', { file_path: 'C:/work/save.ps1', content: 'param($id)' })
  noteScript('bot-a', 'Write', { file_path: 'C:/work/notes.md', content: 'not a script' })
  noteScript('bot-a', 'Read', { file_path: 'C:/work/save.ps1' })
  noteScript('bot-b', 'PowerShell', { command: 'other chat' })
  const scripts = takeTurnScripts('bot-a')
  expect(scripts.map(script => script.name)).toEqual(['command.ps1', 'command-2.ps1', 'save.ps1'])
  expect(scripts[0]!.text).toContain('$fixed')
  expect(takeTurnScripts('bot-a')).toEqual([])
  expect(takeTurnScripts('bot-b')).toHaveLength(1)
})
