import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ComputeAccountStatus,
  ComputeAccountProvider
} from '../../../../shared/compute-accounts'
import type {
  ComputeAccountOperation,
  ComputePythonFailure,
  ComputePythonSelection,
  ComputePythonSnapshot
} from '../../../../shared/compute-python-runtime'
import type { ComputeAccountController } from './use-compute-account'

type SignIn = 'connectAccount' | 'useLocalAccount'
type EnvironmentFailure = Exclude<ComputePythonFailure, 'cancelled' | 'runtime-stale'>
export type ComputePythonEnvironment = {
  snapshot?: ComputePythonSnapshot
  selection: ComputePythonSelection
  phase: 'loading' | 'idle' | 'checking' | 'preparing' | 'ready' | 'error'
  error?: EnvironmentFailure
  load: () => Promise<void>
  select: (selection: ComputePythonSelection) => Promise<void>
  signIn: (method: SignIn) => Promise<ComputeAccountStatus | undefined>
  cancel: () => void
  retrySelection: boolean
  blocked: boolean
}
export function useComputePythonEnvironment(
  provider: ComputeAccountProvider,
  account: ComputeAccountController
): ComputePythonEnvironment {
  const [snapshot, setSnapshot] = useState<ComputePythonSnapshot>()
  const [selection, setSelection] = useState<ComputePythonSelection>({ kind: 'managed' })
  const [phase, setPhase] = useState<
    'loading' | 'idle' | 'checking' | 'preparing' | 'ready' | 'error'
  >('loading')
  const [error, setError] = useState<EnvironmentFailure>()
  const request = useRef<ComputeAccountOperation>({ operationId: '', revision: 0 })
  const live = useRef(true)
  const [failedSelection, setFailedSelection] = useState(false)
  const readGeneration = useRef(0)
  const run = account.run
  const load = useCallback(async (): Promise<void> => {
    const generation = ++readGeneration.current
    await Promise.resolve()
    if (!live.current || readGeneration.current !== generation) return
    setPhase('loading')
    setError(undefined)
    setFailedSelection(false)
    try {
      const next = await window.api.compute.getComputePythonRuntime(provider)
      if (!live.current || readGeneration.current !== generation) return
      request.current.revision = next.revision
      setSnapshot(next)
      setSelection(next.selection)
      setPhase('idle')
    } catch {
      if (live.current && readGeneration.current === generation) {
        setSnapshot(undefined)
        setError('dependency')
        setPhase('error')
      }
    }
  }, [provider])
  useEffect(() => {
    live.current = true
    const reads = readGeneration
    let disposed = false
    queueMicrotask(() => {
      if (!disposed) void load()
    })
    return () => {
      disposed = true
      live.current = false
      reads.current++
      queueMicrotask(() => {
        if (!live.current && request.current.operationId)
          void run('cancelAccountConnection', request.current)
      })
    }
  }, [load, run])
  const cancel = (): void => {
    // A new intent also retires any recovery snapshot still in flight.
    readGeneration.current++
    const previous = request.current
    request.current = { ...previous, operationId: '' }
    if (previous.operationId) void account.run('cancelAccountConnection', previous)
  }
  const begin = (): ComputeAccountOperation => {
    cancel()
    const next = { operationId: crypto.randomUUID(), revision: request.current.revision }
    request.current = next
    setError(undefined)
    return next
  }
  const current = (op: ComputeAccountOperation): boolean => live.current && request.current === op
  const select = async (next: ComputePythonSelection): Promise<void> => {
    if (!live.current) return
    const op = begin()
    setSelection(next)
    setPhase('checking')
    setFailedSelection(true)
    try {
      const result = await window.api.compute.selectComputePythonRuntime(provider, {
        ...op,
        selection: next
      })
      if (!current(op)) return
      request.current.revision = result.revision
      if (result.runtimeError === 'cancelled' || result.runtimeError === 'runtime-stale') {
        await load()
        return
      }
      setError(result.runtimeError)
      setPhase(result.runtimeError ? 'error' : 'ready')
      setFailedSelection(!!result.runtimeError)
    } catch {
      if (current(op)) {
        setError('dependency')
        setPhase('error')
      }
    }
  }
  const signIn = async (method: SignIn): Promise<ComputeAccountStatus | undefined> => {
    const op = begin()
    setFailedSelection(false)
    setPhase(selection.kind === 'managed' ? 'preparing' : 'ready')
    const result = await account.run(method, op)
    if (!current(op)) return
    if (result?.runtimeError) {
      if (result.runtimeError === 'cancelled' || result.runtimeError === 'runtime-stale') {
        if (result.runtimeRevision !== undefined) request.current.revision = result.runtimeRevision
        await load()
        return
      }
      setError(result.runtimeError)
      setPhase('error')
      return
    }
    setPhase(result ? 'ready' : 'error')
    if (!result) setError('dependency')
    return result
  }
  return {
    load,
    snapshot,
    selection,
    phase,
    error,
    select,
    signIn,
    cancel,
    retrySelection: failedSelection,
    blocked:
      phase === 'loading' || phase === 'checking' || phase === 'preparing' || phase === 'error'
  }
}
