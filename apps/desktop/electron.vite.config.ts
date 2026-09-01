import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // `core` is TypeScript source — bundle it into the main build instead of
    // requiring it at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['core'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
})
