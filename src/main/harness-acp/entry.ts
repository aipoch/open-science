import { Readable, Writable } from 'node:stream'
import { ndJsonStream } from '@agentclientprotocol/sdk'
import { createHarnessAcpAgent } from './agent'
import {
  HARNESS_ACP_ARG,
  HARNESS_OTLP_ENV_FILE,
  HARNESS_OTLP_TRACES_ENDPOINT,
  HARNESS_OTLP_TRACES_HEADERS_FILE
} from './config'
import { createHarnessTracing } from './tracing'

export async function runHarnessAcp(argv: readonly string[]): Promise<void> {
  const index = argv.indexOf(HARNESS_ACP_ARG)
  if (index < 0 || index !== argv.length - 2) throw new Error('Invalid built-in Agent arguments')
  const tracing = createHarnessTracing(
    process.env[HARNESS_OTLP_TRACES_ENDPOINT],
    process.env[HARNESS_OTLP_TRACES_HEADERS_FILE],
    process.env[HARNESS_OTLP_ENV_FILE],
    process.env
  )
  const owner = createHarnessAcpAgent(argv[index + 1], tracing)
  const connection = owner.app.connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    )
  )
  try {
    await connection.closed
  } finally {
    tracing?.dispose()
    await owner.dispose()
  }
}
