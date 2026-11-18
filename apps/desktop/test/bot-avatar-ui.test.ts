import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { avatarState, BotAvatar, type BotAvatarProps } from '../src/renderer/src/components/BotAvatar.js'
import { defaultCharacter } from '../src/renderer/src/lib/botAvatar.js'

const SRC = join(__dirname, '../src')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const render = (props: Partial<BotAvatarProps>) => renderToStaticMarkup(createElement(BotAvatar, { id: 'bot-x', size: 36, state: 'idle', theme: 'light', ...props }))

describe('bot avatar ui', () => {
  it('state from row status; one orb with badges', () => {
    expect(avatarState('ready')).toBe('idle')
    expect(avatarState('running')).toBe('working')
    expect(avatarState('waiting')).toBe('attention')
    expect(avatarState('error')).toBe('attention')
    const alert = render({ state: 'attention', override: { image: 'a.png' } })
    expect(alert.match(/class="bot-orb"/g)).toHaveLength(1)
    expect(alert).toContain(`data-character="${defaultCharacter('bot-x')}"`)
    expect(alert).toContain('class="bot-avatar-alert"')
    expect(alert).not.toContain('a.png')
    for (const size of [20, 24, 32, 36, 48, 64, 96] as const) {
      const html = render({ primary: true, size })
      expect(html).not.toContain('<img')
      expect(html).toContain(`data-motion="${size <= 32 ? 'static' : 'idle'}"`)
      expect(html.includes('bot-avatar-primary')).toBe(size >= 36)
    }
    const row = read('renderer/src/components/SidebarConversation.tsx')
    for (const prop of ['override={bot.avatar}', 'primary={bot.primary === true}', 'size={36}', 'state={avatarState(state)}']) expect(row).toMatch(new RegExp(`<BotAvatar [^>]*${prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    const sidebar = read('renderer/src/sidebar-organization.css')
    expect(sidebar).toContain(":root:not([data-window-focused='true']) .sidebar-conversation-avatar > .comet-activity-icon { animation-play-state: paused; }")
    const css = read('renderer/src/bot-avatar.css')
    expect(css).toContain(".sidebar-conversation-avatar > .bot-avatar[data-size='36'] { width: 32px; height: 32px; }")
    // The title pill and its info pane are gone: nothing styles or renders them any more.
    expect(css).not.toContain('.bots-title-pill')
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.bot-avatar, \.bot-avatar \* \{ animation: none !important; \}/)
    expect(css).toMatch(/:root:not\(\[data-window-focused='true'\]\) \.bot-avatar,[^{]*\{ animation-play-state: paused; \}/)
    expect(read('renderer/src/views/BotsView.tsx')).not.toMatch(/BotInfoPane|BotTitlePill/)
  })

  it('gallery and notices wiring', () => {
    expect(read('shared/ipc-types-3.ts')).toMatch(/interface NoticesDto \{ items: \{[^}]*botId\?: string \}\[\]/)
    expect(read('main/notices-ipc.ts')).toContain("...(typeof item.botId === 'string' ? { botId: item.botId } : {})")
    const welcome = read('renderer/src/components/CometWelcome.tsx')
    expect(welcome).toMatch(/primary \? <div><BotAvatar [^>]*size=\{64\}[^>]*\/><\/div> : <CometFace size=\{38\} \/>/)
    expect(welcome).toContain('bots.find(bot => bot.primary === true)')
  })
})
