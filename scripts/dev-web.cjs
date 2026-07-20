/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

// Starts electron-vite dev with the localhost web service enabled. Use --headless to skip the
// initial Electron window while keeping the tray, agent runtime, and web UI available.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const DEFAULT_WEB_PORT = '44100'

// Builds the electron-vite invocation from argv/env: default the web port when unset and forward
// --headless through electron-vite's `--` passthrough. Pure so it can be unit-tested without spawning.
const buildDevWebCommand = (argv, env) => {
  const headless = argv.includes('--headless')
  const nextEnv = { ...env }
  if (!nextEnv.OPEN_SCIENCE_WEB_PORT?.trim()) {
    nextEnv.OPEN_SCIENCE_WEB_PORT = DEFAULT_WEB_PORT
  }
  const args = ['electron-vite', 'dev']
  // Pass a namespaced flag to Electron: Chromium consumes a literal `--headless` and renders native
  // menus (like the tray context menu) invisibly on Windows (electron/electron#48982).
  if (headless) args.push('--', '--open-science-headless')
  return { command: 'npx', args, env: nextEnv }
}

const main = () => {
  const { command, args, env } = buildDevWebCommand(process.argv, process.env)
  const result = spawnSync(command, args, {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  })
  process.exit(result.status ?? 1)
}

if (require.main === module) main()

module.exports = { buildDevWebCommand, DEFAULT_WEB_PORT }
