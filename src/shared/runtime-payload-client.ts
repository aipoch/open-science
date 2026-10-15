import {
  MAX_RUNTIME_PAYLOAD_BYTES,
  RUNTIME_PAYLOAD_CHANNELS,
  RUNTIME_PAYLOAD_UPLOAD_CHANNELS,
  RUNTIME_PAYLOAD_INLINE_BYTES,
  RUNTIME_PAYLOAD_PAGE_BYTES,
  runtimePayloadDescriptorSchema,
  runtimePayloadPageSchema,
  type RuntimePayloadOptions
} from './runtime-payload-transfer'

type Invoke = (
  channel: string,
  args: readonly unknown[],
  options?: RuntimePayloadOptions
) => Promise<unknown>

// Transfer admission belongs to the server; keep ordinary command concurrency unchanged.
export function createRuntimePayloadClient(options: {
  invoke: Invoke
  encode: (value: unknown) => string
  decode: (value: string) => unknown
  signal: () => AbortSignal
}): { invoke: Invoke } {
  let pending = 0
  const run = async (
    channel: string,
    args: readonly unknown[],
    signal: AbortSignal
  ): Promise<unknown> => {
    signal.throwIfAborted()
    let snapshotId: string | undefined
    const call = async (
      args: readonly unknown[],
      transfer?: RuntimePayloadOptions['transfer']
    ): Promise<unknown> => {
      signal.throwIfAborted()
      const result = await options.invoke(channel, args, { acceptPayload: 1, transfer })
      signal.throwIfAborted()
      return result
    }
    try {
      let result: unknown
      const encoded = RUNTIME_PAYLOAD_UPLOAD_CHANNELS.has(channel)
        ? options.encode(args)
        : undefined
      const bytes = encoded === undefined ? undefined : new TextEncoder().encode(encoded)
      if (bytes !== undefined && bytes.length > RUNTIME_PAYLOAD_INLINE_BYTES) {
        if (bytes.length > MAX_RUNTIME_PAYLOAD_BYTES)
          throw new Error('Payload upload exceeds the byte budget.')
        const descriptor = runtimePayloadDescriptorSchema.parse(
          await call([], { kind: 'upload', byteLength: bytes.length })
        )
        snapshotId = descriptor.$payload.snapshotId
        for (let offset = 0; offset < bytes.length; offset += RUNTIME_PAYLOAD_PAGE_BYTES) {
          const page = bytes.subarray(offset, offset + RUNTIME_PAYLOAD_PAGE_BYTES)
          let binary = ''
          for (let index = 0; index < page.length; index += 8192)
            binary += String.fromCharCode(...page.subarray(index, index + 8192))
          const response = await call([], {
            kind: 'append',
            snapshotId,
            offset,
            data: btoa(binary)
          })
          if (
            !response ||
            typeof response !== 'object' ||
            !('nextOffset' in response) ||
            response.nextOffset !== offset + page.length
          )
            throw new Error('Invalid payload upload acknowledgment.')
        }
        // Never retry a commit: a lost response can mean the mutation has already succeeded.
        result = await call([], { kind: 'commit', snapshotId })
      } else result = await call(args)
      if (!result || typeof result !== 'object' || !('$payload' in result)) {
        snapshotId = undefined
        return result
      }
      const descriptor = runtimePayloadDescriptorSchema.parse(result)
      snapshotId = descriptor.$payload.snapshotId
      const byteLength = descriptor.$payload.byteLength
      const decoder = new TextDecoder('utf-8', { fatal: true })
      const parts: string[] = []
      let offset = 0
      while (offset < byteLength) {
        const page = runtimePayloadPageSchema.parse(
          await call([], { kind: 'read', snapshotId, offset })
        )
        const binary = atob(page.data)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
        if (
          page.snapshotId !== snapshotId ||
          page.offset !== offset ||
          bytes.length === 0 ||
          bytes.length > RUNTIME_PAYLOAD_PAGE_BYTES ||
          page.nextOffset !== offset + bytes.length ||
          page.nextOffset > byteLength
        )
          throw new Error('Invalid payload snapshot page.')
        parts.push(decoder.decode(bytes, { stream: true }))
        offset = page.nextOffset
      }
      parts.push(decoder.decode())
      return options.decode(parts.join(''))
    } finally {
      if (snapshotId) {
        // Cleanup cannot turn a confirmed save into an unknown outcome. The server also expires leases.
        await options
          .invoke(channel, [], { acceptPayload: 1, transfer: { kind: 'release', snapshotId } })
          .catch(() => undefined)
      }
    }
  }
  return {
    invoke(channel, args) {
      if (!RUNTIME_PAYLOAD_CHANNELS.has(channel)) return options.invoke(channel, args)
      if (pending >= 32) return Promise.reject(new Error('Too many pending payload requests.'))
      const signal = options.signal()
      pending++
      return run(channel, args, signal).finally(() => {
        pending--
      })
    }
  }
}
