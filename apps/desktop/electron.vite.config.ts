import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'embedding-worker': resolve('src/main/embedding-worker.ts'), 'process-worker': resolve('src/main/process-worker.ts'), 'codex-worker': resolve('src/main/codex-worker.ts'), 'claude-history-worker': resolve('src/main/claude-history-worker.ts'), 'vault-git-worker': resolve('src/main/vault-git-worker.ts') } } },
    plugins: [externalizeDepsPlugin({ exclude: ['core', 'pptxgenjs', 'docx'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
})
