import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join, posix } from 'node:path'
import { conditionalRestoreScript } from '../notebook/conditional-restore-script'

import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate'

import type {
  ArtifactEnvironmentLockBundleInfo,
  ReadArtifactReproducibilityOutputRequest,
  ArtifactReproducibilityOutputPreview,
  CreateArtifactEnvironmentFromLockRequest,
  CreateArtifactEnvironmentFromLockResult,
  ExportArtifactEnvironmentLockRequest,
  ExportArtifactEnvironmentLockResult,
  ArtifactReproducibilityCheckLogRecord,
  ArtifactReproducibilityReceipt,
  ArtifactReproducibilityReceiptScope,
  ArtifactReproducibilityOutputStorage,
  ExportArtifactReproducibilityReceiptRequest,
  ExportArtifactReproducibilityReceiptResult,
  ImportArtifactEnvironmentLockRequest,
  ImportArtifactEnvironmentLockResult
} from '../../shared/artifact-reproducibility'
import type {
  ArtifactVersionDescriptor,
  PersistedArtifactExecutionSnapshot
} from '../../shared/artifact-provenance'
import type { NotebookEnvironmentLock } from '../../shared/notebook'
import { englishNativeTranslator, type NativeTranslator } from '../locale/main-process-messages'
import { parseNotebookEnvironmentLock } from '../notebook/environment-lock'
import { nativeLockRestoreState, renvRestoreExpression } from '../notebook/native-lock-restoration'
import { normalizeRuntimeArchitecture } from '../notebook/runtime-paths'
import { decodeArtifactReproducibilityReceipt } from './artifact-reproducibility-receipts'
import { sha256 } from './provenance-canonical'
import { outputPreview } from './artifact-reproducibility-outputs'
import { compareReproducedContent } from './output-comparison'

const SHA256 = /^[0-9a-f]{64}$/u
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu
const outputFilename = (path: string): string => {
  const name = basename(path.replaceAll('\\', '/'))
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, '-')
    .replace(/^[. ]+|[. ]+$/gu, '')
  return !name || WINDOWS_RESERVED_BASENAME.test(name.split('.')[0]!)
    ? 'reproduced-output.bin'
    : name
}
const ZIP_MTIME = new Date('1980-01-02T00:00:00.000Z')
const MAX_ENVIRONMENT_LOCK_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_ENVIRONMENT_LOCK_ARCHIVE_ENTRIES = 16
const MAX_ENVIRONMENT_LOCK_METADATA_BYTES = 4 * 1024 * 1024
const EXPORT_REQUEST_KEYS = new Set([
  'projectId',
  'appSessionId',
  'artifactId',
  'versionId',
  'receiptChecksum',
  'suggestedName',
  'outputEntityId'
])
const ENVIRONMENT_LOCK_EXPORT_REQUEST_KEYS = new Set([
  'projectId',
  'appSessionId',
  'artifactId',
  'versionId',
  'lockChecksum'
])

type SaveDialogOptions = {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

type OpenDialogOptions = {
  title: string
  properties: ['openFile']
  filters: Array<{ name: string; extensions: string[] }>
}

type ArtifactReproducibilityReceiptExporterDependencies = {
  readVersion?: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<
    | Pick<ArtifactVersionDescriptor, 'versionId' | 'artifactId' | 'versionNumber' | 'checksum'>
    | undefined
  >
  readSourceScope?: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<ArtifactReproducibilityReceiptScope | undefined>
  readOutputStorage?: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<ArtifactReproducibilityOutputStorage>
  // Resolved lazily: Electron's 'downloads' path can be unavailable in isolated profiles, and
  // wiring-time resolution once broke packaged startup (only save dialogs actually need it).
  downloadsDirectory: () => string
  readReceipt: (
    request: ArtifactReproducibilityReceiptScope,
    receiptChecksum: string
  ) => Promise<ArtifactReproducibilityReceipt | undefined>
  readCheckLog?: (
    request: ArtifactReproducibilityReceiptScope & { receiptChecksum: string }
  ) => Promise<ArtifactReproducibilityCheckLogRecord | undefined>
  readOutput?: (
    request: ArtifactReproducibilityReceiptScope,
    checksum: string,
    entityId: string
  ) => Promise<Buffer>
  readOriginalOutput?: (
    request: ArtifactReproducibilityReceiptScope,
    entityId: string
  ) => Promise<Buffer>
  readExecution?: (
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<PersistedArtifactExecutionSnapshot>
  readEnvironmentLock?: (
    lockChecksum: string,
    request: ArtifactReproducibilityReceiptScope
  ) => Promise<string | undefined>
  showSaveDialog: (
    owner: unknown,
    options: SaveDialogOptions
  ) => Promise<{ canceled: boolean; filePath?: string }>
  showOpenDialog?: (
    owner: unknown,
    options: OpenDialogOptions
  ) => Promise<{ canceled: boolean; filePaths: string[] }>
  createEnvironmentFromLock?: (input: {
    projectId?: string
    lockChecksum: string
    kernelKind: 'python' | 'r'
    lock: NotebookEnvironmentLock
  }) => Promise<{ environmentName: string; reused: boolean }>
  writeArchive?: (filePath: string, bytes: Uint8Array) => Promise<unknown>
  translate?: NativeTranslator
}

type ArtifactReproducibilityReceiptExporter = {
  previewOutput: (
    request: ReadArtifactReproducibilityOutputRequest
  ) => Promise<ArtifactReproducibilityOutputPreview>
  export: (
    owner: unknown,
    request: ExportArtifactReproducibilityReceiptRequest
  ) => Promise<ExportArtifactReproducibilityReceiptResult>
  exportEnvironmentLock: (
    owner: unknown,
    request: ExportArtifactEnvironmentLockRequest
  ) => Promise<ExportArtifactEnvironmentLockResult>
  describeEnvironmentLock: (
    request: ExportArtifactEnvironmentLockRequest
  ) => Promise<ArtifactEnvironmentLockBundleInfo>
  createEnvironmentFromLock: (
    request: CreateArtifactEnvironmentFromLockRequest
  ) => Promise<CreateArtifactEnvironmentFromLockResult>
  importEnvironmentLock: (
    owner: unknown,
    request: ImportArtifactEnvironmentLockRequest
  ) => Promise<ImportArtifactEnvironmentLockResult>
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const assertExportRequest: (
  value: unknown
) => asserts value is ExportArtifactReproducibilityReceiptRequest = (value) => {
  const record = value as Record<string, unknown>
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(record).some((key) => !EXPORT_REQUEST_KEYS.has(key)) ||
    !isNonEmptyString(record.projectId) ||
    !isNonEmptyString(record.appSessionId) ||
    !isNonEmptyString(record.artifactId) ||
    !isNonEmptyString(record.versionId) ||
    !isNonEmptyString(record.suggestedName) ||
    (record.outputEntityId !== undefined && !isNonEmptyString(record.outputEntityId)) ||
    typeof record.receiptChecksum !== 'string' ||
    !SHA256.test(record.receiptChecksum)
  ) {
    throw new Error('Invalid reproducibility receipt export request.')
  }
}

const assertEnvironmentLockExportRequest: (
  value: unknown
) => asserts value is ExportArtifactEnvironmentLockRequest = (value) => {
  const record = value as Record<string, unknown>
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(record).some((key) => !ENVIRONMENT_LOCK_EXPORT_REQUEST_KEYS.has(key)) ||
    !isNonEmptyString(record.projectId) ||
    !isNonEmptyString(record.appSessionId) ||
    !isNonEmptyString(record.artifactId) ||
    !isNonEmptyString(record.versionId) ||
    typeof record.lockChecksum !== 'string' ||
    !SHA256.test(record.lockChecksum)
  ) {
    throw new Error('Invalid Environment lock export request.')
  }
}

const matchesRequest = (
  receipt: ArtifactReproducibilityReceipt,
  request: ArtifactReproducibilityReceiptScope & { receiptChecksum: string }
): boolean =>
  receipt.receiptChecksum === request.receiptChecksum &&
  receipt.artifactVersion.projectId === request.projectId &&
  receipt.artifactVersion.appSessionId === request.appSessionId &&
  receipt.artifactVersion.artifactId === request.artifactId &&
  receipt.artifactVersion.versionId === request.versionId

const receiptScope = (
  request: ArtifactReproducibilityReceiptScope
): ArtifactReproducibilityReceiptScope => ({
  projectId: request.projectId,
  appSessionId: request.appSessionId,
  artifactId: request.artifactId,
  versionId: request.versionId
})

const validateReceipt = (receipt: ArtifactReproducibilityReceipt): ArtifactReproducibilityReceipt =>
  decodeArtifactReproducibilityReceipt(
    `sha256-${receipt.receiptChecksum}.json`,
    JSON.stringify(receipt)
  )

const markdownCell = (value: string | number | undefined): string =>
  value === undefined
    ? '—'
    : String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('\\', '\\\\')
        .replaceAll('|', '\\|')
        .replace(/[\r\n]+/gu, ' ')

const comparisonResult = (
  comparison: ArtifactReproducibilityReceipt['comparisons'][number]
): string => (comparison.status === 'matched' ? 'Matched' : 'Different')

const buildVerificationReport = (
  receipt: ArtifactReproducibilityReceipt,
  outputsCleared = false,
  versionNumber?: number,
  sourceEvidence = false,
  outputsOmitted = false
): string => {
  const environmentRows = receipt.environmentLocks.length
    ? receipt.environmentLocks.map(
        (lock) =>
          `| ${markdownCell(lock.kernelKind)} | ${markdownCell(lock.requirementId)} | ${markdownCell(lock.environmentName)} | ${lock.lockChecksum} |`
      )
    : ['| — | — | — | — |']
  const comparisonRows = receipt.comparisons.map(
    (comparison) =>
      `| ${comparisonResult(comparison)} | ${markdownCell(comparison.relativePath)} | ${comparison.expectedChecksum} | ${markdownCell(comparison.actualChecksum)} | ${comparison.expectedSizeBytes} | ${markdownCell(comparison.actualSizeBytes)} | ${markdownCell(comparison.reason)} |`
  )

  return [
    '# Reproducibility verification record',
    '',
    `- Conclusion: **${receipt.outcome === 'matched' ? 'Result reproduced' : 'Result differs'}**`,
    `- Started: ${receipt.startedAt}`,
    `- Completed: ${receipt.completedAt}`,
    `- Claim scope: ${receipt.frontier.claimScope}`,
    `- Completed runs: ${receipt.completedStepIds.length}`,
    `- Receipt checksum: ${receipt.receiptChecksum}`,
    '',
    '## Artifact Version',
    '',
    `- Project ID: ${markdownCell(receipt.artifactVersion.projectId)}`,
    `- Session ID: ${markdownCell(receipt.artifactVersion.appSessionId)}`,
    `- Artifact ID: ${markdownCell(receipt.artifactVersion.artifactId)}`,
    ...(versionNumber === undefined ? [] : [`- Version: v${versionNumber}`]),
    `- Version ID: ${markdownCell(receipt.artifactVersion.versionId)}`,
    `- Target checksum: ${receipt.artifactVersion.targetChecksum}`,
    '',
    '## Reproduction identity',
    '',
    `- Frontier ID: ${markdownCell(receipt.frontier.frontierId)}`,
    `- Recipe ID: ${receipt.recipe.recipeId}`,
    `- Dependency graph checksum: ${receipt.recipe.graphChecksum}`,
    '',
    '## Environment locks',
    '',
    '| Kernel | Requirement | Environment | Lock checksum |',
    '| --- | --- | --- | --- |',
    ...environmentRows,
    '',
    '## Output comparisons',
    '',
    '| Result | File | Expected checksum | Observed checksum | Expected bytes | Observed bytes | Reason |',
    '| --- | --- | --- | --- | ---: | ---: | --- |',
    ...comparisonRows,
    '',
    '## Content comparisons',
    '',
    'Byte checks remain exact. Content comparisons are separate assessments.',
    '',
    '| File | Content result | Reason |',
    '| --- | --- | --- |',
    ...receipt.comparisons.map((comparison) => {
      const report = comparison.contentComparison
      return `| ${markdownCell(comparison.relativePath)} | ${markdownCell(report?.outcome ?? (comparison.contentComparisonUnavailableReason ? 'Unavailable' : comparison.status === 'matched' ? 'Not needed (identical bytes)' : 'Not recorded'))} | ${markdownCell(report?.reason ?? comparison.contentComparisonUnavailableReason)} |`
    }),
    '',
    sourceEvidence
      ? '> These checks were recorded by the source installation, not rerun here.'
      : '',
    outputsOmitted
      ? '> Some reproduced outputs were not included in the imported package. See outputs/not-included.json.'
      : '',
    outputsCleared
      ? '> Reproduced outputs were cleared by the user. Verification metadata and logs are retained.'
      : receipt.comparisons.some((comparison) => comparison.outputCaptured)
        ? '> Retained differing outputs are included under outputs/. Source data and executable environments are not included.'
        : '> This record contains verification metadata only. It does not include source data, regenerated files, or an executable environment.',
    ''
  ].join('\n')
}

const buildVerificationArchive = (
  receipt: ArtifactReproducibilityReceipt,
  checkLog?: ArtifactReproducibilityCheckLogRecord,
  outputs: Record<string, Uint8Array> = {},
  outputsCleared = false,
  versionNumber?: number,
  sourceEvidence = false,
  outputsOmitted = false
): Uint8Array => {
  const entries: Zippable = {
    'report.md': [
      strToU8(
        buildVerificationReport(
          receipt,
          outputsCleared,
          versionNumber,
          sourceEvidence,
          outputsOmitted
        )
      ),
      { mtime: ZIP_MTIME }
    ],
    'verification-receipt.json': [
      strToU8(`${JSON.stringify(receipt, null, 2)}\n`),
      { mtime: ZIP_MTIME }
    ]
  }
  if (outputsCleared)
    entries['output-retention.json'] = [
      strToU8(JSON.stringify({ state: 'cleared', receiptChecksum: receipt.receiptChecksum })),
      { mtime: ZIP_MTIME }
    ]
  if (checkLog) {
    entries['execution-log.json'] = [
      strToU8(`${JSON.stringify(checkLog, null, 2)}\n`),
      { mtime: ZIP_MTIME }
    ]
  }
  for (const [name, bytes] of Object.entries(outputs))
    entries[name] = [bytes, { mtime: ZIP_MTIME, level: 0 }]
  return zipSync(entries, { level: 0 })
}

const safeArchiveStem = (suggestedName: string): string => {
  const source = basename(suggestedName.replaceAll('\\', '/')).replace(/\.[^.]+$/u, '')
  const normalized = source
    .normalize('NFKC')
    .trim()
    .replace(/[<>:"/\\|?*\p{Cc}]+/gu, '-')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^[.-]+|[.-]+$/gu, '')
    .slice(0, 80)
    .replace(/[.-]+$/gu, '')
  if (!normalized) return 'artifact'
  return WINDOWS_RESERVED_BASENAME.test(normalized) ? `artifact-${normalized}` : normalized
}

const verificationArchiveName = (suggestedName: string, completedAt: string): string => {
  const timestamp = completedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return `${safeArchiveStem(suggestedName)}-verification-${timestamp}.zip`
}

const environmentLockArchiveName = (lockChecksum: string): string =>
  `environment-lock-${lockChecksum}.zip`

const packageManagers = (
  lock: NotebookEnvironmentLock
): ArtifactEnvironmentLockBundleInfo['packageManagers'] => [
  ...new Set(
    lock.components.map((component) => {
      if (component.ecosystem === 'conda') return 'conda' as const
      if (component.format === 'uv-lock') return 'uv' as const
      if (component.format === 'poetry-lock') return 'poetry' as const
      if (component.format === 'pip-requirements') return 'pip' as const
      if (component.format === 'renv-lock') return 'renv' as const
      return 'pak' as const
    })
  )
]

const environmentLockBundleInfo = (
  lock: NotebookEnvironmentLock,
  lockChecksum: string,
  lockState: 'available' | 'partial'
): ArtifactEnvironmentLockBundleInfo => ({
  schemaVersion: 1,
  format: 'open-science-environment-lock-export',
  lockChecksum,
  lockState,
  kernelKind: lock.kernelKind,
  environmentName: lock.environmentName,
  ...(lock.platform ? { platform: lock.platform } : {}),
  ...(lock.architecture ? { architecture: lock.architecture } : {}),
  packageManagers: packageManagers(lock)
})

const buildEnvironmentLockReadme = (
  info: ArtifactEnvironmentLockBundleInfo,
  lock?: NotebookEnvironmentLock
): string => {
  if (lock?.schemaVersion === 2)
    return [
      '# Conditional package restoration',
      '',
      'This bundle restores packages using an interpreter you provide. It does not recreate the interpreter, OS, system libraries, or guarantee identical results.',
      '',
      `Required runtime: ${lock.kernelKind} ${lock.externalRuntime!.version}; ${lock.platform}/${lock.architecture}.`,
      `Required package manager: ${lock.kernelKind === 'r' ? 'renv' : 'pip'} ${lock.externalRuntime!.installerVersion}.`,
      '',
      'For R, jsonlite must also be available to the supplied Rscript. R repository/version records are not cryptographic package archive pins; repository availability and content remain prerequisites.',
      '',
      'Inspect the bundle and its sources. From the extracted directory, use Python 3.9 or later to run:',
      '',
      '```sh',
      'python restore-packages.py --interpreter /path/to/interpreter --destination /path/to/new-library',
      '```',
      '',
      'Pass Rscript for R or python for Python. Use a new destination whose parent exists. The script checks runtime/platform/architecture and package-manager versions before installation, and leaves any failed destination for inspection.',
      'The destination belongs to you. Open Science does not register, adopt, or delete it; inspect and remove failed destinations yourself. Activate the supplied interpreter in your shell first if it requires Conda or other native library paths.',
      '',
      'For R execution, explicitly put the new library first in .libPaths(). For Python, use the new environment interpreter. Re-execute the original code with the original inputs and compare outputs; successful package restoration alone is not a successful reproducibility check.',
      ''
    ].join('\n')
  const native = lock ? nativeLockRestoreState(lock) : undefined
  const quote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`
  const nativeCommands: string[] = []
  if (native?.state === 'ready') {
    const { component, primaryFile } = native.plan
    const filename = quote(posix.basename(primaryFile))
    // Follow the same component selection as the app. Other bundled locks are evidence,
    // not additional installers to run over the restored environment.
    nativeCommands.push(`cd "$bundle_root"/${quote(posix.dirname(primaryFile))}`)
    const run = 'micromamba run --prefix "$reproduced_prefix"'
    switch (component.format) {
      case 'pip-requirements':
        nativeCommands.push(
          `${run} python -I -m pip --isolated install --require-hashes --force-reinstall --no-deps -r ${filename}`
        )
        break
      case 'uv-lock':
        nativeCommands.push(
          `${run} env UV_PROJECT_ENVIRONMENT="$reproduced_prefix" UV_PYTHON_DOWNLOADS=never uv sync --locked --inexact --no-install-project --python "$reproduced_prefix/${info.platform === 'win32' ? 'python.exe' : 'bin/python'}"`
        )
        break
      case 'poetry-lock':
        nativeCommands.push(
          `${run} env VIRTUAL_ENV="$reproduced_prefix" POETRY_VIRTUALENVS_CREATE=false poetry install --no-root --no-interaction`
        )
        break
      case 'renv-lock':
      case 'pak-lock': {
        const file = JSON.stringify(posix.basename(primaryFile))
        const expression =
          component.format === 'renv-lock'
            ? renvRestoreExpression(posix.basename(primaryFile), 'R.home("library")')
            : `pak::lockfile_install(lockfile=${file},lib=R.home("library"))`
        nativeCommands.push(`${run} Rscript --vanilla -e ${quote(expression)}`)
        break
      }
    }
  }
  const commands =
    info.lockState === 'available' && native?.state !== 'unsupported'
      ? [
          '## Restore the environment',
          '',
          'Run this block in a POSIX shell from the extracted bundle directory, on the captured platform and architecture. Choose an unused environment directory.',
          '',
          '```sh',
          'set -eu',
          'bundle_root="$(pwd -P)"',
          'reproduced_prefix="$bundle_root/reproduced-env"',
          'unset PYTHONHOME PYTHONPATH PYTHONUSERBASE VIRTUAL_ENV R_HOME R_LIBS R_LIBS_USER R_LIBS_SITE R_ENVIRON R_ENVIRON_USER R_PROFILE R_PROFILE_USER',
          `export PYTHONNOUSERSITE=1 PIP_CONFIG_FILE=${info.platform === 'win32' ? 'nul' : '/dev/null'}`,
          'micromamba create --prefix "$reproduced_prefix" --file "$bundle_root/conda-explicit.txt"',
          ...nativeCommands,
          '```',
          '',
          'Use micromamba run --prefix "$reproduced_prefix" to run code in this environment. The other bundled lock files remain available for inspection.'
        ]
      : []
  return [
    '# Open Science environment lock',
    '',
    `- Environment: ${info.environmentName}`,
    `- Runtime: ${info.kernelKind}`,
    `- Platform: ${info.platform ?? 'unknown'}`,
    `- Architecture: ${info.architecture ?? 'unknown'}`,
    `- Package managers: ${info.packageManagers.join(', ')}`,
    `- Lock checksum: sha256-${info.lockChecksum}`,
    `- Capture: ${info.lockState === 'available' ? 'complete' : 'partial'}`,
    '',
    ...(info.lockState === 'partial'
      ? [
          '> This bundle is for inspection only. Its captured evidence is incomplete, so Open Science will not import it as a runnable environment.',
          ''
        ]
      : []),
    ...(lock?.omittedPackages?.length
      ? [
          '## Run environment',
          '',
          'This lock restores the captured runtime and the dependencies used by the Notebook run. The full installed inventory is retained separately.',
          '',
          `Installed but unused packages omitted from this lock: ${lock.omittedPackages.join(', ')}.`,
          ''
        ]
      : []),
    ...commands,
    ''
  ].join('\n')
}

const buildEnvironmentLockArchive = (
  lock: NotebookEnvironmentLock,
  serialized: string,
  info = environmentLockBundleInfo(lock, sha256(serialized), 'available')
): Uint8Array => {
  const contents = new Map<string, string>([
    ['environment-lock.json', serialized],
    ['bundle-manifest.json', `${JSON.stringify(info, null, 2)}\n`],
    ['README.md', buildEnvironmentLockReadme(info, lock)]
  ])
  if (lock.schemaVersion === 2) contents.set('restore-packages.py', conditionalRestoreScript)
  const addFile = (path: string, content: string): void => {
    const existing = contents.get(path)
    if (existing === undefined) {
      contents.set(path, content)
      return
    }
    if (existing !== content) {
      throw new Error(`Environment lock archive path conflicts: ${path}`)
    }
  }
  for (const component of lock.components) {
    if (component.ecosystem === 'conda') {
      addFile('conda-explicit.txt', component.explicitLock)
      continue
    }
    for (const file of component.files) {
      addFile(file.path, file.content)
    }
  }
  const entries: Zippable = Object.fromEntries(
    [...contents].map(([path, content]) => [path, [strToU8(content), { mtime: ZIP_MTIME }]])
  )
  return zipSync(entries, { level: 6 })
}

const decodeEnvironmentLockBundleInfo = (value: string): ArtifactEnvironmentLockBundleInfo => {
  const decoded = JSON.parse(value) as unknown
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Environment lock bundle manifest is invalid.')
  }
  const parsed = decoded as Partial<ArtifactEnvironmentLockBundleInfo>
  const managers = parsed.packageManagers
  if (
    Object.keys(parsed).some(
      (key) =>
        ![
          'schemaVersion',
          'format',
          'lockChecksum',
          'lockState',
          'kernelKind',
          'environmentName',
          'platform',
          'architecture',
          'packageManagers'
        ].includes(key)
    ) ||
    parsed.schemaVersion !== 1 ||
    parsed.format !== 'open-science-environment-lock-export' ||
    typeof parsed.lockChecksum !== 'string' ||
    !SHA256.test(parsed.lockChecksum) ||
    (parsed.lockState !== 'available' && parsed.lockState !== 'partial') ||
    (parsed.kernelKind !== 'python' && parsed.kernelKind !== 'r') ||
    !isNonEmptyString(parsed.environmentName) ||
    (parsed.platform !== undefined && !isNonEmptyString(parsed.platform)) ||
    (parsed.architecture !== undefined && !isNonEmptyString(parsed.architecture)) ||
    !Array.isArray(managers) ||
    new Set(managers).size !== managers.length ||
    managers.some(
      (manager) => !['conda', 'pip', 'uv', 'poetry', 'renv', 'pak'].includes(String(manager))
    )
  ) {
    throw new Error('Environment lock bundle manifest is invalid.')
  }
  return parsed as ArtifactEnvironmentLockBundleInfo
}

const readEnvironmentLockArchive = async (
  filePath: string
): Promise<{ info: ArtifactEnvironmentLockBundleInfo; lock: NotebookEnvironmentLock }> => {
  const metadata = await stat(filePath)
  if (!metadata.isFile() || metadata.size > MAX_ENVIRONMENT_LOCK_ARCHIVE_BYTES) {
    throw new Error('Environment lock bundle exceeds the safe import limit.')
  }
  const bytes = new Uint8Array(await readFile(filePath))
  if (bytes.byteLength > MAX_ENVIRONMENT_LOCK_ARCHIVE_BYTES) {
    throw new Error('Environment lock bundle exceeds the safe import limit.')
  }
  let entryCount = 0
  let selectedBytes = 0
  const selectedNames = new Set<string>()
  const files = unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1
      if (entryCount > MAX_ENVIRONMENT_LOCK_ARCHIVE_ENTRIES) {
        throw new Error('Environment lock bundle contains too many files.')
      }
      if (entry.name !== 'environment-lock.json' && entry.name !== 'bundle-manifest.json') {
        return false
      }
      if (selectedNames.has(entry.name)) {
        throw new Error('Environment lock bundle contains duplicate metadata files.')
      }
      selectedNames.add(entry.name)
      selectedBytes += entry.originalSize
      if (
        entry.originalSize > MAX_ENVIRONMENT_LOCK_METADATA_BYTES ||
        selectedBytes > MAX_ENVIRONMENT_LOCK_METADATA_BYTES
      ) {
        throw new Error('Environment lock bundle metadata exceeds the safe import limit.')
      }
      return true
    }
  })
  const lockBytes = files['environment-lock.json']
  const manifestBytes = files['bundle-manifest.json']
  if (!lockBytes || !manifestBytes) throw new Error('Environment lock bundle is incomplete.')
  if (lockBytes.byteLength + manifestBytes.byteLength > MAX_ENVIRONMENT_LOCK_METADATA_BYTES) {
    throw new Error('Environment lock bundle metadata exceeds the safe import limit.')
  }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const serialized = decoder.decode(lockBytes)
  const info = decodeEnvironmentLockBundleInfo(decoder.decode(manifestBytes))
  if (sha256(serialized) !== info.lockChecksum) {
    throw new Error('Environment lock bundle checksum mismatch.')
  }
  const lock = parseNotebookEnvironmentLock(serialized)
  if (
    lock.kernelKind !== info.kernelKind ||
    lock.environmentName !== info.environmentName ||
    lock.platform !== info.platform ||
    lock.architecture !== info.architecture ||
    JSON.stringify(packageManagers(lock)) !== JSON.stringify(info.packageManagers)
  ) {
    throw new Error('Environment lock bundle identity mismatch.')
  }
  return { info, lock }
}

const createArtifactReproducibilityReceiptExporter = (
  dependencies: ArtifactReproducibilityReceiptExporterDependencies
): ArtifactReproducibilityReceiptExporter => {
  const resolveEnvironmentLock = async (
    request: ExportArtifactEnvironmentLockRequest
  ): Promise<{
    lock: NotebookEnvironmentLock
    serialized: string
    info: ArtifactEnvironmentLockBundleInfo
  }> => {
    assertEnvironmentLockExportRequest(request)
    if (!dependencies.readExecution || !dependencies.readEnvironmentLock) {
      throw new Error('Environment lock export is unavailable.')
    }
    const execution = await dependencies.readExecution(receiptScope(request))
    const requirement = execution.reproducibilityRecipe?.environmentRequirements.find(
      (candidate) => candidate.lockChecksum === request.lockChecksum
    )
    if (!requirement) {
      throw new Error('Environment lock is not referenced by this Artifact dependency recipe.')
    }
    const serialized = await dependencies.readEnvironmentLock(
      request.lockChecksum,
      receiptScope(request)
    )
    if (!serialized) throw new Error('Environment lock was not found.')
    if (sha256(serialized) !== request.lockChecksum) {
      throw new Error('Environment lock checksum mismatch.')
    }
    const lock = parseNotebookEnvironmentLock(serialized)
    if (
      lock.kernelKind !== requirement.kernelKind ||
      (requirement.environmentName !== undefined &&
        lock.environmentName !== requirement.environmentName)
    ) {
      throw new Error('Environment lock identity mismatch.')
    }
    return {
      lock,
      serialized,
      info: environmentLockBundleInfo(lock, request.lockChecksum, requirement.lockState)
    }
  }

  const materializeEnvironmentLock = async (
    projectId: string | undefined,
    info: ArtifactEnvironmentLockBundleInfo,
    lock: NotebookEnvironmentLock
  ): Promise<CreateArtifactEnvironmentFromLockResult> => {
    if (!dependencies.createEnvironmentFromLock) {
      throw new Error('Environment creation from a lock is unavailable.')
    }
    if (info.lockState !== 'available') {
      throw new Error('A partial Environment lock cannot create a runnable environment.')
    }
    if (info.platform !== undefined && info.platform !== process.platform) {
      throw new Error('Environment lock platform does not match this computer.')
    }
    if (
      info.architecture !== undefined &&
      normalizeRuntimeArchitecture(info.architecture) !== normalizeRuntimeArchitecture(process.arch)
    ) {
      throw new Error('Environment lock architecture does not match this computer.')
    }
    const conda = lock.components.find((component) => component.ecosystem === 'conda')
    if (!conda || conda.ecosystem !== 'conda') {
      throw new Error('Environment lock does not contain an exact Conda environment.')
    }
    const created = await dependencies.createEnvironmentFromLock({
      ...(projectId ? { projectId } : {}),
      lockChecksum: info.lockChecksum,
      kernelKind: info.kernelKind,
      lock
    })
    return {
      environmentName: created.environmentName,
      kernelKind: info.kernelKind,
      reused: created.reused
    }
  }

  return {
    previewOutput: async (request) => {
      if (
        !request ||
        Object.keys(request).some(
          (key) =>
            ![
              'projectId',
              'appSessionId',
              'artifactId',
              'versionId',
              'receiptChecksum',
              'entityId'
            ].includes(key)
        ) ||
        !isNonEmptyString(request.entityId)
      )
        throw new Error('Invalid reproduced output request.')
      const { entityId, ...scope } = request
      assertExportRequest({ ...scope, suggestedName: 'result' })
      const receipt = await dependencies.readReceipt(scope, request.receiptChecksum)
      if (
        !receipt ||
        !matchesRequest(receipt, {
          ...((await dependencies.readSourceScope?.(scope)) ?? scope),
          receiptChecksum: request.receiptChecksum
        })
      )
        throw new Error('Reproducibility receipt was not found.')
      const validated = validateReceipt(receipt)
      const comparison = validated.comparisons.find(
        (item) => item.entityId === entityId && item.outputCaptured
      )
      if (!comparison || !dependencies.readOutput)
        throw new Error('Reproduced output is unavailable.')
      const bytes = await dependencies.readOutput(scope, request.receiptChecksum, entityId)
      const original = await dependencies
        .readOriginalOutput?.(scope, entityId)
        .catch(() => undefined)
      const imageDifference =
        original &&
        comparison.contentComparison?.kind === 'image' &&
        sha256(original) === comparison.expectedChecksum &&
        sha256(bytes) === comparison.actualChecksum
          ? await compareReproducedContent({
              expected: original,
              actual: bytes,
              filename: comparison.relativePath,
              policy: comparison.contentComparison.policy,
              preview: true
            })
          : undefined
      return {
        filename: outputFilename(comparison.relativePath),
        reproduced: imageDifference?.reproducedImage
          ? { kind: 'image', dataUrl: imageDifference.reproducedImage }
          : outputPreview(comparison.relativePath, bytes),
        ...(imageDifference?.differenceImage
          ? { differenceImage: imageDifference.differenceImage }
          : {}),
        ...(original
          ? {
              original: imageDifference?.originalImage
                ? { kind: 'image' as const, dataUrl: imageDifference.originalImage }
                : outputPreview(comparison.relativePath, original)
            }
          : {})
      }
    },
    export: async (owner, request) => {
      assertExportRequest(request)
      const receipt = await dependencies.readReceipt(receiptScope(request), request.receiptChecksum)
      if (!receipt) throw new Error('Reproducibility receipt was not found.')
      const sourceScope = await dependencies.readSourceScope?.(receiptScope(request))
      if (
        !matchesRequest(receipt, {
          ...(sourceScope ?? request),
          receiptChecksum: request.receiptChecksum
        })
      ) {
        throw new Error('Reproducibility receipt identity mismatch.')
      }
      const validated = validateReceipt(receipt)
      const selectedOutput = request.outputEntityId
        ? validated.comparisons.find(
            (item) => item.entityId === request.outputEntityId && item.outputCaptured
          )
        : undefined
      if (request.outputEntityId && !selectedOutput)
        throw new Error('Reproduced output is unavailable.')
      const outputStorage = await dependencies.readOutputStorage?.(receiptScope(request))
      const outputsCleared =
        outputStorage?.clearedReceiptChecksums.includes(validated.receiptChecksum) ?? false
      const omitted = outputStorage?.omittedOutputChecksums ?? []
      if (selectedOutput && omitted.includes(selectedOutput.actualChecksum!))
        throw new Error('Reproduced output was not included in this package.')
      if (selectedOutput && outputsCleared) throw new Error('Reproduced output was cleared.')
      if (selectedOutput) {
        if (!dependencies.readOutput) throw new Error('Reproduced output storage is unavailable.')
        const bytes = await dependencies.readOutput(
          receiptScope(request),
          validated.receiptChecksum,
          selectedOutput.entityId
        )
        const selected = await dependencies.showSaveDialog(owner, {
          title: (dependencies.translate ?? englishNativeTranslator)('Save file'),
          defaultPath: join(
            dependencies.downloadsDirectory(),
            outputFilename(selectedOutput.relativePath)
          ),
          filters: []
        })
        if (selected.canceled || !selected.filePath) return { saved: false }
        await (dependencies.writeArchive ?? writeFile)(selected.filePath, bytes)
        return { saved: true }
      }
      let checkLog: ArtifactReproducibilityCheckLogRecord | undefined
      if (validated.checkLog) {
        if (!dependencies.readCheckLog) {
          throw new Error('Reproducibility check log storage is unavailable.')
        }
        checkLog = await dependencies.readCheckLog({
          ...receiptScope(request),
          receiptChecksum: validated.receiptChecksum
        })
        if (!checkLog) throw new Error('Reproducibility check log was not found.')
      }
      const translate = dependencies.translate ?? englishNativeTranslator
      const selected = await dependencies.showSaveDialog(owner, {
        title: translate('Save file'),
        defaultPath: join(
          dependencies.downloadsDirectory(),
          verificationArchiveName(request.suggestedName, validated.completedAt)
        ),
        filters: [{ name: translate('ZIP archive'), extensions: ['zip'] }]
      })
      if (selected.canceled || !selected.filePath) return { saved: false }

      const finalPath = selected.filePath
      const destination = finalPath.endsWith('.zip') ? finalPath : `${finalPath}.zip`
      const outputs: Record<string, Uint8Array> = {}
      const manifest: Array<{ entityId: string; relativePath: string; archivePath: string }> = []
      const archivedChecksums = new Map<string, string>()
      for (const [index, comparison] of validated.comparisons.entries()) {
        if (
          !comparison.outputCaptured ||
          outputsCleared ||
          omitted.includes(comparison.actualChecksum!)
        )
          continue
        if (!dependencies.readOutput) throw new Error('Reproduced output storage is unavailable.')
        let archivePath = archivedChecksums.get(comparison.actualChecksum!)
        if (!archivePath) {
          archivePath = `outputs/${index + 1}/${outputFilename(comparison.relativePath)}`
          outputs[archivePath] = await dependencies.readOutput(
            receiptScope(request),
            validated.receiptChecksum,
            comparison.entityId
          )
          archivedChecksums.set(comparison.actualChecksum!, archivePath)
        }
        manifest.push({
          entityId: comparison.entityId,
          relativePath: comparison.relativePath,
          archivePath
        })
      }
      if (omitted.length)
        outputs['outputs/not-included.json'] = strToU8(
          JSON.stringify({ omittedOutputChecksums: omitted })
        )
      if (manifest.length)
        outputs['outputs/manifest.json'] = strToU8(JSON.stringify(manifest, null, 2))
      const version = await dependencies.readVersion?.(receiptScope(request))
      if (
        version &&
        (version.versionId !== request.versionId ||
          version.artifactId !== request.artifactId ||
          version.checksum !== validated.artifactVersion.targetChecksum ||
          !Number.isSafeInteger(version.versionNumber) ||
          version.versionNumber < 1)
      )
        throw new Error('Verification report version identity does not match the receipt.')
      await (dependencies.writeArchive ?? writeFile)(
        destination,
        buildVerificationArchive(
          validated,
          checkLog,
          outputs,
          outputsCleared,
          version?.versionNumber,
          Boolean(sourceScope),
          omitted.length > 0
        )
      )
      return { saved: true }
    },
    describeEnvironmentLock: async (request) => (await resolveEnvironmentLock(request)).info,
    createEnvironmentFromLock: async (request) => {
      if (await dependencies.readSourceScope?.(receiptScope(request)))
        throw new Error('Imported Sessions are read-only.')
      const { info, lock } = await resolveEnvironmentLock(request)
      return materializeEnvironmentLock(request.projectId, info, lock)
    },
    exportEnvironmentLock: async (owner, request) => {
      const { lock, serialized, info } = await resolveEnvironmentLock(request)
      const archive = buildEnvironmentLockArchive(lock, serialized, info)

      const translate = dependencies.translate ?? englishNativeTranslator
      const selected = await dependencies.showSaveDialog(owner, {
        title: translate('Save file'),
        defaultPath: join(
          dependencies.downloadsDirectory(),
          environmentLockArchiveName(request.lockChecksum)
        ),
        filters: [{ name: translate('ZIP archive'), extensions: ['zip'] }]
      })
      if (selected.canceled || !selected.filePath) return { saved: false }

      const destination = selected.filePath.endsWith('.zip')
        ? selected.filePath
        : `${selected.filePath}.zip`
      await (dependencies.writeArchive ?? writeFile)(destination, archive)
      return { saved: true }
    },
    importEnvironmentLock: async (owner, request) => {
      if (
        typeof request !== 'object' ||
        request === null ||
        Array.isArray(request) ||
        Object.keys(request).some((key) => key !== 'projectId') ||
        (request.projectId !== undefined && !isNonEmptyString(request.projectId))
      ) {
        throw new Error('Invalid Environment lock import request.')
      }
      if (!dependencies.showOpenDialog || !dependencies.createEnvironmentFromLock) {
        throw new Error('Environment lock import is unavailable.')
      }
      const translate = dependencies.translate ?? englishNativeTranslator
      const selected = await dependencies.showOpenDialog(owner, {
        title: translate('Import Environment lock'),
        properties: ['openFile'],
        filters: [{ name: translate('ZIP archive'), extensions: ['zip'] }]
      })
      const filePath = selected.filePaths[0]
      if (selected.canceled || !filePath) return { imported: false }
      const { info, lock } = await readEnvironmentLockArchive(filePath)
      const created = await materializeEnvironmentLock(request.projectId, info, lock)
      return {
        imported: true,
        environmentName: created.environmentName,
        kernelKind: created.kernelKind,
        reused: created.reused
      }
    }
  }
}

export {
  buildVerificationArchive,
  buildVerificationReport,
  buildEnvironmentLockArchive,
  buildEnvironmentLockReadme,
  createArtifactReproducibilityReceiptExporter,
  environmentLockBundleInfo,
  readEnvironmentLockArchive,
  verificationArchiveName
}
export type {
  ArtifactReproducibilityReceiptExporter,
  ArtifactReproducibilityReceiptExporterDependencies
}
