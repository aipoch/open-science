/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const { spawnSync } = require('node:child_process')
const { realpathSync } = require('node:fs')
const { join } = require('node:path')

// Existing root resolvers and directory ownership also apply to this opt-in launch.
const isolatedDevEnvironment = (root, env) => {
  const next = { ...env }
  if (
    ![
      'OPEN_SCIENCE_E2E_STORAGE_ROOT',
      'OPEN_SCIENCE_CONFIG_ROOT',
      'OPEN_SCIENCE_STORAGE_ROOT'
    ].some((key) => next[key]?.trim())
  )
    next.OPEN_SCIENCE_CONFIG_ROOT = join(realpathSync(root), '.dev-isolate', 'runtime')
  if (!next.OPEN_SCIENCE_WEB_PORT?.trim()) next.OPEN_SCIENCE_WEB_PORT = '0'
  return next
}

if (require.main === module) {
  const root = realpathSync(join(__dirname, '..'))
  if (!process.env.npm_execpath)
    throw new Error(
      'Start isolated development through npm run dev:isolated or npm run dev:web:isolated.'
    )
  const web = process.argv[2] === '--web'
  const env = isolatedDevEnvironment(root, process.env)
  console.log(
    `Isolated development: ${root}\nConfig: ${env.OPEN_SCIENCE_E2E_STORAGE_ROOT || env.OPEN_SCIENCE_CONFIG_ROOT || env.OPEN_SCIENCE_STORAGE_ROOT}\nWeb port: ${env.OPEN_SCIENCE_WEB_PORT} (0 selects an available port)`
  )
  const result = spawnSync(
    process.execPath,
    [
      process.env.npm_execpath,
      'run',
      web ? 'dev:web' : 'dev',
      '--',
      ...process.argv.slice(web ? 3 : 2)
    ],
    {
      cwd: root,
      env,
      stdio: 'inherit'
    }
  )
  if (result.error) console.error(result.error.message)
  process.exit(result.status ?? 1)
}

module.exports = { isolatedDevEnvironment }
