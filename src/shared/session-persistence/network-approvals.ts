import type { SandboxNetworkApproval } from '../sandbox-network-approval'
import { isRecord } from './primitives'

export const sanitizeSandboxNetworkApprovals = (
  value: unknown
): readonly SandboxNetworkApproval[] | undefined => {
  if (!Array.isArray(value) || value.length > 32) return undefined
  const ids = new Set<string>()
  const result: SandboxNetworkApproval[] = []
  for (const entry of value) {
    if (!isRecord(entry) || entry.version !== 1 || entry.kind !== 'sandbox-network')
      return undefined
    if (entry.state !== 'pending' && entry.state !== 'continuing') return undefined
    if (
      entry.decision !== undefined &&
      (!['always-allow', 'project-allow', 'deny'].includes(String(entry.decision)) ||
        entry.state !== 'continuing')
    )
      return undefined
    const names = [
      'requestId',
      'sessionId',
      'executionId',
      'originatingPromptMessageId',
      'agentFrameId',
      'messageBranchId'
    ] as const
    if (
      names.some(
        (key) =>
          typeof entry[key] !== 'string' || !entry[key] || (entry[key] as string).length > 256
      )
    )
      return undefined
    if (
      typeof entry.commandFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.commandFingerprint)
    )
      return undefined
    if (
      typeof entry.hostname !== 'string' ||
      entry.hostname.length > 253 ||
      (!entry.evidence &&
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(
          entry.hostname
        ))
    )
      return undefined
    if (
      !['bash', 'python', 'r', 'repl'].includes(String(entry.runtime)) ||
      !Number.isInteger(entry.port) ||
      Number(entry.port) < 1 ||
      Number(entry.port) > 65535
    )
      return undefined
    if (
      typeof entry.createdAt !== 'number' ||
      !Number.isSafeInteger(entry.createdAt) ||
      entry.createdAt < 0
    )
      return undefined
    let trustedEvidence: SandboxNetworkApproval['evidence']
    if (entry.evidence !== undefined) {
      const evidence = entry.evidence
      if (
        !isRecord(evidence) ||
        typeof evidence.recordId !== 'string' ||
        evidence.recordId !== entry.requestId ||
        !Number.isSafeInteger(evidence.revision) ||
        Number(evidence.revision) < 0 ||
        !Array.isArray(evidence.addresses) ||
        !evidence.addresses.length ||
        evidence.addresses.length > 128 ||
        !evidence.addresses.every(
          (address) =>
            typeof address === 'string' && /^[0-9a-f:.]+$/i.test(address) && address.length <= 45
        ) ||
        !Array.isArray(evidence.risks) ||
        !evidence.risks.every((risk) =>
          ['sensitive', 'local', 'metadata', 'fake-ip'].includes(String(risk))
        ) ||
        typeof evidence.blockReason !== 'string' ||
        evidence.blockReason.length > 256 ||
        typeof entry.hostname !== 'string' ||
        /[\s/\\?#@%]/.test(entry.hostname)
      )
        return undefined
      trustedEvidence = {
        recordId: evidence.recordId as string,
        revision: evidence.revision as number,
        addresses: [...evidence.addresses] as string[],
        risks: [...evidence.risks] as string[],
        blockReason: evidence.blockReason as string
      }
    }
    if (ids.has(entry.requestId as string)) return undefined
    ids.add(entry.requestId as string)
    // Copy only reviewed fields: never retain request bodies, headers, URLs, or shell text.
    result.push({
      version: 1,
      kind: 'sandbox-network',
      state: entry.state,
      ...(entry.decision ? { decision: entry.decision as SandboxNetworkApproval['decision'] } : {}),
      ...(trustedEvidence ? { evidence: trustedEvidence } : {}),
      requestId: entry.requestId as string,
      sessionId: entry.sessionId as string,
      executionId: entry.executionId as string,
      commandFingerprint: entry.commandFingerprint,
      hostname: entry.hostname,
      port: entry.port as number,
      runtime: entry.runtime as SandboxNetworkApproval['runtime'],
      originatingPromptMessageId: entry.originatingPromptMessageId as string,
      agentFrameId: entry.agentFrameId as string,
      messageBranchId: entry.messageBranchId as string,
      createdAt: entry.createdAt
    })
  }
  return result
}
