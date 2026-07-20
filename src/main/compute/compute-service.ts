import type { ProbeResult } from '../../shared/compute'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'

// Probe timeout for the full bundle — individual commands share one connection but each gets this
// budget. Set generously so slow clusters don't abort, but short enough for a responsive UI (30s).
const PROBE_TIMEOUT_MS = 30_000

// Maximum output to capture per probe command (4 KB is plenty for nproc / nvidia-smi -L output).
const PROBE_MAX_OUTPUT_BYTES = 4 * 1024

// Shell script run as a single SSH command. We collect all outputs in one round-trip:
//   - uname -s for OS
//   - nproc for CPU count
//   - free -m for memory (Linux only; macOS falls back via sysctl)
//   - nvidia-smi -L for GPU list (optional; missing command is fine)
//   - which sbatch / qsub / bsub for scheduler detection
//   - echo $SCRATCH for scratch root suggestion
//
// The output is a simple line-delimited key=value format so the parser is a pure function.
const PROBE_SCRIPT = [
  'echo "os=$(uname -s 2>/dev/null)"',
  'echo "cpus=$(nproc 2>/dev/null || sysctl -n hw.logicalcpu 2>/dev/null || echo)"',
  // Linux: free -m | awk, macOS: sysctl hw.memsize converted to MiB.
  'echo "mem_mib=$(free -m 2>/dev/null | awk \'NR==2{print $2}\' || echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 )))"',
  "echo \"gpus=$(nvidia-smi -L 2>/dev/null | grep -oP 'GPU \\d+: \\K[^(]+' | tr '\\n' ';' || echo)\"",
  'echo "sbatch=$(command -v sbatch 2>/dev/null && echo yes || echo no)"',
  'echo "qsub=$(command -v qsub 2>/dev/null && echo yes || echo no)"',
  'echo "bsub=$(command -v bsub 2>/dev/null && echo yes || echo no)"',
  'echo "scratch=$SCRATCH"'
].join('\n')

// Parsed output from the probe script — a pure-data structure so parseProbeOutput is unit-testable
// without SSH.
export type ProbeScriptOutput = {
  os?: string
  cpus?: number
  memMib?: number
  gpus?: Array<{ type: string; count: number }>
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
  scratchEnv?: string
}

// Counts consecutive identical GPU model names to build the [{type, count}] list.
const aggregateGpus = (raw: string): Array<{ type: string; count: number }> => {
  if (!raw.trim()) return []
  const models = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  const counts: Map<string, number> = new Map()
  for (const model of models) {
    counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }))
}

// Pure function: parses the line-delimited key=value output of PROBE_SCRIPT into ProbeScriptOutput.
// Exported so it can be unit-tested independently of SSH.
export const parseProbeOutput = (stdout: string): ProbeScriptOutput => {
  const kv: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    kv[key] = value
  }

  const cpusRaw = Number.parseInt(kv['cpus'] ?? '', 10)
  const memRaw = Number.parseInt(kv['mem_mib'] ?? '', 10)

  const scheduler: ProbeScriptOutput['detectedScheduler'] =
    kv['sbatch'] === 'yes'
      ? 'slurm'
      : kv['qsub'] === 'yes'
        ? 'pbs'
        : kv['bsub'] === 'yes'
          ? 'lsf'
          : 'none'

  return {
    os: kv['os'] || undefined,
    cpus: Number.isFinite(cpusRaw) && cpusRaw > 0 ? cpusRaw : undefined,
    memMib: Number.isFinite(memRaw) && memRaw > 0 ? memRaw : undefined,
    gpus: aggregateGpus(kv['gpus'] ?? ''),
    detectedScheduler: scheduler,
    scratchEnv: kv['scratch'] || undefined
  }
}

// Extracts a short tail from stderr/stdout to surface in the UI probe-failed banner.
const errorTail = (stderr: string, stdout: string, maxLines = 10): string => {
  const combined = [stderr, stdout].filter(Boolean).join('\n')
  const lines = combined.split('\n').filter((l) => l.trim())
  return lines.slice(-maxLines).join('\n')
}

// ComputeService owns probe logic. It is injected with a SshRunner (for testability) and a
// repository (for persistence). It does NOT write detailsDoc — only probeResult, shape, and
// scratchRoot (when applicable). See design.md §4 for the probe/Details distinction.
export class ComputeService {
  constructor(
    private readonly runner: SshRunner,
    private readonly repository: ComputeHostRepository
  ) {}

  // Runs the probe bundle against the host identified by providerId. Persists the structured
  // probeResult and (conditionally) scratchRoot. Never touches detailsDoc.
  async probe(providerId: string): Promise<ProbeResult> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    const probedAt = new Date().toISOString()

    // Resolve SSH target (runs ssh -G, applies overrides). On connection failure this itself may
    // throw — we catch below and treat it as host_unreachable.
    let target
    try {
      target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
    } catch (err) {
      const result: ProbeResult = {
        ok: false,
        probedAt,
        exitCode: null,
        errorTail: err instanceof Error ? err.message : String(err)
      }
      await this.repository.updateProbeResult(providerId, result, 'direct_ssh')
      return result
    }

    // Run the probe script in a login shell so module/conda PATHs are present.
    const runResult = await this.runner.run(target, PROBE_SCRIPT, {
      timeoutMs: PROBE_TIMEOUT_MS,
      loginShell: true,
      maxOutputBytes: PROBE_MAX_OUTPUT_BYTES
    })

    // SSH exit 255 signals a connection-level failure (host unreachable / batch-mode auth failure /
    // unknown host key). Any non-zero exit from the script itself is still a "probe succeeded at
    // connection level" — we report it as ok:true with partial data.
    const connectionFailed =
      runResult.timedOut ||
      runResult.exitCode === 255 ||
      (runResult.exitCode === null && runResult.stderr.includes('Connection'))

    if (connectionFailed) {
      const tail = errorTail(runResult.stderr, runResult.stdout)
      const result: ProbeResult = {
        ok: false,
        probedAt,
        exitCode: runResult.exitCode,
        errorTail: tail || 'Connection failed'
      }
      await this.repository.updateProbeResult(providerId, result, 'direct_ssh')
      return result
    }

    const parsed = parseProbeOutput(runResult.stdout)

    // Infer shape from detected scheduler (design.md §4).
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

    // Persist probe result and shape. Update scratchRoot only when not pinned and the env var was set.
    await this.repository.updateProbeResult(providerId, result, shape)
    if (!host.scratchPinned && parsed.scratchEnv) {
      await this.repository.updateScratchRoot(providerId, parsed.scratchEnv)
    }

    return result
  }
}
