import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The integration files also participate in ordinary test discovery, where absent binaries skip
// live tests. This release/upgrade entry point must never report success for a skipped matrix.
const requiredPaths = [
  'CLAUDE_NATIVE_PATH',
  'CODEX_ACP_PATH',
  'CODEX_NATIVE_PATH',
  'OPENCODE_ACP_PATH'
]
const missing = requiredPaths.filter((name) => !process.env[name] || !existsSync(process.env[name]))
if (missing.length > 0) {
  console.error(`Set these variables to installed executable/adapter files: ${missing.join(', ')}`)
  process.exitCode = 1
} else {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run',
      'src/main/agent-framework/session-mcp-isolation.integration.test.ts',
      'src/main/agent-framework/opencode-mcp-isolation.integration.test.ts'
    ],
    { cwd: root, stdio: 'inherit', env: process.env }
  )
  if (result.error) console.error(result.error.message)
  process.exitCode = result.status ?? 1
}
