/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

// Starts the Node backend for browser development. Use dev for the Electron desktop host.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const DEFAULT_WEB_PORT = '44100'

// Build the ordinary Node invocation and default the port; the entry owns all host configuration.
const buildDevWebCommand = (argv, env) => {
  const nextEnv = { ...env }
  if (!nextEnv.OPEN_SCIENCE_WEB_PORT?.trim()) nextEnv.OPEN_SCIENCE_WEB_PORT = DEFAULT_WEB_PORT
  delete nextEnv.ELECTRON_RUN_AS_NODE
  const args = [
    'out/backend/index.cjs',
    '--development',
    `--serve=${nextEnv.OPEN_SCIENCE_WEB_PORT}`,
    ...argv.slice(2).filter((value) => value !== '--headless')
  ]

  return { command: process.execPath, args, env: nextEnv }
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
