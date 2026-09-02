import type {
  PackageDiagnostic,
  SpecialistPackageInstallResult
} from '../../../shared/specialist-package'
import { formatDisplayNumber } from './locale-format'

// Maps raw validation codes (zip-adapter.ts, package/validator.ts) to user-facing
// copy: a human title plus a body that explains the finding and what to do.
// Raw codes are never shown in the UI; the sanitized `path` carries the anchor
// for matching findings against the downloaded JSON report.

export type SpecialistDiagnosticCopy = { title: string; body: string }
export type SpecialistInstallFailureCode = Extract<
  SpecialistPackageInstallResult,
  { status: 'failed' }
>['code']

export type SpecialistInstallFailureCopy = {
  body: string
  previewAgain: boolean
  revealStorage: boolean
}

const installFailure = (
  body: string,
  options: Partial<Pick<SpecialistInstallFailureCopy, 'previewAgain' | 'revealStorage'>> = {}
): SpecialistInstallFailureCopy => ({
  body,
  previewAgain: options.previewAgain ?? false,
  revealStorage: options.revealStorage ?? false
})

const INSTALL_FAILURES: Record<SpecialistInstallFailureCode, SpecialistInstallFailureCopy> = {
  'candidate-invalid': installFailure(
    'This package request is no longer valid. Preview the ZIP again before installing.',
    { previewAgain: true }
  ),
  'candidate-expired': installFailure(
    'This package preview expired. Preview the ZIP again before installing.',
    { previewAgain: true }
  ),
  'stale-candidate': installFailure(
    'The package preview is out of date. Preview the ZIP again before installing.',
    { previewAgain: true }
  ),
  'candidate-not-installable': installFailure(
    'This package can no longer be installed. Preview the ZIP again and review its diagnostics.',
    { previewAgain: true }
  ),
  'skill-conflict-resolution-required': installFailure(
    'Choose how to resolve every Skill conflict before installing.'
  ),
  'overwrite-confirmation-required': installFailure(
    'Review and confirm the overwrite before installing.'
  ),
  'revision-conflict': installFailure(
    'This Specialist changed after the preview. Create a fresh preview before installing.',
    { previewAgain: true }
  ),
  'protected-target': installFailure(
    'This package targets a protected Specialist and cannot be installed.'
  ),
  'recovery-failed': installFailure(
    'Open Science could not recover an earlier package operation. Restart the app before trying again.',
    { revealStorage: true }
  ),
  'rollback-failed': installFailure(
    'Installation could not be rolled back safely. Restart the app before trying again.',
    { revealStorage: true }
  ),
  'commit-failed': installFailure(
    'Installation failed and the previous data was restored. Preview the ZIP again before retrying.',
    { previewAgain: true }
  )
}

export const specialistInstallFailureCopy = (
  code: SpecialistInstallFailureCode
): SpecialistInstallFailureCopy => INSTALL_FAILURES[code]

const formatBytes = (value: number): string =>
  value >= 1024 * 1024
    ? `${Number((value / (1024 * 1024)).toFixed(1))} MB`
    : `${Number((value / 1024).toFixed(1))} KB`

const formatCount = (value: number): string => formatDisplayNumber(value)

const copy = (title: string, body: string): SpecialistDiagnosticCopy => ({ title, body })

const plain = (title: string, body: string) => (): SpecialistDiagnosticCopy => copy(title, body)

const bytes = (diagnostic: PackageDiagnostic): { actual: string; limit: string } => ({
  actual: formatBytes(diagnostic.actual ?? 0),
  limit: formatBytes(diagnostic.limit ?? 0)
})

const count = (diagnostic: PackageDiagnostic): { actual: string; limit: string } => ({
  actual: formatCount(diagnostic.actual ?? 0),
  limit: formatCount(diagnostic.limit ?? 0)
})

const MAP: Record<string, (diagnostic: PackageDiagnostic) => SpecialistDiagnosticCopy> = {
  // ---- Archive layer (zip-adapter.ts) ----
  'package.archive-invalid': plain(
    'Not a valid ZIP',
    'The selected file could not be read as a ZIP package. Choose the file exported by the app and try again.'
  ),
  'package.archive-compressed-size-exceeded': (d) => {
    const { actual, limit } = bytes(d)
    return copy(
      'Archive too large',
      `The compressed ZIP is ${actual}; the safe preview limit is ${limit}. Remove large assets and rebuild the ZIP.`
    )
  },
  'package.archive-file-count-exceeded': (d) => {
    const { actual, limit } = count(d)
    return copy(
      'Too many files',
      `The ZIP contains ${actual} files; the limit is ${limit}. Remove unused files and rebuild the ZIP.`
    )
  },
  'package.archive-uncompressed-size-exceeded': (d) => {
    const { actual, limit } = bytes(d)
    return copy(
      'Expanded archive too large',
      `The contents expand to ${actual}; the allowed total is ${limit}. Nothing was installed.`
    )
  },
  'package.archive-file-size-exceeded': (d) => {
    const { actual, limit } = bytes(d)
    return copy(
      'Single file too large',
      `A package file is ${actual}; the per-file limit is ${limit}. Remove or reduce this file and rebuild the ZIP.`
    )
  },
  'package.archive-path-depth-exceeded': (d) => {
    const { actual, limit } = count(d)
    return copy(
      'Entry nested too deeply',
      `One entry is ${actual} levels deep; the limit is ${limit}. Flatten the package layout and rebuild the ZIP.`
    )
  },
  'package.archive-path-absolute': plain(
    'Unsafe archive entry path',
    'An entry uses an absolute path and was blocked. Re-export the package from the app and import again.'
  ),
  'package.archive-path-drive': plain(
    'Unsafe archive entry path',
    'An entry uses a Windows drive path and was blocked. Re-export the package and import again.'
  ),
  'package.archive-path-backslash': plain(
    'Unsafe archive entry path',
    'An entry uses backslashes instead of forward slashes and was blocked. Re-export the package and import again.'
  ),
  'package.archive-path-traversal': plain(
    'Unsafe archive entry path',
    'An entry attempts to escape the package root. The ZIP is not safe to preview and nothing was installed.'
  ),
  'package.archive-path-duplicate': plain(
    'Duplicate entry names',
    'Two entries resolve to the same file name after normalization. Remove the duplicate and rebuild the ZIP.'
  ),
  'package.archive-encryption-unsupported': plain(
    'Encrypted archive entries',
    'Encrypted ZIP entries are not supported. Export the package without encryption.'
  ),
  'package.symbolic-link-forbidden': plain(
    'Symbolic link entries',
    'The ZIP contains a symbolic link, which is not supported. Export a package without links.'
  ),
  'package.archive-link-unsupported': plain(
    'Link entries not supported',
    'The ZIP contains a hard or special link entry, which is not supported. Export a package without links.'
  ),
  'package.archive-compression-unsupported': plain(
    'Unsupported compression method',
    'One entry uses a compression method this app cannot read. Re-export the package with the standard ZIP format.'
  ),
  'package.archive-compression-ratio-exceeded': (d) =>
    copy(
      'Unsafe compression ratio',
      `One entry expands to ${formatCount(d.actual ?? 0)}× its stored size, a pattern typical of archive bombs. Extraction stopped before the entry was read.`
    ),
  'package.archive-layout-invalid': plain(
    'Unrecognized ZIP layout',
    'The ZIP must contain one package at its root, or inside a single wrapper folder.'
  ),
  'package.metadata-noise-ignored': plain(
    'Archive metadata ignored',
    'Known platform noise (.DS_Store, __MACOSX) is excluded from installation and content hashes.'
  ),

  // ---- Content layer: package and manifest (package/validator.ts) ----
  'package.json-invalid': plain(
    'Invalid JSON file',
    'This file must contain valid UTF-8 JSON. Fix it and rebuild the ZIP.'
  ),
  'package.required-file-missing': plain(
    'Required file missing',
    'The package must contain this file. Re-export the package and import again.'
  ),
  'package.executable-content-present': plain(
    'Scripts included',
    'The package contains script or executable content. It is inspected as content only and is never executed.'
  ),
  'manifest.object-required': plain(
    'Invalid manifest',
    'manifest.json must be a JSON object. Fix it and rebuild the ZIP.'
  ),
  'manifest.field-forbidden': plain(
    'Unsupported manifest field',
    'manifest.json may contain only application-generated package metadata; dependency declarations are not supported.'
  ),
  'manifest.schema-version-unsupported': plain(
    'Unsupported package schema',
    'manifest.json must declare schema_version 1. Re-export with the current app version and import again.'
  ),
  'manifest.id-invalid': plain(
    'Invalid package ID',
    'The package ID may contain only lowercase letters, digits and dashes, and must not start with "os-" or "mcp-".'
  ),
  'manifest.version-invalid': plain(
    'Invalid package version',
    'The package version must be SemVer, such as 1.2.0.'
  ),
  'manifest.exported-app-version-invalid': plain(
    'Invalid app compatibility version',
    'The exported_with_app_version field must be SemVer. Re-export the package and import again.'
  ),

  // ---- Content layer: specialist.json ----
  'specialist.object-required': plain(
    'Invalid Specialist data',
    'specialist.json must be a JSON object. Fix it and rebuild the ZIP.'
  ),
  'specialist.identity-field-forbidden': plain(
    'Identity fields not allowed',
    'The Specialist ID and package version belong only in manifest.json. Remove them from specialist.json.'
  ),
  'specialist.presentation-field-forbidden': plain(
    'Appearance cannot be imported',
    'Icon and color are chosen in the Specialist configuration page. Remove iconKey and colorKey from specialist.json.'
  ),
  'specialist.capability-field-forbidden': plain(
    'Capabilities cannot be imported',
    'Capabilities are chosen in the Specialist configuration page. Remove capabilityMode and related fields from specialist.json.'
  ),
  'specialist.enabled-field-forbidden': plain(
    'Enabled state cannot be imported',
    'Imported Specialists stay disabled until setup is saved. Remove the enabled field from specialist.json.'
  ),
  'specialist.field-forbidden': plain(
    'Unsupported Specialist field',
    'specialist.json contains a field this app does not support. Remove it and rebuild the ZIP.'
  ),
  'specialist.name-invalid': plain(
    'Invalid Specialist name',
    'The Specialist name is invalid. Use a descriptive name and rebuild the ZIP.'
  ),
  'specialist.display-name-invalid': plain(
    'Invalid display name',
    'The display name is invalid. Shorten it or adjust its characters.'
  ),
  'specialist.description-invalid': plain(
    'Invalid description',
    'The description must be a non-empty string within the length limit.'
  ),
  'specialist.system-prompt-invalid': plain(
    'Invalid system prompt',
    'The system prompt must be a non-empty string within the length limit.'
  ),
  'specialist.skillIds-invalid': plain(
    'Skill list',
    'The Skill list must be an array of portable Skill names. Fix the field and rebuild the ZIP.'
  ),
  'specialist.skillIds-entry-invalid': plain(
    'Invalid Skill name',
    'The Skill list may contain only non-empty strings. Fix or remove the invalid entry and rebuild the ZIP.'
  ),
  'specialist.skillIds-duplicate': plain(
    'Duplicate Skill name',
    'The Skill list must not contain duplicate names. Remove duplicates and rebuild the ZIP.'
  ),
  'specialist.connectorIds-invalid': plain(
    'Connector list',
    'The Connector list must be an array of portable Connector names. Fix the field and rebuild the ZIP.'
  ),
  'specialist.connectorIds-entry-invalid': plain(
    'Invalid Connector name',
    'The Connector list may contain only non-empty strings. Fix or remove the invalid entry and rebuild the ZIP.'
  ),
  'specialist.connectorIds-duplicate': plain(
    'Duplicate Connector name',
    'The Connector list must not contain duplicate names. Remove duplicates and rebuild the ZIP.'
  ),
  'specialist.name-protected': plain(
    'Reserved Specialist name',
    'This name is reserved by the application and cannot be contributed. Rename the Specialist and rebuild the ZIP.'
  ),
  'specialist.name-duplicate': plain(
    'Specialist name already in use',
    'Another Specialist already uses this name. Rename the package Specialist and rebuild the ZIP.'
  ),
  'specialist.id-protected': plain(
    'Reserved package ID',
    'This package ID is reserved by the application and cannot be contributed.'
  ),
  'specialist.skill-unavailable': plain(
    'Referenced Skill unavailable',
    'A referenced Skill is not available on this installation and was ignored.'
  ),
  'specialist.connector-unavailable': plain(
    'Connector unavailable',
    'A referenced Connector is not available on this installation and was ignored.'
  ),
  'builtin.bundled-skills-forbidden': plain(
    'Builtin packages cannot bundle Skills',
    'Builtin Specialist packages cannot bundle Skills. Remove the skills/ folder.'
  ),

  // ---- Content layer: bundled Skills ----
  'skill.path-noncanonical': plain(
    'Non-standard Skill layout',
    'Bundled Skill files must use skills/<skill-name>/<file>.'
  ),
  'skill.id-invalid': plain(
    'Invalid Skill folder name',
    'Bundled Skill folder names must be safe Skill names with lowercase letters, digits and dashes.'
  ),
  'skill.document-missing': plain(
    'Skill document missing',
    'A bundled Skill must contain SKILL.md. Add it and rebuild the ZIP.'
  ),
  'skill.document-invalid': plain('Invalid SKILL.md', 'SKILL.md must contain valid UTF-8 text.'),
  'skill.name-mismatch': plain(
    'Skill name does not match its folder',
    'The SKILL.md name must exactly match its directory name. Make them identical and rebuild the ZIP.'
  ),
  'skill.version-invalid': plain(
    'Invalid Skill version',
    'The SKILL.md version must be SemVer when present.'
  ),
  'skill.executable-content-present': plain(
    'Skill contains scripts',
    'This Skill contains script files. They are inspected as content only and are never executed.'
  ),
  'skill.existing-conflict': plain(
    'Skill version choice required',
    'A Skill with this name is already installed with different content or version. Choose which version to use below.'
  ),

  // ---- Export preview (package/service.ts) ----
  'specialist.export-unbundled-skills': plain(
    'Unbundled Skills omitted',
    'Unchecked Skills are omitted. Capabilities are selected locally after import.'
  ),
  'specialist.export-version-unchanged': plain(
    'Package version unchanged',
    'Content changed but the package version was not increased. Update the version before publishing.'
  ),
  'specialist.export-validation-failed': plain(
    'Export validation failed',
    'The current Specialist or selected Skills contain blocking validation errors.'
  ),

  // ---- Overwrite preview (package/service.ts) ----
  'specialist.overwrite-same-version': plain(
    'Version unchanged',
    'The incoming package has the same version as the installed Specialist. You may continue explicitly.'
  ),
  'specialist.overwrite-downgrade': plain(
    'Version downgrade',
    'The incoming package version is lower than the installed version. Overwriting will roll the Specialist back.'
  ),
  'specialist.overwrite-local-modifications': plain(
    'Local edits will be replaced',
    'This Specialist was modified after import; the incoming package will replace those edits.'
  ),
  'specialist.overwrite-content-without-version-bump': plain(
    'Content changed without a version bump',
    'The package content differs from the last import, but the version did not increase.'
  )
}

const FALLBACK: SpecialistDiagnosticCopy = copy(
  'Validation finding',
  'This item failed validation. Resolve it and try again.'
)

export const specialistDiagnosticCopy = (diagnostic: PackageDiagnostic): SpecialistDiagnosticCopy =>
  MAP[diagnostic.code]?.(diagnostic) ?? FALLBACK
