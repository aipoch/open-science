import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import type { NotebookLanguage } from '../../shared/notebook'
import { assertSafeEnvName, envPrefix } from './runtime-paths'

const OWNERSHIP_DIRECTORY = '.agent-environment-ownership'
const RECEIPT_KIND = 'agent-created-runtime-environment'
const PREFIX_MARKER_FILE = '.open-science-agent-environment.json'
const PREFIX_MARKER_KIND = 'agent-created-runtime-environment-prefix'

export type AgentEnvironmentOwnershipReceipt = {
  schema: 1
  kind: typeof RECEIPT_KIND
  name: string
  language: NotebookLanguage
  canonicalPrefix: string
  ownershipId: string
}

type AgentEnvironmentPrefixMarker = {
  schema: 1
  kind: typeof PREFIX_MARKER_KIND
  name: string
  ownershipId: string
}

export type AgentEnvironmentOwnership = {
  record(name: string, language: NotebookLanguage): void
  owns(name: string, language: NotebookLanguage): boolean
  consume(name: string): AgentEnvironmentOwnershipReceipt
  restore(receipt: AgentEnvironmentOwnershipReceipt): void
}

const pathKey = (path: string, platform: NodeJS.Platform): string => {
  const normalized = resolve(path)
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

const isPhysicalChild = (
  parent: string,
  child: string,
  name: string,
  platform: NodeJS.Platform
): boolean =>
  pathKey(realpathSync.native(child), platform) ===
  pathKey(join(realpathSync.native(parent), name), platform)

export const createAgentEnvironmentOwnership = (
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform
): AgentEnvironmentOwnership => {
  const ownershipDirectory = join(runtimeRoot, OWNERSHIP_DIRECTORY)

  const trustedOwnershipDirectory = (create: boolean): string => {
    if (create) {
      mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 })
      try {
        mkdirSync(ownershipDirectory, { mode: 0o700 })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    const state = lstatSync(ownershipDirectory)
    if (!state.isDirectory() || state.isSymbolicLink()) {
      throw new Error('Agent environment ownership directory is not trusted.')
    }
    if (!isPhysicalChild(runtimeRoot, ownershipDirectory, OWNERSHIP_DIRECTORY, platform)) {
      throw new Error('Agent environment ownership directory resolves outside the Runtime root.')
    }
    return ownershipDirectory
  }

  const canonicalPrefix = (name: string): string => {
    const safeName = assertSafeEnvName(name)
    const environmentsDirectory = join(runtimeRoot, 'envs')
    const prefix = envPrefix(runtimeRoot, safeName, platform)
    const environmentsState = lstatSync(environmentsDirectory)
    const prefixState = lstatSync(prefix)
    if (
      !environmentsState.isDirectory() ||
      environmentsState.isSymbolicLink() ||
      !prefixState.isDirectory() ||
      prefixState.isSymbolicLink()
    ) {
      throw new Error(`Runtime Environment "${safeName}" is not a trusted directory.`)
    }
    if (!isPhysicalChild(environmentsDirectory, prefix, safeName, platform)) {
      throw new Error(`Runtime Environment "${safeName}" resolves outside the managed envs root.`)
    }
    return realpathSync.native(prefix)
  }

  const receiptPath = (name: string): string =>
    join(trustedOwnershipDirectory(false), `${assertSafeEnvName(name)}.json`)

  const readReceipt = (name: string): AgentEnvironmentOwnershipReceipt => {
    const safeName = assertSafeEnvName(name)
    const path = receiptPath(safeName)
    const state = lstatSync(path)
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      throw new Error(`Agent environment ownership receipt for "${safeName}" is not trusted.`)
    }
    const parsed = JSON.parse(
      readFileSync(path, 'utf8')
    ) as Partial<AgentEnvironmentOwnershipReceipt>
    if (
      parsed.schema !== 1 ||
      parsed.kind !== RECEIPT_KIND ||
      parsed.name !== safeName ||
      (parsed.language !== 'python' && parsed.language !== 'r') ||
      typeof parsed.canonicalPrefix !== 'string' ||
      typeof parsed.ownershipId !== 'string' ||
      parsed.ownershipId.length === 0 ||
      pathKey(parsed.canonicalPrefix, platform) !== pathKey(canonicalPrefix(safeName), platform)
    ) {
      throw new Error(`Agent environment ownership receipt for "${safeName}" does not match.`)
    }
    const markerPath = join(parsed.canonicalPrefix, PREFIX_MARKER_FILE)
    const markerState = lstatSync(markerPath)
    if (!markerState.isFile() || markerState.isSymbolicLink() || markerState.nlink !== 1) {
      throw new Error(`Agent environment prefix marker for "${safeName}" is not trusted.`)
    }
    const marker = JSON.parse(
      readFileSync(markerPath, 'utf8')
    ) as Partial<AgentEnvironmentPrefixMarker>
    if (
      marker.schema !== 1 ||
      marker.kind !== PREFIX_MARKER_KIND ||
      marker.name !== safeName ||
      marker.ownershipId !== parsed.ownershipId
    ) {
      throw new Error(`Agent environment prefix marker for "${safeName}" does not match.`)
    }
    return parsed as AgentEnvironmentOwnershipReceipt
  }

  const writeReceipt = (receipt: AgentEnvironmentOwnershipReceipt): void => {
    const directory = trustedOwnershipDirectory(true)
    const path = join(directory, `${assertSafeEnvName(receipt.name)}.json`)
    try {
      writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readReceipt(receipt.name)
      if (
        existing.language !== receipt.language ||
        existing.ownershipId !== receipt.ownershipId ||
        pathKey(existing.canonicalPrefix, platform) !== pathKey(receipt.canonicalPrefix, platform)
      ) {
        throw new Error(
          `Agent environment ownership receipt for "${receipt.name}" already exists and does not match.`
        )
      }
    }
  }

  const readOwned = (name: string, language: NotebookLanguage): boolean => {
    try {
      return readReceipt(name).language === language
    } catch {
      return false
    }
  }

  return {
    record: (name, language) => {
      const safeName = assertSafeEnvName(name)
      if (readOwned(safeName, language)) return
      const prefix = canonicalPrefix(safeName)
      const ownershipId = randomUUID()
      const markerPath = join(prefix, PREFIX_MARKER_FILE)
      writeFileSync(
        markerPath,
        `${JSON.stringify(
          { schema: 1, kind: PREFIX_MARKER_KIND, name: safeName, ownershipId },
          null,
          2
        )}\n`,
        { encoding: 'utf8', mode: 0o600, flag: 'wx' }
      )
      try {
        writeReceipt({
          schema: 1,
          kind: RECEIPT_KIND,
          name: safeName,
          language,
          canonicalPrefix: prefix,
          ownershipId
        })
      } catch (error) {
        try {
          rmSync(markerPath)
        } catch {
          // Leaving a prefix marker without the protected receipt grants no deletion authority.
        }
        throw error
      }
    },
    owns: (name, language) => readOwned(name, language),
    consume: (name) => {
      const receipt = readReceipt(name)
      rmSync(receiptPath(receipt.name))
      return receipt
    },
    restore: (receipt) => writeReceipt(receipt)
  }
}
