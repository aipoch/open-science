/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  digest,
  nativeFiles,
  root,
  sourceFingerprint,
  spec,
  validateNativeRelease,
  verifiedBytes
} from './native-components.mjs'

const require = createRequire(import.meta.url)
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`${command} failed (${result.status})`)
  return result.stdout
}

export function buildNativeComponents() {
  nativeFiles(`${process.platform}-${process.arch}`)
  if (process.versions.node !== spec.node)
    throw new Error(`Native producer requires Node ${spec.node}`)
  for (const pkg of Object.keys(spec.packages)) {
    run(
      process.execPath,
      [
        require.resolve('node-gyp/bin/node-gyp.js'),
        'rebuild',
        '--directory',
        `packages/${pkg}`,
        ...(pkg === 'credential-identity-probe-native' ? ['--', '-Dbuild_node_secret=1'] : [])
      ],
      { env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: spec.macosMinimum } }
    )
  }
}

export async function collectNativeComponents(output) {
  const target = `${process.platform}-${process.arch}`
  await mkdir(output, { recursive: true })
  for (const file of nativeFiles(target))
    await copyFile(
      join(root, 'packages', file.package, 'build/Release', file.name),
      join(output, file.name)
    )
}

export function signMacComponents(output, keychain, identity) {
  if (process.platform !== 'darwin' || !keychain || !identity)
    throw new Error('A macOS signing keychain and identity are required')
  for (const file of nativeFiles(`darwin-${process.arch}`)) {
    run('codesign', [
      '--force',
      '--options',
      'runtime',
      '--timestamp',
      '--keychain',
      keychain,
      '--sign',
      identity,
      '--identifier',
      `com.aipoch.open-science.native.${file.name.replaceAll('_', '-')}`,
      join(output, file.name)
    ])
  }
}

export function verifyNativeSignatures(output, target, invoke = run) {
  if (target !== `${process.platform}-${process.arch}`)
    throw new Error('Verify signatures on the native target')
  for (const file of nativeFiles(target)) {
    const path = join(output, file.name)
    if (process.platform === 'darwin') {
      invoke('codesign', ['--verify', '--strict', '--verbose=2', path])
      invoke('codesign', [
        '--verify',
        '-R',
        `=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and identifier "com.aipoch.open-science.native.${file.name.replaceAll('_', '-')}"`,
        path
      ])
    }
  }
  if (process.platform === 'win32')
    invoke('pwsh.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      join(root, 'scripts/verify-native-component-signatures.ps1'),
      '-Directory',
      output
    ])
}

export async function recordNativeRelease(output, { dryRun = false } = {}) {
  const target = `${process.platform}-${process.arch}`
  if (!dryRun) verifyNativeSignatures(output, target)
  const files = []
  for (const file of nativeFiles(target)) {
    const bytes = await readFile(join(output, file.name))
    const sha256 = digest(bytes)
    files.push({
      ...file,
      sha256,
      size: bytes.length,
      url: `${spec.cdn}/${target}/${sha256}/${file.name}`
    })
  }
  const release = {
    schema: 1,
    target,
    source: await sourceFingerprint(),
    node: spec.node,
    signing: target.startsWith('linux-') ? 'none' : dryRun ? 'unsigned' : 'release',
    files
  }
  if (!dryRun) validateNativeRelease(release, target, release.source)
  await writeFile(join(output, 'release.json'), JSON.stringify(release, null, 2) + '\n')
  return release
}

export async function publishNativeRelease(output, environment = process.env) {
  const release = JSON.parse(await readFile(join(output, 'release.json'), 'utf8'))
  validateNativeRelease(release, `${process.platform}-${process.arch}`, await sourceFingerprint())
  verifyNativeSignatures(output, release.target)
  await publishNativeFiles(output, release, environment)
}

export async function publishNativeFiles(output, release, environment, invoke = spawnSync) {
  validateNativeRelease(release, release.target, release.source)
  if (!environment.S3_BUCKET) throw new Error('S3_BUCKET is required')
  for (const file of release.files) await verifiedBytes(join(output, file.name), file)
  for (const file of release.files) {
    const key = new URL(file.url).pathname.slice(1)
    const checksum = Buffer.from(file.sha256, 'hex').toString('base64')
    const common = [
      '--bucket',
      environment.S3_BUCKET,
      '--key',
      key,
      '--output',
      'json',
      '--no-cli-pager'
    ]
    const options = { encoding: 'utf8', timeout: 120_000, env: environment }
    const head = invoke(
      'aws',
      ['s3api', 'head-object', ...common, '--checksum-mode', 'ENABLED'],
      options
    )
    if (!head.error && head.status === 0) {
      const info = JSON.parse(head.stdout)
      if (info.ContentLength !== file.size || info.ChecksumSHA256 !== checksum)
        throw new Error('Immutable native object differs')
      continue
    }
    if (head.error || !/\((?:404|NoSuchKey|NotFound)\)/.test(head.stderr ?? ''))
      throw new Error('Cannot inspect native CDN object; refusing publication')
    const result = invoke(
      'aws',
      [
        's3api',
        'put-object',
        ...common,
        '--body',
        join(output, file.name),
        '--if-none-match',
        '*',
        '--checksum-algorithm',
        'SHA256',
        '--checksum-sha256',
        checksum,
        '--content-type',
        'application/octet-stream',
        '--cache-control',
        'public, max-age=31536000, immutable'
      ],
      options
    )
    if (result.error || result.status !== 0)
      throw new Error(`Native CDN publication failed: ${file.name}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory = 'out/native-components'] = process.argv.slice(2)
  const output = resolve(directory)
  if (mode === 'build') buildNativeComponents()
  else if (mode === 'collect') await collectNativeComponents(output)
  else if (mode === 'sign-mac')
    signMacComponents(output, process.env.CSC_KEYCHAIN, process.env.NATIVE_SIGNING_IDENTITY)
  else if (mode === 'record')
    await recordNativeRelease(output, { dryRun: process.argv.includes('--dry-run') })
  else if (mode === 'publish') await publishNativeRelease(output)
  else
    throw new Error(
      'Usage: produce-native-components.mjs build | collect | sign-mac | record [--dry-run] | publish [directory]'
    )
}
