import { describe, expect, it, vi } from 'vitest'

import type { LocalShellRuntimeMutation } from '../local-shell-runtime-mutation'
import { LocalShellSettingsWorkflows } from './local-shell'

const deferred = <T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} => {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const powerShellResult = {
  runtimeBinding: { kind: 'powershell' as const, version: '5.1' as const },
  appliesTo: 'subsequent-executions' as const,
  wslProfilePreserved: true
}

const wslResult = {
  runtime: 'wsl2-bash' as const,
  selection: { distro: 'Ubuntu-22.04', user: 'scientist' },
  appliesTo: 'subsequent-executions' as const
}

const mutation = (
  revision: number,
  runtime: LocalShellRuntimeMutation['runtime'],
  previous: LocalShellRuntimeMutation['previous']
): LocalShellRuntimeMutation => ({ revision, runtime, previous })

describe('LocalShellSettingsWorkflows', () => {
  it('persists PowerShell and waits for every live Session capability to refresh', async () => {
    const actions: string[] = []
    const refresh = deferred()
    const write = { result: powerShellResult, mutation: mutation(1, 'powershell', 'wsl2-bash') }
    const settings = {
      switchLocalShellToPowerShell: vi.fn(async () => {
        actions.push('persist')
        return write
      }),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn()
    }
    const requestShellRuntimeRefresh = vi.fn(async () => {
      actions.push('refresh')
      await refresh.promise
    })
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

    let settled = false
    const switching = workflows.switchToPowerShell().finally(() => {
      settled = true
    })
    await vi.waitFor(() => expect(requestShellRuntimeRefresh).toHaveBeenCalledOnce())

    expect(actions).toEqual(['persist', 'refresh'])
    expect(settled).toBe(false)

    refresh.resolve()
    await expect(switching).resolves.toBe(powerShellResult)
  })

  it('does not refresh capabilities when the preference cannot be saved', async () => {
    const failure = new Error('disk full')
    const requestShellRuntimeRefresh = vi.fn()
    const workflows = new LocalShellSettingsWorkflows(
      {
        switchLocalShellToPowerShell: vi.fn(async () => {
          throw failure
        }),
        useWsl2Bash: vi.fn(),
        restoreLocalShellRuntimePreference: vi.fn()
      },
      { requestShellRuntimeRefresh: async () => requestShellRuntimeRefresh() }
    )

    await expect(workflows.switchToPowerShell()).rejects.toBe(failure)
    expect(requestShellRuntimeRefresh).not.toHaveBeenCalled()
  })

  it('enables only the service-validated WSL2 profile and refreshes subsequent capabilities', async () => {
    const write = { result: wslResult, mutation: mutation(2, 'wsl2-bash', 'powershell') }
    const settings = {
      switchLocalShellToPowerShell: vi.fn(),
      useWsl2Bash: vi.fn(async () => write),
      restoreLocalShellRuntimePreference: vi.fn()
    }
    const requestShellRuntimeRefresh = vi.fn(async () => undefined)
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

    await expect(workflows.useWsl2Bash()).resolves.toBe(wslResult)

    expect(settings.useWsl2Bash).toHaveBeenCalledOnce()
    expect(requestShellRuntimeRefresh).toHaveBeenCalledOnce()
  })

  it('rolls back by mutation identity and refreshes again before exposing failure', async () => {
    const refreshFailure = new Error('refresh failed')
    const actions: string[] = []
    const receipt = mutation(3, 'powershell', 'wsl2-bash')
    const settings = {
      switchLocalShellToPowerShell: vi.fn(async () => ({
        result: powerShellResult,
        mutation: receipt
      })),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn(async () => {
        actions.push('rollback')
        return true
      })
    }
    const requestShellRuntimeRefresh = vi
      .fn()
      .mockImplementationOnce(async () => {
        actions.push('refresh:new')
        throw refreshFailure
      })
      .mockImplementationOnce(async () => {
        actions.push('refresh:rollback')
      })
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

    await expect(workflows.switchToPowerShell()).rejects.toBe(refreshFailure)
    expect(settings.restoreLocalShellRuntimePreference).toHaveBeenCalledWith(receipt)
    expect(actions).toEqual(['refresh:new', 'rollback', 'refresh:rollback'])
  })

  it.each([
    ['same target', 'powershell' as const],
    ['different target', 'wsl2-bash' as const]
  ])(
    'serializes %s switches so an older failure cannot overwrite a later success',
    async (_, second) => {
      const firstRefresh = deferred()
      const actions: string[] = []
      let revision = 0
      const settings = {
        switchLocalShellToPowerShell: vi.fn(async () => {
          actions.push('persist:powershell')
          return {
            result: powerShellResult,
            mutation: mutation(++revision, 'powershell', 'wsl2-bash')
          }
        }),
        useWsl2Bash: vi.fn(async () => {
          actions.push('persist:wsl2-bash')
          return { result: wslResult, mutation: mutation(++revision, 'wsl2-bash', 'powershell') }
        }),
        restoreLocalShellRuntimePreference: vi.fn(async () => {
          actions.push('rollback')
          return true
        })
      }
      const requestShellRuntimeRefresh = vi
        .fn()
        .mockImplementationOnce(async () => {
          actions.push('refresh:first')
          await firstRefresh.promise
          throw new Error('first refresh failed')
        })
        .mockImplementationOnce(async () => {
          actions.push('refresh:rollback')
        })
        .mockImplementationOnce(async () => {
          actions.push('refresh:second')
        })
      const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

      const first = workflows.switchToPowerShell()
      await vi.waitFor(() => expect(actions).toContain('refresh:first'))
      const later =
        second === 'powershell' ? workflows.switchToPowerShell() : workflows.useWsl2Bash()

      expect(actions.filter((action) => action === `persist:${second}`)).toHaveLength(
        second === 'powershell' ? 1 : 0
      )
      firstRefresh.resolve()
      await expect(first).rejects.toThrow('first refresh failed')
      await expect(later).resolves.toBe(second === 'powershell' ? powerShellResult : wslResult)
      expect(actions).toEqual([
        'persist:powershell',
        'refresh:first',
        'rollback',
        'refresh:rollback',
        `persist:${second}`,
        'refresh:second'
      ])
    }
  )

  it('retires a generation admitted while the failed refresh was rejecting before the next prompt', async () => {
    let preference: 'powershell' | 'wsl2-bash' = 'wsl2-bash'
    let liveGeneration: string = preference
    const receipt = mutation(4, 'powershell', 'wsl2-bash')
    const settings = {
      switchLocalShellToPowerShell: vi.fn(async () => {
        preference = 'powershell'
        return { result: powerShellResult, mutation: receipt }
      }),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn(async () => {
        preference = 'wsl2-bash'
        return true
      })
    }
    const requestShellRuntimeRefresh = vi
      .fn()
      .mockImplementationOnce(async () => {
        liveGeneration = preference
        throw new Error('retirement rejected after a lazy generation was admitted')
      })
      .mockImplementationOnce(async () => {
        liveGeneration = preference
      })
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

    await expect(workflows.switchToPowerShell()).rejects.toThrow('retirement rejected')

    expect(liveGeneration).toBe('wsl2-bash')
    expect(requestShellRuntimeRefresh).toHaveBeenCalledTimes(2)
  })

  it('reports both failures when the rollback refresh also rejects', async () => {
    const initialFailure = new Error('initial refresh failed')
    const rollbackRefreshFailure = new Error('rollback refresh failed')
    const receipt = mutation(5, 'powershell', 'wsl2-bash')
    const settings = {
      switchLocalShellToPowerShell: vi.fn(async () => ({
        result: powerShellResult,
        mutation: receipt
      })),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn(async () => true)
    }
    const requestShellRuntimeRefresh = vi
      .fn()
      .mockRejectedValueOnce(initialFailure)
      .mockRejectedValueOnce(rollbackRefreshFailure)
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })

    const failure = await workflows.switchToPowerShell().catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect(failure).toMatchObject({
      message: 'Shell capability refresh failed while restoring the saved preference.',
      errors: [initialFailure, rollbackRefreshFailure]
    })
  })

  it('restores the previously activated WSL profile when activating a ready candidate fails', async () => {
    const activeA = { distro: 'Ubuntu-A', user: 'active' }
    const candidateB = { distro: 'Ubuntu-B', user: 'candidate' }
    let activeProfile = activeA
    const receipt: LocalShellRuntimeMutation = {
      revision: 6,
      runtime: 'wsl2-bash',
      previous: 'wsl2-bash',
      previousActivatedWslSelection: activeA
    }
    const settings = {
      switchLocalShellToPowerShell: vi.fn(),
      useWsl2Bash: vi.fn(async () => {
        activeProfile = candidateB
        return {
          result: { ...wslResult, selection: candidateB },
          mutation: receipt
        }
      }),
      restoreLocalShellRuntimePreference: vi.fn(async (mutationToRestore) => {
        activeProfile = mutationToRestore.previousActivatedWslSelection ?? activeProfile
        return true
      })
    }
    const workflows = new LocalShellSettingsWorkflows(settings, {
      requestShellRuntimeRefresh: vi
        .fn()
        .mockRejectedValueOnce(new Error('refresh failed'))
        .mockResolvedValueOnce(undefined)
    })

    await expect(workflows.useWsl2Bash()).rejects.toThrow('refresh failed')

    expect(activeProfile).toEqual(activeA)
    expect(settings.restoreLocalShellRuntimePreference).toHaveBeenCalledWith(receipt)
  })
})

it('falls back and refreshes live capabilities after the active distro is unregistered', async () => {
  const settings = {
    switchLocalShellToPowerShell: vi.fn(async () => ({
      result: powerShellResult,
      mutation: mutation(1, 'powershell', 'wsl2-bash')
    })),
    useWsl2Bash: vi.fn(),
    restoreLocalShellRuntimePreference: vi.fn()
  }
  const requestShellRuntimeRefresh = vi.fn(async () => {})
  const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })
  await expect(
    workflows.fallbackAfterWslProbe(
      {
        state: 'distro-required',
        distros: [],
        errorCode: 'wsl_distro_missing',
        operationReference: 'removed'
      },
      async () => ({ localShellRuntime: 'wsl2-bash', activatedWslSelection: wslResult.selection })
    )
  ).resolves.toBe(true)
  expect(settings.switchLocalShellToPowerShell).toHaveBeenCalledOnce()
  expect(requestShellRuntimeRefresh).toHaveBeenCalledOnce()
})

it.each(['candidate-missing', 'transient-failure', 'already-powershell'] as const)(
  'does not switch the active runtime for %s',
  async (scenario) => {
    const settings = {
      switchLocalShellToPowerShell: vi.fn(),
      useWsl2Bash: vi.fn(),
      restoreLocalShellRuntimePreference: vi.fn()
    }
    const requestShellRuntimeRefresh = vi.fn()
    const workflows = new LocalShellSettingsWorkflows(settings, { requestShellRuntimeRefresh })
    await expect(
      workflows.fallbackAfterWslProbe(
        {
          state: 'failed',
          operationReference: 'probe',
          errorCode: scenario === 'transient-failure' ? 'wsl_probe_failed' : 'wsl_distro_not_found',
          distros:
            scenario === 'candidate-missing'
              ? [{ name: wslResult.selection.distro, version: 2, isDefault: true }]
              : []
        },
        async () => ({
          localShellRuntime: scenario === 'already-powershell' ? 'powershell' : 'wsl2-bash',
          activatedWslSelection: wslResult.selection
        })
      )
    ).resolves.toBe(false)
    expect(settings.switchLocalShellToPowerShell).not.toHaveBeenCalled()
    expect(requestShellRuntimeRefresh).not.toHaveBeenCalled()
  }
)
