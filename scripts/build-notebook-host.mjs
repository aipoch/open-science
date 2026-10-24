import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Cargo already tracks source freshness. Reuse its incremental build instead of trusting a
// checked-in helper that may predate the TypeScript/Rust launch protocol used by this checkout.
if (process.platform === 'win32') {
  execFileSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../packages/notebook-network-sandbox/vendor/windows/build.mjs', import.meta.url)
      )
    ],
    { stdio: 'inherit', windowsHide: true }
  )
}
