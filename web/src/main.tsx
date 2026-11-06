import './lib/polyfills' // first: crypto.randomUUID on plain-http LAN access
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './index.css'
import { applyPrefs } from './lib/prefs'
import App from './App.tsx'

// Theme/density onto <html> before first paint (no flash).
applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
