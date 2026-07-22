import { mkdir, mkdtemp, readdir, stat as fsStat, rm } from 'node:fs/promises'
import { app } from 'electron'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'

import type {
  ComputeCallError,
  ComputeHost,
  DetailsAuthor,
  ExecResult,
  JobResult,
  ProbeResult,
  SubmitJobResult
} from '../../shared/compute'
import { DETAILS_DOC_MAX_LENGTH } from '../../shared/compute'
import type { DirListing, DownloadDest, LocalFile, RemoteFsError } from '../../shared/remote-fs'
import { classifyRemoteError, parseFindListing } from '../../shared/remote-fs'
import type { ComputeApprovalBroker } from './compute-approval-broker'
import type { ComputeHostRepository } from './repository'
import type { SshRunner } from './ssh-runner'
import { resolveSshTarget } from './ssh-runner'
import type { ScpRunner } from './scp-runner'
import {
  GLOB_CHARS,
  MAX_DOWNLOAD_BYTES,
  MAX_IMPORT_BYTES,
  SHELL_UNSAFE_CHARS,
  SystemScpRunner,
  inferMimeType,
  resolveDestFilename,
  runScpTransfer,
  shellSingleQuote,
  validateImportPath
} from './scp-runner'
import type { ComputeJobRepository } from './job-repository'
import { computeRemoteWorkdir, dispatchJob, hashCommand } from './job-dispatcher'
import type { StagedInputEntry } from './job-dispatcher'
import { getJobHarvestDir } from './harvest-engine'
import { getNotebookSessionRoot } from '../notebook/repository'
import type { ConcurrencyManager, SessionStatus } from './concurrency-manager'

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

// Raw input spec as submitted by the agent (before resolution to local paths).
// Three kinds:
//   workspace: {src:"relative/path.csv", dst_filename:"name.csv"}        — relative to session cwd
//   artifact:  {src:"/storage/artifacts/.../name.csv", dst_filename:...} — absolute artifact-store path
//   remote:    {remote_path:"/abs/path", dst_filename?:"name.csv"}       — symlinked, not uploaded
export type RawInputSpec =
  | { src: string; dst_filename: string } // workspace (relative) or artifact (absolute) — see resolveInputs
  | { remote_path: string; dst_filename?: string }

// Validates a dst_filename: must be a bare filename with no path separators.
const assertBareName = (name: string, label: string): void => {
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(
      `dst_filename must be a bare filename with no path separators (got "${name}" for ${label})`
    )
  }
}

// Checks a workspace path doesn't escape the workspace root.
// Returns the resolved absolute path on success, throws on escape.
const resolveWorkspacePath = (workspaceCwd: string, srcPath: string): string => {
  const resolved = resolve(workspaceCwd, srcPath)
  const rel = relative(resolve(workspaceCwd), resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workspace path "${srcPath}" would escape the workspace root "${workspaceCwd}"`)
  }
  return resolved
}

// Resolves an artifact-store path to a validated local absolute path. Backed in production by
// ArtifactRepository.resolveManagedFilePath, which enforces that the path stays inside the artifact
// store root (security boundary) and follows symlinks safely. This product addresses artifacts by
// path (the ArtifactFile.path an agent already holds), not by an opaque id — see design note below.
export interface ArtifactResolver {
  resolveArtifactPath(path: string): Promise<string>
}

// Validates and resolves raw input specs into staged manifest entries.
//   relative src   → resolveWorkspacePath  → StagedInputEntry{kind:'upload', localPath}
//   absolute src   → artifactResolver       → StagedInputEntry{kind:'upload', localPath}
//   remote_path    → validate absolute + no unsafe/glob chars → StagedInputEntry{kind:'symlink'}
// An absolute `src` is an artifact-store path (validated to stay inside the store by the resolver);
// a relative `src` is resolved against the session workspace cwd. remote_path inputs use their own
// key, so within the src branch absolute-vs-relative is an unambiguous discriminator. Returns
// [entries, inputs_summary].
export const resolveInputs = async (
  rawInputs: RawInputSpec[],
  workspaceCwd: string | undefined,
  artifactResolver: ArtifactResolver | undefined
): Promise<{ entries: StagedInputEntry[]; inputsSummary: string }> => {
  const entries: StagedInputEntry[] = []
  const summaryParts: string[] = []

  for (const raw of rawInputs) {
    if ('remote_path' in raw) {
      // Remote symlink: validate absolute + no unsafe/glob chars.
      const rp = raw.remote_path
      if (!rp.startsWith('/')) {
        throw new Error(`remote_path must be an absolute path (got "${rp}")`)
      }
      if (GLOB_CHARS.test(rp)) {
        throw new Error(`remote_path must not contain glob characters (got "${rp}")`)
      }
      if (SHELL_UNSAFE_CHARS.test(rp)) {
        throw new Error(`remote_path must not contain shell-unsafe characters (got "${rp}")`)
      }
      const dstFilename = raw.dst_filename ?? basename(rp)
      assertBareName(dstFilename, `remote_path "${rp}"`)
      entries.push({ kind: 'symlink', remotePath: rp, dstFilename, label: rp })
      summaryParts.push(`${dstFilename} (symlink)`)
    } else {
      // src-based input: absolute → artifact store, relative → workspace.
      const { src, dst_filename: dstFilename } = raw
      assertBareName(dstFilename, `src "${src}"`)

      if (isAbsolute(src)) {
        // Artifact-store path. The resolver enforces it stays inside the artifact store root.
        if (!artifactResolver) {
          throw new Error(`Cannot resolve artifact "${src}": ArtifactResolver is not available`)
        }
        const localPath = await artifactResolver.resolveArtifactPath(src)
        entries.push({ kind: 'upload', localPath, dstFilename, label: src })
        summaryParts.push(dstFilename)
      } else {
        // Workspace-relative path.
        if (!workspaceCwd) {
          throw new Error(`Cannot resolve workspace path "${src}": workspace_cwd is not available`)
        }
        const localPath = resolveWorkspacePath(workspaceCwd, src)
        entries.push({ kind: 'upload', localPath, dstFilename, label: src })
        summaryParts.push(dstFilename)
      }
    }
  }

  const inputsSummary =
    entries.length === 0
      ? ''
      : `${entries.length} input${entries.length === 1 ? '' : 's'}: ${summaryParts.join(', ')}`

  return { entries, inputsSummary }
}

// Maximum timeout seconds allowed for a job (7 days). Commands above this are rejected.
const JOB_MAX_TIMEOUT_SECONDS = 7 * 24 * 3600

// Default timeout when not specified (24 hours).
const JOB_DEFAULT_TIMEOUT_SECONDS = 24 * 3600

// ComputeService owns probe logic. It is injected with a SshRunner (for testability) and a
// repository (for persistence). It does NOT write detailsDoc — only probeResult, shape, and
// scratchRoot (when applicable). See design.md §4 for the probe/Details distinction.
// approvalBroker is optional: when omitted, callCommand throws rather than requesting approval
// (unit tests that don't exercise the approval path omit it).
// scpRunner is optional: when omitted a SystemScpRunner is used (production default).
// overrideDownloadsDir is optional: when supplied, used as the OS Downloads dir (for tests).
// jobRepository is optional: when omitted, submitJob will throw (for tests that don't need it).
// artifactResolver is optional: when omitted, artifact inputs in submitJob throw.
export class ComputeService {
  private readonly scpRunner: ScpRunner

  constructor(
    private readonly runner: SshRunner,
    private readonly repository: ComputeHostRepository,
    private readonly approvalBroker?: ComputeApprovalBroker,
    scpRunner?: ScpRunner,
    private readonly overrideDownloadsDir?: string,
    private readonly jobRepository?: ComputeJobRepository,
    private readonly onJobUpdated?: (job: import('../../shared/compute').ComputeJob) => void,
    private readonly artifactResolver?: ArtifactResolver,
    private readonly storageRoot?: string,
    private readonly concurrencyManager?: ConcurrencyManager
  ) {
    this.scpRunner = scpRunner ?? new SystemScpRunner()
  }

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
    let runResult = await this.runner.run(target, PROBE_SCRIPT, {
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

    // Retry once on transient routing errors (e.g. "No route to host", "Network is unreachable").
    // These occur on macOS when a virtual network bridge (multipass vmnet, Docker, VPN) is still
    // recovering after sleep/wake — the kernel immediately returns EHOSTUNREACH regardless of
    // ConnectTimeout. A 3-second wait is usually enough for the bridge to restore its routes.
    if (connectionFailed && !runResult.timedOut) {
      const errText = (runResult.stderr + runResult.stdout).toLowerCase()
      const isTransientRouting =
        errText.includes('no route to host') || errText.includes('network is unreachable')
      if (isTransientRouting) {
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
    //
    // `cd … || exit 1` is deliberate: a nonexistent / inaccessible path must surface a real
    // error (nonzero exit + cd's stderr) rather than silently falling back to listing $HOME.
    // We keep cd's stderr intact (no `2>&1`) so classifyRemoteError can distinguish
    // not_found ("no such file or directory") from permission ("permission denied").
    //
    // Single-quote the path so the remote shell performs no expansion: an attacker-named directory
    // like `$(...)` or with backticks (browsed via double-click) cannot inject commands. We author
    // this ssh-exec command ourselves, so single-quoting is robust (unlike scp — see validateImportPath).
    //
    // Exception: bare `~` and `~/…` are user-facing navigation shortcuts. Single-quoting suppresses
    // tilde expansion, so `realpath '~'` resolves to a literal file named "~" and `cd '~'` fails.
    // Expand these to `$HOME` / `$HOME/…` instead — $HOME is safe (set by sshd, not user input).
    const expandedPath =
      path === '~' ? '$HOME' : path.startsWith('~/') ? `$HOME/${path.slice(2)}` : path
    const quotedPath = expandedPath.startsWith('$HOME')
      ? expandedPath
      : shellSingleQuote(expandedPath)
    const remoteCmd = [
      `realpath ${quotedPath} 2>/dev/null || echo ${quotedPath}`,
      `cd ${quotedPath} || exit 1`,
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

  // Downloads a remote file to one of three destinations (design.md §4):
  //   - os-downloads:  scp directly to OS Downloads; ≤2 GiB; duplicate names get (1)/(2) suffix.
  //   - artifact:      scp to temp → validate (not-empty, not-dir, no-glob, ≤50 MB, post-transfer
  //                    re-stat) → write as project artifact with provenance metadata.
  //   - session-cache: scp to session workspace; agent Python API path (issue 04).
  //                    Requires approval from the ComputeApprovalBroker BEFORE scp.
  //                    Optional context enables grant-aware approval (conversation/project scope).
  //
  // Human-initiated downloads (os-downloads, artifact) do NOT trigger the approval gate.
  // Only session-cache (agent) downloads go through approval (design §5).
  //
  // Throws an Error with .remoteFsError on any failure (too_large / not_a_file / connection /
  // outside_roots / permission / other).
  async download(
    providerId: string,
    remotePath: string,
    dest: DownloadDest,
    context?: { sessionId: string; projectId: string }
  ): Promise<LocalFile> {
    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    // ── Resolve SSH target (used for both stat check and ControlMaster mux for scp) ──
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

    // Validate the remote path for EVERY destination before it reaches scp: absolute, no glob, no
    // shell-injection metacharacters/control chars. scp may pass the path through a remote shell
    // (version-dependent), so os-downloads and session-cache need this guard just as import does.
    const pathError = validateImportPath(remotePath)
    if (pathError) {
      const fsErr = new Error(`Invalid remote path: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsErr.remoteFsError = {
        detail: 'Path must be absolute and contain no glob or shell metacharacters.',
        remoteKind: pathError
      }
      throw fsErr
    }

    const filename = basename(remotePath)

    if (dest.kind === 'os-downloads') {
      return this._downloadToOsDownloads(host, target, remotePath, filename)
    } else if (dest.kind === 'artifact') {
      return this._downloadToArtifact(host, target, remotePath, filename)
    } else {
      // session-cache: agent download path — requires approval BEFORE scp (design.md §5).
      if (!this.approvalBroker) {
        throw new Error('ComputeApprovalBroker is required for session-cache downloads.')
      }

      const approvalInfo = {
        provider_id: host.providerId,
        provider_name: host.displayName,
        shape: host.shape,
        intent: 'Download remote file to session workspace',
        remote_path: remotePath
      }

      // Use grant-aware requestWithContext when session/project context is available.
      // Falls back to once-only request() when no context is supplied.
      const decision = context
        ? await this.approvalBroker.requestWithContext(approvalInfo, {
            sessionId: context.sessionId,
            projectId: context.projectId,
            operation: 'download'
          })
        : await this.approvalBroker.request(approvalInfo)

      if (decision === 'deny') {
        const err = new Error(
          `Download approval was denied for "${remotePath}" on host "${host.displayName}".`
        ) as Error & { code: string }
        err.code = 'download_denied'
        throw err
      }

      return this._downloadToSessionCache(host, target, remotePath, filename)
    }
  }

  // Downloads to the OS Downloads folder. ≤2GiB limit, (1)/(2) collision rename.
  private async _downloadToOsDownloads(
    host: ComputeHost,
    target: import('./ssh-runner').ResolvedSshTarget,
    remotePath: string,
    filename: string
  ): Promise<LocalFile> {
    // Pre-transfer size check via ssh runner.
    const remoteSize = await this._statRemoteSize(host, target, remotePath)

    if (remoteSize > MAX_DOWNLOAD_BYTES) {
      const fsErr = new Error(
        `File exceeds 2 GiB download limit (${remoteSize} bytes)`
      ) as Error & {
        remoteFsError: RemoteFsError
      }
      fsErr.remoteFsError = {
        detail: `File size ${remoteSize} bytes exceeds the 2 GiB download limit.`,
        remoteKind: 'too_large'
      }
      throw fsErr
    }

    const downloadsDir = this.overrideDownloadsDir ?? this._getDownloadsDir()
    await mkdir(downloadsDir, { recursive: true })

    const destName = await resolveDestFilename(downloadsDir, filename)
    const destPath = join(downloadsDir, destName)

    await runScpTransfer(this.scpRunner, target, remotePath, destPath)

    const fileStat = await fsStat(destPath)
    const mimeType = inferMimeType(filename)

    return { path: destPath, name: destName, size: fileStat.size, mimeType }
  }

  // Downloads to a temp dir and stores as project artifact with provenance.
  // projectId is carried via the dest object; the actual ArtifactRepository write hook
  // will be wired in issue 04. For now we return the temp path + artifactId for the renderer.
  private async _downloadToArtifact(
    host: ComputeHost,
    target: import('./ssh-runner').ResolvedSshTarget,
    remotePath: string,
    filename: string
  ): Promise<LocalFile> {
    // Validate path: absolute, no glob chars.
    const pathError = validateImportPath(remotePath)
    if (pathError) {
      const fsErr = new Error(`Invalid remote path: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsErr.remoteFsError = {
        detail: `Path must be absolute and contain no glob characters.`,
        remoteKind: pathError
      }
      throw fsErr
    }

    // Pre-transfer stat: must be a regular non-empty file ≤50 MB.
    const { fileType, size: remoteSize } = await this._statRemote(host, target, remotePath)

    if (fileType !== 'f') {
      const fsErr = new Error(`Remote path is not a regular file: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsErr.remoteFsError = {
        detail: fileType === 'd' ? 'Path is a directory.' : 'Path is not a regular file.',
        remoteKind: 'not_a_file'
      }
      throw fsErr
    }

    if (remoteSize === 0) {
      const fsErr = new Error(`Remote file is empty: ${remotePath}`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsErr.remoteFsError = {
        detail: 'Cannot import an empty file.',
        remoteKind: 'not_a_file'
      }
      throw fsErr
    }

    if (remoteSize > MAX_IMPORT_BYTES) {
      const fsErr = new Error(`File exceeds 50 MB import limit (${remoteSize} bytes)`) as Error & {
        remoteFsError: RemoteFsError
      }
      fsErr.remoteFsError = {
        detail: `File size ${remoteSize} bytes exceeds the 50 MB import limit.`,
        remoteKind: 'too_large'
      }
      throw fsErr
    }

    // scp to a temp directory.
    const tmpBase = this.overrideDownloadsDir ?? tmpdir()
    const tempDir = await mkdtemp(join(tmpBase, 'cs-import-'))
    const tempPath = join(tempDir, filename)

    try {
      await runScpTransfer(this.scpRunner, target, remotePath, tempPath)

      // Post-transfer re-stat: reject if the file grew during transfer (TOCTOU guard).
      const localStat = await fsStat(tempPath)
      if (localStat.size > remoteSize) {
        const fsErr = new Error(`File grew during transfer: ${remotePath}`) as Error & {
          remoteFsError: RemoteFsError
        }
        fsErr.remoteFsError = {
          detail: 'File size changed during transfer — import rejected.',
          remoteKind: 'not_a_file'
        }
        await rm(tempDir, { recursive: true, force: true })
        throw fsErr
      }

      // Build artifact id. Provenance (ssh:<host>:<path>) is embedded in the LocalFile for the
      // IPC handler to forward to ArtifactRepository when persisting (issue 04 hook).
      const artifactId = `${randomUUID()}|ssh:${host.displayName}:${remotePath}`
      const mimeType = inferMimeType(filename)

      // Return the artifact info. The caller (IPC handler) is responsible for persisting this
      // artifact via the ArtifactRepository so it appears in the project artifact panel.
      return {
        path: tempPath,
        name: filename,
        size: localStat.size,
        mimeType,
        artifactId
        // provenance is stored in artifactId so the renderer can surface it
        // (ArtifactFile metadata will include provenance via the IPC handler)
      }
    } catch (err) {
      // Clean up the temp dir unless we already cleaned it above.
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
  }

  // Downloads to a session-cache temp dir. Approval gate is applied in download() before this is
  // called for session-cache requests (design.md §5 — approval fires before scp).
  private async _downloadToSessionCache(
    _host: ComputeHost,
    target: import('./ssh-runner').ResolvedSshTarget,
    remotePath: string,
    filename: string
  ): Promise<LocalFile> {
    const tempDir = await mkdtemp(join(tmpdir(), 'cs-session-'))
    const destPath = join(tempDir, filename)

    await runScpTransfer(this.scpRunner, target, remotePath, destPath)

    const fileStat = await fsStat(destPath)
    const mimeType = inferMimeType(filename)

    return { path: destPath, name: filename, size: fileStat.size, mimeType }
  }

  // Returns the OS Downloads path via Electron's app module.
  private _getDownloadsDir(): string {
    try {
      return app.getPath('downloads')
    } catch {
      // Fallback for test environments without a full Electron runtime.
      return join(tmpdir(), 'downloads')
    }
  }

  // Runs a remote stat to get file type and size in a single SSH round-trip.
  // Output format: "<type> <size>" where type ∈ { f, d, ? }.
  private async _statRemote(
    _host: ComputeHost,
    target: import('./ssh-runner').ResolvedSshTarget,
    remotePath: string
  ): Promise<{ fileType: string; size: number }> {
    // Single-quote to neutralise shell expansion of the path in this ssh-exec command (same
    // injection class as listDir). The scp transfer that follows is guarded separately by
    // validateImportPath, since scp's remote-path shell handling is version-dependent.
    const quoted = shellSingleQuote(remotePath)
    // Portable: test for file/dir, get size via stat -c (Linux) with macOS fallback.
    const cmd = [
      `if [ -f ${quoted} ]; then`,
      `  printf 'f '; stat -c '%s' ${quoted} 2>/dev/null || stat -f '%z' ${quoted}`,
      `elif [ -d ${quoted} ]; then`,
      `  echo 'd 0'`,
      `else`,
      `  echo '? 0'`,
      `fi`
    ].join('\n')

    const result = await this.runner.run(target, cmd, {
      timeoutMs: 10_000,
      loginShell: false,
      maxOutputBytes: 64
    })

    if (result.timedOut || result.exitCode === 255) {
      const fsErr = new Error('SSH connection failed during stat') as Error & {
        remoteFsError: RemoteFsError & { retry_after_user_action: boolean }
      }
      fsErr.remoteFsError = {
        detail: 'Connection failed.',
        remoteKind: 'connection',
        retry_after_user_action: true
      }
      throw fsErr
    }

    const parts = result.stdout.trim().split(/\s+/)
    const fileType = parts[0] ?? '?'
    const size = Number.parseInt(parts[1] ?? '0', 10)

    return { fileType, size: Number.isFinite(size) ? size : 0 }
  }

  // Runs a remote stat returning only file size. Used for os-downloads where we don't need type.
  private async _statRemoteSize(
    host: ComputeHost,
    target: import('./ssh-runner').ResolvedSshTarget,
    remotePath: string
  ): Promise<number> {
    const { size } = await this._statRemote(host, target, remotePath)
    return size
  }

  // Submits a remote compute job asynchronously (design.md §4, §5).
  //
  // Flow:
  //   1. Validate host exists and timeout is within bounds.
  //   2. Resolve and validate inputs (workspace/artifact/remote_path).
  //   3. Pre-generate a job_id (not yet in DB).
  //   4. Fire approval gate (before any DB write or SSH).
  //   5. On approval: write ComputeJob row (status=submitted) + trigger background dispatch.
  //   6. Return { job_id, provider_id, status:'submitted', remote_workdir } immediately.
  //
  // The background dispatcher transitions the job to running (or error) without blocking this call.
  async submitJob(
    providerId: string,
    intent: string,
    command: string,
    options: {
      environment?: string
      resourceRequest?: string
      inputs?: RawInputSpec[]
      outputManifest?: string
      harvestConfig?: string
      timeoutSeconds?: number
      workspaceCwd?: string
    },
    context: { sessionId: string; projectId: string }
  ): Promise<SubmitJobResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call submitJob.')
    }

    const host = await this.repository.get(providerId)
    if (!host) {
      throw new Error(`No compute host found with provider id "${providerId}".`)
    }

    // Validate timeout bounds.
    const rawTimeout = options.timeoutSeconds
    if (rawTimeout !== undefined) {
      if (!Number.isInteger(rawTimeout) || rawTimeout <= 0) {
        const err = new Error(
          `timeout_seconds must be a positive integer (got ${rawTimeout}).`
        ) as Error & { computeCallError: ComputeCallError }
        err.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds must be a positive integer.`,
          retry_after_user_action: false
        }
        throw err
      }
      if (rawTimeout > JOB_MAX_TIMEOUT_SECONDS) {
        const err = new Error(
          `timeout_seconds ${rawTimeout} exceeds the 7-day maximum. Use a scheduler driver for multi-day jobs.`
        ) as Error & { computeCallError: ComputeCallError }
        err.computeCallError = {
          error_code: 'timeout',
          message: `timeout_seconds exceeds the 7-day (${JOB_MAX_TIMEOUT_SECONDS}s) maximum.`,
          retry_after_user_action: false
        }
        throw err
      }
    }
    const timeoutSeconds = rawTimeout ?? JOB_DEFAULT_TIMEOUT_SECONDS

    // ── RESOLVE INPUTS (validation in main process — security boundary) ───────────
    let stagedEntries: StagedInputEntry[] = []
    let inputsSummary = ''
    if (options.inputs && options.inputs.length > 0) {
      const resolved = await resolveInputs(
        options.inputs,
        options.workspaceCwd,
        this.artifactResolver
      )
      stagedEntries = resolved.entries
      inputsSummary = resolved.inputsSummary
    }

    // Pre-generate job_id for the approval card's remote_workdir preview.
    const jobId = randomUUID()
    const remoteWorkdir = computeRemoteWorkdir(host.scratchRoot, jobId)

    // ── APPROVAL GATE (must fire before any DB write or SSH) ──────────────────────
    if (!this.approvalBroker) {
      throw new Error('ComputeApprovalBroker is required to call submitJob.')
    }

    const commandPreview =
      command.length > COMMAND_PREVIEW_MAX_LEN
        ? `${command.slice(0, COMMAND_PREVIEW_MAX_LEN)}…`
        : command

    const approvalInfo = {
      provider_id: host.providerId,
      provider_name: host.displayName,
      shape: host.shape,
      intent,
      command_preview: commandPreview,
      command_full: command,
      inputs_summary: inputsSummary || undefined,
      timeout_seconds: timeoutSeconds,
      remote_workdir: remoteWorkdir
    }

    const decision = await this.approvalBroker.requestWithContext(approvalInfo, {
      sessionId: context.sessionId,
      projectId: context.projectId,
      operation: 'submit_job'
    })

    if (decision === 'deny') {
      const err = new Error(
        `Job submission approval was denied for host "${host.displayName}".`
      ) as Error & { computeCallError: ComputeCallError }
      err.computeCallError = {
        error_code: 'approval_denied',
        message: `Approval denied for submit_job on ${host.displayName}.`,
        retry_after_user_action: false
      }
      throw err
    }

    // ── WRITE JOB ROW ──────────────────────────────────────────────────────────────
    const commandHash = hashCommand(command)
    const inputManifest = stagedEntries.length > 0 ? JSON.stringify(stagedEntries) : undefined

    await this.jobRepository.create({
      id: jobId,
      providerId: host.providerId,
      shape: host.shape,
      sessionId: context.sessionId,
      projectId: context.projectId,
      intent,
      command,
      commandHash,
      environment: options.environment,
      resourceRequest: options.resourceRequest,
      inputManifest,
      outputManifest: options.outputManifest,
      harvestConfig: options.harvestConfig,
      timeoutSeconds,
      remoteWorkdir
    })

    // ── BACKGROUND DISPATCH (non-blocking) ────────────────────────────────────────
    // Fire-and-forget. Errors are persisted to the job row by the dispatcher.
    void dispatchJob(jobId, {
      runner: this.runner,
      scpRunner: this.scpRunner,
      hostRepository: this.repository,
      jobRepository: this.jobRepository,
      onJobUpdated: this.onJobUpdated
    })

    return {
      job_id: jobId,
      provider_id: host.providerId,
      status: 'submitted',
      remote_workdir: remoteWorkdir
    }
  }

  // Returns the lightweight status shape for a job. Does not make any SSH call.
  async getJobStatus(jobId: string): Promise<import('../../shared/compute').JobStatusResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call getJobStatus.')
    }

    const job = await this.jobRepository.get(jobId)
    if (!job) {
      throw new Error(`No compute job found with id "${jobId}".`)
    }

    return {
      job_id: job.job_id,
      status: job.status,
      exit_code: job.exit_code,
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail,
      remote_workdir: job.remote_workdir
    }
  }

  // Returns the full job result (spec §11.4, design §9). Non-blocking: reads DB row + scans
  // the local harvest directory. Does not make any SSH call or trigger harvest.
  //
  // Four-timing semantics:
  //  1. Non-terminal (submitted/running): empty file lists, no error.
  //  2. Terminal but harvest not done (harvestedAt null): same.
  //  3. Clean harvest (harvestedAt set, harvestError null): full file lists.
  //  4. harvest_failed (harvestedAt set, harvestError non-null): partial files + remote_workdir.
  //
  // File paths are workspace-relative (e.g. "hpc/<jobId>/featured/out.result") so the agent's
  // data kernel can directly open() them relative to the workspace cwd (design §4).
  async getJobResult(jobId: string): Promise<JobResult> {
    if (!this.jobRepository) {
      throw new Error('ComputeJobRepository is required to call getJobResult.')
    }

    const job = await this.jobRepository.get(jobId)
    if (!job) {
      throw new Error(`No compute job found with id "${jobId}".`)
    }

    // Terminal states that can have harvest output.
    const terminalStates = new Set(['success', 'failed', 'timeout', 'error'])
    const isTerminal = terminalStates.has(job.status)

    // Parse left_on_remote JSON from the job row (may be undefined before harvest).
    let leftOnRemote: Array<{ uri: string; size_mb: number; reason: string }> = []
    if (job.left_on_remote) {
      try {
        leftOnRemote = JSON.parse(job.left_on_remote) as typeof leftOnRemote
      } catch {
        // Malformed JSON — treat as empty (same guard as harvest-engine and job-notifier).
      }
    }

    // Return empty file lists for non-terminal or pre-harvest states (design §9 rules 1 & 2).
    if (!isTerminal || !job.harvested_at) {
      return {
        job_id: job.job_id,
        status: job.status,
        exit_code: job.exit_code,
        featured_files: [],
        hidden_files: [],
        output_files: [],
        left_on_remote: [],
        remote_workdir: job.remote_workdir,
        stdout_tail: job.stdout_tail,
        stderr_tail: job.stderr_tail
      }
    }

    // Harvest is done (rules 3 & 4): scan the local harvest directory for actual files.
    // storageRoot is required to locate the harvest directory.
    const effectiveStorageRoot = this.storageRoot
    if (!effectiveStorageRoot) {
      // Fall back to empty file lists if storageRoot was not wired (should not happen in prod).
      return {
        job_id: job.job_id,
        status: job.status,
        exit_code: job.exit_code,
        featured_files: [],
        hidden_files: [],
        output_files: [],
        left_on_remote: leftOnRemote,
        remote_workdir: job.remote_workdir,
        stdout_tail: job.stdout_tail,
        stderr_tail: job.stderr_tail
      }
    }

    const harvestDir = getJobHarvestDir(
      effectiveStorageRoot,
      job.project_id,
      job.session_id,
      job.job_id
    )
    // Workspace root: one level up from hpc/<jobId>/ — the session workspace cwd.
    const workspaceCwd = getNotebookSessionRoot(
      effectiveStorageRoot,
      job.project_id,
      job.session_id
    )

    const featuredFiles = await scanDirRelative(join(harvestDir, 'featured'), workspaceCwd)
    const hiddenFiles = await scanDirRelative(join(harvestDir, 'hidden'), workspaceCwd)

    return {
      job_id: job.job_id,
      status: job.status,
      exit_code: job.exit_code,
      featured_files: featuredFiles,
      hidden_files: hiddenFiles,
      // featured first, then hidden (design §9).
      output_files: [...featuredFiles, ...hiddenFiles],
      left_on_remote: leftOnRemote,
      remote_workdir: job.remote_workdir,
      stdout_tail: job.stdout_tail,
      stderr_tail: job.stderr_tail
    }
  }

  // ---------------------------------------------------------------------------
  // Session concurrency control (Phase 3c, issue 04)
  // ---------------------------------------------------------------------------

  // Set session-level concurrency limit. Delegates to ConcurrencyManager.
  async setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager not initialized')
    }
    if (limit <= 0 || !Number.isInteger(limit)) {
      throw new Error('Concurrency limit must be a positive integer')
    }
    this.concurrencyManager.setSessionLimit(sessionId, limit)
  }

  // Get session concurrency status. Delegates to ConcurrencyManager and enriches with provider ceilings.
  async getSessionConcurrencyStatus(sessionId: string): Promise<SessionStatus> {
    if (!this.concurrencyManager) {
      throw new Error('ConcurrencyManager not initialized')
    }
    // Get status from manager (includes provider ceilings from jobs in this session)
    const status = await this.concurrencyManager.getStatus(sessionId)

    // Enrich with ALL registered compute hosts (not just those with jobs in this session)
    const allHosts = await this.repository.list()
    for (const host of allHosts) {
      // Only set if not already present from jobs
      if (!(host.providerId in status.provider_ceilings)) {
        status.provider_ceilings[host.providerId] = host.concurrencyLimit ?? 10
      }
    }

    return status
  }
}

// ---------------------------------------------------------------------------
// scanDirRelative: recursively list files under a directory, returning paths
// relative to workspaceCwd. Returns [] if the directory does not exist.
// ---------------------------------------------------------------------------

async function scanDirRelative(dir: string, workspaceCwd: string): Promise<string[]> {
  const results: string[] = []
  try {
    await collectFiles(dir, dir, workspaceCwd, results)
  } catch {
    // Directory absent (harvest not created yet, or was deleted) — return empty.
  }
  return results
}

async function collectFiles(
  baseDir: string,
  currentDir: string,
  workspaceCwd: string,
  results: string[]
): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(currentDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      await collectFiles(baseDir, fullPath, workspaceCwd, results)
    } else if (entry.isFile()) {
      // Use workspace-relative path so agent can open() directly (design §4).
      results.push(relative(workspaceCwd, fullPath))
    }
  }
}
