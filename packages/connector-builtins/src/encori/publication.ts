import type { ToolContext } from '@aipoch/connector-core'

/** Write a temporary file, then atomically publish without replacing an existing destination.
 * The host owns durability and platform-specific publication; cancellation must be checked at commit.
 */
export type EncoriPublisher = (
  destination: string,
  write: (temporary: string) => Promise<void>,
  signal?: AbortSignal
) => Promise<void>
export type EncoriContext = ToolContext & { publishFile: EncoriPublisher }
