import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { MEDICAL_PROVIDERS, MEDICAL_ROUTES } from '@aipoch/connector-builtins/medical-data'

const execute = promisify(execFile)
const runtimePackages = ['mcp', 'duckdb', 'pandas', 'httpx', 'pyreadstat']

export async function checkMedicalPython(
  python: string,
  signal?: AbortSignal,
  environment: Record<string, string> = {}
): Promise<void> {
  if (!existsSync(python)) {
    throw new Error(
      'Initialize the Python runtime in Settings > Runtimes before using the medical data engine. provider_info and access_requirements remain available without Python.'
    )
  }
  let output: string
  try {
    const result = await execute(
      python,
      [
        '-c',
        `import importlib.util,json; print(json.dumps([m for m in ${JSON.stringify(
          runtimePackages
        )} if importlib.util.find_spec(m) is None]))`
      ],
      {
        timeout: 15_000,
        windowsHide: true,
        signal,
        encoding: 'utf8',
        env: { ...process.env, ...environment }
      }
    )
    output = result.stdout
  } catch {
    signal?.throwIfAborted()
    throw new Error(
      'The medical data Python runtime could not be checked. Repair the selected Python runtime in Settings > Runtimes; no packages were installed automatically.'
    )
  }
  let missing: unknown
  try {
    missing = JSON.parse(output)
  } catch {
    throw new Error('The medical data Python runtime returned an invalid dependency check.')
  }
  if (!Array.isArray(missing) || missing.some((name) => !runtimePackages.includes(name))) {
    throw new Error('The medical data Python runtime returned an invalid dependency check.')
  }
  if (missing.length) {
    throw new Error(
      `Medical data engine requires Python packages: ${missing.join(
        ', '
      )}. Use manage_packages to add these packages to the default Python runtime according to the bundled requirements.txt. No packages were installed automatically. An administrator may select another prepared interpreter using OPEN_SCIENCE_MEDICAL_PYTHON.`
    )
  }
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

// Uses the application-owned MCP manager: its cached clients and application disposal own
// worker lifetime. Every route still passes through the bundled Connector approval gate.
export function createMedicalDataHandlers(deps: Dependencies): Record<string, Handler> {
  const handlers: Record<string, Handler> = {}
  for (const provider of MEDICAL_PROVIDERS) {
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
              package_requirements: [
                'mcp>=1.13.1,<2',
                'duckdb>=1.2.1,<2',
                'pandas>=2.2.3,<3',
                'httpx>=0.28.1,<1',
                'pyreadstat>=1.3.6,<2'
              ],
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
        await (deps.checkRuntime ?? checkMedicalPython)(python, signal, runtimeEnvironment)
        signal?.throwIfAborted()
        const env: Record<string, string> = {
          ...runtimeEnvironment,
          PYTHONUTF8: '1',
          PYTHONDONTWRITEBYTECODE: '1'
        }
        for (const name of provider.credentialNames) {
          if (environment[name]) env[name] = environment[name]!
        }
        return deps.client.call(
          {
            id: `builtin-medical:${provider.id}`,
            name: `builtin-medical-${provider.id}`,
            transport: 'stdio',
            command: python,
            args: [script, '--provider', provider.id, '--data-root', deps.dataRoot()],
            env
          },
          route.method,
          args,
          signal
        )
      }
    }
  }
  return handlers
}
