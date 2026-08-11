import type { DetailsAuthor, ProbeResult } from '../../shared/compute'
import { DETAILS_DOC_MAX_LENGTH } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'

const PROBE_TIMEOUT_MS = 30_000
const PROBE_MAX_OUTPUT_BYTES = 4 * 1024

const PROBE_SCRIPT = [
  'echo "os=$(uname -s 2>/dev/null)"',
  'echo "cpus=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo)"',
  'echo "mem_mib=$(free -m 2>/dev/null | awk \'NR==2{print $2}\' || echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 )))"',
  "echo \"gpus=$(nvidia-smi -L 2>/dev/null | grep -oP 'GPU \\d+: \\K[^(]+' | tr '\\n' ';' || echo)\"",
  'echo "sbatch=$(command -v sbatch 2>/dev/null && echo yes || echo no)"',
  'echo "qsub=$(command -v qsub 2>/dev/null && echo yes || echo no)"',
  'echo "bsub=$(command -v bsub 2>/dev/null && echo yes || echo no)"',
  'echo "scratch=$SCRATCH"'
].join('\n')

export type ProbeScriptOutput = {
  os?: string
  cpus?: number
  memMib?: number
  gpus?: Array<{ type: string; count: number }>
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
  scratchEnv?: string
}

const aggregateGpus = (raw: string): Array<{ type: string; count: number }> => {
  if (!raw.trim()) return []
  const models = raw
    .split(';')
    .map((model) => model.trim())
    .filter(Boolean)
  const counts = new Map<string, number>()
  for (const model of models) counts.set(model, (counts.get(model) ?? 0) + 1)
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }))
}

export const parseProbeOutput = (stdout: string): ProbeScriptOutput => {
  const values: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator === -1) continue
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  const cpus = Number.parseInt(values['cpus'] ?? '', 10)
  const memMib = Number.parseInt(values['mem_mib'] ?? '', 10)
  const detectedScheduler: ProbeScriptOutput['detectedScheduler'] =
    values['sbatch'] === 'yes'
      ? 'slurm'
      : values['qsub'] === 'yes'
        ? 'pbs'
        : values['bsub'] === 'yes'
          ? 'lsf'
          : 'none'

  return {
    os: values['os'] || undefined,
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : undefined,
    memMib: Number.isFinite(memMib) && memMib > 0 ? memMib : undefined,
    gpus: aggregateGpus(values['gpus'] ?? ''),
    detectedScheduler,
    scratchEnv: values['scratch'] || undefined
  }
}

const errorTail = (stderr: string, stdout: string, maxLines = 10): string => {
  const lines = [stderr, stdout]
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .filter((line) => line.trim())
  return lines.slice(-maxLines).join('\n')
}

const buildDetailsSkeleton = (probe: ProbeResult): string => {
  const lines: string[] = ['## Resources', '']
  if (probe.cpus != null) lines.push(`cpus: ${probe.cpus}`)
  if (probe.memMib != null) lines.push(`mem: ${Math.round(probe.memMib / 1024)} GB`)
  if (probe.gpus && probe.gpus.length > 0) {
    lines.push(`gpus: ${probe.gpus.map((gpu) => `${gpu.count}x ${gpu.type}`).join(', ')}`)
  }
  if (probe.detectedScheduler) lines.push(`scheduler: ${probe.detectedScheduler}`)
  return lines.join('\n')
}

const hostNotFound = (providerId: string): Error =>
  new Error(`No compute host found with provider id "${providerId}".`)

export class ComputeHostProfileOwner {
  constructor(
    private readonly runner: SshRunner,
    private readonly repository: ComputeHostRepository
  ) {}

  async probe(providerId: string): Promise<ProbeResult> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)

    const probedAt = new Date().toISOString()
    let target
    try {
      target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
    } catch (error) {
      const result: ProbeResult = {
        ok: false,
        probedAt,
        exitCode: null,
        errorTail: error instanceof Error ? error.message : String(error)
      }
      await this.repository.updateProbeResult(providerId, result, 'direct_ssh')
      return result
    }

    let runResult = await this.runner.run(target, PROBE_SCRIPT, {
      timeoutMs: PROBE_TIMEOUT_MS,
      loginShell: true,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
    })
    const connectionFailed =
      runResult.timedOut ||
      runResult.exitCode === 255 ||
      (runResult.exitCode === null && runResult.stderr.includes('Connection'))

    if (connectionFailed && !runResult.timedOut) {
      const errorText = (runResult.stderr + runResult.stdout).toLowerCase()
      if (errorText.includes('no route to host') || errorText.includes('network is unreachable')) {
        await new Promise<void>((resolve) => setTimeout(resolve, 3000))
        runResult = await this.runner.run(target, PROBE_SCRIPT, {
          timeoutMs: PROBE_TIMEOUT_MS,
          loginShell: true,
          maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
        })
      }
    }

    const connectionFailedFinal =
      runResult.timedOut ||
      runResult.exitCode === 255 ||
      (runResult.exitCode === null && runResult.stderr.includes('Connection'))
    if (connectionFailedFinal) {
      const result: ProbeResult = {
        ok: false,
        probedAt,
        exitCode: runResult.exitCode,
        errorTail: errorTail(runResult.stderr, runResult.stdout) || 'Connection failed'
      }
      await this.repository.updateProbeResult(providerId, result, 'direct_ssh')
      return result
    }

    const parsed = parseProbeOutput(runResult.stdout)
    const shape =
      parsed.detectedScheduler && parsed.detectedScheduler !== 'none'
        ? 'scheduler_cluster'
        : 'direct_ssh'
    const result: ProbeResult = {
      ok: true,
      probedAt,
      exitCode: runResult.exitCode,
      errorTail: null,
      os: parsed.os,
      cpus: parsed.cpus,
      memMib: parsed.memMib,
      gpus: parsed.gpus && parsed.gpus.length > 0 ? parsed.gpus : undefined,
      detectedScheduler: parsed.detectedScheduler
    }

    await this.repository.updateProbeResult(providerId, result, shape)
    if (!host.scratchPinned && parsed.scratchEnv) {
      await this.repository.updateScratchRoot(providerId, parsed.scratchEnv)
    }
    return result
  }

  async getDetails(providerId: string): Promise<{ doc: string; isSkeleton: boolean }> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)
    if (host.detailsDoc) return { doc: host.detailsDoc, isSkeleton: false }
    if (!host.probeResult?.ok) return { doc: '', isSkeleton: false }
    return { doc: buildDetailsSkeleton(host.probeResult), isSkeleton: true }
  }

  async replaceDetails(
    providerId: string,
    { text, oldText, author }: { text: string; oldText: string; author: DetailsAuthor }
  ): Promise<void> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)
    if (host.detailsDoc !== oldText) {
      throw new Error(
        `replaceDetails: old_text does not match the current details document for "${providerId}".`
      )
    }
    if (text.length > DETAILS_DOC_MAX_LENGTH) {
      throw new Error(
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer (got ${text.length}).`
      )
    }
    await this.repository.updateDetails(providerId, text, author)
  }

  async appendDetails(
    providerId: string,
    { text, author }: { text: string; author: DetailsAuthor }
  ): Promise<void> {
    const host = await this.repository.get(providerId)
    if (!host) throw hostNotFound(providerId)
    const newDoc = host.detailsDoc ? `${host.detailsDoc}\n${text}` : text
    if (newDoc.length > DETAILS_DOC_MAX_LENGTH) {
      throw new Error(
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer (appended doc would be ${newDoc.length}).`
      )
    }
    await this.repository.updateDetails(providerId, newDoc, author)
  }

  async setScratchRoot(providerId: string, path: string): Promise<void> {
    if (!(await this.repository.get(providerId))) throw hostNotFound(providerId)
    await this.repository.updateScratchPinned(providerId, path)
  }

  async setConcurrencyLimit(providerId: string, limit: number): Promise<void> {
    if (!(await this.repository.get(providerId))) throw hostNotFound(providerId)
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(`Concurrent job limit must be an integer in the range 1..500 (got ${limit}).`)
    }
    await this.repository.updateConcurrencyLimit(providerId, limit)
  }
}
