// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ProjectPackageDropZone } from './ProjectPackageDropZone'
import { usePackageOperationStore } from '@/stores/package-operation-store'
import { WEB_EVENT_SURFACE_ATTRIBUTE } from '../../../shared/web-event-connection'
import { useFileDropZone } from '@/hooks/useFileDropZone'
import { createPortal } from 'react-dom'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ActiveTransferOwner } from '../../../main/uploads/active-transfer-owner'
import { useWorkspaceComposerController } from '@/pages/workspace/workspace-composer-controller'
import { WorkspaceComposerDraftsProvider } from '@/pages/workspace/workspace-composer-drafts'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (text: string, values?: { project: string }) =>
      text.replace('{{project}}', values?.project ?? '')
  })
}))
const importPackage = vi.fn(async () => null)
beforeEach(() => {
  importPackage.mockClear()
  vi.stubGlobal('api', { sessions: { importPackage } })
  usePackageOperationStore.setState({ operation: null, open: false })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(WEB_EVENT_SURFACE_ATTRIBUTE)
})
const drop = (target: Element, names: string[]): void => {
  fireEvent.drop(target, {
    dataTransfer: {
      types: ['Files'],
      files: names.map((name) => new File(['fixture'], name))
    }
  })
}
const mount = (canImport = true, canAttach = true): ReturnType<typeof vi.fn> => {
  const attach = vi.fn()
  render(
    <ProjectPackageDropZone
      projectId="target"
      projectName="Research"
      canImport={canImport}
      canAttach={canAttach}
      onFiles={attach}
      data-testid="workspace"
    >
      <div data-testid="composer" onDrop={attach} />
    </ProjectPackageDropZone>
  )
  return attach
}
it('routes a package dropped on the composer to the current Project, without attaching it', async () => {
  const attach = mount()
  drop(screen.getByTestId('composer'), ['research.SCIENCE'])
  expect(importPackage).toHaveBeenCalledWith({ projectId: 'target' }, expect.any(File))
  expect(attach).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(importPackage).toHaveBeenCalledTimes(1))
})
it('stages ordinary file drops exactly once before nested targets', () => {
  const attach = mount()
  drop(screen.getByTestId('composer'), ['data.csv'])
  expect(attach).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name: 'data.csv' })])
  expect(importPackage).not.toHaveBeenCalled()
})

it('does not report storage exhaustion when a real directory is dropped on the composer', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'composer-directory-drop-'))
  const sourcePath = join(storageRoot, 'raw-data')
  await mkdir(sourcePath)
  await writeFile(join(storageRoot, 'existing.txt'), 'kept')
  const owner = new ActiveTransferOwner(storageRoot)
  const uploadApi = {
    stageLocalFile: (file: File, request: Parameters<typeof owner.beginTransfer>[0]) =>
      owner.stageLocalFile({ ...request, sourcePath: join(storageRoot, file.name) }),
    beginTransfer: owner.beginTransfer.bind(owner),
    appendTransfer: owner.appendTransfer.bind(owner),
    getTransferStatus: owner.getTransferStatus.bind(owner),
    finishTransfer: owner.finishTransfer.bind(owner),
    abortTransfer: owner.abortTransfer.bind(owner),
    deleteUpload: async () => {}
  }
  const Composer = (): React.JSX.Element => {
    const composer = useWorkspaceComposerController({
      currentDraftKey: 'directory-drop',
      newConversationDraftKey: 'new:project',
      activeProjectId: 'project',
      activeSession: { id: 'directory-drop', projectId: 'project' },
      pendingCustomizePrefill: undefined,
      onCustomizePrefillApplied: () => {},
      historyEntries: [],
      historyPolicy: {
        catalogSkillIds: new Set(),
        allowedSkillIds: undefined,
        skillCatalogReady: true,
        refreshSkillCatalog: false,
        specialistCatalogReady: true,
        specialistId: undefined,
        loadSkills: async () => {},
        loadSpecialists: async () => {}
      },
      canStageAttachments: true,
      supportsImageInput: true,
      uploads: uploadApi
    })
    return (
      <ProjectPackageDropZone canImport={false} canAttach onFiles={composer.actions.stageFiles}>
        <div data-testid="directory-composer" />
        <div data-testid="upload-error">{composer.view.error}</div>
        <div data-testid="upload-transfers">{JSON.stringify(composer.view.transfers)}</div>
        <div data-testid="uploaded-files">
          {composer.view.attachments.map((attachment) => attachment.originalName).join(',')}
        </div>
      </ProjectPackageDropZone>
    )
  }
  try {
    render(
      <WorkspaceComposerDraftsProvider>
        <Composer />
      </WorkspaceComposerDraftsProvider>
    )
    fireEvent.drop(screen.getByTestId('directory-composer'), {
      dataTransfer: { types: ['Files'], files: [new File(['kept'], 'existing.txt')] }
    })
    await vi.waitFor(() =>
      expect(screen.getByTestId('uploaded-files').textContent).toBe('existing.txt')
    )
    // Native directory drops expose a File plus a directory entry, rather than child files.
    const file = new File([], 'raw-data')
    fireEvent.drop(screen.getByTestId('directory-composer'), {
      dataTransfer: {
        types: ['Files'],
        files: [file],
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
            webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: file.name })
          }
        ]
      }
    })
    await vi.waitFor(() => {
      expect(screen.getByTestId('upload-transfers').textContent).not.toMatch(/queued|uploading/)
    })
    expect(screen.getByTestId('upload-error').textContent).not.toBe(
      'Could not attach the file. Check available storage and try again.'
    )
    expect(screen.getByRole('status').textContent).toBe(
      'Folders cannot be attached. Select files inside the folder instead. No files were added.'
    )
    expect(screen.getByTestId('upload-transfers').textContent).toBe('[]')
    expect(screen.getByTestId('uploaded-files').textContent).toBe('existing.txt')
  } finally {
    cleanup()
    await rm(storageRoot, { recursive: true, force: true })
  }
})

it.each([
  ['raw-data'],
  ['raw-data', 'data.csv'],
  ['data.csv', 'raw-data'],
  ['raw-data.science'],
  ['research.science', 'raw-data']
])('rejects the complete native batch containing a folder: %j', (...names) => {
  const attach = mount()
  const target = screen.getByTestId('composer')
  const files = names.map((name) => new File([], name))
  const dataTransfer = {
    types: ['Files'],
    files,
    items: files.map((file) => ({
      kind: 'file',
      webkitGetAsEntry: () => ({ isDirectory: file.name.startsWith('raw-data') })
    }))
  }
  fireEvent.dragEnter(target, { dataTransfer })
  expect(screen.getByText('Drop files to attach or import a .science package')).toBeTruthy()
  expect(fireEvent.drop(target, { dataTransfer })).toBe(false)
  expect(attach).not.toHaveBeenCalled()
  expect(importPackage).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('Folders cannot be attached.')
  expect(screen.queryByText('Drop files to attach or import a .science package')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('status')).toBeNull()
  drop(target, ['data.csv'])
  expect(attach).toHaveBeenCalledOnce()
})

it.each(['file', 'unavailable'])(
  'accepts empty extensionless files when the native entry is %s',
  (entryKind) => {
    const attach = mount()
    const file = new File([], 'README')
    fireEvent.drop(screen.getByTestId('composer'), {
      dataTransfer: {
        types: ['Files'],
        files: [file],
        items: [
          {
            kind: 'file',
            webkitGetAsEntry: () => (entryKind === 'file' ? { isDirectory: false } : null)
          }
        ]
      }
    })
    expect(attach).toHaveBeenCalledExactlyOnceWith([file])
    expect(screen.queryByRole('status')).toBeNull()
  }
)
it.each([
  ['first.science', 'second.science'],
  ['first.science', 'data.csv']
])('rejects the entire mixed or multiple package drop: %s, %s', (...names) => {
  const attach = mount()
  drop(screen.getByTestId('composer'), names)
  expect(importPackage).not.toHaveBeenCalled()
  expect(attach).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('Drop one .science file')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
  expect(screen.queryByRole('status')).toBeNull()
})
it('rejects package drops into an unavailable Project', () => {
  const attach = mount(false)
  drop(screen.getByTestId('composer'), ['study.science'])
  expect(attach).not.toHaveBeenCalled()
  expect(importPackage).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('unavailable')
})
it('opens existing progress instead of starting another operation', () => {
  usePackageOperationStore.setState({
    operation: {
      id: 'busy',
      kind: 'export',
      state: 'running',
      progress: { phase: 'copying' }
    }
  })
  mount()
  drop(screen.getByTestId('composer'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
  expect(usePackageOperationStore.getState().open).toBe(true)
})
it('ignores portal drops outside the Project DOM', () => {
  render(
    <ProjectPackageDropZone projectId="target" projectName="Research" canImport>
      {createPortal(<div data-testid="modal" />, document.body)}
    </ProjectPackageDropZone>
  )
  drop(screen.getByTestId('modal'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
})
it('does not advertise desktop import in Web', () => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  mount()
  fireEvent.dragEnter(screen.getByTestId('composer'), { dataTransfer: { types: ['Files'] } })
  expect(screen.getByText('Drop files to attach')).toBeTruthy()
  expect(screen.queryByText(/import a .science/)).toBeNull()
  drop(screen.getByTestId('composer'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
})
it('uses neutral hover feedback when protected drag data has no filenames', () => {
  mount()
  const target = screen.getByTestId('composer')
  fireEvent.dragEnter(target, { dataTransfer: { types: ['text/plain'] } })
  expect(screen.queryByRole('status')).toBeNull()
  fireEvent.dragEnter(target, { dataTransfer: { types: ['Files'] } })
  expect(screen.getByText('Drop files to attach or import a .science package')).toBeTruthy()
  drop(target, ['data.csv'])
  expect(screen.queryByRole('status')).toBeNull()
})

it('clears a nested attachment overlay when the Project captures its drop', async () => {
  const attach = vi.fn()
  const Composer = (): React.JSX.Element => {
    const { isDragging, dropZoneProps } = useFileDropZone({ enabled: true, onFiles: attach })
    return <div {...dropZoneProps} data-testid="nested-composer" data-dragging={isDragging} />
  }
  render(
    <ProjectPackageDropZone projectId="target" projectName="Research" canImport>
      <Composer />
    </ProjectPackageDropZone>
  )
  const composer = screen.getByTestId('nested-composer')
  fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } })
  expect(composer.getAttribute('data-dragging')).toBe('true')
  drop(composer, ['research.science'])
  expect(composer.getAttribute('data-dragging')).toBe('false')
  expect(attach).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(importPackage).toHaveBeenCalledOnce())
})

it.each(['data.csv', 'paper.pdf', 'image.png'])(
  'accepts %s on conversation blank space',
  (name) => {
    const attach = mount()
    drop(screen.getByTestId('workspace'), [name])
    expect(attach).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ name })])
    expect(importPackage).not.toHaveBeenCalled()
  }
)

it('rejects ordinary files when attachments are unavailable while retaining package import', () => {
  const attach = mount(true, false)
  drop(screen.getByTestId('workspace'), ['data.csv'])
  expect(attach).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('Files cannot be attached right now.')
  drop(screen.getByTestId('workspace'), ['research.science'])
  expect(importPackage).toHaveBeenCalledOnce()
  expect(screen.queryByRole('status')).toBeNull()
})

it('prevents native navigation on an unavailable drop without claiming an accepted action', () => {
  const attach = mount(false, false)
  const target = screen.getByTestId('workspace')
  const dataTransfer = { types: ['Files'], files: [new File([''], 'data.csv')], dropEffect: 'copy' }
  fireEvent.dragOver(target, { dataTransfer })
  expect(dataTransfer.dropEffect).toBe('none')
  expect(screen.queryByText('Drop files to attach')).toBeNull()
  expect(fireEvent.drop(target, { dataTransfer })).toBe(false)
  expect(attach).not.toHaveBeenCalled()
})

it.each(['blur', 'dragend', 'drop'])('clears the overlay on window %s', (type) => {
  mount()
  fireEvent.dragEnter(screen.getByTestId('workspace'), { dataTransfer: { types: ['Files'] } })
  expect(screen.getByText('Drop files to attach or import a .science package')).toBeTruthy()
  fireEvent(type === 'blur' ? window : document, new Event(type, { bubbles: true }))
  expect(screen.queryByText('Drop files to attach or import a .science package')).toBeNull()
})

it('keeps the overlay across children and clears when leaving the conversation', () => {
  mount()
  const dataTransfer = { types: ['Files'] }
  const workspace = screen.getByTestId('workspace')
  const composer = screen.getByTestId('composer')
  fireEvent.dragEnter(workspace, { dataTransfer })
  fireEvent.dragEnter(composer, { dataTransfer })
  fireEvent.dragLeave(composer, { dataTransfer })
  expect(screen.getByText('Drop files to attach or import a .science package')).toBeTruthy()
  fireEvent.dragLeave(workspace, { dataTransfer })
  expect(screen.queryByText('Drop files to attach or import a .science package')).toBeNull()
})

it('ignores ordinary file drags and drops in portal dialogs', () => {
  const attach = vi.fn()
  render(
    <ProjectPackageDropZone
      projectId="target"
      projectName="Research"
      canImport
      canAttach
      onFiles={attach}
    >
      {createPortal(<div data-testid="portal" />, document.body)}
    </ProjectPackageDropZone>
  )
  const portal = screen.getByTestId('portal')
  fireEvent.dragEnter(portal, { dataTransfer: { types: ['Files'] } })
  expect(screen.queryByText('Drop files to attach or import a .science package')).toBeNull()
  drop(portal, ['data.csv'])
  expect(attach).not.toHaveBeenCalled()
})

it.each(['blur', 'dragend', 'drop'])('clears the destination-free overlay on %s', (type) => {
  render(<ProjectPackageDropZone canImport data-testid="home" />)
  fireEvent.dragEnter(screen.getByTestId('home'), { dataTransfer: { types: ['Files'] } })
  expect(screen.getByText('Drop a .science file to import')).toBeTruthy()
  fireEvent(type === 'blur' ? window : document, new Event(type, { bubbles: true }))
  expect(screen.queryByText('Drop a .science file to import')).toBeNull()
})

it('does not enable destination-free desktop import on Web', () => {
  document.documentElement.setAttribute(WEB_EVENT_SURFACE_ATTRIBUTE, 'true')
  render(<ProjectPackageDropZone canImport data-testid="home" />)
  const home = screen.getByTestId('home')
  const dataTransfer = { types: ['Files'], dropEffect: 'copy' }
  fireEvent.dragEnter(home, { dataTransfer })
  fireEvent.dragOver(home, { dataTransfer })
  expect(dataTransfer.dropEffect).toBe('none')
  expect(screen.queryByText('Drop a .science file to import')).toBeNull()
  drop(home, ['research.science'])
  expect(importPackage).not.toHaveBeenCalled()
})

it('keeps an explicitly empty Project target unavailable', () => {
  render(<ProjectPackageDropZone projectId="" projectName="" canImport data-testid="invalid" />)
  drop(screen.getByTestId('invalid'), ['study.science'])
  expect(importPackage).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toContain('unavailable')
})
