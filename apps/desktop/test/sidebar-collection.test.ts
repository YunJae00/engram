import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import type { SidebarLayout } from '../src/shared/types.js'
import { SidebarCollection } from '../src/renderer/src/components/SidebarCollection.js'

vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useLayoutEffect: react.useEffect }
})

function render(layout: SidebarLayout['chat'], recency: Record<string, number> = {}, hidden: string[] = []) {
  const item = (id: string) => ({ id, name: id, recency: recency[id] ?? 0, content: id })
  return renderToStaticMarkup(createElement(SidebarCollection, {
    layout, items: layout.items.map(one => item(one.id)), hidden: hidden.map(item),
    onChange: vi.fn(async () => undefined), onOpen: vi.fn(), onError: vi.fn(),
  }))
}

it('lists every bot in its group by latest activity, ignores old pins, and leaves the saved layout intact', () => {
  const layout: SidebarLayout['chat'] = {
    folders: [{ id: 'work', name: 'Work' }],
    items: [
      { id: 'root-normal', folder: null }, { id: 'filed-normal', folder: 'work' },
      { id: 'filed-pin', folder: 'work', pinned: true }, { id: 'root-pin', folder: null, pinned: true },
      { id: 'filed-pin-two', folder: 'work', pinned: true },
    ],
  }
  const before = JSON.stringify(layout)
  const html = render(layout, { 'filed-normal': 5, 'filed-pin': 3, 'filed-pin-two': 1, 'root-normal': 9, 'root-pin': 2 })
  const order = [...html.matchAll(/data-testid="bot-([^"]+)"/g)].map(match => match[1])
  expect(order).toEqual(['filed-normal', 'filed-pin', 'filed-pin-two', 'root-normal', 'root-pin'])
  expect(html.indexOf('bot-filed-normal')).toBeLessThan(html.indexOf('data-testid="sidebar-chats"'))
  expect(html).not.toContain('Pinned conversation')
  expect(html).not.toContain('data-pinned')
  expect(JSON.stringify(layout)).toBe(before)
})

it('offers no menus, rename fields or drag handles: rows open a chat and groups fold, nothing else', () => {
  const html = render({ folders: [{ id: 'empty', name: 'Empty' }], items: [{ id: 'first', folder: null }, { id: 'second', folder: null, pinned: true }] }, {}, ['tucked'])
  for (const gone of ['aria-haspopup', 'draggable', '<input', 'sidebar-more', 'Drop here', 'Move out of folders', 'sidebar-rename']) expect(html).not.toContain(gone)
  expect(html.match(/<button/g)).toHaveLength(4)
  expect(html).toContain('data-tree-item="hidden"')
})
