import * as acp from '@agentclientprotocol/sdk'
import type {
  ClientConnection,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@agentclientprotocol/sdk'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

import { readWorkspaceTextFile, writeWorkspaceTextFile } from './filesystem'

type AcpAgentConnectionHooks = Readonly<{
  requestPermission: (
    request: RequestPermissionRequest
  ) => RequestPermissionResponse | Promise<RequestPermissionResponse>
  observeSessionUpdate: (notification: SessionNotification) => void
  observeClaudeSdkMessage: (message: Record<string, unknown>) => void
  filesystem: Readonly<{
    resolveSessionCwd: (sessionId: string) => string
    protectedReadRoots: () => readonly string[]
  }>
}>

type AcpAgentConnectionInput = Readonly<{
  process: ChildProcessWithoutNullStreams
}>

// Translates one spawned agent's stdio and client-side protocol callbacks into an ACP connection.
// Process, connection, bridge-lease, and transition ownership remain with the Runtime/resource owner.
class AcpAgentConnectionAdapter {
  open(input: AcpAgentConnectionInput, hooks: AcpAgentConnectionHooks): ClientConnection {
    const stream = acp.ndJsonStream(
      Writable.toWeb(input.process.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(input.process.stdout) as ReadableStream<Uint8Array>
    )

    return acp
      .client({ name: 'open-science' })
      .onRequest(acp.methods.client.session.requestPermission, (context) =>
        hooks.requestPermission(context.params)
      )
      .onNotification(acp.methods.client.session.update, (context) =>
        hooks.observeSessionUpdate(context.params)
      )
      .onNotification(
        '_claude/sdkMessage',
        (params) => params as Record<string, unknown>,
        (context) => hooks.observeClaudeSdkMessage(context.params)
      )
      .onRequest(acp.methods.client.fs.readTextFile, (context) =>
        readWorkspaceTextFile(
          hooks.filesystem.resolveSessionCwd(context.params.sessionId),
          context.params,
          [...hooks.filesystem.protectedReadRoots()]
        )
      )
      .onRequest(acp.methods.client.fs.writeTextFile, (context) =>
        writeWorkspaceTextFile(
          hooks.filesystem.resolveSessionCwd(context.params.sessionId),
          context.params
        )
      )
      .connect(stream)
  }
}

export { AcpAgentConnectionAdapter }
export type { AcpAgentConnectionHooks, AcpAgentConnectionInput }
