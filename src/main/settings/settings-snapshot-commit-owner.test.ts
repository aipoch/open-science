import { describe, expect, it, vi } from 'vitest'

import type { SettingsSnapshot } from '../../shared/settings'
import { SettingsSnapshotCommitOwner } from './settings-snapshot-commit-owner'

const snapshot = (): SettingsSnapshot => ({
  claude: {},
  activeProviderId: undefined,
  providers: [],
  agentFrameworkId: 'claude-code',
  agentFrameworks: [],
  opencode: {},
  codex: {},
  codebuddy: {},
  claudeManaged: false,
  opencodeManaged: false,
  codexManaged: false,
  codebuddyManaged: false,
  reasoningEffort: 'default',
  notificationsEnabled: true,
  conversationSkillImportEnabled: true,
  appIconVariant: 'light'
})

describe('SettingsSnapshotCommitOwner', () => {
  it('preserves real operation errors and allows projection recovery after publication fails', async () => {
    const current = snapshot()
    const read = vi.fn().mockResolvedValue(current)
    const failure = new Error('apply failed')
    const publish = vi.fn().mockImplementationOnce(() => {
      throw new Error('publication failed')
    })
    const owner = new SettingsSnapshotCommitOwner({ getSettingsView: read }, { publish })

    await expect(owner.projectAfter(Promise.reject(failure))).rejects.toBe(failure)
    expect(read).not.toHaveBeenCalled()
    await expect(owner.projectAfter(Promise.resolve('saved'))).resolves.toBe('saved')
    await expect(owner.readCurrentSnapshot()).resolves.toBe(current)
    await expect(owner.projectAfter(Promise.resolve('saved again'))).resolves.toBe('saved again')
    expect(publish).toHaveBeenCalledTimes(2)
  })
  it('assigns monotonic revisions to distinct committed projections', async () => {
    const first = snapshot()
    const second = snapshot()
    const publish = vi.fn()
    const owner = new SettingsSnapshotCommitOwner(
      { getSettingsView: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second) },
      { publish }
    )

    await expect(owner.currentSnapshotAfter(Promise.resolve())).resolves.toBe(first)
    await expect(owner.currentSnapshotAfter(Promise.resolve())).resolves.toBe(second)

    expect(first.revision).toBe(1)
    expect(second.revision).toBe(2)
    expect(publish).toHaveBeenNthCalledWith(1, 'settings:changed', first)
    expect(publish).toHaveBeenNthCalledWith(2, 'settings:changed', second)
  })

  it('returns the current revision without publishing a new commit', async () => {
    const initial = snapshot()
    const committed = snapshot()
    const current = snapshot()
    const publish = vi.fn()
    const owner = new SettingsSnapshotCommitOwner(
      {
        getSettingsView: vi
          .fn()
          .mockResolvedValueOnce(initial)
          .mockResolvedValueOnce(committed)
          .mockResolvedValueOnce(current)
      },
      { publish }
    )

    await expect(owner.readCurrentSnapshot()).resolves.toBe(initial)
    await owner.currentSnapshotAfter(Promise.resolve())
    await expect(owner.readCurrentSnapshot()).resolves.toBe(current)

    expect(initial.revision).toBe(0)
    expect(committed.revision).toBe(1)
    expect(current.revision).toBe(1)
    expect(publish).toHaveBeenCalledOnce()
  })
})
