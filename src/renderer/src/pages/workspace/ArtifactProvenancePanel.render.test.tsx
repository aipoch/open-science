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
    review: {
      checks: Array<{ claim: string }>
      submittedChecks?: unknown[]
    }
    defaultExpanded?: boolean
    onGoToTranscript?: (intent: { reviewId: string; findingId?: string; checkId?: string }) => void
  }) => {
    reviewerCardSpy(props)
    return (
      <div data-testid="reviewer-card">
        {props.review.checks.map((check) => check.claim).join(', ')}
        <button
          type="button"
          onClick={() => props.onGoToTranscript?.({ reviewId: 'review-1', checkId: 'check-only' })}
        >
          Open check-only transcript
        </button>
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
    message: { id: string; content: string; completedAt?: number }
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
  projectId: 'project-1',
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
      capture_status: 'partial',
      warnings: ['inventory-cache-best-effort', 'Live Kernel package state unavailable.'],
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
      op_log_truncation: {
        omitted_count: 2,
        earliest_retained_at: '2026-07-27T19:00:00.000Z'
      },
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
      selectedVersionAssessment: { ...review, checks: [check] },
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
let getCodeReconstruction: ReturnType<typeof vi.fn>
let generateCodeReconstruction: ReturnType<typeof vi.fn>
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
  getCodeReconstruction = vi.fn().mockResolvedValue({
    state: 'ready',
    origin: 'llm',
    language: 'python',
    sourceTruncated: false
  })
  generateCodeReconstruction = vi.fn().mockResolvedValue({
    state: 'cached',
    value: {
      origin: 'llm',
      code: 'import numpy as np\nnp.sin(0)',
      language: 'python',
      generatedAt: '2026-07-27T20:05:00.000Z',
      frameworkId: 'codex',
      model: 'model-a',
      sourceTruncated: false
    }
  })
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
        getVersionReview,
        getCodeReconstruction,
        generateCodeReconstruction
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
  it('navigates to the previous Artifact version outside the loaded history page', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active' },
      versions: [],
      selectedVersion: secondDescriptor,
      previousVersion: descriptor,
      headVersion: secondDescriptor
    })
    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'version-2' }}
          projectId="project-1"
          onClose={vi.fn()}
        />
      )
    )
    await flush()
    const previous = container.querySelector<HTMLButtonElement>(
      '[aria-label="Previous Artifact version"]'
    )
    expect(previous?.disabled).toBe(false)
    await act(async () => previous?.click())
    await flush()
    expect(getVersionProvenance).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'version-1' })
    )
  })
  it('retries an earlier history page without reloading core evidence or changing selection', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    const latest = {
      ...descriptor,
      id: 'version-102',
      versionId: 'version-102',
      versionNumber: 102
    }
    const initial = {
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active' as const },
      versions: Array.from({ length: 50 }, (_, i) => ({
        ...descriptor,
        id: `version-${i + 53}`,
        versionId: `version-${i + 53}`,
        versionNumber: i + 53
      })),
      selectedVersion: descriptor,
      headVersion: latest,
      nextVersion: secondDescriptor,
      nextCursor: '53'
    }
    const getLineage = vi.mocked(window.api.artifacts.getLineage)
    getLineage
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('history temporarily unavailable'))
      .mockResolvedValueOnce({
        ...initial,
        versions: [descriptor, secondDescriptor],
        nextCursor: undefined
      })
    getVersionProvenance.mockClear()
    await act(async () =>
      root.render(<ArtifactProvenancePanel item={item} projectId="project-1" onClose={vi.fn()} />)
    )
    await flush()
    await clickTab('Load earlier versions')
    await flush()
    expect(container.textContent).toContain('history temporarily unavailable')
    await clickTab('Retry loading earlier versions')
    await flush()
    expect(getLineage).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1',
      cursor: '53'
    })
    expect(getVersionProvenance).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('history temporarily unavailable')
    expect(container.textContent).toContain('v1')
    expect(
      container
        .querySelector('button[aria-label="Next Artifact version"]')
        ?.hasAttribute('disabled')
    ).toBe(false)
  })

  it.each(['missing', 'checksum-mismatch'] as const)(
    'offers diagnostics for %s content while retaining captured provenance',
    async (reason) => {
      act(() => root.unmount())
      container.replaceChildren()
      root = createRoot(container)
      getVersionProvenance.mockResolvedValue({
        ...provenance(),
        contentStatus: { state: 'unavailable', reason }
      })
      await act(async () =>
        root.render(<ArtifactProvenancePanel item={item} projectId="project-1" onClose={vi.fn()} />)
      )
      await flush()
      expect(container.textContent).toContain(
        `Artifact content is ${reason}; captured provenance remains available.`
      )
      const diagnostics = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'View diagnostics'
      )
      expect(
        diagnostics,
        'known content integrity failures must offer a diagnostic entry'
      ).toBeDefined()
      expect(diagnostics!.getAttribute('aria-expanded')).toBe('false')
      await act(async () => diagnostics!.click())
      expect(diagnostics!.getAttribute('aria-expanded')).toBe('true')
      const diagnosticsRegion = document.getElementById(
        diagnostics!.getAttribute('aria-controls')!
      )!
      expect(diagnosticsRegion.hidden).toBe(false)
      const diagnosticText = container.querySelector('pre')!.textContent!
      expect(JSON.parse(diagnosticText)).toMatchObject({
        projectId: 'project-1',
        artifactId: 'artifact-1',
        versionId: 'version-1',
        section: 'content',
        kind: 'integrity-failed',
        message: reason
      })
      const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
      try {
        await clickTab('Copy diagnostics')
        await flush()
        expect(writeText).toHaveBeenCalledWith(diagnosticText)
        expect(container.textContent).toContain('Copied')

        writeText.mockRejectedValueOnce(new Error('clipboard unavailable'))
        await clickTab('Copied')
        await flush()
        expect(container.textContent).not.toContain('Copied')
        expect(container.textContent).toContain(
          'Could not copy diagnostics. Select and copy the text above.'
        )
        expect(container.querySelector('pre')!.textContent).toBe(diagnosticText)

        await clickTab('Copy diagnostics')
        await flush()
        expect(container.textContent).toContain('Copied')
        expect(container.textContent).not.toContain('Could not copy diagnostics.')

        await clickTab('Hide diagnostics')
        expect(diagnosticsRegion.hidden).toBe(true)
        expect(diagnostics!.getAttribute('aria-expanded')).toBe('false')
        await clickTab('View diagnostics')
        expect(diagnosticsRegion.hidden).toBe(false)
        expect(container.querySelector('pre')!.textContent).toBe(diagnosticText)
      } finally {
        if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
        else Reflect.deleteProperty(navigator, 'clipboard')
      }
    }
  )

  it.each(['lineage', 'provenance'] as const)(
    'retries a transient %s load failure without closing the panel',
    async (stage) => {
      act(() => root.unmount())
      container.replaceChildren()
      root = createRoot(container)
      const load =
        stage === 'lineage' ? vi.mocked(window.api.artifacts.getLineage) : getVersionProvenance
      load.mockClear()
      load.mockRejectedValueOnce(new Error('database busy'))
      await act(async () =>
        root.render(<ArtifactProvenancePanel item={item} projectId="project-1" onClose={vi.fn()} />)
      )
      await flush()
      expect(container.textContent).toContain('database busy')
      const retry = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Retry'
      )
      expect(retry, 'a transient load error must offer Retry in the open panel').toBeDefined()
      await act(async () => retry!.click())
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
      expect(container.textContent).not.toContain('database busy')
    }
  )

  it.each(['Execution Log', 'Messages', 'Review'] as const)(
    'retries a transient deferred %s failure without changing versions',
    async (tab) => {
      const load =
        tab === 'Execution Log'
          ? getVersionExecution
          : tab === 'Messages'
            ? getVersionMessages
            : getVersionReview
      load.mockRejectedValueOnce(new Error('IPC temporarily unavailable'))
      await clickTab(tab)
      await flush()
      expect(load).toHaveBeenCalledTimes(1)
      expect(container.textContent).toContain('IPC temporarily unavailable')
      const retry = [...container.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === 'Retry'
      )
      expect(retry, 'a failed deferred section must offer Retry').toBeDefined()
      await act(async () => retry!.click())
      await flush()
      expect(load).toHaveBeenCalledTimes(2)
      expect(getVersionProvenance).toHaveBeenCalledTimes(1)
      expect(container.textContent).not.toContain('IPC temporarily unavailable')
    }
  )

  it('shows user-edit lineage without requesting Agent provenance', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    const editedDescriptor = {
      ...secondDescriptor,
      originKind: 'user_edit' as const,
      basedOnVersionId: 'version-1'
    }
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [{ ...descriptor, originKind: 'legacy' }, editedDescriptor]
    })
    getVersionProvenance.mockClear()

    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'version-2' }}
          projectId="project-1"
          onClose={vi.fn()}
        />
      )
    )
    await flush()

    expect(container.textContent).toContain('Edited in Open Science')
    expect(container.textContent).toContain('Based on v1')
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(getVersionProvenance).not.toHaveBeenCalled()
    expect(getCodeReconstruction).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-2' })
    )
  })

  it('opens the exact source Version from a user-edit Based on link', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    const editedDescriptor = {
      ...secondDescriptor,
      originKind: 'user_edit' as const,
      basedOnVersionId: 'version-1'
    }
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [{ ...descriptor, originKind: 'agent_generated' }, editedDescriptor]
    })
    const onVersionChange = vi.fn(() => true)
    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'version-2' }}
          projectId="project-1"
          onClose={vi.fn()}
          onVersionChange={onVersionChange}
        />
      )
    )
    await flush()

    const sourceLink = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open source version v1"]'
    )
    expect(sourceLink).not.toBeNull()
    await act(async () => sourceLink?.click())

    expect(onVersionChange).toHaveBeenCalledWith(
      expect.objectContaining({
        managedFileId: 'artifact-1',
        selectedVersionId: 'version-1',
        versionNumber: 1
      })
    )
  })

  it('keeps the user edit selected when the dirty guard rejects its legacy source Version', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    const editedDescriptor = {
      ...secondDescriptor,
      originKind: 'user_edit' as const,
      basedOnVersionId: 'version-1'
    }
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [{ ...descriptor, originKind: 'legacy' }, editedDescriptor]
    })
    const onVersionChange = vi.fn(() => false)
    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'version-2' }}
          projectId="project-1"
          onClose={vi.fn()}
          onVersionChange={onVersionChange}
        />
      )
    )
    await flush()

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Open source version v1"]')?.click()
    )

    expect(onVersionChange).toHaveBeenCalledWith(
      expect.objectContaining({ selectedVersionId: 'version-1', versionNumber: 1 })
    )
    expect(container.textContent).toContain('Edited in Open Science')
    expect(container.textContent).toContain('Based on v1')
  })

  it('shows a legacy Version without requesting Agent provenance', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [
        { ...descriptor, originKind: 'legacy' },
        { ...secondDescriptor, originKind: 'user_edit', basedOnVersionId: 'version-1' }
      ]
    })
    getVersionProvenance.mockClear()

    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'version-1' }}
          projectId="project-1"
          onClose={vi.fn()}
        />
      )
    )
    await flush()

    expect(container.textContent).toContain('Provenance is not available for this legacy version.')
    expect(container.querySelector('[role="tablist"]')).toBeNull()
    expect(getVersionProvenance).not.toHaveBeenCalled()
  })

  it('shows an empty legacy state without requesting Version provenance', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue(undefined)
    getVersionProvenance.mockClear()

    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{
            ...item,
            id: 'session-1:message-1:sin.png',
            artifactId: 'session-1:message-1:sin.png',
            selectedVersionId: undefined
          }}
          projectId="project-1"
          onClose={vi.fn()}
        />
      )
    )
    await flush()

    expect(container.textContent).toContain('Provenance is not available for this legacy file.')
    expect(getVersionProvenance).not.toHaveBeenCalled()
  })

  it('reports an explicitly unavailable Version instead of displaying the latest Version', async () => {
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

    expect(container.textContent).toContain('The selected Artifact version is unavailable.')
    expect(getVersionProvenance).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-2' })
    )
  })

  it('refreshes lineage when an open preview targets a newly finalized Version', async () => {
    const thirdDescriptor = {
      ...secondDescriptor,
      id: 'version-3',
      versionId: 'version-3',
      versionNumber: 3,
      checksum: 'checksum-3',
      path: '/data/sin-v3.png',
      fileUrl: 'file:///data/sin-v3.png',
      mtimeMs: 3
    }
    vi.mocked(window.api.artifacts.getLineage).mockResolvedValue({
      artifactId: 'artifact-1',
      filename: 'sin.png',
      originSession: { sessionId: 'session-1', state: 'active', title: 'Sine' },
      versions: [descriptor, secondDescriptor, thirdDescriptor]
    })

    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={{ ...item, selectedVersionId: 'version-3', versionNumber: 3 }}
          projectId="project-1"
          onClose={vi.fn()}
        />
      )
    )
    await flush()

    expect(window.api.artifacts.getLineage).toHaveBeenCalledTimes(2)
    expect(getVersionProvenance).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'version-3' })
    )
    expect(container.textContent).toContain('v3')
    expect(container.textContent).not.toContain('The selected Artifact version is unavailable.')
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

  it('checks the reconstruction cache on Code open without calling the model', async () => {
    expect(getCodeReconstruction).toHaveBeenCalledOnce()
    expect(getCodeReconstruction).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    })
    expect(generateCodeReconstruction).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Generate script')
    expect(container.textContent).toContain('Captured producer block')

    const reconstructionStatus = [...container.querySelectorAll('p')].find((paragraph) =>
      paragraph.textContent?.includes('Generate a standalone script')
    )
    expect(reconstructionStatus?.className).toContain('truncate')
    expect(reconstructionStatus?.parentElement?.className).not.toContain('flex-wrap')
  })

  it('keeps the Code and Execution Log action bars aligned', async () => {
    const codeAction = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Generate script'
    )
    const codeActionBarClassName = codeAction?.parentElement?.className

    await clickTab('Execution Log')
    await flush()

    const executionAction = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download notebook'
    )
    expect(codeActionBarClassName).toContain('py-2')
    expect(executionAction?.parentElement?.className).toBe(codeActionBarClassName)
  })

  it('shows a content loading state while reconstruction is generating', async () => {
    const generated = {
      state: 'cached' as const,
      value: {
        origin: 'llm' as const,
        code: 'import numpy as np\nnp.sin(0)',
        language: 'python' as const,
        generatedAt: '2026-07-27T20:05:00.000Z',
        frameworkId: 'codex' as const,
        model: 'model-a',
        sourceTruncated: false
      }
    }
    let resolveGeneration!: (value: typeof generated) => void
    generateCodeReconstruction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve
        })
    )

    const generate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Generate script'
    )
    await act(async () => generate?.click())

    const loading = container.querySelector('[aria-label="Generating reconstructed script"]')
    expect(loading).not.toBeNull()
    expect(loading?.textContent).toContain('Generating script…')
    expect(loading?.querySelector('svg')?.className.baseVal).toContain('animate-spin')
    expect(container.textContent).not.toContain('Captured producer block')

    await act(async () => resolveGeneration(generated))
    await flush()
    expect(container.textContent).toContain('LLM-generated reconstruction')
  })

  it('generates only after the user clicks and links the result to Execution Log', async () => {
    const generate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Generate script'
    )
    await act(async () => generate?.click())
    await flush()

    expect(generateCodeReconstruction).toHaveBeenCalledOnce()
    expect(generateCodeReconstruction).toHaveBeenCalledWith({
      projectId: 'project-1',
      appSessionId: 'session-1',
      artifactId: 'artifact-1',
      versionId: 'version-1'
    })
    expect(container.textContent).toContain('Download script')
    expect(container.textContent).toContain('LLM-generated reconstruction')
    expect(container.textContent).toContain('Execution Log')
    expect(container.textContent).not.toContain('Captured producer block')

    // The caption is one <Trans> sentence, so its copy arrives as text nodes sitting directly in the
    // wrapper rather than in a <span> that can be matched on. What this pins is the wrapper's own
    // layout, so match the wrapper — and assert it was found first, since the `not.toContain` below
    // passes vacuously when the lookup misses.
    const reconstructionCaption = [...container.querySelectorAll('div')].find((div) =>
      div.textContent?.startsWith('LLM-generated reconstruction')
    )
    expect(reconstructionCaption).toBeDefined()
    expect(reconstructionCaption?.className).toContain('truncate')
    expect(reconstructionCaption?.parentElement?.className).not.toContain('flex-wrap')

    const download = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Download script'
    )
    await act(async () => download?.click())
    expect(saveBlobFile).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'sin-v1.py', mimeType: 'text/x-python' })
    )

    const executionLinks = [...container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Execution Log'
    )
    expect(executionLinks).toHaveLength(2)
    await act(async () => executionLinks.at(-1)?.click())
    await flush()
    expect(getVersionExecution).toHaveBeenCalledOnce()
  })

  it('labels deterministic helper replay without attributing it to an LLM', async () => {
    act(() => root.unmount())
    container.replaceChildren()
    root = createRoot(container)
    getCodeReconstruction.mockResolvedValue({
      state: 'ready',
      origin: 'app-replay',
      language: 'python',
      sourceTruncated: false
    })
    generateCodeReconstruction.mockResolvedValue({
      state: 'cached',
      value: {
        origin: 'app-replay',
        code: 'print(1)',
        language: 'python',
        generatedAt: '2026-07-27T20:05:00.000Z',
        sourceTruncated: false
      }
    })

    await act(async () =>
      root.render(<ArtifactProvenancePanel item={item} projectId="project-1" onClose={vi.fn()} />)
    )
    await flush()
    expect(container.textContent).toContain(
      'This script can be reconstructed directly from the immutable Execution Log.'
    )

    const generate = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Generate script'
    )
    await act(async () => generate?.click())
    await flush()

    expect(container.textContent).toContain(
      'Reconstructed directly from the immutable Execution Log'
    )
    expect(container.textContent).not.toContain('LLM-generated reconstruction')
  })

  it('does not present Review absence while the lazy section is loading', async () => {
    let resolveReview!: (value: { review: ArtifactVersionProvenance['review'] }) => void
    getVersionReview.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve
        })
    )

    await clickTab('Review')

    expect(container.textContent).toContain('Loading Review')
    expect(container.textContent).not.toContain('No review for this version')
    expect(container.textContent).not.toContain('Model · not triggered')

    await act(async () => resolveReview({ review: provenance().review }))

    expect(container.querySelector('[data-testid="reviewer-card"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Loading Review')
  })

  it('waits for the lazy Execution response before presenting unavailable evidence', async () => {
    let resolveExecution!: (value: { execution: ArtifactVersionProvenance['execution'] }) => void
    getVersionExecution.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExecution = resolve
        })
    )

    await clickTab('Execution Log')

    expect(container.textContent).toContain('Loading Execution Log')
    expect(container.textContent).not.toContain(
      'Unable to determine the producer execution for this version'
    )

    await act(async () => resolveExecution({ execution: undefined }))

    expect(container.textContent).toContain(
      'Unable to determine the producer execution for this version'
    )
    expect(container.textContent).not.toContain('Loading Execution Log')
  })

  it('does not present Message snapshot absence while the lazy section is loading', async () => {
    let resolveMessages!: (value: { messages: ArtifactVersionProvenance['messages'] }) => void
    getVersionMessages.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMessages = resolve
        })
    )

    await clickTab('Messages')

    expect(container.textContent).toContain('Loading Messages')
    expect(container.textContent).not.toContain('immutable message snapshot is not available')

    await act(async () => resolveMessages({ messages: provenance().messages }))

    expect(container.querySelector('[data-testid="workspace-message"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Loading Messages')
  })

  it('asks for an update when a Message snapshot uses a newer persistence version', async () => {
    getVersionMessages.mockResolvedValueOnce({
      messages: { state: 'unavailable', reason: 'message-snapshot-unsupported' }
    })

    await clickTab('Messages')
    await flush()

    expect(container.textContent).toContain(
      'This message snapshot was created by a newer version of Open Science. Update the app to view it.'
    )
    expect(container.textContent).not.toContain('(message-snapshot-unsupported)')
  })

  it('reuses a loaded lazy section when switching away and back', async () => {
    await clickTab('Messages')
    await flush()
    expect(getVersionMessages).toHaveBeenCalledOnce()

    await clickTab('Execution Log')
    await flush()
    expect(getVersionExecution).toHaveBeenCalledOnce()

    await clickTab('Messages')
    await flush()

    expect(getVersionMessages).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-testid="workspace-message"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Loading Messages')
  })

  it('loads the selected Version section when switching Versions inside Provenance', async () => {
    const renderPanel = (selectedItem: PreviewFileItem): boolean => {
      root.render(
        <ArtifactProvenancePanel
          item={selectedItem}
          projectId="project-1"
          onClose={vi.fn()}
          onVersionChange={renderPanel}
        />
      )
      return true
    }
    await act(async () => renderPanel(item))
    await flush()
    getVersionMessages.mockImplementation(async (request: { versionId: string }) => {
      const messages = provenance().messages
      if (messages.state !== 'available') throw new Error('Expected available fixture messages')
      return {
        messages: {
          ...messages,
          items: messages.items.map((message) => ({
            ...message,
            content: `${request.versionId}: ${message.content}`
          }))
        }
      }
    })

    await clickTab('Messages')
    await flush()
    expect(container.textContent).toContain('version-1: The plot is ready.')

    const next = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Next Artifact version"]'
    )
    await act(async () => next?.click())
    await flush()

    expect(getVersionMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ versionId: 'version-2' })
    )
    expect(container.textContent).toContain('version-2: The plot is ready.')
    expect(container.textContent).not.toContain('(not-loaded)')
  })

  it('does not commit its selected Version when the owning surface rejects the switch', async () => {
    const onVersionChange = vi.fn(() => false)
    await act(async () =>
      root.render(
        <ArtifactProvenancePanel
          item={item}
          projectId="project-1"
          onClose={vi.fn()}
          onVersionChange={onVersionChange}
        />
      )
    )
    await flush()

    const next = container.querySelector<HTMLButtonElement>('[aria-label="Next Artifact version"]')
    expect(next).not.toBeNull()
    await act(async () => next?.click())
    await flush()

    expect(onVersionChange).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('v1')
    expect(getVersionProvenance).not.toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'version-2' })
    )
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
        message: expect.objectContaining({ id: 'agent-1' }),
        artifacts: [],
        showUserActions: false,
        contentPaddingClassName: 'px-0 md:px-0'
      })
    )
    expect(workspaceMessageItemSpy.mock.lastCall?.[0].message).not.toHaveProperty('completedAt')
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

  it('restores immutable Reviewer Correction attribution into the shared Message presentation', async () => {
    getVersionMessages.mockResolvedValue({
      messages: {
        state: 'available',
        items: [
          {
            id: 'correction-1',
            role: 'user',
            content: '[Auditor] Correct the unsupported claim.',
            attribution: {
              kind: 'application',
              feature: 'reviewer',
              purpose: 'correction',
              causeReviewId: 'review-1'
            },
            createdAt: 1
          }
        ],
        activities: [],
        activityGroups: []
      }
    })

    await clickTab('Messages')

    expect(workspaceMessageItemSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          id: 'correction-1',
          attribution: {
            kind: 'application',
            feature: 'reviewer',
            purpose: 'correction',
            causeReviewId: 'review-1'
          }
        }),
        showUserActions: false
      })
    )
  })

  it('reuses the existing ReviewerCard presentation for the selected Version assessment', async () => {
    await clickTab('Review')

    expect(container.querySelector('[data-testid="reviewer-card"]')?.textContent).toContain(
      'The curve matches the executed code'
    )
    expect(reviewerCardSpy).toHaveBeenCalledWith(expect.objectContaining({ defaultExpanded: true }))
  })

  it('projects a pass Review with zero checks without inventing Review Check evidence', async () => {
    const baseProjection = provenance().review
    if (baseProjection.state !== 'available') throw new Error('Expected available review fixture.')
    const emptyPassAssessment = { ...review, checks: [], submittedChecks: [] }
    getVersionReview.mockResolvedValue({
      review: {
        state: 'available',
        value: {
          ...baseProjection.value,
          selectedVersionAssessment: emptyPassAssessment,
          currentDirectAssessment: emptyPassAssessment,
          latestChainReview: emptyPassAssessment,
          selectedVersionChecks: [],
          turnLevelChecks: []
        }
      }
    })

    await clickTab('Review')
    await flush()

    expect(reviewerCardSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        review: expect.objectContaining({
          outcome: 'pass',
          checks: [],
          submittedChecks: []
        })
      })
    )
    expect(container.querySelector('[data-testid="reviewer-card"]')?.textContent).not.toContain(
      'The curve matches the executed code'
    )
  })

  it('renders the Reviewer-owned selected Version projection without mutating frozen history', async () => {
    const selectedTrackedSource = {
      ...check,
      id: 'tracked-selected',
      status: 'fail' as const,
      claim: 'Selected source issue'
    }
    const otherTrackedSource = {
      ...selectedTrackedSource,
      id: 'tracked-other',
      claim: 'Other source issue'
    }
    const selectedNew = { ...check, id: 'new-selected', claim: 'Selected new check' }
    const otherNew = {
      ...check,
      id: 'new-other',
      claim: 'Other new check',
      artifactVersionId: 'version-2'
    }
    const turnNew = {
      ...check,
      id: 'new-turn',
      claim: 'Turn-level check',
      artifactVersionId: undefined
    }
    const submittedChecks = [
      {
        kind: 'tracked' as const,
        submissionIndex: 0,
        sourceFindingId: selectedTrackedSource.id,
        dispositionOutcome: 'still_open' as const,
        assessedArtifactVersionId: 'version-1',
        assessment: {
          status: 'fail' as const,
          claim: 'Selected tracked assessment',
          evidence: 'Selected tracked evidence',
          artifactVersionId: 'version-1',
          sortIndex: 0
        },
        sourceCheck: selectedTrackedSource
      },
      {
        kind: 'tracked' as const,
        submissionIndex: 1,
        sourceFindingId: otherTrackedSource.id,
        dispositionOutcome: 'still_open' as const,
        assessedArtifactVersionId: 'version-2',
        assessment: {
          status: 'fail' as const,
          claim: 'Other tracked assessment',
          evidence: 'Other tracked evidence',
          artifactVersionId: 'version-2',
          sortIndex: 1
        },
        sourceCheck: otherTrackedSource
      },
      { kind: 'new' as const, submissionIndex: 2, check: selectedNew },
      { kind: 'new' as const, submissionIndex: 3, check: otherNew },
      { kind: 'new' as const, submissionIndex: 4, check: turnNew }
    ]
    const assessment = { ...review, checks: [selectedNew, otherNew, turnNew], submittedChecks }
    const selectedVersionAssessment = {
      ...assessment,
      checks: [selectedNew, turnNew],
      submittedChecks: [submittedChecks[0]!, submittedChecks[2]!, submittedChecks[4]!]
    }
    const baseProjection = provenance().review
    if (baseProjection.state !== 'available') throw new Error('Expected available review fixture.')
    getVersionReview.mockResolvedValue({
      review: {
        state: 'available',
        value: {
          ...baseProjection.value,
          selectedVersionAssessment,
          currentDirectAssessment: assessment,
          latestChainReview: assessment,
          selectedVersionChecks: [selectedNew],
          turnLevelChecks: [turnNew]
        }
      }
    })

    await clickTab('Review')
    await flush()

    const renderedReview = reviewerCardSpy.mock.lastCall?.[0].review as {
      submittedChecks: typeof submittedChecks
    }
    expect(
      renderedReview.submittedChecks.map((item) =>
        item.kind === 'new' ? item.check.id : item.sourceFindingId
      )
    ).toEqual(['tracked-selected', 'new-selected', 'new-turn'])
    expect(submittedChecks).toHaveLength(5)
  })

  it('uses checkId as the active Session Reviewer identity when findingId is absent', async () => {
    await clickTab('Review')
    const open = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Open check-only transcript'
    )
    await act(async () => open?.click())

    const reviewerItem = usePreviewWorkbenchStore
      .getState()
      .items.find((candidate) => candidate.type === 'tool' && candidate.toolKind === 'reviewer')
    expect(reviewerItem).toBeDefined()
    if (!reviewerItem || reviewerItem.type !== 'tool') {
      throw new Error('Expected the Reviewer action to open a tool preview item.')
    }
    expect(reviewerItem.reviewerActiveFindingId).toBe('check-only')
  })

  it('does not present a saved Review as current when its active source Session is unavailable', async () => {
    getVersionReview.mockResolvedValue({
      review: { state: 'unavailable', reason: 'source-session-unavailable' }
    })

    await clickTab('Review')
    await flush()

    expect(container.textContent).toContain('Review unavailable')
    expect(container.textContent).toContain('saved review cannot be verified as current')
    expect(container.querySelector('[data-testid="reviewer-card"]')).toBeNull()
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
    expect(container.textContent).toContain(
      '2 earlier operations omitted from this bounded history.'
    )
    expect(container.textContent).toContain('Retained entries begin')
    expect(container.textContent).toContain('Inventory cache was reused without a full validation')
    expect(container.textContent).toContain('Live Kernel package state unavailable.')
    expect(container.textContent).toContain('create')
    expect(container.textContent).toContain('numpy 2.4.6')
    expect(container.textContent).toContain(
      'Observed since the previous snapshot (not attributed to this operation)'
    )
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
      expect.objectContaining({ suggestedName: 'sin-v1.py', mimeType: 'text/x-python' })
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

  it('exports each kernel separately when the Execution Log contains mixed kernels', async () => {
    const execution = provenance().execution!
    getVersionExecution.mockResolvedValue({
      execution: {
        ...execution,
        runs: [
          ...execution.runs,
          {
            ...execution.runs[0],
            runId: 'notebook-run-r',
            runIndex: 1,
            kernelKind: 'r',
            script: 'plot(sin(0))'
          }
        ]
      }
    })

    await clickTab('Execution Log')
    await flush()
    const download = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Download notebook')
    )
    await act(async () => download?.click())

    expect(saveBlobFile).toHaveBeenCalledTimes(2)
    expect(saveBlobFile).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ suggestedName: 'sin-v1-python.ipynb' })
    )
    expect(saveBlobFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ suggestedName: 'sin-v1-r.ipynb' })
    )
  })

  it('discloses bounded execution evidence instead of presenting it as complete', async () => {
    const execution = provenance().execution!
    getVersionExecution.mockResolvedValue({
      execution: {
        ...execution,
        truncation: {
          reason: 'payload-limit',
          omittedLeadingRunCount: 3,
          omittedOutputCount: 17,
          omittedInputCount: 2
        }
      }
    })

    await clickTab('Execution Log')
    await flush()

    expect(container.textContent).toContain(
      'Execution evidence was bounded for storage: omitted 3 earlier runs, 17 outputs, and 2 inputs.'
    )
  })

  it('surfaces a segmented evidence loading failure instead of silently showing empty evidence', async () => {
    getVersionExecution.mockRejectedValueOnce(new Error('execution snapshot unavailable'))

    await clickTab('Execution Log')
    await flush()

    expect(container.textContent).toContain('execution snapshot unavailable')
    expect(getVersionExecution).toHaveBeenCalledOnce()

    await clickTab('Code')

    expect(container.textContent).toContain('Captured producer block')
    expect(container.textContent).not.toContain('execution snapshot unavailable')
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
