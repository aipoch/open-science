import { fork, type ChildProcess } from 'node:child_process'
import { researchFilmResources } from './resources.js'
import type { ResearchVideoSpeechInput, ResearchVideoWorkerMessage } from './generation.js'

export type SpeechRequest = Extract<
  ResearchVideoWorkerMessage,
  { kind: 'synthesize' | 'measure-duration' }
> & { input: ResearchVideoSpeechInput }
export type SpeechReply =
  | Extract<ResearchVideoWorkerMessage, { kind: 'speech-result' | 'speech-duration' }>
  | (Extract<ResearchVideoWorkerMessage, { kind: 'error' }> & { lane: number })

const SPEECH_REQUEST_TIMEOUT_MS = 180_000
const SPEECH_EXIT_TIMEOUT_MS = 5_000

export class ResearchVideoSpeechCleanupError extends Error {
  constructor(readonly exited: Promise<void>) {
    super('Film narration did not confirm shutdown. Wait for it to exit before trying again.')
  }
}

export const forkSpeechProcess = (): ChildProcess =>
  fork(researchFilmResources().speechProcessPath, [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.versions.electron ? '1' : undefined,
      NODE_OPTIONS: undefined
    },
    execArgv: [],
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })

/** Owns exactly one leaf process. A signal, error or IPC disconnect does not prove exit. */
export function ownSpeechProcess(
  child: ChildProcess,
  reply: (message: Extract<SpeechReply, { kind: 'speech-result' | 'speech-duration' }>) => void,
  reject: (error: unknown, lane?: number, exitCode?: number) => void
): { send(request: SpeechRequest): void; stop(): Promise<void> } {
  const exited = Promise.withResolvers<void>()
  const requests = new Map<number, ReturnType<typeof setTimeout>>()
  let stopping: Promise<void> | undefined
  let hasExited = false
  const fail = (error: unknown, lane?: number, code?: number): void => {
    if (!stopping) reject(error, lane, code)
  }
  const confirmExit = (): void => {
    hasExited = true
    exited.resolve()
  }
  child.once('exit', (code) => {
    confirmExit()
    fail(
      new Error('Film narration process stopped before completion.'),
      undefined,
      code ?? undefined
    )
  })
  child.once('close', () => {
    // A failed spawn emits error and close but has no PID and emits no exit.
    if (child.pid === undefined) confirmExit()
  })
  child.on('error', (error) => fail(error))
  child.on('message', (message: SpeechReply) => {
    if (stopping) return
    if (message.kind === 'error') {
      fail(Object.assign(new Error(message.message), { code: message.code }), message.lane)
      return
    }
    const timer = requests.get(message.lane)
    if (!timer) return
    clearTimeout(timer)
    requests.delete(message.lane)
    try {
      reply(message)
    } catch (error) {
      fail(error, message.lane)
    }
  })

  return {
    send(request) {
      if (requests.has(request.lane)) throw new Error('Speech worker already busy')
      requests.set(
        request.lane,
        setTimeout(
          () =>
            fail(
              Object.assign(new Error('Film narration timed out.'), { code: 'ETIMEDOUT' }),
              request.lane
            ),
          SPEECH_REQUEST_TIMEOUT_MS
        )
      )
      child.send(request, (error) => {
        if (error) fail(error, request.lane)
      })
    },
    stop() {
      return (stopping ??= Promise.resolve().then(async () => {
        for (const timer of requests.values()) clearTimeout(timer)
        requests.clear()
        if (hasExited) return
        // The child's supervisor can terminate itself on lost IPC even while ONNX is stuck.
        try {
          if (child.connected) child.disconnect()
        } catch {
          // Still try to stop the child through its process handle.
        }
        try {
          child.kill('SIGKILL')
        } catch {
          // The exit event is the authority, even when sending the signal throws.
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            exited.promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new ResearchVideoSpeechCleanupError(exited.promise)),
                SPEECH_EXIT_TIMEOUT_MS
              )
            })
          ])
        } finally {
          clearTimeout(timer)
          // Keep listening for a late exit without keeping the desktop alive.
          if (!hasExited) {
            child.channel?.unref()
            child.unref()
          }
        }
      }))
    }
  }
}
