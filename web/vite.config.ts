import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { poeAccount } from './plugins/poe-account.ts'
import { pobBridge } from './plugins/pob-bridge.ts'
import { treeArt } from './plugins/tree-art.ts'

// https://vite.dev/config/
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    // The engine is part of the same checkout, one directory up. The plugin
    // starts it with the dev server and serves it under /bridge, so the app
    // makes same-origin requests and never needs to know its port.
    pobBridge({ repoRoot }),
    // The tree's node art is extracted from the game's own texture files.
    // Gitignored and slow to build, so the first dev run makes it.
    treeArt({ repoRoot }),
    // Signing in to pathofexile.com and listing characters. The engine's own
    // network layer is stubbed out headless, so the transport lives here and
    // the import still goes through PoB's importer.
    poeAccount({ repoRoot }),
  ],
})
