import React from 'react'
import { createRoot } from 'react-dom/client'
import { api } from './api.js'
import { App } from './App.js'
import { uiLanguage } from './i18n.js'
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

document.documentElement.dataset['platform'] = api.platform
try {
  let worst = 0
  let armed = 0
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) worst = Math.max(worst, entry.duration)
    const now = Date.now()
    if (worst >= 200 && now - armed > 5_000) { armed = now; api.reportLongTask(worst); worst = 0 }
  }).observe({ entryTypes: ['longtask'] })
} catch { }

api.onEvent((event) => {
  if (event.type === 'window:focus') document.documentElement.dataset['windowFocused'] = String(event.value)
  if (event.type !== 'window:fullscreen') return
  if (event.value) document.documentElement.dataset['fullscreen'] = 'true'
  else delete document.documentElement.dataset['fullscreen']
})

const root = createRoot(document.getElementById('root')!)
let language = uiLanguage()
const render = () => root.render(
  <React.StrictMode>
    <App key={language} />
  </React.StrictMode>,
)
render()
api.onEvent((event) => {
  if (event.type !== 'settings:changed' || uiLanguage() === language) return
  language = uiLanguage()
  render()
})

requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    const boot = document.getElementById('boot')
    if (!boot) return
    boot.style.animation = 'none'
    boot.style.opacity = '0'
    setTimeout(() => boot.remove(), 400)
  }),
)
