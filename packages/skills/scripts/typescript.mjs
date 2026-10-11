import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'

// The host also installs a native compiler exposing `tsc`. Resolve this package's declared
// TypeScript dependency by name so PATH cannot silently choose a different compiler.
const require = createRequire(import.meta.url)
// Removed source modules must not survive as stale implementation files in a packed build.
if (process.argv.includes('tsconfig.json'))
  rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true })
const result = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), ...process.argv.slice(2)],
  { stdio: 'inherit' }
)
if (result.error) throw result.error
process.exit(result.status ?? 1)
