import { expect, it } from 'vitest'
import { sessionShape } from '../src/agent-session-shape.js'
import type { Engine, NativeTools } from '../src/engine/types.js'

// grokbar D1/D5/F1: the comet searched the disk for "fixtures/meeting-notes.md", asked to leave the sandbox to move files, and asked
// whether to make a copy of a deck it was told to change. The session rules now say where the person's paths are and which tools do it.
it('tells a comet with its own tools where the workspace is and how files there and document files are read, moved and changed', () => {
  const native = (more: Partial<NativeTools> = {}): NativeTools => ({ cwd: '/vault/workspace/tasks/bot-1', readRoots: [], decide: async () => ({ behavior: 'allow' }), ...more })
  const rules = (options: Parameters<typeof sessionShape>[1]) => sessionShape({ engine: { id: 'claude' } as Engine, tools: [] }, options).system
  const inside = rules({ native: native({ workspace: '/vault/workspace' }) })
  for (const part of ['The person\'s workspace folder is /vault/workspace.', 'instead of searching for it, without asking', 'use file_move, which needs no approval', 'to change a text file they already keep there use your own Edit on its full path, also without asking', 'never ask to run a command outside the sandbox for either', 'Deleting a file of theirs is never done without asking first',
    'changed with file_edit_package under its own file name', 'without asking whether to make a copy', 'A new workbook, charts included, is made with file_create_workbook', 'the application is never started for them', 'unless the person asked to see it there',
    'its receipt is that readback: answer with its link at once']) expect(inside).toContain(part)
  expect(rules({ native: native() })).not.toContain('workspace folder is')
  expect(rules({})).not.toContain('file_move')
  expect(rules({ native: native({ workspace: '/vault/workspace', mode: 'plan' }) })).not.toContain('file_move')
})
