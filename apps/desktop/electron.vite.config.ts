import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // `core` is TypeScript source — bundle it into the main build instead of
    // requiring it at runtime.
    plugins: [externalizeDepsPlugin({ exclude: ['core'] })],
    build: {
      rollupOptions: {
        // The inference host is forked as its own process, so it needs its own
        // entry next to the main bundle.
        input: {
          index: 'src/main/index.ts',
          'llm-worker': 'src/main/llm-worker.ts',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
})
