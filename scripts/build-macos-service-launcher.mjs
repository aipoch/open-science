import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// The same native-target build is used by Electron dev, packaged Desktop, and launcher fixtures.
export function buildMacosServiceLauncher(output) {
  const source = resolve('build/macos-service-launcher.c')
  mkdirSync(dirname(output), { recursive: true })
  execFileSync('/usr/bin/clang', [
    '-mmacosx-version-min=12.0',
    '-Wall',
    '-Werror',
    source,
    '-o',
    output
  ])
}
