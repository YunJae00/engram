import React from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api.js'
import { App } from './App.js'
import './styles.css'

for (const key of Object.keys(localStorage)) {
  if (!key.startsWith('strata.')) continue
  const next = `engram.${key.slice('strata.'.length)}`
  if (localStorage.getItem(next) === null) localStorage.setItem(next, localStorage.getItem(key)!)
  localStorage.removeItem(key)
}

document.documentElement.dataset['theme'] = window.matchMedia('(prefers-color-scheme: dark)').matches
  ? 'dark'
  : 'light'

// Platform hook for CSS (e.g. the top bar reserves space for the macOS
// traffic lights). Fullscreen on macOS hides those lights, so track it too.
document.documentElement.dataset['platform'] = api.platform
// Surface the worst UI-thread stalls (scroll jank, heavy re-renders) into the
// main log — a user's renderer has no profiler we can reach. Throttled so a
// bad stretch reports its peak once every few seconds, not every frame.
try {
  let worst = 0
  let armed = 0
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) worst = Math.max(worst, entry.duration)
    const now = Date.now()
    if (worst >= 200 && now - armed > 5_000) { armed = now; api.reportLongTask(worst); worst = 0 }
  }).observe({ entryTypes: ['longtask'] })
} catch { /* longtask not supported — no signal, no harm */ }

api.onEvent((event) => {
  if (event.type === 'window:focus') document.documentElement.dataset['windowFocused'] = String(event.value)
  if (event.type !== 'window:fullscreen') return
  if (event.value) document.documentElement.dataset['fullscreen'] = 'true'
  else delete document.documentElement.dataset['fullscreen']
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// The boot word stays through React's first paint and fades on the next
// frame, so opening reads as one dissolve instead of a swap.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const boot = document.getElementById('boot')
    if (!boot) return
    boot.style.animation = 'none'
    boot.style.opacity = '0'
    setTimeout(() => boot.remove(), 400)
  }),
)
