import type { WebContents } from 'electron'
import type { ApplicationInvocation } from '../application-command-router'
import { callerContextForEvent } from '../caller-context'
import { callerLeaseForEvent } from '../caller-lifecycle'
import { ipcMainHandle } from '../ipc-handler-registry'
import {
  createArtifactReproducibilityCommands,
  artifactReproducibilityMethods,
  type ArtifactReproducibilityCommandOwner,
  type ArtifactReproducibilityCommandDependencies,
  type ArtifactReproducibilityCommands
} from './artifact-reproducibility-commands'

// The IPC layer contributes only a caller lease and a document event sink. Both hosts execute the
// same command owner; no business validation, archive admission or cancellation lives in this adapter.
export const registerArtifactReproducibilityIpcHandlers = (
  owner: ArtifactReproducibilityCommandOwner,
  dependencies: ArtifactReproducibilityCommandDependencies,
  sharedCommands?: ArtifactReproducibilityCommands
): (() => void) => {
  const senders = new Map<string, WebContents>()
  const commands =
    sharedCommands ??
    createArtifactReproducibilityCommands(
      () => owner,
      dependencies,
      (clientId, state) => {
        const sender = senders.get(clientId)
        if (sender && !sender.isDestroyed())
          sender.send('artifacts:reproducibility-check-changed', state)
      }
    )
  for (const [channel, method] of Object.entries(artifactReproducibilityMethods)) {
    ipcMainHandle(channel, (event, request) => {
      const callerContext = callerContextForEvent(event)
      const callerLease = callerLeaseForEvent(event)
      if (!senders.has(callerContext.clientId)) {
        senders.set(callerContext.clientId, event.sender)
        callerLease.signal.addEventListener('abort', () => senders.delete(callerContext.clientId), {
          once: true
        })
      }
      // Dynamic channel registration is checked against the complete method map above. The owner
      // validates each payload and retains its precise request/result types for the unified router.
      return (
        commands[method] as (invocation: ApplicationInvocation<readonly [unknown]>) => unknown
      )({
        callerContext,
        callerLease,
        args: [request]
      })
    })
  }
  return () => {
    senders.clear()
    if (!sharedCommands) commands.dispose()
  }
}
export type { ArtifactReproducibilityCommandDependencies as ArtifactReproducibilityIpcDependencies }
