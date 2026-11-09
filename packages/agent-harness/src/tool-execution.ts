export type ToolExecutionReceipt = Readonly<{
  callId: string
  status: 'started' | 'completed' | 'denied' | 'unknown'
  output?: string
}>

const freeze = <Value>(value: Value, seen = new WeakSet<object>()): Value => {
  if (value && typeof value === 'object') {
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error('Tool arguments must contain only plain objects and arrays')
    if (seen.has(value)) return value
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value)) freeze(child, seen)
  }
  return value
}

/** Authorization and execution consume the same validated arguments. Persistence always leads effects. */
export async function executeToolCall<Arguments>(options: {
  callId: string
  input: unknown
  signal: AbortSignal
  validate(input: unknown): Arguments
  authorize(args: Arguments, signal: AbortSignal): Promise<boolean>
  execute(args: Arguments, signal: AbortSignal): Promise<string>
  record(receipt: ToolExecutionReceipt): Promise<void>
}): Promise<Readonly<{ status: 'completed' | 'denied'; output: string }>> {
  const { callId, signal, record } = options
  if (!callId.trim()) throw new Error('Missing tool call identity')
  signal.throwIfAborted()
  const args = freeze(structuredClone(options.validate(options.input)))
  const allowed = await options.authorize(args, signal)
  signal.throwIfAborted()
  if (allowed !== true) {
    const result = { status: 'denied' as const, output: 'Permission denied' }
    await record({ callId, ...result })
    return result
  }
  await record({ callId, status: 'started' })
  let output: string
  try {
    signal.throwIfAborted()
    output = await options.execute(args, signal)
    if (typeof output !== 'string') throw new Error('Tool result must be text')
  } catch (error) {
    try {
      await record({ callId, status: 'unknown' })
    } catch (storageError) {
      throw new AggregateError([error, storageError], 'Tool execution and recording failed')
    }
    throw error
  }
  // An ambiguous result write is not permission to execute again or overwrite it as unknown.
  await record({ callId, status: 'completed', output })
  signal.throwIfAborted()
  return { status: 'completed', output }
}
