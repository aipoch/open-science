/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Runs on the native notarization runner, after the final ZIP and its blockmap exist.
import { execFileSync, spawnSync } from 'node:child_process'
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { dump, load } from 'js-yaml'
import semver from 'semver'
import { artifactHash } from '../../scripts/release-artifact-validation.mjs'

const [dir, arch, sdk] = process.argv.slice(2).map((s, i) => (i === 1 ? s : resolve(s)))
if (!['arm64', 'x64'].includes(arch)) throw new Error('Invalid macOS arch')
const {
  MAC_SPARKLE_PUBLIC_KEY: key,
  MAC_SPARKLE_PRIVATE_KEY: secret,
  GITHUB_REPOSITORY: repo
} = process.env
delete process.env.MAC_SPARKLE_PRIVATE_KEY
if (!key || !secret || !repo) throw new Error('Missing Sparkle release configuration')
const publicKey = createPublicKey({
  format: 'jwk',
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key, 'base64').toString('base64url') }
})
const command = (bin, args, options = {}) =>
  execFileSync(bin, args, { encoding: 'utf8', ...options }).trim()
const feedPath = join(dir, arch + '-mac.yml')
const feed = load(readFileSync(feedPath, 'utf8'))
const version = feed.version
const stable = /^\d+\.\d+\.\d+$/
if (!stable.test(version) || !semver.valid(version)) throw new Error('Expected stable target')
const zipName = (v) => 'aipoch-open-science-' + v + '-mac-' + arch + '.zip'
const [file] = feed.files
if (file.url !== zipName(version)) throw new Error('Unexpected final ZIP')
const app = (folder, zip, v) => {
  command('ditto', ['-x', '-k', zip, folder])
  const bundle = join(folder, 'Open-Science.app')
  const plist = join(bundle, 'Contents', 'Info.plist')
  const field = (k) => command('/usr/libexec/PlistBuddy', ['-c', 'Print :' + k, plist])
  if (
    field('CFBundleIdentifier') !== 'com.aipoch.open-science' ||
    field('CFBundleShortVersionString') !== v ||
    field('SUPublicEDKey') !== key ||
    readFileSync(join(bundle, 'Contents/Resources/mac-sparkle.pub'), 'utf8').trim() !== key
  )
    throw new Error('Release bundle identity, version or update key differs')
  const build = field('CFBundleVersion')
  if (!/^\d+(?:\.\d+){0,3}$/.test(build)) throw new Error('Invalid CFBundleVersion')
  for (const binary of [
    join(bundle, 'Contents/MacOS', field('CFBundleExecutable')),
    join(bundle, 'Contents/Resources/mac-sparkle.node')
  ])
    command('lipo', [binary, '-verify_arch', arch === 'x64' ? 'x86_64' : arch])
  command('codesign', ['--verify', '--deep', '--strict', bundle])
  return { bundle, build }
}
const sign = (path) => {
  const signature = command(join(sdk, 'bin/sign_update'), ['--ed-key-file', '-', '-p', path], {
    input: secret + '\n'
  })
  if (!verify(null, readFileSync(path), publicKey, Buffer.from(signature, 'base64')))
    throw new Error('Signing key mismatch')
  return signature
}
const temp = mkdtempSync(join(tmpdir(), 'sparkle-pair-'))
try {
  const zip = join(dir, file.url)
  const target = app(join(temp, 'new'), zip, version)
  file.sparklePublicKey = key
  // Test the key pair even for the bridge release.
  const zipSignature = sign(zip)
  const tags = command('gh', [
    'api',
    '--paginate',
    'repos/' + repo + '/releases?per_page=100',
    '--jq',
    '.[] | select(.draft == false and .prerelease == false) | .tag_name'
  ])
  const previous = tags
    .split('\n')
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .filter((v) => semver.lt(v, version))
    .sort(semver.rcompare)[0]
  if (previous) {
    const get = (name) =>
      command('gh', [
        'release',
        'download',
        'v' + previous,
        '--repo',
        repo,
        '--dir',
        temp,
        '--pattern',
        name
      ])
    get('latest-mac.yml')
    const prior = load(readFileSync(join(temp, 'latest-mac.yml'), 'utf8'))
    if (prior.version !== previous) throw new Error('Previous feed version mismatch')
    const source = prior.files.find((f) => f.url === zipName(previous))
    if (!source) throw new Error('Missing previous macOS ZIP')
    if (source.sparklePublicKey === key) {
      get(source.url)
      const oldZip = join(temp, source.url)
      if (artifactHash(oldZip, 'sha512', 'base64') !== source.sha512)
        throw new Error('Previous ZIP differs from its feed')
      const old = app(join(temp, 'old'), oldZip, previous)
      const patch = join(dir, file.url + '.from-' + previous + '.delta')
      const tool = join(sdk, 'bin/BinaryDelta')
      command(tool, [
        'create',
        '--version=4',
        '--compression=lzma',
        old.bundle,
        target.bundle,
        patch
      ])
      const size = statSync(patch).size
      if (size < file.size && size <= 64 * 1024 ** 2) {
        const rebuilt = join(temp, 'rebuilt.app')
        command(tool, ['apply', old.bundle, rebuilt, patch])
        command('codesign', ['--verify', '--deep', '--strict', rebuilt])
        command('xcrun', ['stapler', 'validate', rebuilt])
        const cdhash = (bundle) => {
          const result = spawnSync('codesign', ['-d', '--verbose=4', bundle], { encoding: 'utf8' })
          const hash = /^CDHash=([0-9a-f]+)$/m.exec(result.stderr)?.[1]
          if (result.status !== 0 || !hash) throw new Error('Missing bundle code directory hash')
          return hash
        }
        if (cdhash(rebuilt) !== cdhash(target.bundle))
          throw new Error('Restored bundle differs from target')
        file.sparkleDelta = {
          from: previous,
          sourceBuild: old.build,
          targetBuild: target.build,
          size,
          signature: sign(patch),
          zipSignature,
          sha512: artifactHash(patch, 'sha512', 'base64')
        }
        const pair = join(temp, 'pair.json')
        writeFileSync(
          pair,
          JSON.stringify([
            previous,
            version,
            arch,
            old.build,
            target.build,
            file.sha512,
            file.sparkleDelta.sha512
          ])
        )
        file.sparkleDelta.pairSignature = sign(pair)
      } else rmSync(patch)
    }
  }
  writeFileSync(feedPath, dump(feed, { lineWidth: -1 }))
} finally {
  rmSync(temp, { recursive: true, force: true })
}
