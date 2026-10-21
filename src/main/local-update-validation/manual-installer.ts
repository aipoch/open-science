import { join, relative, sep } from 'node:path'
import { installationFs } from '../update/installation-filesystem'
import type { ManualInstallerArtifact } from '../update/manual-install'
import { validateZipArchivePaths, verifyArtifactChecksum } from '../update/installation-artifact'
import {
  runVerificationProcess,
  verificationDirectoryIsSettled
} from '../update/verification-process'
import type { LocalUpdateValidationConfig } from './config'

// Inspect physical installer contents: Electron exposes app.asar as a virtual directory.
const { mkdtemp, readFile, readdir, rm, stat } = installationFs.promises

/** Test-build-only publisher check: inspect actual signed archive bytes, never a renderer claim. */
export async function inspectValidationManualInstaller(
  artifact: ManualInstallerArtifact,
  config: LocalUpdateValidationConfig
): Promise<void> {
  if (
    process.platform !== 'darwin' ||
    artifact.platform !== 'darwin' ||
    artifact.format !== 'zip' ||
    artifact.algorithm !== 'sha512' ||
    artifact.arch !== process.arch
  )
    throw new Error('The local validation verifier only supports native macOS ZIP artifacts.')
  const target = config.targetArtifact
  if (
    artifact.version !== target.version ||
    artifact.arch !== target.arch ||
    artifact.size !== target.size ||
    artifact.checksum !== target.sha512
  )
    throw new Error("The manual artifact differs from this frozen run's packaged B identity.")
  const inside = relative(config.updateCacheRoot, artifact.path)
  if (!inside || inside === '..' || inside.startsWith(`..${sep}`))
    throw new Error('The validation artifact escaped its isolated cache.')
  const signal = AbortSignal.timeout(120_000)
  await verifyArtifactChecksum(artifact.path, artifact.checksum, signal)
  await validateZipArchivePaths(artifact.path, signal)
  const directory = await mkdtemp(join(config.updateCacheRoot, 'manual-inspection-'))
  const run = (command: string, args: string[]): ReturnType<typeof runVerificationProcess> =>
    runVerificationProcess(command, args, { signal, cwd: directory })
  try {
    await run('/usr/bin/ditto', ['-x', '-k', artifact.path, directory])
    const members = (await readdir(directory)).filter((name) => name !== '__MACOSX')
    if (members.length !== 1 || members[0] !== 'Open-Science.app')
      throw new Error('The validation ZIP must contain the complete single application bundle.')
    const bundle = join(directory, members[0])
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle])
    const signature = await run('/usr/bin/codesign', ['-d', '--verbose=4', bundle])
    const lines = new Set(`${signature.stdout}\n${signature.stderr}`.split(/\r?\n/))
    if (
      !lines.has('Identifier=com.aipoch.open-science.local-update-validation') ||
      !lines.has('Signature=adhoc')
    )
      throw new Error("The ZIP is not this local validation channel's ad-hoc signed application.")
    const plist = join(bundle, 'Contents', 'Info.plist')
    const value = async (key: string): Promise<string> =>
      (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim()
    if (
      (await value('CFBundleShortVersionString')) !== artifact.version ||
      (await value('CFBundleIdentifier')) !== 'com.aipoch.open-science.local-update-validation'
    )
      throw new Error('The validation archive identity differs from the offered target.')
    const resources = join(bundle, 'Contents', 'Resources')
    if (
      !(await stat(join(resources, 'app.asar'))).isFile() ||
      JSON.parse(await readFile(join(resources, 'backend', 'package.json'), 'utf8')).version !==
        artifact.version
    )
      throw new Error('The validation ZIP is missing the complete target backend/application.')
    const executable = await value('CFBundleExecutable')
    if (!executable || executable.includes('/') || executable.includes('\\'))
      throw new Error('Invalid validation executable identity.')
    const arch = await run('/usr/bin/lipo', [
      '-archs',
      join(bundle, 'Contents', 'MacOS', executable)
    ])
    if (!arch.stdout.trim().split(/\s+/).includes(artifact.arch))
      throw new Error('The validation application does not contain the target architecture.')
  } finally {
    if (verificationDirectoryIsSettled(directory))
      await rm(directory, { recursive: true, force: true })
  }
}
