import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin')
  throw new Error('This fixture requires native macOS LaunchServices')
const root = mkdtempSync(join(tmpdir(), 'open-science-mac-recovery-entry-'))
const application = join(root, 'Recovery Entry Fixture.app')
const executable = join(application, 'Contents/MacOS/entry')
const receipt = join(root, 'ordinary-entry.receipt')
const result = { platform: process.platform, arch: process.arch, root, scenarios: [] }
/** @returns {void} */
// JavaScript fixture: this rule requires TypeScript syntax even with the JSDoc return type.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const launch = (name) => {
  const launched = spawnSync('/usr/bin/open', ['-n', '-W', application], {
    encoding: 'utf8',
    timeout: 10_000
  })
  result.scenarios.push({
    name,
    command: ['/usr/bin/open', '-n', '-W', application],
    status: launched.status,
    stderr: launched.stderr,
    executed: existsSync(receipt)
  })
}
try {
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(
    join(application, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>entry</string>
<key>CFBundleIdentifier</key><string>com.aipoch.fixture.recovery-entry.${process.pid}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`
  )
  execFileSync('/usr/bin/xcrun', [
    'clang',
    '-Wall',
    '-Werror',
    `-DRECOVERY_ENTRY_RECEIPT=${JSON.stringify(receipt)}`,
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/mac-recovery-entry/main.c'),
    '-o',
    executable
  ])
  // Local ad-hoc signing is only for the native entry probe. No updater trust is bypassed.
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', application], { stdio: 'pipe' })
  launch('intact-ordinary-application')
  if (result.scenarios[0].status !== 0 || !existsSync(receipt))
    throw new Error('The intact native fixture did not launch')
  rmSync(receipt)
  rmSync(executable)
  launch('CFBundleExecutable-missing')
  if (result.scenarios[1].status === 0 || existsSync(receipt))
    throw new Error('Unexpected executable-missing entry behavior')
  rmSync(application, { recursive: true })
  launch('whole-bundle-missing-during-replacement')
  if (result.scenarios[2].status === 0 || existsSync(receipt))
    throw new Error('Unexpected bundle-missing entry behavior')
  result.conclusion =
    'The ordinary app entry cannot execute an in-app recovery handler when its native executable or bundle is absent.'
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
