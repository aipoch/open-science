/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Cargo already tracks source freshness. Reuse its incremental build instead of trusting a
// checked-in helper that may predate the TypeScript/Rust launch protocol used by this checkout.
export function buildNotebookHost({
  platform = process.platform,
  architecture = process.arch,
  run = execFileSync
} = {}) {
  if (platform !== 'win32') return false
  try {
    run(
      process.execPath,
      [
        fileURLToPath(
          new URL('../packages/notebook-network-sandbox/vendor/windows/build.mjs', import.meta.url)
        ),
        architecture
      ],
      { stdio: 'inherit', windowsHide: true }
    )
  } catch (error) {
    const detail = error instanceof Error && error.message ? ` ${error.message}` : ''
    throw new Error(
      `Windows Notebook AppContainer helper build failed.${detail} Install Rust Cargo and the ` +
        'Microsoft C++ build tools (Desktop development with C++), verify cargo.exe is available, ' +
        'then retry the Windows desktop or backend build.',
      { cause: error }
    )
  }
  return true
}

export async function prepareBackendStage({
  platform = process.platform,
  stage,
  buildHost = buildNotebookHost,
  removeStage
}) {
  // Rebuild from this checkout before replacing the old stage. If Cargo or MSVC is unavailable,
  // the previous stage remains intact and cannot be mistaken for a successful build.
  if (platform === 'win32') buildHost()
  await removeStage(stage, { recursive: true, force: true })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildNotebookHost({ architecture: process.argv[2] || process.arch })
