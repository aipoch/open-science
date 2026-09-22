export const createRuntimeAgentMessageId = (
  sessionId: string,
  streamId: string,
  responseToMessageId?: string
): string => {
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(
    `${sessionId}\0${responseToMessageId ?? ''}\0${streamId}`
  )) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return `message-stream-${hash.toString(16).padStart(16, '0')}`
}
