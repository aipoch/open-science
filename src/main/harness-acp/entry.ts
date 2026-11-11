import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { createHarnessAcpAgent } from './agent'
import { HARNESS_ACP_ARG } from './config'

export async function runHarnessAcp(argv: readonly string[]): Promise<void> {
  const index = argv.indexOf(HARNESS_ACP_ARG)
  if (index < 0 || index !== argv.length - 2) throw new Error('Invalid built-in Agent arguments')
  const owner = createHarnessAcpAgent(argv[index + 1])
  const connection = owner.app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    )
  )
  try {
    await connection.closed
  } finally {
    await owner.dispose()
  }
}
