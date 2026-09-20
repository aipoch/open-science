/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Official GitHub artifact URLs used by the Electron installers on GitHub-hosted runners.
export const GITHUB_ELECTRON_MIRROR = 'https://github.com/electron/electron/releases/download/'
export const GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/'
export const DEFAULT_NPM_CI_ARGS = ['--no-audit']
export const WINDOWS_CI_RETRY_DELAY_MS = 5_000
export const WINDOWS_CI_ATTEMPTS = 2

export function shouldForceGitHubElectronMirrors(env = process.env) {
  return env.GITHUB_ACTIONS === 'true'
}

export function npmCiAttemptCount({ platform = process.platform, env = process.env } = {}) {
  return platform === 'win32' && env.GITHUB_ACTIONS === 'true' ? WINDOWS_CI_ATTEMPTS : 1
}

const defaultSleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function githubElectronMirrorEnv(env = process.env) {
  return {
    ...env,
    ELECTRON_MIRROR: GITHUB_ELECTRON_MIRROR,
    ELECTRON_BUILDER_BINARIES_MIRROR: GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR
  }
}

export function npmCiEnv(env = process.env) {
  return shouldForceGitHubElectronMirrors(env) ? githubElectronMirrorEnv(env) : { ...env }
}

export function npmCiCommand(platform = process.platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function runNpmCi({
  args = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  sleep = defaultSleep,
  spawn = spawnSync
} = {}) {
  const attempts = npmCiAttemptCount({ platform, env })
  const command = npmCiCommand(platform)
  const spawnArgs = ['ci', ...DEFAULT_NPM_CI_ARGS, ...args]
  const options = {
    env: npmCiEnv(env),
    stdio: 'inherit',
    shell: platform === 'win32'
  }

  let status = 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    status = spawn(command, spawnArgs, options).status ?? 1
    if (status === 0) return 0
    if (attempt < attempts) {
      console.error(
        `npm-ci: Windows GitHub Actions install failed (attempt ${attempt}/${attempts}); retrying after ${WINDOWS_CI_RETRY_DELAY_MS}ms`
      )
      sleep(WINDOWS_CI_RETRY_DELAY_MS)
    }
  }
  return status
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runNpmCi())
}
