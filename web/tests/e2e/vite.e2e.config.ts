import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { buildSites } from '../../plugins/build-sites.ts'
import { poeAccount } from '../../plugins/poe-account.ts'
import { pobBridge } from '../../plugins/pob-bridge.ts'
import { treeArt } from '../../plugins/tree-art.ts'

// The same plugins as web/vite.config.ts, with the engine moved off :49090.
// That port is where a developer's own `npm run dev` keeps its engine, and
// the bridge plugin reuses whatever already answers there, so the tests
// would otherwise run against (and save into) a real session.
export const ENGINE_PORT = 51990

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('../../', import.meta.url)),
  plugins: [
    react(),
    pobBridge({ repoRoot, port: ENGINE_PORT }),
    treeArt({ repoRoot }),
    poeAccount({ repoRoot }),
    buildSites({ repoRoot }),
  ],
})
