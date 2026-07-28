// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createInitialPreviewWorkbenchState,
  type PreviewFileItem,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import type { ArtifactVersionProvenance } from '../../../../shared/artifact-provenance'

const reviewerCardSpy = vi.hoisted(() => vi.fn())
const workspaceMessageItemSpy = vi.hoisted(() => vi.fn())
const workspaceActivityGroupSpy = vi.hoisted(() => vi.fn())

vi.mock('@/components/ReviewerCard', () => ({
  ReviewerCard: (props: {
    review: { checks: Array<{ claim: string }> }
    defaultExpanded?: boolean
  }) => {
    reviewerCardSpy(props)
    return (
      <div data-testid="reviewer-card">
        {props.review.checks.map((check) => check.claim).join(', ')}
      </div>
    )
  }
}))

vi.mock('./SessionNotebookDialog', () => ({
  NotebookDialogCell: ({ run }: { run: { runId: string } }) => (
    <div data-testid="notebook-run">{run.runId}</div>
  )
}))

vi.mock('./WorkspaceMessageItem', () => ({
  WorkspaceMessageItem: (props: {
    message: { id: string; content: string }
    artifacts?: unknown[]
    showUserActions?: boolean
    contentPaddingClassName?: string
  }) => {
    workspaceMessageItemSpy(props)
    return <div data-testid="workspace-message">{props.message.content}</div>
  }
}))

vi.mock('./WorkspaceActivityGroup', () => ({
  WorkspaceActivityGroup: (props: {
    group: { id: string; title?: string }
    contentPaddingClassName?: string
  }) => {
    workspaceActivityGroupSpy(props)
    return <div data-testid="workspace-activity">{props.group.title}</div>
  }
}))

import { ArtifactProvenancePanel } from './ArtifactProvenancePanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const item: PreviewFileItem = {
  id: 'artifact-1',
  artifactId: 'artifact-1',
  selectedVersionId: 'version-1',
  sessionId: 'session-1',
  type: 'file',
  title: 'sin.png',
  name: 'sin.png',
  path: '/data/sin.png',
  format: 'image',
  source: 'artifact'
}

const descriptor = {
  id: 'version-1',
  artifactId: 'artifact-1',
  versionId: 'version-1',
  versionNumber: 1,
  checksum: 'checksum-1',
  createdAt: '2026-07-27T20:00:00.000Z',
  state: 'finalized' as const,
  projectName: 'project-1',
  sessionId: 'session-1',
  runId: 'artifact-run-1',
  name: 'sin.png',
  path: '/data/sin.png',
  fileUrl: 'file:///data/sin.png',
  size: 12,
  mtimeMs: 1
}

const secondDescriptor = {
  ...descriptor,
  id: 'version-2',
  versionId: 'version-2',
  versionNumber: 2,
  checksum: 'checksum-2',
  path: '/data/sin-v2.png',
  fileUrl: 'file:///data/sin-v2.png',
  mtimeMs: 2
}

const review = {
  id: 'review-1',
  projectId: 'project-1',
  sessionId: 'session-1',
  turnMessageId: 'message-1',
  scope: {
    turnMessageId: 'message-1',
    blocks: [],
    artifactVersionIds: ['version-1']
  },
  lifecycle: 'complete' as const,
  outcome: 'pass' as const,
  model: 'reviewer-model',
  reviewerLog: [],
  createdAt: 1,
  updatedAt: 2,
  checks: [],
  scopeSnapshot: { state: 'available' as const, blocks: [] }
}

const check = {
  id: 'check-1',
  reviewId: 'review-1',
  status: 'pass' as const,
  resolution: 'open' as const,
  claim: 'The curve matches the executed code',
  evidence: 'sin(x) was plotted over one period.',
  artifactVersionId: 'version-1',
  artifactBindingState: 'scope_validated' as const,
  sortIndex: 0,
  reflagCount: 0
}

const provenance = (): ArtifactVersionProvenance => ({
  descriptor,
  contentStatus: { state: 'available' },
  evidence: {
    schema_version: 1,
    project_id: 'project-1',
    app_session_id: 'session-1',
    artifact_id: 'artifact-1',
    version_id: 'version-1',
    version_number: 1,
    filename: 'sin.png',
    content_type: 'image/png',
    size_bytes: 64,
    checksum: 'a'.repeat(64),
    created_at: '2026-07-27T19:01:01.000Z',
    conversation: {
      root_frame_id: 'root-frame-1',
      agent_frame_id: 'root-frame-1',
      message_branch_id: 'branch-1',
      runtime_segment_id: 'runtime-segment-1',
      prompt_message_id: 'user-1'
    },
    is_user_upload: false,
    reproduction_code: 'import numpy as np\nnp.sin(0)',
    execution_snapshot_checksum: 'b'.repeat(64),
    execution_status: { state: 'available' },
    inputs: [
      {
        ordinal: 0,
        input_file_version_id: 'upload-version-1',
        source_kind: 'upload-version',
        source_file_id: 'upload-1',
        source_version_number: 3,
        source_created_at: '2026-07-27T18:59:00.000Z',
        source_project_id: 'project-1',
        source_session_id: 'source-session-1',
        filename: 'groups.csv',
        content_type: 'text/csv',
        size_bytes: 42,
        checksum: 'd'.repeat(64),
        storage_key: 'must-not-reach-rendered-input',
        strongest_association: 'resolver-accessed'
      }
    ],
    producer: {
      state: 'available',
      notebook_session_id: 'session-1',
      producer_run_id: 'notebook-run-2',
      run_index: 0,
      kernel_kind: 'python',
      association_method: 'agent-declared-and-session-validated'
    },
    environment: {
      capture_kind: 'completed-run',
      environment_name: 'python',
      runtime_version: '3.11.15',
      runtime_source: 'managed',
      kernel_kind: 'python',
      platform: 'darwin',
      architecture: 'arm64',
      capture_status: 'complete',
      packages: [
        {
          name: 'numpy',
          version: '2.4.6',
          version_status: 'known',
          ecosystem: 'python',
          evidence_sources: ['python-importlib-metadata'],
          loaded_state: 'loaded'
        },
        {
          name: 'libzlib',
          version: '1.3.2',
          version_status: 'known',
          ecosystem: 'native',
          evidence_sources: ['python-importlib-metadata'],
          loaded_state: 'installed-only'
        }
      ],
      inventory_sources: ['interpreter-native'],
      installed_inventory: {
        captured_at: '2026-07-27T19:01:00.000Z',
        source: 'full-scan',
        validation: 'full-scan'
      },
      op_log: [
        {
          operation_id: 'operation-1',
          timestamp: '2026-07-27T19:00:00.000Z',
          operation: 'create',
          packages: ['numpy'],
          result: 'success',
          attempts: [],
          fallback_used: false,
          inventory_refresh: 'published',
          package_changes: [
            {
              name: 'numpy',
              ecosystem: 'python',
              relationship: 'requested',
              change: 'installed',
              after_version: '2.4.6'
            },
            {
              name: 'packaging',
              ecosystem: 'python',
              relationship: 'unattributed',
              change: 'updated',
              before_version: '25.0',
              after_version: '26.0'
            }
          ],
          inventory_refresh_attempts: [
            {
              attempt: 1,
              trigger: 'terminal',
              timestamp: '2026-07-27T19:01:00.000Z',
              result: 'published'
            }
          ]
        }
      ],
      captured_at: '2026-07-27T19:01:01.000Z',
      source_manifest_checksum: 'c'.repeat(64),
      complete: true
    },
    environment_status: { state: 'available' }
  },
  execution: {
    schemaVersion: 2,
    rootFrameId: 'root-frame-1',
    agentFrameId: 'root-frame-1',
    messageBranchId: 'branch-1',
    terminalPromptMessageId: 'user-1',
    producerRunId: 'notebook-run-2',
    producerRunIndex: 0,
    createdAt: '2026-07-27T19:01:01.000Z',
    inputFiles: [],
    runs: [
      {
        runId: 'notebook-run-2',
        runIndex: 0,
        agentFrameId: 'root-frame-1',
        messageBranchId: 'branch-1',
        runtimeSegmentId: 'runtime-segment-1',
        promptMessageId: 'user-1',
        kernelKind: 'python',
        script: 'import numpy as np\nnp.sin(0)',
        status: 'completed',
        executionCount: 1,
        startedAt: '2026-07-27T19:01:00.000Z',
        completedAt: '2026-07-27T19:01:01.000Z',
        outputs: [{ type: 'text', text: '0.0' }],
        inputFileVersionKeys: []
      }
    ]
  },
  messages: {
    state: 'available',
    items: [
      {
        id: 'user-1',
        role: 'user',
        content: 'Plot a sine curve',
        createdAt: 1
      },
      {
        id: 'agent-1',
        role: 'agent',
        content: 'The plot is ready.',
        artifacts: [{ versionId: 'version-1', name: 'sin.png' }],
        createdAt: 2
      }
    ],
    activities: [
      {
        id: 'activity-1',
        kind: 'tool',
        title: 'Notebook cell',
        activityGroupId: 'activity-group-1',
        status: 'completed',
        sortIndex: 1,
        eventIds: ['event-1'],
        providerToolName: 'mcp__open-science-notebook__notebook_execute',
        toolKind: 'execute',
        rawInput: { code: 'plot(sin(x))' },
        createdAt: 1.5,
        updatedAt: 1.75
      }
    ],
    activityGroups: [
      {
        id: 'activity-group-1',
        title: 'Notebook execution',
        sortIndex: 1,
        activityIds: ['activity-1'],
        createdAt: 1.5,
        updatedAt: 1.75,
        completedAt: 1.75
      }
    ]
  },
  review: {
    state: 'available',
    value: {
      binding: 'version',
      selectedVersionId: 'version-1',
      currentDirectAssessment: { ...review, checks: [check] },
      latestChainReview: { ...review, checks: [check] },
      selectedVersionChecks: [check],
      turnLevelChecks: [],
      selectedVersionDispositions: [],
      history: [
        {
          kind: 'review',
          review: { ...review, checks: [check] },
          directlyAssessesSelectedVersion: true
        }
      ]
    }
  }
})

let container: HTMLDivElement
let root: Root
let getVersionProvenance: ReturnType<typeof vi.fn>
let getVersionExecution: ReturnType<typeof vi.fn>
let getVersionMessages: ReturnType<typeof vi.fn>
let getVersionReview: ReturnType<typeof vi.fn>
let saveBlobFile: ReturnType<typeof vi.fn>

const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const clickTab = async (label: string): Promise<void> => {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label
  )
  await act(async () => button?.click())
}

beforeEach(async () => {
  reviewerCardSpy.mockClear()
  workspaceMessageItemSpy.mockClear()
  workspaceActivityGroupSpy.mockClear()
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project-1')
  usePreviewWorkbenchStore.getState().upsertAndActivateItem(item)
  const completeProvenance = provenance()
  getVersionProvenance = vi.fn().mockResolvedValue({
    ...completeProvenance,
    execution: undefined,
    messages: { state: 'unavailable', reason: 'not-loaded' },
    review: { state: 'unavailable', reason: 'not-loaded' }
  })
  getVersionExecution = vi.fn().mockResolvedValue({ execution: completeProvenance.execution })
  getVersionMessages = vi.fn().mockResolvedValue({ messages: completeProvenance.messages })
  getVersionReview = vi.fn().mockResolvedValue({ review: completeProvenance.review })
  saveBlobFile = vi.fn().mockResolvedValue({ saved: true, filePath: '/tmp/session.ipynb' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifacts: {
        getLineage: vi.fn().mockResolvedValue({
          artifactId: 'artifact-1',
          filename: 'sin.png',
          originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
          versions: [descriptor, secondDescriptor]
        }),
        getVersionProvenance,
        getVersionExecution,
        getVersionMessages,
        getVersionReview
      },
      reviewer: { onUpdated: vi.fn().mockReturnValue(() => undefined) },
      saveBlobFile
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(<ArtifactProvenancePanel item={item} projectId="project-1" onClose={vi.fn()} />)
  )
  await flush()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('ArtifactProvenancePanel', () => {
  it('falls back to the latest lineage Version when the preview selection is stale', async () => {
    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'stale-version-id' }}
          projectId="project-1"
          onClose={vi.fn()}
        />
      )
    )
    await flush()

    const versionLabel = container.querySelector(
      'button[aria-label="Next Artifact version"]'
    )?.previousElementSibling
    expect(versionLabel?.textContent).toBe('v2')
  })

  it('loads tab-specific evidence only when that tab is opened', async () => {
    expect(getVersionExecution).not.toHaveBeenCalled()
    expect(getVersionMessages).not.toHaveBeenCalled()
    expect(getVersionReview).not.toHaveBeenCalled()

    await clickTab('Messages')
    await flush()
    expect(getVersionMessages).toHaveBeenCalledOnce()
    expect(getVersionExecution).not.toHaveBeenCalled()
    expect(getVersionReview).not.toHaveBeenCalled()
  })

  it('renders producer inputs in Code and opens the exact immutable input Version', async () => {
    expect(container.querySelector('[aria-label="Inputs"]')?.textContent).toContain('groups.csv')
    expect(container.querySelector('[aria-label="Inputs"]')?.textContent).toContain('v3')
    expect(container.textContent).not.toContain('must-not-reach-rendered-input')

    const input = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.includes('groups.csv')
    )
    await act(async () => input?.click())

    expect(usePreviewWorkbenchStore.getState().items).toContainEqual(
      expect.objectContaining({
        id: 'upload:upload-1',
        sessionId: 'source-session-1',
        selectedVersionId: 'upload-version-1',
        versionNumber: 3,
        path: expect.stringContaining('notebook-input:')
      })
    )
  })

  it('synchronizes version selection with the stable preview workbench item', async () => {
    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next Artifact version"]'
    )

    await act(async () => next?.click())
    await flush()

    expect(usePreviewWorkbenchStore.getState().items).toContainEqual(
      expect.objectContaining({
        id: 'artifact-1',
        selectedVersionId: 'version-2',
        versionNumber: 2,
        path: 'artifact-version:project-1/session-1/artifact-1/version-2'
      })
    )
  })

  it('renders captured Messages through the normal Session message surface without GENERATED cards', async () => {
    await clickTab('Messages')

    expect(workspaceMessageItemSpy).toHaveBeenCalledTimes(2)
    expect(workspaceMessageItemSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        artifacts: [],
        showUserActions: false,
        contentPaddingClassName: 'px-0 md:px-0'
      })
    )
    expect(workspaceActivityGroupSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        group: expect.objectContaining({
          activities: [expect.objectContaining({ id: 'activity-1' })]
        }),
        contentPaddingClassName: 'px-0 md:px-0'
      })
    )
    expect(container.textContent).not.toContain('GENERATED')
  })

  it('reuses the existing ReviewerCard presentation for the selected Version assessment', async () => {
    await clickTab('Review')

    expect(container.querySelector('[data-testid="reviewer-card"]')?.textContent).toContain(
      'The curve matches the executed code'
    )
    expect(reviewerCardSpy).toHaveBeenCalledWith(expect.objectContaining({ defaultExpanded: true }))
  })

  it('shows a three-column relevant-package table and retains access to the full inventory', async () => {
    await clickTab('Environment')

    expect(container.textContent).toContain('Package')
    expect(container.textContent).toContain('Version')
    expect(container.textContent).toContain('State')
    expect(container.textContent).toContain('numpy')
    expect(container.textContent).not.toContain('libzlib')
    expect(container.textContent).toContain('Show all 2 packages')
    expect(container.textContent).toContain('Operations')
    expect(container.textContent).toContain('create')
    expect(container.textContent).toContain('numpy 2.4.6')
    expect(container.textContent).toContain('Other observed changes')
    expect(container.textContent).toContain('packaging 25.0 → 26.0')
    const operationTimeHeader = [...container.querySelectorAll('th')].find(
      (header) => header.textContent === 'Time'
    )
    expect(operationTimeHeader?.className).toContain('w-[34%]')
    const operationTime = container.querySelector('time[datetime="2026-07-27T19:00:00.000Z"]')
    expect(operationTime?.className).toContain('whitespace-normal')
    expect(operationTime?.className).toContain('break-words')
    expect(operationTime?.className).not.toContain('whitespace-nowrap')
    const operationsTable = [...container.querySelectorAll('table')].find((table) =>
      [...table.querySelectorAll('th')].some((header) => header.textContent === 'Operation')
    )
    const packagesCell = [...(operationsTable?.querySelectorAll('td') ?? [])].find(
      (cell) => cell.textContent === 'numpy 2.4.6'
    )
    expect(packagesCell?.className).toContain('whitespace-normal')
    expect(packagesCell?.className).toContain('break-words')
    expect(packagesCell?.className).not.toContain('truncate')

    const showAll = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Show all 2 packages')
    )
    await act(async () => showAll?.click())
    expect(container.textContent).toContain('libzlib')
  })

  it('downloads the exact captured producer block with the matching kernel extension', async () => {
    const download = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download'
    )
    expect(download).toBeTruthy()
    await act(async () => download?.click())

    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'sin-v1.py', mimeType: 'text/plain' })
    )
    const request = saveBlobFile.mock.calls[0]?.[0] as { data: ArrayBuffer }
    expect(new TextDecoder().decode(request.data)).toBe('import numpy as np\nnp.sin(0)')
  })

  it('downloads an immutable notebook projection from the captured Execution Log', async () => {
    await clickTab('Execution Log')

    const download = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download notebook'
    )
    expect(download).toBeTruthy()
    await act(async () => download?.click())

    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: 'sin-v1.ipynb',
        mimeType: 'application/x-ipynb+json'
      })
    )
    const request = saveBlobFile.mock.calls[0]?.[0] as { data: ArrayBuffer }
    const notebook = JSON.parse(new TextDecoder().decode(request.data)) as {
      cells: Array<{ source: string[] }>
    }
    expect(notebook.cells[0]?.source.join('')).toContain('np.sin(0)')
  })

  it('surfaces a segmented evidence loading failure instead of silently showing empty evidence', async () => {
    getVersionExecution.mockRejectedValueOnce(new Error('execution snapshot unavailable'))

    await clickTab('Execution Log')
    await flush()

    expect(container.textContent).toContain('execution snapshot unavailable')
    expect(getVersionExecution).toHaveBeenCalledOnce()
  })

  it('keeps the Execution Log visible and reports notebook download failures', async () => {
    saveBlobFile.mockRejectedValueOnce(new Error('save cancelled'))
    await clickTab('Execution Log')

    const download = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download notebook'
    )
    await act(async () => download?.click())
    await flush()

    expect(container.textContent).toContain('save cancelled')
    expect(container.querySelector('[data-testid="notebook-run"]')).not.toBeNull()
  })
})
