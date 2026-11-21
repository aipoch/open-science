import { posix, win32 } from 'node:path'

import type { NotebookRunDocument, NotebookRunRecord } from '../../shared/notebook'
import type { ProjectFolderRunInput } from '../../shared/project-folder-changes'
import type { PersistedChatSession } from '../../shared/session-persistence'
import type { SessionPackageManifest } from '../../shared/session-package'
import { encodeRunDocumentDataPaths } from '../notebook/run-document-data-path-codec'
import { encodeSessionDataPaths } from '../session-persistence/session-data-paths'
import { encodeDataPath } from '../storage/data-path-codec'

// Only known execution/attachment path fields pass through this function. Research strings,
// Notebook code/output and user file bytes never do. Existing managed packages use their old codec.
function portablePath(path: string | undefined, dataRoot: string): string | undefined {
  const encoded = encodeDataPath(path, dataRoot)
  return encoded && (posix.isAbsolute(encoded) || win32.isAbsolute(encoded)) ? '' : encoded
}

export function portableProjectSession(
  session: PersistedChatSession,
  dataRoot: string
): PersistedChatSession {
  const encoded = encodeSessionDataPaths(session, dataRoot)
  const messages = (source: PersistedChatSession['messages']): PersistedChatSession['messages'] =>
    source.map((message) => ({
      ...message,
      uploads: message.uploads?.map((upload) =>
        upload.path ? { ...upload, path: portablePath(upload.path, dataRoot) } : upload
      )
    }))
  return {
    ...encoded,
    cwd: portablePath(encoded.cwd, dataRoot) ?? '',
    messages: messages(encoded.messages),
    ...(encoded.conversationGraph
      ? {
          conversationGraph: {
            ...encoded.conversationGraph,
            messages: messages(
              encoded.conversationGraph.messages
            ) as typeof encoded.conversationGraph.messages
          }
        }
      : {}),
    artifacts: encoded.artifacts?.map((artifact) => ({
      ...artifact,
      path: portablePath(artifact.path, dataRoot) ?? ''
    }))
  }
}

function portableRun(run: NotebookRunRecord, dataRoot: string): NotebookRunRecord {
  const path = (value: string): string => portablePath(value, dataRoot) ?? ''
  return {
    ...run,
    runtimeId: portablePath(run.runtimeId, dataRoot) || undefined,
    ...(run.frozenRuntimeTarget
      ? {
          frozenRuntimeTarget: {
            ...run.frozenRuntimeTarget,
            runtimeId: portablePath(run.frozenRuntimeTarget.runtimeId, dataRoot) || undefined,
            interpreterPath:
              portablePath(run.frozenRuntimeTarget.interpreterPath, dataRoot) || undefined,
            condaPrefix: portablePath(run.frozenRuntimeTarget.condaPrefix, dataRoot) || undefined,
            command: portablePath(run.frozenRuntimeTarget.command, dataRoot) || undefined
          }
        }
      : {}),
    cwdBefore: portablePath(run.cwdBefore, dataRoot),
    cwdAfter: portablePath(run.cwdAfter, dataRoot),
    workingFiles: run.workingFiles.map((file) => ({ ...file, path: path(file.path) })),
    artifacts: run.artifacts?.map((artifact) => ({ ...artifact, path: path(artifact.path) })),
    ...(run.frozenShellContext
      ? {
          frozenShellContext: {
            ...run.frozenShellContext,
            cwd: path(run.frozenShellContext.cwd),
            handoffDir: path(run.frozenShellContext.handoffDir),
            runtimeRoot: path(run.frozenShellContext.runtimeRoot),
            notebookSessionRoot: path(run.frozenShellContext.notebookSessionRoot),
            inputRoot: path(run.frozenShellContext.inputRoot),
            protectedDirs: run.frozenShellContext.protectedDirs.map(path),
            environment: Object.fromEntries(
              Object.entries(run.frozenShellContext.environment).map(([name, value]) => [
                name,
                [
                  'PWD',
                  'OLDPWD',
                  'OPEN_SCIENCE_NOTEBOOK_DATA_DIR',
                  'OPEN_SCIENCE_NOTEBOOK_OUTPUT_DIR',
                  'OPEN_SCIENCE_HANDOFF_DIR',
                  'OPEN_SCIENCE_WORKSPACE_DIR'
                ].includes(name)
                  ? path(value)
                  : value
              ])
            )
          }
        }
      : {})
  }
}

export function portableProjectNotebook(
  document: NotebookRunDocument,
  dataRoot: string
): NotebookRunDocument {
  const encoded = encodeRunDocumentDataPaths(document, dataRoot)
  return {
    ...encoded,
    // Per-installation interpreter bindings are not restored from shared research history.
    runtimeBindings: undefined,
    workspaceCwd: portablePath(encoded.workspaceCwd, dataRoot) ?? '',
    notebookSessionRoot: portablePath(encoded.notebookSessionRoot, dataRoot) ?? '',
    dataRoot: portablePath(encoded.dataRoot, dataRoot) ?? '',
    kernel: {
      ...encoded.kernel,
      runtimeRoot: portablePath(encoded.kernel.runtimeRoot, dataRoot) ?? '',
      pythonPath: portablePath(encoded.kernel.pythonPath, dataRoot) || undefined
    },
    runs: encoded.runs.map((run) => portableRun(run, dataRoot))
  }
}

export function isProjectFolderWorkingProjection(key: string): boolean {
  return /^notebooks\/[^/]+\/[^/]+\/(?:frames\/[^/]+\/)?data(?:\/|$)/u.test(key)
}

export function projectFolderInputOmissions(
  documents: readonly NotebookRunDocument[]
): SessionPackageManifest['omissions'] {
  const inputs = new Map<string, ProjectFolderRunInput>()
  for (const document of documents)
    for (const run of document.runs) {
      // Optional historical metadata: no input is invented by analyzing the user's source code.
      for (const input of run.projectFolderInputs ?? []) {
        if (
          typeof input.relativePath !== 'string' ||
          posix.isAbsolute(input.relativePath) ||
          win32.isAbsolute(input.relativePath) ||
          input.relativePath
            .replaceAll('\\', '/')
            .split('/')
            .some((part) => part === '..') ||
          (input.checksum !== undefined && !/^[a-f0-9]{64}$/.test(input.checksum)) ||
          !Number.isSafeInteger(input.sizeBytes) ||
          input.sizeBytes < 0 ||
          input.frozen !== false
        )
          throw new Error('Invalid project folder input provenance.')
        inputs.set(`${input.relativePath}\0${input.checksum ?? input.sizeBytes}`, input)
      }
    }
  return [
    {
      kind: 'external' as const,
      description:
        'The live project folder, its working projection and private change history are not bundled. External folder inputs were not frozen.'
    },
    ...[...inputs.values()].map((input) => ({
      kind: 'external' as const,
      description: `Project folder input is external and not bundled; source was not frozen. File: ${input.relativePath.slice(0, 1600)}; ${input.checksum ? `SHA-256: ${input.checksum}` : 'checksum not captured'}; bytes: ${input.sizeBytes}.`
    }))
  ]
}
