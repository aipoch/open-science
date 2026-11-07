import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// The same native-target build is used by Electron dev, packaged Desktop, and launcher fixtures.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- typed in the .d.mts entry point
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
