import { describe, expect, it } from 'vitest'
import type { BotDto } from '../src/shared/types.js'
import { en, followSettings, tIn } from '../src/renderer/src/i18n'
import { ko } from '../src/renderer/src/i18n-ko'
import { ko3 } from '../src/renderer/src/i18n-ko-3'
import { botMenuItems } from '../src/renderer/src/lib/sidebarBots.js'

const TABLE: [keyof typeof en, string][] = [
  ['sidebar.sectionUnknown', 'Could not tell which section was created; the bot was not moved.'],
  ['sidebar.routineBrowser', 'Browser task'],
  ['sidebar.routineComet', 'Comet task'],
  ['sidebar.routineSteps', '{n} steps'],
  ['sidebar.routineDone', 'Last run completed'],
  ['sidebar.routinePaused', 'Paused'],
  ['sidebar.routineAttention', 'Needs attention'],
  ['sidebar.searchRoutines', 'Search routines'],
  ['sidebar.searchConversations', 'Search conversations'],
  ['sidebar.clearSearch', 'Clear search'],
  ['sidebar.searchButton', 'Search'],
  ['sidebar.create', 'Create'],
  ['sidebar.newRoutineFolder', 'New routine folder'],
  ['sidebar.newFolder', 'New folder'],
  ['sidebar.newSection', 'New section'],
  ['sidebar.conversations', 'Conversations'],
  ['sidebar.savedRoutines', 'Saved routines'],
  ['sidebar.routines', 'Routines'],
  ['sidebar.bots', 'Bots'],
  ['sidebar.noMatches', 'No matches found'],
  ['sidebar.empty', 'Your conversations will appear here.'],
  ['sidebar.folderName', 'Folder name'],
  ['sidebar.sectionName', 'Section name'],
  ['sidebar.options', 'Options for {name}'],
  ['sidebar.pinned', 'Pinned conversation'],
  ['sidebar.pin', 'Pin'],
  ['sidebar.unpin', 'Unpin'],
  ['sidebar.dropHere', 'Drop here'],
  ['sidebar.unfileFolders', 'Move out of folders'],
  ['sidebar.unfileSections', 'Move out of sections'],
  ['sidebar.hiddenBots', 'Hidden bots ({n})'],
  ['sidebar.moveTo', 'Move to {name}'],
  ['sidebar.moveToNewSection', 'Move to new section'],
  ['sidebar.hide', 'Hide from sidebar'],
  ['sidebar.show', 'Show'],
  ['sidebar.makePrimary', 'Make primary'],
  ['sidebar.waiting', 'Waiting for you'],
  ['sidebar.writing', 'Writing a reply…'],
  ['sidebar.thinking', 'Thinking…'],
  ['sidebar.noAnswer', '{provider} did not answer'],
  ['sidebar.theAi', 'The AI'],
  ['sidebar.couldNotFinish', 'Could not finish'],
  ['sidebar.youSaid', 'You: {text}'],
  ['sidebar.startConversation', 'Start a conversation'],
  ['sidebar.unread', 'Unread activity'],
  ['sidebar.filingUnavailable', 'Filing AI unavailable'],
  ['sidebar.filingPaused', 'Filing is paused. Choose a connected AI for filing in Settings.'],
  ['sidebar.checkingAi', 'Checking AI…'],
  ['sidebar.filingReady', 'Filing ready'],
  ['sidebar.retryFiling', 'Retry filing'],
  ['sidebar.retryFilingHint', 'Retry filing with the selected filing AI'],
  ['sidebar.deleteTitleConversation', 'Delete conversation?'],
  ['sidebar.deleteTitleRoutine', 'Delete routine?'],
  ['sidebar.deleteTitleSection', 'Delete section?'],
  ['sidebar.deleteTitleFolder', 'Delete folder?'],
  ['sidebar.removesConversation', 'This removes the conversation from your library.'],
  ['sidebar.removesRoutine', 'This removes the routine from your library.'],
  ['sidebar.inSection', '{items} in this section. You can keep them in the sidebar or delete them too.'],
  ['sidebar.inFolder', '{items} in this folder. You can keep them in the sidebar or delete them too.'],
  ['sidebar.conversationsOne', '{n} conversation'],
  ['sidebar.conversationsMany', '{n} conversations'],
  ['sidebar.routinesOne', '{n} routine'],
  ['sidebar.routinesMany', '{n} routines'],
  ['sidebar.factsOne', '{n} remembered fact'],
  ['sidebar.factsMany', '{n} remembered facts'],
  ['sidebar.archivedOne', '{n} archived chat'],
  ['sidebar.archivedMany', '{n} archived chats'],
  ['sidebar.deleteSummaryNote', 'Routines and remembered facts are deleted with the bot. Archived chats stay on disk.'],
  ['sidebar.counting', 'Counting what goes with this bot…'],
  ['sidebar.deleteFailed', 'Could not finish deleting. Any remaining items have been kept.'],
  ['sidebar.cancel', 'Cancel'],
  ['sidebar.deleteSectionOnly', 'Delete section only'],
  ['sidebar.deleteFolderOnly', 'Delete folder only'],
  ['sidebar.deleteConversation', 'Delete conversation'],
  ['sidebar.deleteRoutine', 'Delete routine'],
  ['sidebar.deleteSectionAnd', 'Delete section and {items}'],
  ['sidebar.deleteFolderAnd', 'Delete folder and {items}'],
  ['sidebar.notifications', 'Notifications'],
  ['sidebar.notificationsNew', 'Notifications, {n} new'],
  ['sidebar.clearRead', 'Clear read'],
  ['sidebar.clearFailed', 'Could not clear notifications. Try again.'],
  ['sidebar.noticesEmpty', 'Nothing new. Scheduled results and ways of working Engram notices show up here.'],
  ['sidebar.noticeRunning', 'Running…'],
  ['sidebar.scheduled', 'Scheduled'],
  ['sidebar.stopTask', 'Stop “{name}”'],
  ['sidebar.stop', 'Stop'],
  ['sidebar.stopFailed', 'Could not stop it. Try again.'],
  ['sidebar.engramMenu', 'Engram menu'],
  ['sidebar.explore', 'Explore Engram'],
  ['sidebar.workspaces', 'Workspaces'],
  ['sidebar.deleteWorkspace', 'Delete workspace'],
  ['sidebar.deleteWorkspaceNamed', 'Delete workspace {name}'],
  ['sidebar.workspaceMode', 'Workspace mode'],
  ['sidebar.cometsMode', 'Comets mode'],
  ['sidebar.developersMode', 'Developers mode'],
  ['sidebar.developers', 'Developers'],
]

const PINNED_KO: Partial<Record<keyof typeof en, string>> = {
  'sidebar.newSection': '새 섹션',
  'sidebar.sectionName': '섹션 이름',
  'sidebar.unfileSections': '섹션에서 빼기',
  'sidebar.hiddenBots': '숨긴 봇 ({n})',
  'sidebar.moveToNewSection': '새 섹션으로 이동',
  'sidebar.hide': '사이드바에서 숨기기',
  'sidebar.makePrimary': '대표 봇으로 지정',
  'sidebar.deleteTitleSection': '섹션을 삭제할까요?',
  'sidebar.deleteSectionOnly': '섹션만 삭제',
}

// Copy of scripts/verify-scenarios/ui-korean.mjs isOffending and its allowlists.
const ALLOW_PHRASES = ['Claude Code', 'Claude Desktop']
const ALLOW = new Set([
  'Engram', 'Claude', 'ChatGPT', 'Codex', 'OpenAI', 'Gemini', 'Cosmos', 'Orbit', 'GitHub', 'Obsidian',
  'Chrome', 'Edge', 'Brave', 'Windows', 'Mac', 'MCP', 'CLI', 'API', 'URL', 'JSON',
  'PNG', 'JPG', 'JPEG', 'PDF', 'Cmd', 'Ctrl', 'Shift', 'Alt', 'Esc', 'Enter',
])
function isOffending(text: string, phrases: string[]): boolean {
  let rest = text.replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|\s)(?:~?\/|[A-Za-z]:\\)\S+/g, ' ')
  for (const phrase of phrases) rest = rest.split(phrase).join(' ')
  rest = rest.replace(/[A-Za-z]+/g, token => (ALLOW.has(token) ? ' ' : token))
  return /[A-Za-z]{3,}/.test(rest)
}

const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()

async function useLanguage(uiLanguage: 'ko' | 'en') {
  const bridge = {
    onEvent: () => () => undefined,
    settingsGet: async () => ({ uiLanguage }),
  } as unknown as Parameters<typeof followSettings>[0]
  await followSettings(bridge)
}

const bot: BotDto = { id: 'b', name: 'Bot b', purpose: 'purpose b', createdAt: '2026-01-01T00:00:00.000Z' }
const folders = [{ id: 'fa', name: 'Section A' }, { id: 'fb', name: 'Section B' }]

describe('sidebar i18n', () => {
  it('sidebar keys keep the English text and the section rename', () => {
    expect(TABLE).toHaveLength(96)
    for (const [key, value] of TABLE) expect(en[key], key).toBe(value)
    expect(en['sidebar.rename']).toBe('Rename')
    expect(en['sidebar.delete']).toBe('Delete')
    expect(en['topbar.tabBots']).toBe('Comets')
    expect(Object.keys(ko3)).toEqual(TABLE.map(([key]) => key))
  })

  it('every sidebar ko value is Korean and passes the ui-korean rule', () => {
    for (const [key] of TABLE) {
      const value = ko[key]
      expect(value, key).toMatch(/[가-힣]/)
      expect(placeholders(value), key).toEqual(placeholders(en[key]))
      expect(isOffending(value.replace(/\{\w+\}/g, ' '), ALLOW_PHRASES), key).toBe(false)
    }
    for (const [key, value] of Object.entries(PINNED_KO)) expect(ko[key as keyof typeof en], key).toBe(value)
  })

  it('bot menu labels follow the UI language', async () => {
    const runs = botMenuItems(bot, { folder: 'fb', pinned: false }, folders).map(item => item.run)
    await useLanguage('ko')
    const korean = botMenuItems(bot, { folder: 'fb', pinned: false }, folders)
    expect(korean.map(item => item.label)).toEqual([ko['sidebar.rename'], ko['sidebar.pin'], tIn('ko', 'sidebar.moveTo', { name: 'Section A' }), ko['sidebar.moveToNewSection'], ko['sidebar.hide'], ko['sidebar.makePrimary'], ko['sidebar.delete']])
    expect(korean.map(item => item.run)).toEqual(runs)
    await useLanguage('en')
    const english = botMenuItems(bot, { folder: 'fb', pinned: false }, folders)
    expect(english.map(item => item.label)).toEqual(['Rename', 'Pin', 'Move to Section A', 'Move to new section', 'Hide from sidebar', 'Make primary', 'Delete'])
    expect(english.map(item => item.run)).toEqual(runs)
  })
})
