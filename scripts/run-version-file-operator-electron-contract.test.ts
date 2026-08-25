import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

describe('VersionFileOperator Electron contract runner', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for process-tree termination and child exit before rejecting a timeout', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      waitForElectronContractProcess?: (
        child: EventEmitter & {
          exitCode: number | null
          signalCode: NodeJS.Signals | null
        },
        options: {
          timeoutMs: number
          terminateProcessTree: () => Promise<void>
        }
      ) => Promise<void>
    }
    expect(runner.waitForElectronContractProcess).toBeTypeOf('function')

    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    let allowTermination!: () => void
    const terminationAllowed = new Promise<void>((resolve) => {
      allowTermination = resolve
    })
    const terminateProcessTree = vi.fn(async () => {
      await terminationAllowed
      child.signalCode = 'SIGTERM'
      child.emit('exit', null, 'SIGTERM')
    })

    let settled = false
    const result = runner.waitForElectronContractProcess?.(child, {
      timeoutMs: 10,
      terminateProcessTree
    })
    void result?.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await vi.advanceTimersByTimeAsync(10)
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    allowTermination()
    await expect(result).rejects.toThrow(
      'VersionFileOperator Electron contract timed out after 10 milliseconds.'
    )
    expect(settled).toBe(true)
  })

  it('cleans runner-owned temporary roots only after a timed-out child tree exits', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      runVersionFileOperatorElectronContract?: (options: {
        prepareCacheRoot: () => Promise<void>
        createTemporaryRoot: (prefix: string) => Promise<string>
        buildContractBundle: (outputDirectory: string) => Promise<void>
        spawnElectronContract: () => EventEmitter & {
          exitCode: number | null
          signalCode: NodeJS.Signals | null
        }
        terminateProcessTree: () => Promise<void>
        processTimeoutMs: number
        addTerminationSignalHandler: () => void
        removeTerminationSignalHandler: () => void
        exitWithSignal: () => void
        removeTemporaryRoot: (path: string) => Promise<void>
      }) => Promise<void>
      waitForElectronContractProcess: (
        child: EventEmitter & {
          exitCode: number | null
          signalCode: NodeJS.Signals | null
        },
        options: {
          timeoutMs: number
          terminateProcessTree: () => Promise<void>
        }
      ) => Promise<void>
    }
    expect(runner.runVersionFileOperatorElectronContract).toBeTypeOf('function')

    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    const lifecycle: string[] = []
    let allowTermination!: () => void
    const terminationAllowed = new Promise<void>((resolve) => {
      allowTermination = resolve
    })
    const roots = ['/tmp/electron-contract-build', '/tmp/electron-contract-storage']
    const removeTemporaryRoot = vi.fn(async (path: string) => {
      lifecycle.push(`remove:${path}`)
    })
    const result = runner.runVersionFileOperatorElectronContract?.({
      prepareCacheRoot: vi.fn().mockResolvedValue(undefined),
      createTemporaryRoot: vi.fn(async () => roots.shift() as string),
      buildContractBundle: vi.fn().mockResolvedValue(undefined),
      spawnElectronContract: () => child,
      terminateProcessTree: async () => {
        lifecycle.push('terminate:start')
        await terminationAllowed
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
        lifecycle.push('terminate:exit')
      },
      processTimeoutMs: 10,
      addTerminationSignalHandler: () => undefined,
      removeTerminationSignalHandler: () => undefined,
      exitWithSignal: () => undefined,
      removeTemporaryRoot
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(lifecycle).toEqual(['terminate:start'])
    expect(removeTemporaryRoot).not.toHaveBeenCalled()

    allowTermination()
    await expect(result).rejects.toThrow(
      'VersionFileOperator Electron contract timed out after 10 milliseconds.'
    )
    expect(lifecycle).toEqual([
      'terminate:start',
      'terminate:exit',
      'remove:/tmp/electron-contract-storage',
      'remove:/tmp/electron-contract-build'
    ])
  })

  it('coalesces SIGTERM and timeout teardown before cleanup and preserves signal exit semantics', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      runVersionFileOperatorElectronContract: (options: {
        prepareCacheRoot: () => Promise<void>
        createTemporaryRoot: (prefix: string) => Promise<string>
        buildContractBundle: (outputDirectory: string) => Promise<void>
        spawnElectronContract: () => EventEmitter & {
          exitCode: number | null
          signalCode: NodeJS.Signals | null
        }
        terminateProcessTree: () => Promise<void>
        processTimeoutMs: number
        addTerminationSignalHandler: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
        removeTerminationSignalHandler: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
        exitWithSignal: (signal: 'SIGINT' | 'SIGTERM') => void
        removeTemporaryRoot: (path: string) => Promise<void>
      }) => Promise<void>
    }

    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    const handlers = new Map<NodeJS.Signals, () => void>()
    const lifecycle: string[] = []
    let allowTermination!: () => void
    const terminationAllowed = new Promise<void>((resolve) => {
      allowTermination = resolve
    })
    const terminateProcessTree = vi.fn(async () => {
      lifecycle.push('terminate:start')
      await terminationAllowed
      child.signalCode = 'SIGTERM'
      child.emit('exit', null, 'SIGTERM')
      lifecycle.push('terminate:exit')
    })
    const spawnElectronContract = vi.fn(() => child)
    const roots = ['/tmp/electron-contract-build', '/tmp/electron-contract-storage']
    const result = runner.runVersionFileOperatorElectronContract({
      prepareCacheRoot: vi.fn().mockResolvedValue(undefined),
      createTemporaryRoot: vi.fn(async () => roots.shift() as string),
      buildContractBundle: vi.fn().mockResolvedValue(undefined),
      spawnElectronContract,
      terminateProcessTree,
      processTimeoutMs: 10,
      addTerminationSignalHandler: (signal, handler) => handlers.set(signal, handler),
      removeTerminationSignalHandler: (signal, handler) => {
        if (handlers.get(signal) === handler) handlers.delete(signal)
      },
      exitWithSignal: (signal) => lifecycle.push(`signal:${signal}`),
      removeTemporaryRoot: async (path) => {
        lifecycle.push(`remove:${path}`)
      }
    })

    await vi.waitFor(() => expect(spawnElectronContract).toHaveBeenCalledOnce())
    handlers.get('SIGTERM')?.()
    handlers.get('SIGTERM')?.()
    await vi.advanceTimersByTimeAsync(10)
    expect(terminateProcessTree).toHaveBeenCalledOnce()
    expect(lifecycle).toEqual(['terminate:start'])

    allowTermination()
    await expect(result).resolves.toBeUndefined()
    expect(lifecycle).toEqual([
      'terminate:start',
      'terminate:exit',
      'remove:/tmp/electron-contract-storage',
      'remove:/tmp/electron-contract-build',
      'signal:SIGTERM'
    ])
    expect(handlers).toEqual(new Map())
  })

  it('joins signal teardown that starts during normal process-tree confirmation before cleanup', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      runVersionFileOperatorElectronContract: (options: Record<string, unknown>) => Promise<void>
    }
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    const handlers = new Map<NodeJS.Signals, () => void>()
    const lifecycle: string[] = []
    let allowConfirmation!: () => void
    const confirmationAllowed = new Promise<void>((resolve) => {
      allowConfirmation = resolve
    })
    let allowTermination!: () => void
    const terminationAllowed = new Promise<void>((resolve) => {
      allowTermination = resolve
    })
    const roots = ['/tmp/electron-contract-build', '/tmp/electron-contract-storage']
    const result = runner.runVersionFileOperatorElectronContract({
      prepareCacheRoot: vi.fn().mockResolvedValue(undefined),
      createTemporaryRoot: vi.fn(async () => roots.shift() as string),
      buildContractBundle: vi.fn().mockResolvedValue(undefined),
      spawnElectronContract: () => {
        queueMicrotask(() => {
          child.exitCode = 0
          child.emit('exit', 0, null)
        })
        return child
      },
      confirmProcessTreeExit: async () => {
        lifecycle.push('confirm:start')
        await confirmationAllowed
        lifecycle.push('confirm:exit')
      },
      terminateProcessTree: async () => {
        lifecycle.push('terminate:start')
        await terminationAllowed
        lifecycle.push('terminate:exit')
      },
      addTerminationSignalHandler: (signal: NodeJS.Signals, handler: () => void) =>
        handlers.set(signal, handler),
      removeTerminationSignalHandler: (signal: NodeJS.Signals, handler: () => void) => {
        if (handlers.get(signal) === handler) handlers.delete(signal)
      },
      exitWithSignal: (signal: NodeJS.Signals) => lifecycle.push(`signal:${signal}`),
      removeTemporaryRoot: async (path: string) => {
        lifecycle.push(`remove:${path}`)
      }
    })

    await vi.waitFor(() => expect(lifecycle).toContain('confirm:start'))
    handlers.get('SIGTERM')?.()
    await vi.waitFor(() => expect(lifecycle).toContain('terminate:start'))
    allowConfirmation()
    await new Promise((resolve) => setImmediate(resolve))
    const lifecycleBeforeTerminationExit = [...lifecycle]

    allowTermination()
    await expect(result).resolves.toBeUndefined()
    expect(lifecycleBeforeTerminationExit).toEqual([
      'confirm:start',
      'terminate:start',
      'confirm:exit'
    ])
    expect(lifecycle).toEqual([
      'confirm:start',
      'terminate:start',
      'confirm:exit',
      'terminate:exit',
      'remove:/tmp/electron-contract-storage',
      'remove:/tmp/electron-contract-build',
      'signal:SIGTERM'
    ])
    expect(handlers).toEqual(new Map())
  })

  it('polls until a SIGKILLed POSIX process group disappears', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      waitForPosixProcessGroupExit?: (
        pid: number,
        options: {
          processGroupExists: (pid: number) => boolean
          delay: (milliseconds: number) => Promise<void>
          timeoutMs: number
          pollIntervalMs: number
        }
      ) => Promise<void>
    }
    expect(runner.waitForPosixProcessGroupExit).toBeTypeOf('function')

    const states = [true, true, false]
    const processGroupExists = vi.fn(() => states.shift() as boolean)
    const delay = vi.fn().mockResolvedValue(undefined)

    await expect(
      runner.waitForPosixProcessGroupExit?.(4242, {
        processGroupExists,
        delay,
        timeoutMs: 20,
        pollIntervalMs: 10
      })
    ).resolves.toBeUndefined()
    expect(processGroupExists).toHaveBeenCalledTimes(3)
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it('fails after the bounded POSIX process-group disappearance poll is exhausted', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      waitForPosixProcessGroupExit: (
        pid: number,
        options: {
          processGroupExists: () => boolean
          delay: () => Promise<void>
          timeoutMs: number
          pollIntervalMs: number
        }
      ) => Promise<void>
    }
    const processGroupExists = vi.fn(() => true)
    const delay = vi.fn().mockResolvedValue(undefined)

    await expect(
      runner.waitForPosixProcessGroupExit(4242, {
        processGroupExists,
        delay,
        timeoutMs: 20,
        pollIntervalMs: 10
      })
    ).rejects.toThrow(
      'Unable to confirm Electron contract process group 4242 exited after SIGKILL.'
    )
    expect(processGroupExists).toHaveBeenCalledTimes(3)
    expect(delay).toHaveBeenCalledTimes(2)
  })

  it('bounds the POSIX wrapper exit wait after escalating its process group', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      terminatePosixProcessTree?: (
        child: EventEmitter & {
          pid: number
          exitCode: number | null
          signalCode: NodeJS.Signals | null
        },
        options: {
          signalProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => boolean
          waitForExitWithin: () => Promise<boolean>
          waitForProcessGroupExit: () => Promise<void>
          terminationTimeoutMs: number
        }
      ) => Promise<void>
    }
    expect(runner.terminatePosixProcessTree).toBeTypeOf('function')

    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    const waitForExitWithin = vi.fn().mockResolvedValue(false)
    const waitForProcessGroupExit = vi.fn().mockResolvedValue(undefined)

    await expect(
      runner.terminatePosixProcessTree?.(child, {
        signalProcessGroup: vi.fn(() => true),
        waitForExitWithin,
        waitForProcessGroupExit,
        terminationTimeoutMs: 10
      })
    ).rejects.toThrow('Unable to confirm Electron contract wrapper 4242 exited after SIGKILL.')
    expect(waitForExitWithin).toHaveBeenCalledTimes(2)
    expect(waitForProcessGroupExit).not.toHaveBeenCalled()
  })

  it('bounds Windows taskkill and wrapper exit waits when taskkill hangs', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      terminateWindowsProcessTree?: (
        child: EventEmitter & {
          pid: number
          exitCode: number | null
          signalCode: NodeJS.Signals | null
          kill: ReturnType<typeof vi.fn>
        },
        options: {
          spawnTaskkill: () => EventEmitter & {
            exitCode: number | null
            signalCode: NodeJS.Signals | null
            kill: ReturnType<typeof vi.fn>
          }
          waitForExitWithin: () => Promise<boolean>
          terminationTimeoutMs: number
        }
      ) => Promise<void>
    }
    expect(runner.terminateWindowsProcessTree).toBeTypeOf('function')

    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn()
    })
    const taskkill = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn()
    })
    const waitForExitWithin = vi.fn().mockResolvedValue(false)

    await expect(
      runner.terminateWindowsProcessTree?.(child, {
        spawnTaskkill: () => taskkill,
        waitForExitWithin,
        terminationTimeoutMs: 10
      })
    ).rejects.toThrow('Unable to confirm Electron contract process-tree exit: taskkill.exe hung.')
    expect(taskkill.kill).toHaveBeenCalledOnce()
    expect(child.kill).toHaveBeenCalledOnce()
    expect(waitForExitWithin).toHaveBeenCalledTimes(3)
  })

  it('treats a signal-terminated Windows taskkill as an unconfirmed process tree', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      terminateWindowsProcessTree: (
        child: EventEmitter & {
          pid: number
          exitCode: number | null
          signalCode: NodeJS.Signals | null
          kill: ReturnType<typeof vi.fn>
        },
        options: Record<string, unknown>
      ) => Promise<void>
    }
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: 0,
      signalCode: null as NodeJS.Signals | null,
      kill: vi.fn()
    })
    const taskkill = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: 'SIGTERM' as NodeJS.Signals | null,
      kill: vi.fn()
    })

    await expect(
      runner.terminateWindowsProcessTree(child, {
        spawnTaskkill: () => taskkill,
        waitForExitWithin: vi.fn().mockResolvedValue(true),
        terminationTimeoutMs: 10
      })
    ).rejects.toMatchObject({
      message:
        'Unable to confirm Electron contract process-tree exit: taskkill.exe exited with signal SIGTERM.',
      treeExitUnconfirmed: true
    })
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('preserves roots when a normally exited POSIX wrapper leaves its process group alive', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      runVersionFileOperatorElectronContract: (options: Record<string, unknown>) => Promise<void>
    }
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    const removeTemporaryRoot = vi.fn().mockResolvedValue(undefined)
    const roots = ['/tmp/electron-contract-build', '/tmp/electron-contract-storage']

    const result = runner.runVersionFileOperatorElectronContract({
      prepareCacheRoot: vi.fn().mockResolvedValue(undefined),
      createTemporaryRoot: vi.fn(async () => roots.shift() as string),
      buildContractBundle: vi.fn().mockResolvedValue(undefined),
      spawnElectronContract: () => {
        queueMicrotask(() => {
          child.exitCode = 0
          child.emit('exit', 0, null)
        })
        return child
      },
      confirmProcessTreeExit: async () => {
        throw new Error('POSIX process group 4242 is still alive.')
      },
      addTerminationSignalHandler: () => undefined,
      removeTerminationSignalHandler: () => undefined,
      exitWithSignal: vi.fn(),
      removeTemporaryRoot
    })

    await expect(result).rejects.toThrow('POSIX process group 4242 is still alive.')
    expect(removeTemporaryRoot).not.toHaveBeenCalled()
  })

  it('confirms normal Windows completion from the bounded Electron wrapper exit only', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      confirmElectronContractProcessTreeExit?: (
        child: EventEmitter & {
          pid: number
          exitCode: number | null
          signalCode: NodeJS.Signals | null
        },
        options: {
          platform: NodeJS.Platform
          waitForExitWithin: () => Promise<boolean>
          waitForProcessGroupExit: () => Promise<void>
          confirmationTimeoutMs: number
        }
      ) => Promise<void>
    }
    expect(runner.confirmElectronContractProcessTreeExit).toBeTypeOf('function')

    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: 0,
      signalCode: null as NodeJS.Signals | null
    })
    const waitForExitWithin = vi.fn().mockResolvedValue(true)
    const waitForProcessGroupExit = vi.fn().mockResolvedValue(undefined)

    await expect(
      runner.confirmElectronContractProcessTreeExit?.(child, {
        platform: 'win32',
        waitForExitWithin,
        waitForProcessGroupExit,
        confirmationTimeoutMs: 10
      })
    ).resolves.toBeUndefined()
    expect(waitForExitWithin).toHaveBeenCalledOnce()
    expect(waitForProcessGroupExit).not.toHaveBeenCalled()
  })

  it('preserves temporary roots when process-tree exit cannot be confirmed', async () => {
    const runner = (await import('./run-version-file-operator-electron-contract.mjs')) as {
      runVersionFileOperatorElectronContract: (options: Record<string, unknown>) => Promise<void>
    }
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null
    })
    const handlers = new Map<NodeJS.Signals, () => void>()
    const removeTemporaryRoot = vi.fn().mockResolvedValue(undefined)
    const exitWithSignal = vi.fn()
    const reportFailure = vi.fn()
    const spawnElectronContract = vi.fn(() => child)
    const roots = ['/tmp/electron-contract-build', '/tmp/electron-contract-storage']
    const result = runner.runVersionFileOperatorElectronContract({
      prepareCacheRoot: vi.fn().mockResolvedValue(undefined),
      createTemporaryRoot: vi.fn(async () => roots.shift() as string),
      buildContractBundle: vi.fn().mockResolvedValue(undefined),
      spawnElectronContract,
      terminateProcessTree: async () => {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
        throw new Error('Unable to confirm Electron contract process-tree exit.')
      },
      addTerminationSignalHandler: (signal: NodeJS.Signals, handler: () => void) =>
        handlers.set(signal, handler),
      removeTerminationSignalHandler: (signal: NodeJS.Signals, handler: () => void) => {
        if (handlers.get(signal) === handler) handlers.delete(signal)
      },
      exitWithSignal,
      reportFailure,
      removeTemporaryRoot
    })

    await vi.waitFor(() => expect(spawnElectronContract).toHaveBeenCalledOnce())
    handlers.get('SIGINT')?.()

    await expect(result).resolves.toBeUndefined()
    expect(removeTemporaryRoot).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Unable to confirm Electron contract process-tree exit.'
      })
    )
    expect(exitWithSignal).toHaveBeenCalledWith('SIGINT')
    expect(handlers).toEqual(new Map())
  })
})
