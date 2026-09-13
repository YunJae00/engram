import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { SidebarKind, SidebarLayout } from '../src/shared/types.js'
import { SidebarCollection } from '../src/renderer/src/components/SidebarCollection.js'

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useLayoutEffect: react.useEffect }
})

function render(kind: SidebarKind, layout: SidebarLayout[SidebarKind]) {
  return renderToStaticMarkup(createElement(SidebarCollection, {
    kind, layout, newFolder: 0, items: layout.items.map(item => ({ id: item.id, name: item.id })),
    onChange: vi.fn(), onOpen: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), onError: vi.fn(),
  }))
}

it('shows pins first inside their own folder, preserves manual order within groups, and leaves saved order intact', () => {
  const layout: SidebarLayout['chat'] = {
    folders: [{ id: 'work', name: 'Work' }],
    items: [
      { id: 'root-normal', folder: null }, { id: 'filed-normal', folder: 'work' },
      { id: 'filed-pin', folder: 'work', pinned: true }, { id: 'root-pin', folder: null, pinned: true },
      { id: 'filed-pin-two', folder: 'work', pinned: true },
    ],
  }
  const before = JSON.stringify(layout), html = render('chat', layout)
  const order = [...html.matchAll(/data-testid="bot-([^"]+)"/g)].map(match => match[1])
  expect(order).toEqual(['filed-pin', 'filed-pin-two', 'filed-normal', 'root-pin', 'root-normal'])
  expect(html.indexOf('bot-filed-normal')).toBeLessThan(html.indexOf('data-testid="sidebar-chats"'))
  expect(html.match(/aria-label="Pinned conversation"/g)).toHaveLength(3)
  expect(html.match(/data-pinned="true"/g)).toHaveLength(3)
  expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(6)
  expect(JSON.stringify(layout)).toBe(before)
})

it('renders no idle drop instructions and does not pin or reorder routines', () => {
  const html = render('routine', {
    folders: [{ id: 'empty', name: 'Empty' }],
    items: [{ id: 'first', folder: null }, { id: 'second', folder: null, pinned: true }],
  })
  expect(html).not.toContain('Drop here')
  expect(html).not.toContain('Move out of folders')
  expect(html).not.toContain('Pinned conversation')
  expect(html.indexOf('sidebar-routine-run-first')).toBeLessThan(html.indexOf('sidebar-routine-run-second'))
})
