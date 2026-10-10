import { beforeEach, expect, it } from 'vitest'
import {
  createInitialPreviewWorkbenchState,
  usePreviewWorkbenchStore
} from '@/stores/preview-workbench-store'
import {
  ensureResearchPreview,
  releaseAutomaticResearchPreview
} from './research-preview-navigation'
import { showSessionReplay } from './workspace-session-actions'
import { showRecordedObservation } from './replay/open-run-observation'

const source = { projectId: 'project', sourceSessionId: 'source', sourceTitle: 'Imported study' }
beforeEach(() => {
  usePreviewWorkbenchStore.setState(createInitialPreviewWorkbenchState())
  usePreviewWorkbenchStore.getState().activateProject('project')
})

it('opens a default once, respects a collapsed panel, and removes only defaults on leaving research', () => {
  ensureResearchPreview(source, 'project')
  const id = usePreviewWorkbenchStore.getState().activeItemId
  expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({ replayAutomatic: true })
  usePreviewWorkbenchStore.getState().collapsePanel()
  ensureResearchPreview(source, 'project')
  expect(usePreviewWorkbenchStore.getState()).toMatchObject({
    activeItemId: id,
    panelState: 'collapsed',
    openRequestVersion: 1
  })
  releaseAutomaticResearchPreview('project')
  expect(usePreviewWorkbenchStore.getState().items).toEqual([])
})

it('does not replace an explicitly opened exact receiving archive when entering discussion', () => {
  const target = {
    projectId: 'project',
    sessionId: 'source',
    artifactId: 'archive',
    versionId: 'version-2'
  }
  showRecordedObservation(target, 'Saved experiment')
  const before = usePreviewWorkbenchStore.getState()
  ensureResearchPreview(source, 'project')
  expect(usePreviewWorkbenchStore.getState()).toBe(before)
  releaseAutomaticResearchPreview('project')
  expect(usePreviewWorkbenchStore.getState().items[0]).toMatchObject({
    replayRecordingTarget: target
  })
})

it('keeps a source the user explicitly selected even when it was initially automatic', () => {
  ensureResearchPreview(source, 'project')
  const store = usePreviewWorkbenchStore.getState()
  store.activateItem(store.activeItemId!)
  releaseAutomaticResearchPreview('project')
  expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
  expect(usePreviewWorkbenchStore.getState().items[0]).not.toHaveProperty('replayAutomatic', true)
})

it('keeps explicit View process requests and never touches another project slice', () => {
  ensureResearchPreview(source, 'project')
  showSessionReplay('project', 'source', 'Imported study')
  releaseAutomaticResearchPreview('project')
  expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
  usePreviewWorkbenchStore.getState().activateProject('other')
  ensureResearchPreview(source, 'project')
  releaseAutomaticResearchPreview('project')
  expect(usePreviewWorkbenchStore.getState().items).toEqual([])
  usePreviewWorkbenchStore.getState().activateProject('project')
  expect(usePreviewWorkbenchStore.getState().items).toHaveLength(1)
})
