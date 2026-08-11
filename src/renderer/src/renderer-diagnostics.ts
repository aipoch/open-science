import type {
  RendererErrorCategory,
  RendererFailureContext,
  RendererFailureReport,
  RendererFailureSource,
  RendererFailureSurface
} from '../../shared/diagnostics'

const errorCategoryFor = (value: unknown): RendererErrorCategory => {
  try {
    const name = value instanceof Error ? value.name : undefined
    const byName: Record<string, RendererErrorCategory> = {
      Error: 'error',
      TypeError: 'type',
      ReferenceError: 'reference',
      RangeError: 'range',
      SyntaxError: 'syntax'
    }
    return name && Object.hasOwn(byName, name) ? byName[name] : 'unknown'
  } catch {
    return 'unknown'
  }
}

const normalizedStackSignature = (value: unknown): string => {
  try {
    if (!(value instanceof Error) || typeof value.stack !== 'string') {
      return errorCategoryFor(value)
    }
    return value.stack
      .split(/\r?\n/)
      .slice(1, 5)
      .join('\n')
      .replace(/https?:\/\/\S+/gi, '[url]')
      .replace(/[A-Za-z]:\\[^\s)]+/g, '[path]')
      .replace(/\/(?:[^\s/]+\/)+[^\s)]+/g, '[path]')
      .replace(/\d+/g, '#')
      .slice(0, 512)
  } catch {
    return 'unknown'
  }
}

const fingerprint = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const projectRendererFailure = (
  source: RendererFailureSource,
  value: unknown,
  surface: RendererFailureSurface,
  context?: RendererFailureContext
): RendererFailureReport => ({
  source,
  surface,
  errorCategory: errorCategoryFor(value),
  ...(context ? { context } : {}),
  fingerprint: fingerprint(normalizedStackSignature(value))
})

type RendererFailureEventTarget = {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

type InstallRendererFailureDiagnosticsOptions = {
  target: RendererFailureEventTarget
  getSurface: () => RendererFailureSurface
  report: (report: RendererFailureReport) => void
}

export const installRendererFailureDiagnostics = (
  options: InstallRendererFailureDiagnosticsOptions
): (() => void) => {
  let reporting = false
  const reportFailure = (source: RendererFailureSource, readValue: () => unknown): void => {
    if (reporting) return
    let value: unknown
    let surface: RendererFailureSurface
    try {
      value = readValue()
    } catch {
      value = undefined
    }
    try {
      surface = options.getSurface()
    } catch {
      surface = 'unknown'
    }
    reporting = true
    try {
      options.report(projectRendererFailure(source, value, surface))
    } catch {
      // Never let a failing diagnostics bridge create another top-level renderer error.
    } finally {
      reporting = false
    }
  }
  const onError: EventListener = (event) => {
    reportFailure('window-error', () => (event as ErrorEvent).error)
  }
  const onUnhandledRejection: EventListener = (event) => {
    reportFailure('unhandled-rejection', () => (event as PromiseRejectionEvent).reason)
  }

  let errorListenerInstalled = false
  let rejectionListenerInstalled = false
  try {
    options.target.addEventListener('error', onError)
    errorListenerInstalled = true
  } catch {
    // Diagnostics are optional and must not block renderer startup.
  }
  try {
    options.target.addEventListener('unhandledrejection', onUnhandledRejection)
    rejectionListenerInstalled = true
  } catch {
    // Diagnostics are optional and must not block renderer startup.
  }

  return () => {
    if (errorListenerInstalled) {
      try {
        options.target.removeEventListener('error', onError)
      } catch {
        // Removal remains best effort during renderer teardown.
      }
    }
    if (rejectionListenerInstalled) {
      try {
        options.target.removeEventListener('unhandledrejection', onUnhandledRejection)
      } catch {
        // Removal remains best effort during renderer teardown.
      }
    }
  }
}
