/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Official GitHub artifact URLs used by the Electron installers on GitHub-hosted runners.
export const GITHUB_ELECTRON_MIRROR = 'https://github.com/electron/electron/releases/download/'
export const GITHUB_ELECTRON_BUILDER_BINARIES_MIRROR =
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/'

export function shouldForceGitHubElectronMirrors(env = process.env) {
  return env.GITHUB_ACTIONS === 'true'
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
  spawn = spawnSync
} = {}) {
  const result = spawn(npmCiCommand(platform), ['ci', ...args], {
    env: npmCiEnv(env),
    stdio: 'inherit',
    shell: platform === 'win32'
  })
  return result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runNpmCi())
}
