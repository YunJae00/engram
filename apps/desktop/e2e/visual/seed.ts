import { formatAsk, initVault, type Bot, type BotTurn, type SidebarLayout } from 'core'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PRIMARY_ID = 'vis-primary'
export const CHAT_ID = 'vis-chat'
const CREATED = '2026-01-05T09:00:00.000Z'

const BOTS: Bot[] = [
  { id: PRIMARY_ID, name: 'Sun', purpose: 'Keeps the whole team on track.', createdAt: CREATED, primary: true, avatar: { body: 0, face: 0, accessory: 0, palette: 0 } },
  { id: CHAT_ID, name: 'Garden planner', purpose: 'Plans the spring garden.', createdAt: CREATED, avatar: { body: 1, face: 1, accessory: 0, palette: 1 } },
  { id: 'vis-budget', name: 'Budget review', purpose: 'Checks the monthly numbers.', createdAt: CREATED, avatar: { body: 2, face: 0, accessory: 1, palette: 2 } },
  { id: 'vis-hidden', name: 'Old archive', purpose: 'Kept out of the sidebar.', createdAt: CREATED, hidden: true },
  { id: 'vis-new', name: 'New helper', purpose: 'Has not been asked anything yet.', createdAt: CREATED },
  { id: 'vis-routine', name: 'Weekly report', purpose: 'Writes the Friday report.', createdAt: CREATED, tasks: [{ id: 'vis-task', name: 'Friday report', goal: 'Summarize the week.', lastRunAt: '2026-01-09T17:00:00.000Z' }] },
  { id: 'vis-paused', name: 'Reading list', purpose: 'Collects articles to read.', createdAt: CREATED, notify: 'off', tasks: [{ id: 'vis-paused-task', name: 'Morning digest', goal: 'Collect new articles.', paused: true }] },
]

const TURNS: Record<string, BotTurn[]> = {
  [PRIMARY_ID]: [
    { role: 'user', text: 'What is on the list today?', at: '2026-01-06T08:00:00.000Z' },
    { role: 'assistant', text: 'Three things: the garden plan, the budget review and the weekly report.', at: '2026-01-06T08:00:05.000Z' },
  ],
  [CHAT_ID]: [
    { role: 'user', text: 'Plan the spring planting for the back garden.', at: '2026-01-06T09:00:00.000Z' },
    { role: 'assistant', text: 'Here is a first plan: tulips along the fence in March, tomatoes in the raised bed in May, and herbs by the door.', at: '2026-01-06T09:00:06.000Z' },
    { role: 'user', text: 'Add a small vegetable patch near the shed.', at: '2026-01-07T10:30:00.000Z' },
    { role: 'assistant', text: formatAsk('Which vegetables should go in the patch?', ['Lettuce and radish', 'Beans and peas']), at: '2026-01-07T10:30:04.000Z' },
  ],
  'vis-budget': [
    { role: 'user', text: 'Check the January numbers.', at: '2026-01-08T14:00:00.000Z' },
    { role: 'assistant', text: 'January spending is within the plan; groceries ran slightly over.', at: '2026-01-08T14:00:07.000Z' },
  ],
  'vis-routine': [
    { role: 'assistant', text: 'The weekly report is ready in your notes.', at: '2026-01-09T17:00:10.000Z', scheduled: true },
  ],
  'vis-paused': [
    { role: 'user', text: 'Pause the morning digest for now.', at: '2026-01-04T07:00:00.000Z' },
    { role: 'assistant', text: 'Paused. Say the word when you want it back.', at: '2026-01-04T07:00:03.000Z' },
  ],
}

const LAYOUT: SidebarLayout = {
  chat: {
    folders: [{ id: 'vis-folder-home', name: 'Home' }, { id: 'vis-folder-money', name: 'Money' }],
    items: BOTS.map(bot => ({ id: bot.id, folder: bot.id === CHAT_ID ? 'vis-folder-home' : bot.id === 'vis-budget' ? 'vis-folder-money' : null })),
  },
  routine: { folders: [], items: [] },
}

export async function seedVisualVault(root: string): Promise<{ primaryId: string; chatId: string }> {
  const paths = await initVault(root, { git: false })
  await writeFile(join(paths.cache, 'bots.json'), `${JSON.stringify({ version: 2, bots: BOTS, dismissed: [] }, null, 2)}\n`)
  await writeFile(join(paths.cache, 'sidebar-layout.json'), `${JSON.stringify(LAYOUT, null, 2)}\n`)
  await mkdir(join(paths.cache, 'bot-chats'), { recursive: true })
  for (const [id, turns] of Object.entries(TURNS)) await writeFile(join(paths.cache, 'bot-chats', `${id}.jsonl`), turns.map(turn => JSON.stringify(turn)).join('\n') + '\n')
  return { primaryId: PRIMARY_ID, chatId: CHAT_ID }
}
