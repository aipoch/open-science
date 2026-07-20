import type {
  ComputeCallError,
  ComputeHost,
  DetailsAuthor,
  ExecResult,
  ProbeResult
} from '../../shared/compute'
import { DETAILS_DOC_MAX_LENGTH } from '../../shared/compute'
import type { DirListing, RemoteFsError } from '../../shared/remote-fs'
import { classifyRemoteError, parseFindListing } from '../../shared/remote-fs'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'

// Probe timeout for the full bundle — individual commands share one connection but each gets this
// budget. Set generously so slow clusters don't abort, but short enough for a responsive UI (30s).
const PROBE_TIMEOUT_MS = 30_000

// Maximum output to capture per probe command (4 KB is plenty for nproc / nvidia-smi -L output).
const PROBE_MAX_OUTPUT_BYTES = 4 * 1024

// Default timeout for call_command (design.md §5). Callers may pass a longer value but 60s prevents
// accidental indefinite hangs when the agent forgets to set a timeout.
const CALL_COMMAND_DEFAULT_TIMEOUT_MS = 60_000

// Maximum bytes captured per stream for call_command (design.md §5). Prevents `cat big_file` from
// filling memory or the RPC response buffer.
const CALL_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024

// Maximum bytes for listDir output. 5000 entries × ~100 bytes each ≈ 500KB; set to ~2MB for safety.
// The default 64KB would truncate large directories before hitting the 5000-entry limit.
const LIST_DIR_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

// Hard upper limit on directory entries returned by listDir. When a directory has more entries
// than this, truncated=true is set and only the first MAX_LIST_ENTRIES items are returned.
const MAX_LIST_ENTRIES = 5000

// Timeout for listDir. Directories with many files can take a few seconds; 30s is generous.
const LIST_DIR_TIMEOUT_MS = 30_000

// Short command preview shown in the approval card when the full command is long.
const COMMAND_PREVIEW_MAX_LEN = 120

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

// Synthesizes a first-contact skeleton from a successful probeResult. Used by getDetails when
// detailsDoc is empty — gives agents a structured starting point without requiring a manual edit.
const buildDetailsSkeleton = (probe: ProbeResult): string => {
  const lines: string[] = ['## Resources', '']
  if (probe.cpus != null) {
    lines.push(`cpus: ${probe.cpus}`)
  }
  if (probe.memMib != null) {
    const gb = Math.round(probe.memMib / 1024)
    lines.push(`mem: ${gb} GB`)
  }
  if (probe.gpus && probe.gpus.length > 0) {
    const gpuStr = probe.gpus.map((g) => `${g.count}x ${g.type}`).join(', ')
    lines.push(`gpus: ${gpuStr}`)
  }
  if (probe.detectedScheduler) {
    lines.push(`scheduler: ${probe.detectedScheduler}`)
  }
  return lines.join('\n')
}

// ComputeService owns probe logic. It is injected with a SshRunner (for testability) and a
// repository (for persistence). It does NOT write detailsDoc — only probeResult, shape, and
// scratchRoot (when applicable). See design.md §4 for the probe/Details distinction.
// approvalBroker is optional: when omitted, callCommand throws rather than requesting approval
// (unit tests that don't exercise the approval path omit it).
export class ComputeService {
  constructor(
    private readonly runner: SshRunner,
    private readonly repository: ComputeHostRepository,
    private readonly approvalBroker?: ComputeApprovalBroker
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

  // Lists all registered compute hosts, newest-first. Returns a lightweight summary for discovery
  // (provider_id / display_name / shape / status derived from probeResult.ok).
  async list(): Promise<ComputeHost[]> {
    return this.repository.list()
  }

  // Returns the details document for a host. When detailsDoc is empty and a successful probe
  // exists, synthesizes a first-contact skeleton from probeResult (## Resources + resource lines).
  // isSkeleton=true signals the caller this was auto-generated, not user/agent content.
  async getDetails(providerId: string): Promise<{ doc: string; isSkeleton: boolean }> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    if (host.detailsDoc) {
      return { doc: host.detailsDoc, isSkeleton: false }
    }

    // No stored doc — synthesize a skeleton from the last probe result if available.
    const probe = host.probeResult
    if (!probe || !probe.ok) {
      return { doc: '', isSkeleton: false }
    }

    return { doc: buildDetailsSkeleton(probe), isSkeleton: true }
  }

  // Replaces detailsDoc via exact-match: the full current doc is replaced with `text` only if
  // `oldText` equals the current detailsDoc. This prevents concurrent edit collisions and is the
  // mechanism used by both the UI (author='user') and the agent (author='agent', issue 06).
  async replaceDetails(
    providerId: string,
    { text, oldText, author }: { text: string; oldText: string; author: DetailsAuthor }
  ): Promise<void> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    // Exact-match guard: oldText must equal the current stored doc.
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

  // Appends text to detailsDoc, respecting the 32KB cap. Used by the agent-facing details channel
  // (design.md §5). Reads the current doc, validates the combined length, then delegates to the
  // repository updateDetails — same path as replaceDetails, no duplicated validation logic.
  async appendDetails(
    providerId: string,
    { text, author }: { text: string; author: DetailsAuthor }
  ): Promise<void> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    const newDoc = host.detailsDoc ? `${host.detailsDoc}\n${text}` : text

    if (newDoc.length > DETAILS_DOC_MAX_LENGTH) {
      throw new Error(
        `Details must be ${DETAILS_DOC_MAX_LENGTH} characters or fewer (appended doc would be ${newDoc.length}).`
      )
    }

    await this.repository.updateDetails(providerId, newDoc, author)
  }

  // Sets the scratch root and marks the host as pinned. Pinned hosts are never overwritten by
  // probe (probe checks scratchPinned before updating scratchRoot — see probe() above).
  async setScratchRoot(providerId: string, path: string): Promise<void> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    await this.repository.updateScratchPinned(providerId, path)
  }

  // Stores the concurrent job limit (1..500). Phase 1 persists it only — no enforcement until
  // the job runner lands in a later phase.
  async setConcurrencyLimit(providerId: string, limit: number): Promise<void> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error(`Concurrent job limit must be an integer in the range 1..500 (got ${limit}).`)
    }

    await this.repository.updateConcurrencyLimit(providerId, limit)
  }

  // Lists the contents of a remote directory using find -printf via the existing exec SshRunner.
  // A single SSH round-trip collects: realpath (resolves ..), echo $HOME, and find output.
  // Returns a DirListing with entries sorted directories-first then alphabetically, plus roots and
  // resolvedPath metadata. Throws an Error with a .remoteFsError property on failure.
  async listDir(providerId: string, path: string): Promise<DirListing> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    let target
    try {
      target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const fsErr = new Error(msg) as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsErr.remoteFsError = { detail: msg, remoteKind: 'connection', retry_after_user_action: true }
      throw fsErr
    }

    // One round-trip: realpath → cd → echo $HOME → find -printf (NUL-separated).
    // Stdout format: <resolvedPath>\n<home>\n<find_output>
    // %Y = file type following symlinks (d for dir, f for file, l for broken symlink, etc.)
    // %s = size in bytes; %T@ = mtime as float seconds; %f = filename (last component)
    const quotedPath = JSON.stringify(path)
    const remoteCmd = [
      `realpath ${quotedPath} 2>/dev/null || echo ${quotedPath}`,
      `cd ${quotedPath} 2>&1 || true`,
      'echo "$HOME"',
      `find . -maxdepth 1 -mindepth 1 -printf '%Y\\t%s\\t%T@\\t%f\\0' 2>/dev/null`
    ].join('\n')

    const runResult = await this.runner.run(target, remoteCmd, {
      timeoutMs: LIST_DIR_TIMEOUT_MS,
      loginShell: false,
      maxOutputBytes: LIST_DIR_MAX_OUTPUT_BYTES
    })

    // Connection-level failure.
    if (runResult.timedOut || runResult.exitCode === 255) {
      const tail = errorTail(runResult.stderr, runResult.stdout)
      const fsErr = new Error(tail || 'Connection failed') as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsErr.remoteFsError = {
        detail: tail || 'SSH connection failed.',
        remoteKind: 'connection',
        retry_after_user_action: true
      }
      throw fsErr
    }

    // Non-connection failure: classify via stderr text.
    if (runResult.exitCode !== 0 && runResult.stderr) {
      const classified = classifyRemoteError({ stderr: runResult.stderr })
      const fsErr = new Error(runResult.stderr) as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsErr.remoteFsError = {
        detail: runResult.stderr,
        remoteKind: classified.remoteKind,
        retry_after_user_action: classified.retry_after_user_action
      }
      throw fsErr
    }

    // Parse the composite stdout: first line = resolvedPath, second line = home, rest = find output.
    const nlIdx1 = runResult.stdout.indexOf('\n')
    const nlIdx2 = runResult.stdout.indexOf('\n', nlIdx1 + 1)

    const resolvedPath = nlIdx1 !== -1 ? runResult.stdout.slice(0, nlIdx1).trim() : path
    const home = nlIdx2 !== -1 ? runResult.stdout.slice(nlIdx1 + 1, nlIdx2).trim() : ''
    const findOutput = nlIdx2 !== -1 ? runResult.stdout.slice(nlIdx2 + 1) : ''

    // Parse, sort, and apply 5000-entry hard limit.
    const parsed = parseFindListing(findOutput)

    // Sort: directories first, then files; each group alphabetical (case-sensitive, matching ls).
    parsed.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    const truncated = parsed.length > MAX_LIST_ENTRIES
    const entries = truncated ? parsed.slice(0, MAX_LIST_ENTRIES) : parsed

    return {
      entries,
      truncated,
      roots: {
        home: home || '~',
        scratch: host.scratchRoot ?? undefined
      },
      resolvedPath: resolvedPath || path
    }
  }

  // Executes a short remote command on the SSH host, preceded by an approval gate (design.md §6).
  //
  // When sessionId and projectId are supplied, grant memory is checked and recorded:
  //   - conversation: session in-memory grant (no card on repeat calls in the same session)
  //   - project: persisted to settings JSON (no card for that project after first approval)
  //   - once: no memory — card shown every time
  //
  // call_command does NOT count against the concurrent job limit (design.md §5).
  //
  // Returns ExecResult on success; throws ComputeCallError (as an Error with .code property) on
  // approval_denied, host_unreachable, or timeout.
  async callCommand(
    providerId: string,
    cmd: string,
    intent: string,
    loginShell = true,
    timeoutSeconds?: number,
    context?: { sessionId: string; projectId: string }
  ): Promise<ExecResult> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    // ── APPROVAL GATE (must fire before any SSH call) ──────────────────────────────
    if (!this.approvalBroker) {
      throw new Error('ComputeApprovalBroker is required to call callCommand.')
    }

    const commandPreview =
      cmd.length > COMMAND_PREVIEW_MAX_LEN ? `${cmd.slice(0, COMMAND_PREVIEW_MAX_LEN)}…` : cmd

    const approvalInfo = {
      provider_id: host.providerId,
      provider_name: host.displayName,
      shape: host.shape,
      intent,
      command_preview: commandPreview,
      command_full: cmd
    }

    // Use grant-aware requestWithContext when session/project context is available (issue 05).
    // Fall back to legacy request() otherwise (keeps backward compatibility).
    const decision = context
      ? await this.approvalBroker.requestWithContext(approvalInfo, {
          sessionId: context.sessionId,
          projectId: context.projectId,
          operation: 'call_command'
        })
      : await this.approvalBroker.request(approvalInfo)

    if (decision === 'deny') {
      const err = new Error(
        `Remote command approval was denied for host "${host.displayName}".`
      ) as Error & { computeCallError: ComputeCallError }
      err.computeCallError = {
        error_code: 'approval_denied',
        message: `Approval denied for call_command on ${host.displayName}.`,
        retry_after_user_action: false
      }
      throw err
    }

    // ── SSH EXECUTION ───────────────────────────────────────────────────────────────
    let target
    try {
      target = await resolveSshTarget(host.sshAlias, host.sshOverrides)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const callErr = new Error(msg) as Error & { computeCallError: ComputeCallError }
      callErr.computeCallError = {
        error_code: 'host_unreachable',
        message: msg,
        retry_after_user_action: true
      }
      throw callErr
    }

    // cwd = scratchRoot if configured; fallback to home on cd failure (design.md §5).
    const cwdExpr = host.scratchRoot
      ? `cd ${JSON.stringify(host.scratchRoot)} 2>/dev/null || cd ~`
      : 'cd ~'

    // Wrap the user command in a cwd-change prefix so it runs in the right directory.
    const wrappedCmd = `${cwdExpr}; ${cmd}`

    const timeoutMs =
      typeof timeoutSeconds === 'number' && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : CALL_COMMAND_DEFAULT_TIMEOUT_MS

    const runResult = await this.runner.run(target, wrappedCmd, {
      timeoutMs,
      loginShell,
      maxOutputBytes: CALL_COMMAND_MAX_OUTPUT_BYTES
    })

    // ── ERROR MAPPING ────────────────────────────────────────────────────────────────
    if (runResult.timedOut) {
      const callErr = new Error(
        `call_command on "${host.displayName}" timed out after ${timeoutMs}ms.`
      ) as Error & { computeCallError: ComputeCallError }
      callErr.computeCallError = {
        error_code: 'timeout',
        message: `Command timed out after ${timeoutMs / 1000}s.`,
        retry_after_user_action: false
      }
      throw callErr
    }

    // SSH exit code 255 indicates a connection-level failure (BatchMode auth failure, unknown host
    // key, network error). The user must fix the external condition; no automatic retry.
    if (runResult.exitCode === 255) {
      const tail = errorTail(runResult.stderr, runResult.stdout)
      const callErr = new Error(
        `SSH connection to "${host.displayName}" failed: ${tail || 'exit 255'}`
      ) as Error & { computeCallError: ComputeCallError }
      callErr.computeCallError = {
        error_code: 'host_unreachable',
        message: tail || 'SSH exit 255: connection failed.',
        retry_after_user_action: true
      }
      throw callErr
    }

    return {
      exit_code: runResult.exitCode,
      stdout: runResult.stdout,
      stderr: runResult.stderr,
      truncated: runResult.truncated
    }
  }
}
