/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyChanges } from './classify-pr-changes.mjs'

const windowsRuntimeSignal =
  /['"]win32['"]|powershell|taskkill(?:\.exe)?|windowsHide|SystemRoot|WINDIR|USERPROFILE|ProgramFiles|LOCALAPPDATA|APPDATA/i

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listSourceFiles(path) : [path]
  })
}

// Keep this repository-wide invariant independent of affected-test selection.
export function findWindowsRoutingGaps(root = process.cwd(), manifest) {
  return ['src/main', 'src/preload', 'src/shared']
    .flatMap((directory) => listSourceFiles(resolve(root, directory)))
    .filter((path) => /\.(?:ts|tsx)$/.test(path) && !/\.(?:test|spec)\.(?:ts|tsx)$/.test(path))
    .filter((path) => windowsRuntimeSignal.test(readFileSync(path, 'utf8')))
    .map((path) => relative(root, path).replaceAll('\\', '/'))
    .filter((path) => {
      const plan = classifyChanges([{ path, status: 'modified' }], manifest)
      return (
        !plan.roots.includes('windows_sensitive') ||
        !plan.lanes.includes('e2e_functional_windows') ||
        !plan.lanes.includes('e2e_workspace_windows')
      )
    })
    .sort()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const gaps = findWindowsRoutingGaps()
    if (gaps.length > 0) {
      throw new Error(
        `Missing Windows runtime routing in scripts/ci/change-impact.json:\n${gaps.map((path) => `- ${path}`).join('\n')}\nRegister these paths in windows_sensitive and retain both Windows E2E lanes.`
      )
    }
    console.log('Change-impact Windows runtime routing passed.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
