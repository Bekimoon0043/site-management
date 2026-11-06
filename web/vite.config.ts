import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // React Compiler (stable 1.0) via the Babel preset path documented for plugin-react v6.
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  // 5173 is taken by another app on this machine
  server: { port: 5180, strictPort: true, host: true }, // host: reachable from other devices on the LAN
})
