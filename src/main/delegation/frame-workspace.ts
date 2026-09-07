import { randomUUID } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { parseArtifactVersionLocator } from '../../shared/artifact-provenance'
import { parseUploadVersionReference } from '../../shared/uploads'
import type { SessionKey } from './session-records'

type ResolvedImmutableInput = Readonly<{
  path: string
  filename?: string
  copyTo?: (destinationPath: string) => Promise<void>
  close?: () => Promise<void>
}>

type ProductionFrameWorkspaceOptions = Readonly<{
  root: string
  resolveInput(identity: string, session: SessionKey): Promise<ResolvedImmutableInput>
}>

type ProductionFrameWorkspace = Readonly<{
  validateInput(identity: string, session: SessionKey): Promise<boolean>
  prepare(session: SessionKey, frameId: string, inputs: readonly string[]): Promise<{ cwd: string }>
  deleteSession(session: SessionKey): Promise<void>
  deleteProject(projectId: string): Promise<void>
}>

const safeSegment = (value: string, label: string): string => {
  if (
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new Error(`Unsafe delegated ${label}: ${JSON.stringify(value)}`)
  }
  return value
}

const safeFilename = (value: string): string => {
  const name = basename(value)
    .replaceAll(/[^\p{L}\p{N}._ -]/gu, '_')
    .trim()
  return name && name !== '.' && name !== '..' ? name : 'input'
}

const assertVersionIdentityScope = (identity: string, session: SessionKey): void => {
  const upload = parseUploadVersionReference(identity)
  if (upload) {
    if (upload.projectId && upload.projectId !== session.projectId) {
      throw new Error('Upload Version belongs to a different Project.')
    }
    if (upload.sessionId && upload.sessionId !== session.sessionId) {
      throw new Error('Upload Version belongs to a different Session.')
    }
    return
  }
  const artifact = parseArtifactVersionLocator(identity)
  if (
    !artifact ||
    artifact.projectId !== session.projectId ||
    artifact.appSessionId !== session.sessionId
  ) {
    throw new Error('Input is not an immutable Upload or Artifact Version in this Session.')
  }
}

const makeTreeRemovable = async (path: string): Promise<void> => {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry) return
  // chmod and traversal must never follow a workspace symlink into caller-owned data. The parent
  // directory is made writable, which is sufficient for rm to unlink this leaf.
  if (entry.isSymbolicLink()) return
  if (!entry.isDirectory()) {
    await chmod(path, 0o644)
    return
  }
  await chmod(path, 0o755)
  for (const child of await readdir(path)) await makeTreeRemovable(join(path, child))
}

const createProductionFrameWorkspace = (
  options: ProductionFrameWorkspaceOptions
): ProductionFrameWorkspace => {
  const projectRoot = (projectId: string): string =>
    join(options.root, safeSegment(projectId, 'Project id'))
  const sessionRoot = (session: SessionKey): string =>
    join(projectRoot(session.projectId), safeSegment(session.sessionId, 'Session id'))

  const resolve = async (
    identity: string,
    session: SessionKey
  ): Promise<ResolvedImmutableInput> => {
    assertVersionIdentityScope(identity, session)
    return options.resolveInput(identity, session)
  }

  return Object.freeze({
    async validateInput(identity: string, session: SessionKey): Promise<boolean> {
      let input: ResolvedImmutableInput | undefined
      try {
        input = await resolve(identity, session)
        return true
      } catch {
        return false
      } finally {
        await input?.close?.().catch(() => undefined)
      }
    },
    async prepare(
      session: SessionKey,
      frameId: string,
      inputs: readonly string[]
    ): Promise<{ cwd: string }> {
      const root = sessionRoot(session)
      const cwd = join(root, 'frames', safeSegment(frameId, 'Frame id'))
      const staging = join(root, '.staging', `${frameId}-${randomUUID()}`)
      const stagedInputs = join(staging, 'inputs')
      let resolved: ResolvedImmutableInput[] = []
      await mkdir(stagedInputs, { recursive: true })
      try {
        // A lease may resolve after another input fails; wait for it before closing the batch.
        const resolutions = await Promise.allSettled(
          inputs.map((identity) => resolve(identity, session))
        )
        resolved = resolutions.flatMap((result) =>
          result.status === 'fulfilled' ? [result.value] : []
        )
        const failed = resolutions.find((result) => result.status === 'rejected')
        if (failed?.status === 'rejected') throw failed.reason
        const inputsDir = join(cwd, 'inputs')
        const alreadyPrepared = await stat(inputsDir)
          .then((entry) => entry.isDirectory())
          .catch(() => false)
        if (alreadyPrepared) return { cwd }
        for (const [index, input] of resolved.entries()) {
          const ordinal = String(index + 1).padStart(2, '0')
          const target = join(
            stagedInputs,
            `${ordinal}-${safeFilename(input.filename ?? input.path)}`
          )
          if (input.copyTo) await input.copyTo(target)
          else await copyFile(input.path, target)
          await chmod(target, 0o444)
        }
        await mkdir(cwd, { recursive: true })
        await rename(stagedInputs, inputsDir)
        await chmod(inputsDir, 0o555)
        return { cwd }
      } finally {
        await Promise.all(resolved.map((input) => input.close?.().catch(() => undefined)))
        await chmod(stagedInputs, 0o755).catch(() => undefined)
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    },
    async deleteSession(session: SessionKey): Promise<void> {
      const root = sessionRoot(session)
      await makeTreeRemovable(root)
      await rm(root, { recursive: true, force: true })
    },
    async deleteProject(projectId: string): Promise<void> {
      const root = projectRoot(projectId)
      await makeTreeRemovable(root)
      await rm(root, { recursive: true, force: true })
    }
  })
}

export { createProductionFrameWorkspace }
export type { ProductionFrameWorkspace, ProductionFrameWorkspaceOptions, ResolvedImmutableInput }
