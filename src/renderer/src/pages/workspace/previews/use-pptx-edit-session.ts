import { useCallback, useEffect, useRef, useState } from 'react'

import type { ManagedFileIdentity } from '../../../../../shared/managed-file-versions'
import type { SaveTextEditResult } from '../../../../../shared/managed-file-versions'
import type { PptxOperation } from '../../../../../shared/pptx-edit'
import type { PptxEditSessionView } from '../../../../../shared/pptx-edit-session'
import {
  EMPTY_PPTX_EDIT_STATE,
  isPptxEditDirty,
  pushOperation,
  pushOperations,
  redoOperation,
  undoOperation,
  type PptxEditState
} from './pptx-edit-state'

type PptxEditSessionOptions = {
  identity: ManagedFileIdentity | undefined
  // The version the edit is based on, and the head the save must still match.
  baseVersionId: string | undefined
  headVersionId: string | undefined
}

type PptxEditPhase = 'idle' | 'opening' | 'ready' | 'saving'

type PptxEditSaveOutcome =
  | { kind: 'saved'; result: Extract<SaveTextEditResult, { kind: 'created' | 'noop' }> }
  | { kind: 'conflict'; result: Extract<SaveTextEditResult, { kind: 'conflict' }> }
  | { kind: 'failed' }

type PptxEditFailure = 'too-large' | 'error'

type PptxEditSession = {
  phase: PptxEditPhase
  view: PptxEditSessionView | undefined
  state: PptxEditState
  failed: boolean
  // Distinguishes an output over the size limit (usually a large replacement image).
  failure: PptxEditFailure | undefined
  dirty: boolean
  // The session edits a historical version, so saving even without edits restores it.
  restoring: boolean
  // A newer head appeared after the session opened; saving would conflict until rebased.
  headMoved: boolean
  canUndo: boolean
  canRedo: boolean
  begin: () => Promise<boolean>
  discard: () => void
  addOperation: (operation: PptxOperation) => Promise<boolean>
  addOperations: (operations: readonly PptxOperation[]) => Promise<boolean>
  undo: () => Promise<boolean>
  redo: () => Promise<boolean>
  save: () => Promise<PptxEditSaveOutcome>
  // Replays the pending operations onto another version; the current session stays on failure.
  rebase: (versionId: string) => Promise<boolean>
}

const usePptxEditSession = ({
  identity,
  baseVersionId,
  headVersionId
}: PptxEditSessionOptions): PptxEditSession => {
  const [phase, setPhase] = useState<PptxEditPhase>('idle')
  const [view, setView] = useState<PptxEditSessionView | undefined>()
  const [state, setState] = useState<PptxEditState>(EMPTY_PPTX_EDIT_STATE)
  const [failure, setFailure] = useState<PptxEditFailure>()
  // The base the session replays onto and the head a save must still match, fixed at open.
  const [pinned, setPinned] = useState<{ base: string; head: string }>()
  const sessionIdRef = useRef<string | undefined>(undefined)
  const sequenceRef = useRef(0)
  const pendingSaveRef = useRef<{ key: string; operationId: string } | undefined>(undefined)
  const stateRef = useRef<PptxEditState>(EMPTY_PPTX_EDIT_STATE)

  const release = useCallback((): void => {
    sequenceRef.current += 1
    stateRef.current = EMPTY_PPTX_EDIT_STATE
    const sessionId = sessionIdRef.current
    sessionIdRef.current = undefined
    pendingSaveRef.current = undefined
    if (sessionId) void window.api.pptxEdit.close(sessionId).catch(() => undefined)
  }, [])

  const discard = useCallback((): void => {
    release()
    setPhase('idle')
    setView(undefined)
    setState(EMPTY_PPTX_EDIT_STATE)
    setFailure(undefined)
    setPinned(undefined)
  }, [release])

  useEffect(() => release, [release])

  const begin = useCallback(async (): Promise<boolean> => {
    if (!identity || !baseVersionId || !headVersionId || sessionIdRef.current) return false
    const sequence = ++sequenceRef.current
    setPhase('opening')
    setFailure(undefined)
    try {
      const result = await window.api.pptxEdit.open({ ...identity, versionId: baseVersionId })
      if (sequenceRef.current !== sequence) {
        if (result.ok) void window.api.pptxEdit.close(result.value.sessionId).catch(() => undefined)
        return false
      }
      if (!result.ok) throw new Error(result.error.code)
      sessionIdRef.current = result.value.sessionId
      stateRef.current = EMPTY_PPTX_EDIT_STATE
      setPinned({ base: baseVersionId, head: headVersionId })
      setView(result.value)
      setState(EMPTY_PPTX_EDIT_STATE)
      setPhase('ready')
      return true
    } catch {
      if (sequenceRef.current === sequence) {
        setPhase('idle')
        setFailure('error')
      }
      return false
    }
  }, [baseVersionId, headVersionId, identity])

  const chainRef = useRef<Promise<unknown>>(Promise.resolve())

  // Replays are serialized so revisions reach the preview in the order the user made them.
  const commit = useCallback((next: PptxEditState): Promise<boolean> => {
    const previous = stateRef.current
    const sessionId = sessionIdRef.current
    if (!sessionId || next === previous) return Promise.resolve(false)
    const sequence = sequenceRef.current
    stateRef.current = next
    setState(next)
    const run = async (): Promise<boolean> => {
      if (sequenceRef.current !== sequence) return false
      try {
        const result = await window.api.pptxEdit.apply({
          sessionId,
          operations: next.operations as PptxOperation[]
        })
        if (sequenceRef.current !== sequence) return false
        if (!result.ok) throw new Error(result.error.code)
        setView(result.value)
        setFailure(undefined)
        return true
      } catch (error) {
        if (sequenceRef.current !== sequence) return false
        stateRef.current = previous
        setState(previous)
        setFailure(error instanceof Error && error.message === 'TOO_LARGE' ? 'too-large' : 'error')
        return false
      }
    }
    const settled = chainRef.current.then(run, run)
    chainRef.current = settled
    return settled
  }, [])

  const addOperation = useCallback(
    (operation: PptxOperation) => commit(pushOperation(stateRef.current, operation)),
    [commit]
  )
  const addOperations = useCallback(
    (operations: readonly PptxOperation[]) => commit(pushOperations(stateRef.current, operations)),
    [commit]
  )
  const undo = useCallback(() => commit(undoOperation(stateRef.current)), [commit])
  const redo = useCallback(() => commit(redoOperation(stateRef.current)), [commit])

  const save = useCallback(async (): Promise<PptxEditSaveOutcome> => {
    const sessionId = sessionIdRef.current
    const restoring = pinned !== undefined && pinned.base !== pinned.head
    if (!sessionId || !pinned || (!restoring && !isPptxEditDirty(stateRef.current))) {
      return { kind: 'failed' }
    }
    await chainRef.current
    const operations = stateRef.current.operations as PptxOperation[]
    const key = JSON.stringify([sessionId, pinned.base, pinned.head, operations])
    // An uncertain result may already be committed, so retry the same operation identity.
    if (pendingSaveRef.current?.key !== key) {
      pendingSaveRef.current = { key, operationId: crypto.randomUUID() }
    }
    const sequence = sequenceRef.current
    setPhase('saving')
    try {
      const result = await window.api.pptxEdit.save({
        sessionId,
        operations,
        expectedHeadVersionId: pinned.head,
        operationId: pendingSaveRef.current.operationId,
        ...(restoring ? { restore: true } : {})
      })
      if (sequenceRef.current !== sequence) return { kind: 'failed' }
      setPhase('ready')
      if (!result.ok) {
        if (result.error.code === 'OPERATION_REJECTED') pendingSaveRef.current = undefined
        return { kind: 'failed' }
      }
      if (result.value.kind === 'conflict') return { kind: 'conflict', result: result.value }
      pendingSaveRef.current = undefined
      return { kind: 'saved', result: result.value }
    } catch {
      if (sequenceRef.current === sequence) setPhase('ready')
      return { kind: 'failed' }
    }
  }, [pinned])

  const rebase = useCallback(
    async (versionId: string): Promise<boolean> => {
      const previousId = sessionIdRef.current
      if (!identity || !previousId) return false
      await chainRef.current
      const operations = stateRef.current.operations as PptxOperation[]
      const sequence = ++sequenceRef.current
      setPhase('opening')
      let openedId: string | undefined
      try {
        const opened = await window.api.pptxEdit.open({ ...identity, versionId })
        if (!opened.ok) throw new Error(opened.error.code)
        openedId = opened.value.sessionId
        const applied = operations.length
          ? await window.api.pptxEdit.apply({ sessionId: openedId, operations })
          : { ok: true as const, value: opened.value }
        if (!applied.ok) throw new Error(applied.error.code)
        if (sequenceRef.current !== sequence) throw new Error('SUPERSEDED')
        sessionIdRef.current = openedId
        pendingSaveRef.current = undefined
        void window.api.pptxEdit.close(previousId).catch(() => undefined)
        setPinned({ base: versionId, head: versionId })
        setView(applied.value)
        setFailure(undefined)
        setPhase('ready')
        return true
      } catch {
        if (openedId) void window.api.pptxEdit.close(openedId).catch(() => undefined)
        if (sequenceRef.current === sequence) setPhase('ready')
        return false
      }
    },
    [identity]
  )

  return {
    phase,
    view,
    state,
    failed: failure !== undefined,
    failure,
    dirty: isPptxEditDirty(state),
    restoring: pinned !== undefined && pinned.base !== pinned.head,
    headMoved: pinned !== undefined && headVersionId !== undefined && headVersionId !== pinned.head,
    canUndo: state.operations.length > 0,
    canRedo: state.redo.length > 0,
    begin,
    discard,
    addOperation,
    addOperations,
    undo,
    redo,
    save,
    rebase
  }
}

export { usePptxEditSession }
export type { PptxEditPhase, PptxEditSaveOutcome, PptxEditSession, PptxEditSessionOptions }
