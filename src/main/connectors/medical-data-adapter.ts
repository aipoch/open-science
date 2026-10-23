import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { MEDICAL_PROVIDERS, MEDICAL_ROUTES } from '@aipoch/connector-builtins/medical-data'
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'

const execute = promisify(execFile)
const runtimePackages = ['mcp', 'duckdb', 'pandas', 'httpx', 'pyreadstat']
const runtimeRequirements = [
  { name: 'mcp', minimum: [1, 13, 1], maximumMajor: 2, spec: 'mcp>=1.13.1,<2' },
  { name: 'duckdb', minimum: [1, 2, 1], maximumMajor: 2, spec: 'duckdb>=1.2.1,<2' },
  { name: 'pandas', minimum: [2, 2, 3], maximumMajor: 3, spec: 'pandas>=2.2.3,<3' },
  { name: 'httpx', minimum: [0, 28, 1], maximumMajor: 1, spec: 'httpx>=0.28.1,<1' },
  { name: 'pyreadstat', minimum: [1, 3, 6], maximumMajor: 2, spec: 'pyreadstat>=1.3.6,<2' }
]

// Probe imports, not just module discovery: an installed native extension can still fail
// to load. Suppress arbitrary import output and never include exception text in the report.
const runtimeProbe = `import contextlib, importlib, importlib.metadata, io, json, sys
packages = []
for name in ${JSON.stringify(runtimePackages)}:
    version = None
    imported = False
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            version = importlib.metadata.version(name)
            importlib.import_module(name)
        imported = True
    except Exception:
        pass
    packages.append({'name': name, 'version': version, 'imported': imported})
print(json.dumps({'python': list(sys.version_info[:3]), 'packages': packages}))`

export function validateMedicalRuntimeReport(report: unknown): void {
  const invalid = (): never => {
    throw new Error('The medical data Python runtime returned an invalid dependency check.')
  }
  if (!report || typeof report !== 'object') invalid()
  const value = report as { python?: unknown; packages?: unknown }
  if (
    !Array.isArray(value.python) ||
    value.python.length !== 3 ||
    !value.python.every((part) => Number.isInteger(part) && part >= 0) ||
    !Array.isArray(value.packages) ||
    value.packages.length !== runtimePackages.length
  )
    invalid()
  const python = value.python as number[]
  if (python[0] < 3 || (python[0] === 3 && python[1] < 11)) {
    throw new Error(
      'The medical data engine requires Python 3.11 or newer. Select a supported prepared runtime.'
    )
  }
  const entries = value.packages as { name?: unknown; version?: unknown; imported?: unknown }[]
  if (
    entries.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        typeof item.name !== 'string' ||
        !runtimePackages.includes(item.name) ||
        typeof item.imported !== 'boolean'
    ) ||
    new Set(entries.map((item) => item.name)).size !== runtimePackages.length
  )
    invalid()
  const unsupported = runtimeRequirements.filter((requirement) => {
    const item = entries.find((entry) => entry.name === requirement.name)!
    if (
      !item.imported ||
      typeof item.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:\.post\d+)?$/.test(item.version)
    )
      return true
    const parts = item.version.split('.').slice(0, 3).map(Number)
    const comparison =
      parts[0] - requirement.minimum[0] ||
      parts[1] - requirement.minimum[1] ||
      parts[2] - requirement.minimum[2]
    return parts[0] >= requirement.maximumMajor || comparison < 0
  })
  if (unsupported.length) {
    throw new Error(
      `Medical data engine has missing, incompatible or unloadable Python packages: ${unsupported
        .map((item) => item.spec)
        .join(
          ', '
        )}. Repair the selected runtime using the existing package manager and bundled requirements.txt. No packages were installed automatically.`
    )
  }
}

export async function checkMedicalPython(
  python: string,
  signal?: AbortSignal,
  environment: Record<string, string> = {}
): Promise<void> {
  if (!isAbsolute(python)) {
    throw new Error('Select an absolute Python executable path for the medical data runtime.')
  }
  if (!existsSync(python)) {
    throw new Error(
      'Initialize the Python runtime in Settings > Runtimes before using the medical data engine. provider_info and access_requirements remain available without Python.'
    )
  }
  let output: string
  try {
    // Use the same inherited environment contract as the actual stdio worker. In particular,
    // a host PYTHONPATH/PYTHONHOME/LD_LIBRARY_PATH must not make this probe pass when the
    // worker will not inherit it. User-site discovery follows the selected interpreter.
    const probeEnvironment = {
      ...getDefaultEnvironment(),
      ...environment,
      PYTHONUTF8: '1',
      PYTHONDONTWRITEBYTECODE: '1'
    }
    const result = await execute(python, ['-c', runtimeProbe], {
      timeout: 15_000,
      windowsHide: true,
      signal,
      encoding: 'utf8',
      env: probeEnvironment,
      cwd: dirname(python)
    })
    output = result.stdout
  } catch {
    signal?.throwIfAborted()
    throw new Error(
      'The medical data Python runtime could not be checked. Repair the selected Python runtime in Settings > Runtimes; no packages were installed automatically.'
    )
  }
  let report: unknown
  try {
    report = JSON.parse(output)
  } catch {
    throw new Error('The medical data Python runtime returned an invalid dependency check.')
  }
  validateMedicalRuntimeReport(report)
}

type Handler = (
  args: Record<string, unknown>,
  context: unknown,
  signal?: AbortSignal
) => Promise<unknown>
type WorkerConfig = {
  id: string
  name: string
  transport: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
}
type Dependencies = {
  client: {
    close(id: string): Promise<void>
    call(
      config: WorkerConfig,
      method: string,
      args: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<unknown>
  }
  python: () => string
  script: () => string | undefined
  dataRoot: () => string
  environment?: () => Record<string, string | undefined>
  runtimeEnvironment?: () => Record<string, string>
  checkRuntime?: typeof checkMedicalPython
}

function waitForMedicalOperation<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(signal.reason ?? new Error('Medical data operation cancelled.'))
    if (signal.aborted) {
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

// Uses the application-owned MCP manager: its cached clients and application disposal own
// worker lifetime. Every route still passes through the bundled Connector approval gate.
export function createMedicalDataHandlers(deps: Dependencies): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  for (const provider of MEDICAL_PROVIDERS) {
    let current: { config: WorkerConfig; identity: string; jobs: Set<string> } | undefined
    let queue: Promise<unknown> = Promise.resolve()
    const guidance = (environment: Record<string, string | undefined>) => ({
      provider: provider.id,
      kind: provider.accessKind,
      message: provider.notes,
      application_url: provider.applicationUrl,
      permission_status: provider.access === 'public' ? 'public_scope_only' : 'not_verified',
      credentials: Object.fromEntries(
        provider.credentialNames.map((name) => [name, { configured: Boolean(environment[name]) }])
      ),
      credential_instructions:
        'Supply only the listed credentials in the application launch environment. Never paste secrets into chat or tool arguments. Presence does not verify authorization or credential validity.'
    })
    for (const route of MEDICAL_ROUTES.filter((item) => item.provider === provider.id)) {
      handlers[`${provider.id}/${route.method}`] = async (args, _context, signal) => {
        signal?.throwIfAborted()
        const environment = deps.environment?.() ?? process.env
        const access = guidance(environment)
        if (route.method === 'access_requirements') {
          return {
            ...access,
            ...(args.include_related_services
              ? {
                  related_credentials_status: 'not_checked_managed_by_host_app',
                  related_builtin_services: [
                    {
                      source: 'OpenAlex',
                      application_url: 'https://help.openalex.org/api/authentication/'
                    },
                    {
                      source: 'NCBI',
                      application_url: 'https://support.nlm.nih.gov/kbArticle/?pn=KA-05317'
                    },
                    {
                      source: 'openFDA',
                      application_url: 'https://open.fda.gov/apis/authentication/'
                    }
                  ]
                }
              : {})
          }
        }
        if (route.method === 'provider_info') {
          const root = join(deps.dataRoot(), provider.id)
          return {
            provider: provider.id,
            label: provider.label,
            access: provider.access,
            docs: provider.docs,
            portal: provider.portal,
            notes: provider.notes,
            download: provider.download,
            data_root: root,
            incoming_directory: join(root, 'incoming'),
            directory_creation:
              'Data folders are created on the first engine operation. Call list_tables after preparing Python before copying files into incoming.',
            access_guidance: access,
            return_row_data_to_model: provider.access === 'public' || provider.id === 'gbd',
            formats: [
              '.csv',
              '.csv.gz',
              '.tsv',
              '.txt',
              '.xpt',
              '.dta',
              '.sas7bdat',
              '.parquet',
              '.json',
              '.jsonl',
              '.ndjson'
            ],
            download_file_limit_bytes: 5 * 1024 ** 3,
            import_file_limit_bytes: 20 * 1024 ** 3,
            query_result_limit_rows: 1000,
            query_timeout_seconds: 20,
            bulk_download_resume: false,
            automatic_access_application: false,
            runtime: {
              language: 'python',
              required_packages: runtimePackages,
              package_requirements: runtimeRequirements.map((item) => item.spec),
              automatic_installation: false
            }
          }
        }
        const python = deps.python()
        const script = deps.script()
        if (!script)
          throw new Error(
            'The bundled medical data engine resources are missing. Repair the application installation.'
          )
        const runtimeEnvironment = deps.runtimeEnvironment?.() ?? {}
        const env: Record<string, string> = {
          ...runtimeEnvironment,
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1'
        }
        for (const name of provider.credentialNames) {
          if (environment[name]) env[name] = environment[name]!
        }
        const desired: WorkerConfig = {
          id: `builtin-medical:${provider.id}`,
          name: `builtin-medical-${provider.id}`,
          transport: 'stdio',
          command: python,
          args: [script, '--provider', provider.id, '--data-root', deps.dataRoot()],
          env
        }
        const identity = createHash('sha256').update(JSON.stringify(desired)).digest('hex')
        // The MCP manager caches by id. Serialize calls so configuration replacement cannot
        // close a worker while another request is using it. Background jobs retain their worker.
        const operation = queue.then(async () => {
          signal?.throwIfAborted()
          if (current && current.identity !== identity) {
            const pollingExistingJob =
              route.method === 'get_job' &&
              typeof args.job_id === 'string' &&
              current.jobs.has(args.job_id)
            if (!pollingExistingJob) {
              if (current.jobs.size) {
                throw new Error(
                  'Medical data worker configuration changed while background jobs are active. Poll their existing get_job identifiers until they finish, or restart the application to mark unfinished jobs interrupted. The active worker was not replaced.'
                )
              }
              await deps.client.close(current.config.id)
              current = undefined
            }
          }
          if (!current) {
            await (deps.checkRuntime ?? checkMedicalPython)(python, signal, runtimeEnvironment)
            signal?.throwIfAborted()
            current = { config: desired, identity, jobs: new Set() }
          }
          const result = await deps.client.call(current.config, route.method, args, signal)
          if (result && typeof result === 'object') {
            const job = result as { job_id?: unknown; status?: unknown }
            if (
              typeof job.job_id === 'string' &&
              ['queued', 'running'].includes(String(job.status))
            ) {
              current.jobs.add(job.job_id)
            }
            if (
              route.method === 'get_job' &&
              typeof args.job_id === 'string' &&
              ['ready', 'error', 'interrupted', 'cancelled'].includes(String(job.status))
            ) {
              current.jobs.delete(args.job_id)
            }
          }
          return result
        })
        queue = operation.catch(() => undefined)
        return waitForMedicalOperation(operation, signal)
      }
    }
  }
  return handlers
}
