/* eslint-disable @typescript-eslint/no-require-imports */

// Starts electron-vite dev with the localhost web service enabled. Use --headless to skip the
// initial Electron window while keeping the tray, agent runtime, and web UI available.
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const headless = process.argv.includes('--headless')
if (!process.env.OPEN_SCIENCE_WEB_PORT?.trim()) {
  process.env.OPEN_SCIENCE_WEB_PORT = '44100'
}

const args = ['electron-vite', 'dev']
if (headless) args.push('--', '--headless')

const result = spawnSync('npx', args, {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
  shell: process.platform === 'win32'
})

process.exit(result.status ?? 1)
