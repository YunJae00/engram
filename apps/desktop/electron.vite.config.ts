import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
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
