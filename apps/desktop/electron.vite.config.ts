import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    build: { rollupOptions: { input: { index: resolve('src/main/index.ts'), 'embedding-worker': resolve('src/main/embedding-worker.ts'), 'process-worker': resolve('src/main/process-worker.ts'), 'codex-worker': resolve('src/main/codex-worker.ts'), 'vault-git-worker': resolve('src/main/vault-git-worker.ts') } } },
    // `core` is TypeScript source — bundle it into the main build instead of
    // requiring it at runtime. The document libraries are pure ESM whose own
    // imports (jszip) break when left external in the ESM main bundle, so
    // bundle them in too and let the build resolve their graph.
    plugins: [externalizeDepsPlugin({ exclude: ['core', 'pptxgenjs', 'docx'] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react()],
  },
})
