import { createHash } from 'node:crypto'
import { openAgentSession, type AgentSession } from './session'
import type {
  AgentSessionOptions,
  AgentTool,
  ContentBlock,
  Json,
  ToolContext
} from './session-types'
import { ToolValidationError } from './tool-validation'

export type DelegatedAgent = {
  description: string
  /** Explicit capabilities and budgets. Parent history, tools and credentials are never copied. */
  session: Omit<AgentSessionOptions, 'sessionId' | 'signal'>
}
export type DelegationOptions = {
  agents: Readonly<Record<string, DelegatedAgent>>
  authorize: AgentTool['authorize']
  maxConcurrent?: number
  /** Final UTF-8 text plus serialized portable media; receipt metadata is additional. */
  maxResultBytes?: number
}

/** A composable tool owner, independent of ACP, process spawning and product role catalogs. */
export function createDelegationTool(options: DelegationOptions): {
  tool: AgentTool
  dispose(): Promise<void>
} {
  const concurrency = options.maxConcurrent ?? 4
  const resultBytes = options.maxResultBytes ?? 16_384
  if (![concurrency, resultBytes].every((n) => Number.isSafeInteger(n) && n > 0))
    throw new Error('Invalid delegation budget')
  const agents = new Map(
    Object.entries(options.agents).map(([name, agent]) => [
      name,
      {
        description: agent.description,
        session: {
          ...agent.session,
          tools: [...(agent.session.tools ?? [])],
          guards: [...(agent.session.guards ?? [])]
        }
      }
    ])
  )
  if (!agents.size || [...agents.keys()].some((name) => !name.trim()))
    throw new Error('Delegation requires named agents')
  const active = new Map<string, { cancel(): void; settled: Promise<void> }>()
  let disposed = false
  const parse = (input: Json): { agent: string; task: string } => {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.agent !== 'string' ||
      !agents.has(input.agent) ||
      typeof input.task !== 'string' ||
      !input.task.trim() ||
      Object.keys(input).some((key) => key !== 'agent' && key !== 'task')
    )
      throw new ToolValidationError([
        { path: '$', expected: 'an available agent and a non-empty task' }
      ])
    return { agent: input.agent, task: input.task }
  }
  const tool: AgentTool = {
    name: 'delegate_task',
    version: '2',
    description:
      'Delegate a focused task to an isolated agent. Only its final result is returned.\n' +
      [...agents].map(([name, agent]) => `${name}: ${agent.description}`).join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['agent', 'task'],
      properties: {
        agent: { type: 'string', enum: [...agents.keys()] },
        task: { type: 'string', minLength: 1 }
      }
    },
    scheduling: 'parallel',
    validate: parse,
    authorize: (args, context) => options.authorize(args, context),
    async execute(input, context: ToolContext) {
      const args = parse(input)
      context.signal.throwIfAborted()
      if (disposed) throw new Error('Delegation owner is disposed')
      if (active.size >= concurrency)
        return { content: [{ type: 'text', text: 'Delegation capacity reached' }], isError: true }
      const id =
        'delegate-' +
        createHash('sha256')
          .update(JSON.stringify([context.sessionId, context.invocationId]))
          .digest('hex')
      if (active.has(id)) throw new Error('Delegation invocation is already active')
      const controller = new AbortController()
      const cancel = (): void => controller.abort()
      context.signal.addEventListener('abort', cancel, { once: true })
      let settle!: () => void
      const settled = new Promise<void>((resolve) => {
        settle = resolve
      })
      active.set(id, { cancel, settled })
      let session: AgentSession | undefined
      try {
        const config = agents.get(args.agent)!.session
        // Never silently replay a previously attempted task after a lost parent receipt.
        if (await config.store?.load(id))
          throw new Error('Delegated task already exists; reconcile its checkpoint')
        session = await openAgentSession({ ...config, sessionId: id, signal: controller.signal })
        const status = await session.prompt([{ type: 'text', text: args.task }])
        const checkpoint = await session.snapshot()
        if (
          checkpoint.pending.some(
            (pending) => pending.status === 'started' || pending.status === 'unknown'
          )
        )
          throw new Error('Delegated effects are uncertain; reconcile the child checkpoint')
        if (status === 'waiting') {
          if (!config.store)
            throw new Error('Delegated waiting requires a host-supplied child store')
          // Persist only the reference in the parent; questions/evidence stay in the child store.
          return {
            waiting: {
              type: 'delegation',
              taskId: id,
              agent: args.agent,
              parentSessionId: context.sessionId,
              parentInvocationId: context.invocationId
            }
          }
        }
        const final = checkpoint.messages.findLast(
          (message) => message.role === 'assistant' && !message.calls?.length
        )
        const output =
          final?.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n') ?? ''
        const encoded = Buffer.from(output)
        let end = Math.min(encoded.length, resultBytes)
        while (end < encoded.length && end > 0 && (encoded[end] & 0xc0) === 0x80) end--
        const media: ContentBlock[] = []
        let remaining = resultBytes - end
        let omittedMedia = 0
        for (const block of final?.content ?? []) {
          if (block.type === 'text') continue
          const source = block.source
          const portable =
            typeof source === 'string'
              ? /^(data:|https?:\/\/)/.test(source)
              : source !== null &&
                typeof source === 'object' &&
                !Array.isArray(source) &&
                Object.keys(source).length === 1 &&
                typeof source.url === 'string' &&
                /^https?:\/\//.test(source.url)
          const bytes = Buffer.byteLength(JSON.stringify(block))
          // Provider-private references cannot cross child/parent model identities.
          if (!portable || bytes > remaining) {
            omittedMedia++
            continue
          }
          remaining -= bytes
          media.push(block)
        }
        // Raw child messages and per-request usage remain in the supplied store/event observer.
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                taskId: id,
                agent: args.agent,
                status,
                result: encoded.subarray(0, end).toString(),
                truncated: end < encoded.length || omittedMedia > 0,
                ...(omittedMedia ? { omittedMedia } : {}),
                requests: checkpoint.requests.map(({ id, status, usage, purpose }) => ({
                  id,
                  status,
                  usage,
                  purpose
                }))
              })
            },
            ...media
          ],
          ...(status !== 'complete' ? { isError: true } : {})
        }
      } finally {
        try {
          await session?.dispose()
        } finally {
          context.signal.removeEventListener('abort', cancel)
          active.delete(id)
          settle()
        }
      }
    }
  }
  return {
    tool,
    async dispose() {
      disposed = true
      const tasks = [...active.values()]
      tasks.forEach((task) => task.cancel())
      await Promise.all(tasks.map((task) => task.settled))
    }
  }
}
