import { useLayoutEffect, useRef, useState } from 'react'
import {
  PROMPT_OPTIMIZATION_INPUT_LIMIT,
  optimizePromptResultSchema,
  type OptimizePromptRequest,
  type OptimizePromptResult,
  type OptimizationEvent
} from '../../../../../shared/prompt-optimization'
import type { SessionAgentConfiguration } from '../../../../../shared/settings'
import type { ComposerDoc, ComposerNode } from './composer-doc'

type Options = {
  projectId?: string
  modelConfiguration?: SessionAgentConfiguration
  attachmentIds?: readonly string[]
  transferIds?: readonly string[]
  sessionKey: string
  doc: ComposerDoc
  onChange: (doc: ComposerDoc) => void
  optimize?: (request: OptimizePromptRequest) => Promise<OptimizePromptResult>
  recordEvent?: (event: OptimizationEvent) => Promise<void>
}

type OptimizationState = {
  optimize: () => Promise<void>
  undo: () => void
  sent: () => void
  edited: () => void
  pending: boolean
  notice?: 'changed' | 'failed'
  canUndo: boolean
  tooLong: boolean
  canOptimize: boolean
}

export function usePromptOptimization(options: Options): OptimizationState {
  const scope = `${options.projectId ?? ''}:${options.sessionKey}`
  const serialized = JSON.stringify(options.doc)
  const current = useRef({ scope, serialized, revision: 0, options })
  // Compare committed drafts before events or async completions can apply an older result.
  useLayoutEffect(() => {
    const changed = current.current.scope !== scope || current.current.serialized !== serialized
    current.current = {
      scope,
      serialized,
      revision: current.current.revision + Number(changed),
      options
    }
  })
  const requestId = useRef(0)
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState<'changed' | 'failed'>()
  const [previous, setPrevious] = useState<ComposerDoc>()
  const [stateScope, setStateScope] = useState(scope)
  if (stateScope !== scope) {
    setStateScope(scope)
    setPending(false)
    setNotice(undefined)
    setPrevious(undefined)
  }
  const successful = useRef<{ edited: boolean } | undefined>(undefined)
  const record = (action: OptimizationEvent['action']): void => {
    const api = current.current.options.recordEvent ?? window.api?.projects?.recordOptimizationEvent
    void api?.({ action }).catch(() => undefined)
  }
  useLayoutEffect(() => {
    busy.current = false
    successful.current = undefined
    return () => {
      requestId.current += 1
    }
  }, [scope])
  // Observe user actions, not programmatic clearing/restoration during send preparation.
  const edited = (): void => {
    if (!successful.current || successful.current.edited) return
    successful.current.edited = true
    record('edit')
  }

  const optimize = async (): Promise<void> => {
    if (
      busy.current ||
      !current.current.options.projectId ||
      !current.current.options.modelConfiguration
    )
      return
    const snapshot = current.current
    const original = snapshot.options.doc
    const prefix = `OS_REFERENCE_${crypto.randomUUID()}_`
    const references: Array<{ token: string; node: ComposerNode }> = []
    const input = original.nodes
      .map((node) => {
        if (node.type === 'text') return node.text
        const token = `\`${prefix}${references.length}\``
        references.push({ token, node })
        return token
      })
      .join('')
    if (!input.trim() || input.length > PROMPT_OPTIMIZATION_INPUT_LIMIT) return
    busy.current = true
    setPending(true)
    setNotice(undefined)
    const id = ++requestId.current
    try {
      const api = snapshot.options.optimize ?? window.api.projects.optimizePrompt
      const result = optimizePromptResultSchema.parse(
        await api({
          projectId: snapshot.options.projectId!,
          input,
          agentConfiguration: snapshot.options.modelConfiguration!
        })
      )
      if (id !== requestId.current || scope !== current.current.scope) return
      if (snapshot.revision !== current.current.revision) {
        setNotice('changed')
        return
      }
      const nodes: ComposerNode[] = []
      const sorted = references
        .map((reference) => {
          if (result.text.split(reference.token).length !== 2) throw new Error('Reference changed')
          return { ...reference, offset: result.text.indexOf(reference.token) }
        })
        .sort((a, b) => a.offset - b.offset)
      let offset = 0
      for (const reference of sorted) {
        if (reference.offset > offset)
          nodes.push({ type: 'text', text: result.text.slice(offset, reference.offset) })
        nodes.push(reference.node)
        offset = reference.offset + reference.token.length
      }
      if (offset < result.text.length) nodes.push({ type: 'text', text: result.text.slice(offset) })
      const doc = { nodes }
      successful.current = { edited: false }
      setPrevious(original)
      current.current.options.onChange(doc)
      setNotice(undefined)
    } catch {
      if (id === requestId.current && scope === current.current.scope) setNotice('failed')
    } finally {
      if (id === requestId.current) {
        busy.current = false
        setPending(false)
      }
    }
  }
  const undo = (): void => {
    if (!previous || pending) return
    successful.current = undefined
    // Upload removal also deletes its staged file. Restore the saved text inline when its
    // attachment/transfer no longer exists, rather than resurrecting an unsendable anchor.
    const { attachmentIds = [], transferIds = [] } = current.current.options
    const restored = {
      nodes: previous.nodes.map((node): ComposerNode =>
        node.type === 'pasted-text' &&
        !(node.attachmentId && attachmentIds.includes(node.attachmentId)) &&
        !(node.transferId && transferIds.includes(node.transferId))
          ? { type: 'text', text: node.text }
          : node
      )
    }
    current.current.options.onChange(restored)
    setPrevious(undefined)
    setNotice(undefined)
    record('undo')
  }
  const sendRequestId = requestId.current
  const sent = (): void => {
    // A delayed admission must not clear an optimization started in a different draft.
    if (scope !== current.current.scope || sendRequestId !== requestId.current) return
    if (successful.current) record('send')
    requestId.current += 1
    busy.current = false
    setPending(false)
    setPrevious(undefined)
    setNotice(undefined)
    successful.current = undefined
  }
  const textLength = options.doc.nodes.reduce(
    (size, node) => size + (node.type === 'text' ? node.text.length : 80),
    0
  )
  return {
    optimize,
    undo,
    sent,
    edited,
    pending,
    notice,
    canUndo: Boolean(previous),
    tooLong: textLength > PROMPT_OPTIMIZATION_INPUT_LIMIT,
    canOptimize: Boolean(
      options.projectId &&
      options.modelConfiguration &&
      options.doc.nodes.some((node) => node.type === 'text' && node.text.trim()) &&
      textLength <= PROMPT_OPTIMIZATION_INPUT_LIMIT
    )
  }
}
