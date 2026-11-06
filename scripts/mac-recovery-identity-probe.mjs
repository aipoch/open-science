/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('This probe requires native macOS')
const root = mkdtempSync(join(tmpdir(), 'mac-recovery-identity-'))
const source = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/mac-recovery-entry/identity-probe.m'
)
const receipt = join(root, 'identity.json')
const proof = { root, variants: [] }
function build(name, defines) {
  const bundle = join(root, `${name}.app`)
  const executable = join(bundle, 'Contents/MacOS/entry')
  mkdirSync(dirname(executable), { recursive: true })
  writeFileSync(
    join(bundle, 'Contents/Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>entry</string>
<key>CFBundleIdentifier</key><string>com.aipoch.fixture.identity.${process.pid}.${name}</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
</dict></plist>`
  )
  execFileSync('/usr/bin/xcrun', [
    'clang',
    '-framework',
    'AppKit',
    '-framework',
    'Foundation',
    '-Wall',
    '-Werror',
    ...defines,
    source,
    '-o',
    executable
  ])
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' })
  return { bundle, executable }
}
try {
  const payload = build('runtime', [`-DPROBE_RECEIPT=${JSON.stringify(receipt)}`])
  for (const mode of ['exec', 'child']) {
    const launcher = build(`launcher-${mode}`, [
      `-DPROBE_PAYLOAD_EXEC=${JSON.stringify(payload.executable)}`,
      ...(mode === 'child' ? ['-DPROBE_CHILD=1'] : [])
    ])
    execFileSync(
      '/usr/bin/open',
      ['-n', '-W', launcher.bundle, '--args', '--profile', 'original profile'],
      { timeout: 10_000 }
    )
    proof.variants.push({
      mode,
      launcher: launcher.bundle,
      payload: payload.bundle,
      ...JSON.parse(readFileSync(receipt, 'utf8'))
    })
    rmSync(receipt)
  }
  if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(proof, null, 2) + '\n')
  process.stdout.write(JSON.stringify(proof, null, 2) + '\n')
} finally {
  rmSync(root, { recursive: true, force: true })
}
