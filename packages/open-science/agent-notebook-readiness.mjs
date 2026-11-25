/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { z } from 'zod'

const actions = {
  notebook_environment_preparing: [
    'service',
    'recheck_setup',
    'Notebook environment setup is running. Check setup again after it finishes.'
  ],
  notebook_environment_recovery_required: [
    'user',
    'review_notebook_environment',
    'Review recovery for the selected language. Recheck setup, or use repair_notebook_environment if the user explicitly authorizes rebuilding the managed default. The manual location is Settings > Runtimes.'
  ],
  notebook_environment_missing: [
    'agent',
    'prepare_notebook_environment',
    'Use prepare_notebook_environment for the requested language with user authorization. The manual location is Settings > Runtimes.'
  ],
  notebook_language_required: [
    'user',
    'choose_notebook_language',
    'No Notebook language is ready. Check the Python and R results and choose a language when the user requests computation.'
  ],
  notebook_python_missing: [
    'user',
    'choose_notebook_language',
    'This service reports legacy Python readiness only. Check the required language in Open-Science or update the service.'
  ],
  notebook_sandbox_preparing: [
    'service',
    'recheck_setup',
    'The Notebook protection check is in progress. Check setup again when it finishes.'
  ],
  notebook_bubblewrap_missing: [
    'deployment',
    'install_bubblewrap',
    'Install the distribution bubblewrap package and restart Open-Science with bwrap on the service PATH.'
  ],
  notebook_trust_bundle_invalid: [
    'deployment',
    'review_notebook_trust_bundle',
    'Check the service CA certificates, OpenSSL support, and the Notebook trust bundle setting. Use a readable PEM bundle with the required public roots.'
  ],
  notebook_linux_isolation_unconfirmed: [
    'deployment',
    'verify_notebook_isolation',
    'Verify that the Open-Science service user can launch bubblewrap with its required namespaces and private procfs mount in this deployment.'
  ],
  notebook_linux_namespaces_unavailable: [
    'deployment',
    'review_linux_namespaces',
    'Verify that the service account and container are permitted to create the namespaces required by bubblewrap.'
  ],
  notebook_linux_private_procfs_unavailable: [
    'deployment',
    'review_linux_private_procfs',
    'Verify that the deployment permits bubblewrap to mount a private procfs inside the Notebook sandbox.'
  ],
  notebook_windows_isolation_unconfirmed: [
    'user',
    'review_notebook_protection',
    'Check Notebook protection in Open-Science Settings. Its compatibility probe is outside this read-only check.'
  ],
  notebook_platform_unconfirmed: [
    'deployment',
    'verify_notebook_isolation',
    'Check the Notebook protection requirements for this service platform.'
  ],
  notebook_sandbox_unavailable: [
    'deployment',
    'review_notebook_protection',
    'Check the service log and repair the native Notebook protection dependencies on this host.'
  ],
  notebook_linux_procfs_unavailable: [
    'deployment',
    'review_linux_procfs',
    'Restore access to genuine kernel procfs for the service and verify the deployment supports the Notebook private procfs mount.'
  ],
  notebook_linux_cgroup_unavailable: [
    'deployment',
    'review_linux_cgroup',
    'Use a supported deployment where the memory reader can authenticate the cgroup namespace and see all limiting ancestors.'
  ],
  notebook_memory_policy_unavailable: [
    'deployment',
    'review_memory_policy',
    'Check the service log for the Notebook memory policy failure and repair the host memory reader.'
  ],
  notebook_memory_recovering: [
    'service',
    'recheck_setup',
    'The host memory reading has returned to normal. Check setup again in a few seconds while Open-Science confirms that it stays stable.'
  ],
  notebook_memory_pressure: [
    'deployment',
    'review_memory_pressure',
    'Wait for memory pressure to clear in the reported execution scope, or ask the operator to free resources.'
  ],
  notebook_evidence_unavailable: [
    'service',
    'recheck_setup',
    'Some Notebook evidence could not be read. Recheck this profile and inspect the service log if it stays unconfirmed.'
  ],
  delivery_directory_not_directory: [
    'user',
    'review_delivery_directory',
    'The default delivery location is not a regular directory. Ask the user for a suitable directory.'
  ],
  delivery_directory_not_writable: [
    'user',
    'review_delivery_directory',
    'Ask the user to make the default delivery directory writable or specify a writable destination.'
  ],
  delivery_directory_unconfirmed: [
    'user',
    'review_delivery_directory',
    'Check access to the default delivery directory from the CLI or MCP process.'
  ]
}

const status = z.enum(['ready', 'blocked', 'checking', 'unconfirmed'])
const check = z.object({ status, reason: z.enum(Object.keys(actions)).optional().catch(undefined) })
const sources = z.enum([
  'darwin-sysctl-dispatch',
  'linux-proc',
  'linux-proc-cgroup-v1',
  'linux-proc-cgroup-v2',
  'windows-performance-info',
  'darwin',
  'linux',
  'win32'
])
const scope = z
  .string()
  .regex(/^(darwin:host|windows:host|linux:host|linux:cgroup-v[12]:\/[\w./:@-]{0,241}|default)$/u)
const schemas = {
  environment: check.extend({
    python: check.optional(),
    r: check.optional(),
    pythonReady: z.boolean().optional(),
    rReady: z.boolean().optional()
  }),
  dependencies: check,
  sandbox: check,
  memoryPolicy: check.extend({
    source: sources.optional().catch(undefined),
    executionScope: scope.optional().catch(undefined)
  })
}

export function projectAgentNotebookReadiness(evidence, profile, language) {
  const platform = z.enum(['darwin', 'linux', 'win32']).safeParse(evidence?.platform)
  const checks = Object.fromEntries(
    Object.entries(schemas).map(([key, schema]) => [
      key,
      schema.safeParse(evidence?.[key]).data ?? { status: 'unconfirmed' }
    ])
  )
  const environment = checks.environment
  if (environment.python && environment.r) {
    const languages = [environment.python, environment.r]
    const active = language
      ? environment[language]
      : (languages.find(({ status }) => status === 'ready') ??
        languages.find(({ status }) => status === 'checking') ??
        (languages.every(({ status }) => status === 'blocked')
          ? { status: 'blocked', reason: 'notebook_language_required' }
          : { status: 'unconfirmed' }))
    checks.environment = {
      ...environment,
      ...active,
      reason: active.reason,
      ...(language ? { language } : {})
    }
  } else if (language === 'r' || (environment.status === 'ready' && !environment.pythonReady)) {
    checks.environment = {
      ...environment,
      status: 'unconfirmed',
      reason: 'notebook_evidence_unavailable'
    }
  }
  if (
    checks.memoryPolicy.status === 'ready' &&
    (!checks.memoryPolicy.source || !checks.memoryPolicy.executionScope)
  ) {
    checks.memoryPolicy = { status: 'unconfirmed' }
  }
  const statuses = Object.values(checks).map((value) => value.status)
  return {
    status: statuses.includes('blocked')
      ? 'blocked'
      : statuses.includes('checking')
        ? 'checking'
        : platform.success && statuses.every((value) => value === 'ready')
          ? 'ready'
          : 'unconfirmed',
    checks: { ...(platform.success ? { platform: platform.data } : {}), ...checks },
    next: readinessActions(Object.values(checks), profile, language)
  }
}

export const readinessActions = (checks, profile, language) =>
  [...new Set(checks.filter(({ status }) => status !== 'ready').map(({ reason }) => reason))]
    .filter((code) => Object.hasOwn(actions, code))
    .map((code) => {
      const [owner, action, message] = actions[code]
      return {
        code,
        owner,
        action,
        message,
        ...(action === 'prepare_notebook_environment' && language
          ? { arguments: { language } }
          : {}),
        ...(action === 'review_notebook_environment' && language
          ? { repair: { capability: 'repair_notebook_environment', arguments: { language } } }
          : {}),
        ...(action === 'choose_notebook_language' ? { choices: ['python', 'r'] } : {}),
        requiresUser: owner === 'user' || owner === 'deployment',
        retryable: owner === 'service',
        verify: {
          capability: 'get_setup_status',
          ...(profile ? { profile } : {}),
          ...(language ? { arguments: { language } } : {})
        }
      }
    })
