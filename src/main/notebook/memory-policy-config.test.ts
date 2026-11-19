import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_NOTEBOOK_MEMORY_POLICY,
  loadNotebookMemoryPolicyConfig,
  NOTEBOOK_MEMORY_POLICY_CONFIG_FILE
} from './memory-policy-config'

const makeRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), 'open-science-memory-policy-'))

describe('loadNotebookMemoryPolicyConfig', () => {
  it('uses certified defaults when no optional file exists', async () => {
    const root = await makeRoot()
    try {
      await expect(loadNotebookMemoryPolicyConfig(root)).resolves.toEqual({
        policy: DEFAULT_NOTEBOOK_MEMORY_POLICY,
        source: 'default'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads bounded optional thresholds and ignores unknown fields', async () => {
    const root = await makeRoot()
    try {
      await writeFile(
        join(root, NOTEBOOK_MEMORY_POLICY_CONFIG_FILE),
        JSON.stringify({
          windowsEnterRatio: 0.12,
          windowsExitRatio: 0.31,
          linuxEnterRatio: 0.11,
          linuxExitRatio: 0.29,
          macNormalRecoveryMs: 30_000,
          ignoredFutureField: true
        })
      )

      await expect(loadNotebookMemoryPolicyConfig(root)).resolves.toEqual({
        policy: {
          windowsEnterRatio: 0.12,
          windowsExitRatio: 0.31,
          linuxEnterRatio: 0.11,
          linuxExitRatio: 0.29,
          macNormalRecoveryMs: 30_000
        },
        source: 'file'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to defaults for malformed or unsafe values', async () => {
    const root = await makeRoot()
    try {
      await mkdir(root, { recursive: true })
      await writeFile(
        join(root, NOTEBOOK_MEMORY_POLICY_CONFIG_FILE),
        JSON.stringify({ windowsEnterRatio: 0.4, windowsExitRatio: 0.2 })
      )

      await expect(loadNotebookMemoryPolicyConfig(root)).resolves.toEqual({
        policy: DEFAULT_NOTEBOOK_MEMORY_POLICY,
        source: 'fallback',
        diagnostic: 'invalid-values'
      })

      await writeFile(join(root, NOTEBOOK_MEMORY_POLICY_CONFIG_FILE), '{broken')
      await expect(loadNotebookMemoryPolicyConfig(root)).resolves.toEqual({
        policy: DEFAULT_NOTEBOOK_MEMORY_POLICY,
        source: 'fallback',
        diagnostic: 'invalid-json'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
