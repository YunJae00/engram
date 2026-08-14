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
api.onEvent((event) => {
  if (event.type !== 'window:fullscreen') return
  if (event.value) document.documentElement.dataset['fullscreen'] = 'true'
  else delete document.documentElement.dataset['fullscreen']
})

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
