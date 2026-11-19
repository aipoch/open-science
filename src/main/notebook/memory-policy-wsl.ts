import { setTimeout as delay } from 'node:timers/promises'
import { LinuxMemoryPolicyAdapter } from './memory-policy-linux'
import {
  MemoryPolicyError,
  MemoryPolicyService,
  type MemoryPolicyObservation
} from './memory-policy'
import { loadNotebookMemoryPolicyConfig } from './memory-policy-config'
import { createWslMemoryReader, wslMemoryReaderProgram } from './memory-policy-wsl-reader'
import type { NotebookMemoryPolicyPort } from './execution-admission'
import type { NotebookSandboxedSpawn } from './process-sandbox'

// One policy/cache belongs to the original ShellCellSession. The original launch
// capability fixes distro/user, token, and scope; no public string can mint it.
export const createWslExecutionMemoryPolicy = async (
  probe: NonNullable<NotebookSandboxedSpawn['memoryProbe']>,
  configRoot?: string
): Promise<NotebookMemoryPolicyPort> => {
  let owner: { pid: number; birth: string; token: string } | undefined
  const config = configRoot ? await loadNotebookMemoryPolicyConfig(configRoot) : undefined
  const policy = new MemoryPolicyService({
    ...(config ? { policy: config.policy } : {}),
    adapter: {
      platform: 'linux',
      defaultExecutionScope: probe.executionScope,
      sample: async (signal, scope) => {
        if (scope && scope !== probe.executionScope)
          throw new MemoryPolicyError('execution-domain-unavailable', 'The WSL execution changed.')
        const client = createWslMemoryReader(
          probe.openReader(wslMemoryReaderProgram, signal),
          signal
        )
        try {
          if (!owner) {
            // The bootstrap can be alive before its private identity proof is
            // published. No user frame has been written while this wait runs.
            let proof: string | undefined
            for (let attempt = 0; attempt < 50; attempt++) {
              try {
                proof = await client.reader.read(probe.proofPath, signal)
                break
              } catch {
                signal.throwIfAborted()
                if (attempt === 49)
                  throw new MemoryPolicyError(
                    'linux-memory-unavailable',
                    'The original WSL execution identity is unavailable.'
                  )
                await delay(20, undefined, { signal })
              }
            }
            const fields = proof?.trim().split(' ')
            if (
              !fields ||
              fields.length !== 4 ||
              fields[0] !== 'v1' ||
              fields[1] !== probe.token ||
              !/^[1-9]\d*$/.test(fields[2]) ||
              !/^\d+$/.test(fields[3]) ||
              !Number.isSafeInteger(Number(fields[2]))
            )
              throw new MemoryPolicyError(
                'linux-memory-unavailable',
                'The original WSL execution identity is invalid.'
              )
            // Capture once before payload dispatch; never adopt a replacement
            // process from a modified proof, even after a failed sample.
            owner = { pid: Number(fields[2]), birth: fields[3], token: probe.token }
          }
          await client.validateExecutionTree(owner, signal)
          const adapter = new LinuxMemoryPolicyAdapter({
            reader: client.reader,
            pid: owner.pid,
            expectedBirth: owner.birth
          })
          const sample = await adapter.sample(signal)
          await client.validateExecutionTree(owner, signal)
          return { ...sample, executionScope: probe.executionScope }
        } finally {
          await client.close()
        }
      }
    }
  })
  const localize = (state: MemoryPolicyObservation): MemoryPolicyObservation =>
    state.status === 'pressured'
      ? { ...state, reason: { ...state.reason, pressureScope: 'execution-domain' } }
      : state
  return {
    getState: async (request) => localize(await policy.getState(request)),
    currentState: (request) => localize(policy.currentState(request)),
    subscribe: (listener) => policy.subscribe((state) => listener(localize(state))),
    invalidate: () => policy.invalidate(),
    dispose: () => policy.dispose()
  }
}
