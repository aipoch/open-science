import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import {
  createPosixProcessTreeOwnership,
  trackOwnedPosixProcessTree,
  terminateProcessTree
} from '../process-tree'
import type { NotebookProcessSandbox, NotebookSandboxedSpawn } from '../notebook/process-sandbox'

const PYTHON_PROGRAM = String.raw`
import json
import os
import sys
from urllib.parse import urlparse, unquote
from importlib.metadata import version as package_version

def error_message(error):
    # Some native constructor errors include their entire configuration map.
    # The command-local proxy credentials must never become a tool result.
    message = str(error)
    proxy_value = os.environ.get("HTTPS_PROXY", "")
    secrets = [proxy_value]
    try:
        proxy = urlparse(proxy_value)
        secrets.extend([proxy.username, proxy.password, unquote(proxy.username or ""), unquote(proxy.password or "")])
    except ValueError:
        pass
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[redacted]")
    return message

# Diagnose this interpreter before opening any network connection. Packages are
# supplied by the configured environment; the connector never installs them.
try:
    if sys.version_info < (3, 10):
        raise RuntimeError("Python 3.10 or newer is required")
    import cellxgene_census
    import tiledbsoma
    import numpy as np
    import pandas as pd
    import pyarrow as pa
    runtime_versions = {
        name: package_version(name)
        for name in ("cellxgene-census", "tiledbsoma", "numpy", "pandas")
    }
except Exception as error:
    print(json.dumps({
        "id": 1, "ok": False,
        "error": "CENSUS_RUNTIME_UNAVAILABLE: Python " + sys.version.split()[0]
        + "; configure OPEN_SCIENCE_CENSUS_PYTHON with cellxgene-census, tiledbsoma, numpy and pandas. "
        + error_message(error),
    }), flush=True)
    sys.exit(1)

TILEDB_CONFIG = {
    "sm.skip_checksum_validation": "false",
    "vfs.s3.region": "us-west-2",
    "vfs.s3.no_sign_request": "true",
    # Bound metadata buffers instead of using Census's 1 GiB default.
    "py.init_buffer_bytes": 8 * 1024 * 1024,
    "soma.init_buffer_bytes": 8 * 1024 * 1024,
}


def tiledb_config():
    # TileDB uses the AWS C++ SDK, which does not consume HTTPS_PROXY itself.
    # Forward only the command-local gateway provided by Notebook sandbox wrap().
    proxy = urlparse(os.environ.get("HTTPS_PROXY", ""))
    if proxy.scheme != "http" or not proxy.hostname or not proxy.port:
        raise RuntimeError("Census requires the Notebook sandbox HTTP proxy")
    config = dict(TILEDB_CONFIG)
    config.update({
        "vfs.s3.proxy_host": proxy.hostname,
        "vfs.s3.proxy_port": str(proxy.port),
        "vfs.s3.proxy_scheme": proxy.scheme,
        "vfs.s3.proxy_username": unquote(proxy.username or ""),
        "vfs.s3.proxy_password": unquote(proxy.password or ""),
    })
    ca_file = os.environ.get("SSL_CERT_FILE")
    if ca_file:
        config["vfs.s3.ca_file"] = ca_file
    return config


def jsonable(value):
    if value is None:
        return None
    if isinstance(value, float) and not np.isfinite(value):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, np.generic):
        return jsonable(value.item())
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [jsonable(v) for v in value]
    return str(value)


def resolve_version(version):
    version = str(version or "stable")
    if version not in ("stable", "latest"):
        return version
    description = cellxgene_census.get_census_version_description(version)
    resolved = description.get("release_build") if isinstance(description, dict) else None
    if not resolved:
        raise ValueError(f"Census release {version!r} did not provide a build date")
    return str(resolved)


def organism_key(value):
    value = str(value or "homo_sapiens").strip().lower()
    aliases = {
        "human": "homo_sapiens",
        "homo sapiens": "homo_sapiens",
        "mouse": "mus_musculus",
        "mus musculus": "mus_musculus",
    }
    return aliases.get(value, value)


def text_filter(column, value):
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        raise ValueError(f"nonblank value required for {column}")
    # These values become a SOMA value_filter, never executable Python. Restricting the
    # character set keeps quoting predictable and avoids accepting an expression.
    if any(ch in value for ch in "\n\r\\'"):
        raise ValueError(f"invalid value for {column}")
    return f"{column} == '{value}'"


OBSERVATION_FILTER_COLUMNS = (
    ("tissue", "tissue_general"),
    ("cell_type", "cell_type"),
    ("disease", "disease"),
    ("sex", "sex"),
)


def observation_filter(args):
    clauses = []
    for field, column in OBSERVATION_FILTER_COLUMNS:
        clause = text_filter(column, args.get(field))
        if clause:
            clauses.append(clause)
    return " and ".join(clauses) or None


def observations(census, args, limit, columns=None):
    organism = organism_key(args.get("organism"))
    value_filter = observation_filter(args)
    if not value_filter:
        raise ValueError("at least one of tissue, cell_type, or disease is required")
    columns = columns or [
        "soma_joinid",
        "dataset_id",
        "assay",
        "cell_type",
        "tissue_general",
        "disease",
        "sex",
        "development_stage",
    ]
    dataframe = census["census_data"][organism]["obs"]
    get_enumerations = getattr(dataframe, "get_enumeration_values", None)
    if get_enumerations is not None:
        categorical = {
            column: str(args[field]).strip()
            for field, column in OBSERVATION_FILTER_COLUMNS
            if args.get(field) is not None and str(args[field]).strip()
            and isinstance(dataframe.schema.field(column).type, pa.DictionaryType)
        }
        if categorical:
            # An absent dictionary value cannot match an exact equality filter.
            # Use this release's complete enum, never a cached or sampled cohort.
            enumerations = get_enumerations(list(categorical))
            if any(value not in enumerations[column].to_pylist() for column, value in categorical.items()):
                return organism, pd.DataFrame(columns=columns)
    reader = dataframe.read(
        value_filter=value_filter,
        column_names=columns,
        result_order="row-major",
        # Only this bounded cell scan needs a small first batch.
        platform_config={"soma.init_buffer_bytes": "65536"},
    )
    frames = []
    rows = 0
    try:
        for table in reader:
            frame = table.slice(0, limit - rows).to_pandas()
            if frame.empty:
                continue
            remaining = limit - rows
            frames.append(frame.head(remaining))
            rows += min(len(frame), remaining)
            if rows >= limit:
                break
    finally:
        close = getattr(reader, "close", None)
        if close:
            close()
    frame = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=columns)
    return organism, frame.head(limit)


def list_datasets(census, args, census_version):
    frame = census["census_info"]["datasets"].read().concat().to_pandas()
    query = str(args.get("query") or "").strip().lower()
    if query:
        searchable = ["dataset_id", "dataset_title", "collection_name", "citation"]
        mask = frame[searchable].fillna("").astype(str).apply(
            lambda row: row.str.lower().str.contains(query, regex=False).any(), axis=1
        )
        frame = frame[mask]
    limit = int(args.get("limit", 25))
    columns = [
        "dataset_id",
        "dataset_version_id",
        "dataset_title",
        "collection_id",
        "collection_name",
        "collection_doi",
        "dataset_total_cell_count",
    ]
    available = [column for column in columns if column in frame.columns]
    rows = frame[available].head(limit).to_dict(orient="records")
    return {"census_version": census_version, "total": int(len(frame)), "datasets": jsonable(rows)}


def query_cells(census, args, census_version):
    limit = int(args.get("limit", 25))
    organism, frame = observations(census, args, limit)
    return {
        "census_version": census_version,
        "organism": organism,
        "total_returned": int(len(frame)),
        "cells": jsonable(frame.to_dict(orient="records")),
    }


def handle(request):
    action = request.get("action")
    # Reject invalid cohorts before release resolution or any remote handle opens.
    if action == "query_cells" and not observation_filter(request):
        raise ValueError("at least one of tissue, cell_type, or disease is required")
    version = str(request.get("census_version") or "stable")
    census_version = resolve_version(version)
    for attempt in range(2):
        try:
            # No cross-call cache: close every SOMA handle before reporting success.
            # A truncated S3 transfer can surface as a non-retryable checksum
            # error in the AWS SDK. Start a new read; never disable checksums.
            with cellxgene_census.open_soma(
                census_version=census_version, tiledb_config=tiledb_config()
            ) as census:
                if action == "list_datasets":
                    return list_datasets(census, request, census_version)
                if action == "query_cells":
                    return query_cells(census, request, census_version)
                raise ValueError(f"unknown Census action: {action}")
        except tiledbsoma.SOMAError as error:
            message = str(error)
            if attempt or "S3:" not in message or "Response checksums mismatch" not in message:
                raise
            # All actions are read-only, use the same resolved release, and share
            # the parent's original deadline. Persistent mismatches still fail.
            print("Census S3 checksum mismatch; retrying once with a fresh context.", file=sys.stderr, flush=True)


for line in sys.stdin:
    request = None
    try:
        request = json.loads(line)
        response = {"id": request.get("id"), "ok": True, "result": handle(request)}
    except Exception as error:
        response = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": error_message(error) + "; runtime=" + json.dumps(runtime_versions, sort_keys=True)}
    print(json.dumps(response, ensure_ascii=False, default=jsonable), flush=True)
`

type CensusRequest = Record<string, unknown> & { action: string }
type CensusResponse = { id: number; ok: boolean; result?: unknown; error?: string }
const CENSUS_TIMEOUT_MS = 180_000

const redactCensusDiagnostic = (message: string, env: NodeJS.ProcessEnv): string => {
  const secrets = new Set<string>()
  for (const [key, value] of Object.entries(env)) {
    if (!/^(https?|all)_proxy$/i.test(key) || !value) continue
    secrets.add(value)
    try {
      const proxy = new URL(value)
      for (const credential of [proxy.username, proxy.password]) {
        if (!credential) continue
        secrets.add(credential)
        try {
          secrets.add(decodeURIComponent(credential))
        } catch {
          // The encoded credential is still redacted if percent decoding fails.
        }
      }
    } catch {
      // Even an invalid proxy URL must not be echoed in a diagnostic.
    }
  }
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    message = message.replaceAll(secret, '[redacted]')
  }
  return message
}

// A venv needs its pyvenv.cfg/site-packages and the symlink target's standard library.
const pythonReadRoots = (executable: string): string[] => {
  if (!isAbsolute(executable)) return []
  const prefix = (path: string): string => {
    const directory = dirname(path)
    return basename(directory) === 'bin' || basename(directory) === 'Scripts'
      ? dirname(directory)
      : directory
  }
  return [...new Set([prefix(executable), prefix(realpathSync(executable))])]
}

export type CensusPythonHandlerOptions = {
  pythonPath?: string
  spawnProcess?: typeof spawn
  processSandbox?: NotebookProcessSandbox
  action?: string
}

export class CensusPythonRunner {
  constructor(private readonly options: CensusPythonHandlerOptions = {}) {}

  async call(
    request: CensusRequest,
    context: { sessionId?: string; projectId?: string },
    signal?: AbortSignal
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const executable =
      this.options.pythonPath ?? process.env.OPEN_SCIENCE_CENSUS_PYTHON ?? 'python3'
    const spawnProcess = this.options.spawnProcess ?? spawn
    const processSandbox = this.options.processSandbox
    if (!processSandbox) {
      throw new Error('CELLxGENE Census requires the Notebook Python network sandbox.')
    }
    if (!context.sessionId || !context.projectId) {
      throw new Error('CELLxGENE Census requires an active Notebook Session and Project.')
    }
    const readOnlyRoots = pythonReadRoots(executable)
    const deadlineController = new AbortController()
    const callSignal = signal
      ? AbortSignal.any([signal, deadlineController.signal])
      : deadlineController.signal
    const deadlineTimer = setTimeout(
      () =>
        deadlineController.abort(
          new Error(`CELLxGENE Census query timed out after ${CENSUS_TIMEOUT_MS}ms.`)
        ),
      CENSUS_TIMEOUT_MS
    )
    const id = 1
    let sandboxed: NotebookSandboxedSpawn | undefined
    let endSandboxExecution: (() => void) | undefined
    let child: ChildProcessWithoutNullStreams | undefined
    let settled = false
    let cleanupPromise: Promise<void> | undefined

    const cleanup = async (
      reason: 'exit' | 'cancel' | 'timeout' | 'spawn-failed'
    ): Promise<void> => {
      if (cleanupPromise) return cleanupPromise
      cleanupPromise = (async () => {
        endSandboxExecution?.()
        let processesTerminated = !child
        let terminationError: unknown
        if (child) {
          try {
            processesTerminated = (await terminateProcessTree(child)).reaped
            if (sandboxed?.confirmProcessTreeTermination) {
              processesTerminated = await sandboxed.confirmProcessTreeTermination()
            }
          } catch (error) {
            terminationError = error
            processesTerminated = false
          }
        }
        const result = await sandboxed?.cleanup(reason, {
          processesTerminated,
          ...(sandboxed.confirmProcessTreeTermination
            ? { confirmTermination: sandboxed.confirmProcessTreeTermination }
            : {})
        })
        if (terminationError) throw terminationError
        if (
          !processesTerminated ||
          (result &&
            (!result.processesTerminated ||
              !result.networkClosed ||
              !result.temporaryResourcesRemoved))
        ) {
          throw new Error(
            'CELLxGENE Census sandbox cleanup incomplete; process termination or resource release could not be confirmed.'
          )
        }
      })()
      return cleanupPromise
    }

    const invocation = {
      executable,
      args: ['-I', '-B', '-u', '-c', PYTHON_PROGRAM],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      cwd: process.cwd(),
      commandText: `${executable} -I -B -u -c <cellxgene-census-bridge>`,
      sessionId: context.sessionId ?? '',
      projectId: context.projectId ?? '',
      runtime: 'python' as const,
      superviseProcessTree: process.platform === 'win32',
      allowedNetworkHosts: [
        'census.cellxgene.cziscience.com',
        'cellxgene-census-public-us-west-2.s3.amazonaws.com',
        'cellxgene-census-public-us-west-2.s3.us-west-2.amazonaws.com'
      ],
      filesystem: {
        readOnlyRoots,
        readWriteRoots: [],
        deniedReadRoots: [],
        deniedWriteRoots: []
      },
      signal: callSignal
    }
    try {
      sandboxed = await processSandbox.wrap(invocation)
    } catch (error) {
      clearTimeout(deadlineTimer)
      throw error
    }
    let launch: ReturnType<NonNullable<NotebookSandboxedSpawn['beginSpawn']>> | undefined
    try {
      callSignal.throwIfAborted()
      endSandboxExecution = sandboxed.beginExecution?.()
      launch = sandboxed.beginSpawn?.()
      callSignal.throwIfAborted()
    } catch (error) {
      clearTimeout(deadlineTimer)
      launch?.notStarted()
      await cleanup(
        deadlineController.signal.aborted
          ? 'timeout'
          : callSignal.aborted
            ? 'cancel'
            : 'spawn-failed'
      )
      throw error
    }
    const executableToRun = sandboxed?.executable ?? executable
    const argsToRun = sandboxed?.args ?? invocation.args
    const envToRun = sandboxed?.env ?? invocation.env
    const promise = new Promise<unknown>((resolve, reject) => {
      const finish = async (
        error?: Error,
        result?: unknown,
        reason: 'exit' | 'cancel' | 'timeout' | 'spawn-failed' = 'exit'
      ): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(deadlineTimer)
        callSignal.removeEventListener('abort', abort)
        try {
          await cleanup(reason)
        } catch (cleanupError) {
          const cleanupMessage =
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          if (error) {
            reject(new Error(`${error.message} (sandbox cleanup failed: ${cleanupMessage})`))
          } else {
            reject(cleanupError instanceof Error ? cleanupError : new Error(cleanupMessage))
          }
          return
        }
        if (error) reject(error)
        else resolve(result)
      }
      const abort = (): void => {
        const timedOut = deadlineController.signal.aborted && !signal?.aborted
        void finish(
          callSignal.reason instanceof Error
            ? callSignal.reason
            : new Error('CELLxGENE Census query cancelled.'),
          undefined,
          timedOut ? 'timeout' : 'cancel'
        )
      }
      callSignal.addEventListener('abort', abort, { once: true })
      try {
        const ownership = createPosixProcessTreeOwnership(envToRun)
        callSignal.throwIfAborted()
        child = spawnProcess(executableToRun, argsToRun, {
          cwd: sandboxed.env.TMPDIR ?? invocation.cwd,
          env: ownership.env,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        if (process.platform !== 'win32') trackOwnedPosixProcessTree(child, ownership.token)
        launch?.started()
      } catch (error) {
        launch?.notStarted()
        void finish(
          error instanceof Error ? error : new Error(String(error)),
          undefined,
          'spawn-failed'
        )
        return
      }
      let buffer = ''
      let stdoutBytes = 0
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (settled) return
        stdoutBytes += Buffer.byteLength(chunk, 'utf8')
        if (stdoutBytes > 8 * 1024 * 1024) {
          void finish(new Error('CELLxGENE Census response exceeded the 8 MiB limit.'))
          return
        }
        buffer += chunk
        let newline = buffer.indexOf('\n')
        while (newline >= 0) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
          let response: CensusResponse
          try {
            response = JSON.parse(line) as CensusResponse
          } catch {
            continue
          }
          if (!response || typeof response !== 'object' || response.id !== id) continue
          if (response.ok) void finish(undefined, response.result)
          else void finish(new Error(response.error ?? 'CELLxGENE Census query failed.'))
        }
      })
      child.stderr.setEncoding('utf8')
      let stderrBuffer = ''
      child.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk.slice(0, Math.max(0, 8 * 1024 - stderrBuffer.length))
      })
      child.once('error', (error) => void finish(error, undefined, 'spawn-failed'))
      child.stdin.once?.('error', (error) => void finish(error, undefined, 'spawn-failed'))
      // exit can precede the final stdout/stderr data; close waits for both pipes.
      child.once('close', (code, exitSignal) => {
        if (!settled) {
          const diagnostic = sandboxed?.annotateStderr?.(stderrBuffer.trim())
          void finish(
            new Error(
              `CELLxGENE Census Python runtime exited (${exitSignal ?? `code ${code ?? 'unknown'}`}). ` +
                'No complete response was received.' +
                (diagnostic
                  ? ` ${redactCensusDiagnostic(diagnostic, envToRun).slice(0, 4000)}`
                  : '')
            )
          )
        }
      })
      try {
        child.stdin.write(`${JSON.stringify({ ...request, id })}\n`)
        child.stdin.end()
      } catch (error) {
        void finish(
          error instanceof Error ? error : new Error(String(error)),
          undefined,
          'spawn-failed'
        )
      }
    })
    return promise.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const redacted = redactCensusDiagnostic(message, envToRun)
      if (redacted === message) throw error
      throw new Error(redacted)
    })
  }

  dispose(): void {
    // Each request owns and cleans up its sandboxed process.
  }
}

type CensusHandler = (
  args: Record<string, unknown>,
  context?: { sessionId?: string; projectId?: string },
  signal?: AbortSignal
) => Promise<unknown>

export const createCensusHandler = (options: CensusPythonHandlerOptions = {}): CensusHandler => {
  const runner = new CensusPythonRunner(options)
  const handler = async (
    args: Record<string, unknown>,
    context: { sessionId?: string; projectId?: string } = {},
    signal?: AbortSignal
  ): Promise<unknown> => {
    signal?.throwIfAborted()
    const result = await runner.call(
      { ...args, action: options.action ?? args.action ?? '' } as CensusRequest,
      context,
      signal
    )
    signal?.throwIfAborted()
    return result
  }
  Object.defineProperty(handler, 'dispose', { value: () => runner.dispose() })
  return handler
}
