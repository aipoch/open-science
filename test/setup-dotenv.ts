// Vitest global setup file: loads .env into process.env before any test runs.
// This allows gated integration tests to read COMPUTE_TEST_SSH_ALIAS, RUN_COMPUTE_JOBS, etc.
// from a local .env file without committing real values. The .env file is gitignored;
// .env.example documents the supported variables.
//
// This setup file does nothing if .env does not exist (CI environments, clean checkouts).

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const envPath = resolve(process.cwd(), '.env')

if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf8')

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    // Skip comments and blank lines.
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue

    const key = trimmed.slice(0, eqIdx).trim()
    // Strip optional surrounding quotes from value.
    let value = trimmed.slice(eqIdx + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    // Only set if not already in the environment (allows CI to override via real env vars).
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}
