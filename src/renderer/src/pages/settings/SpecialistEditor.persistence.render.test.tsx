// @vitest-environment jsdom
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpecialistEditor } from './SpecialistEditor'
import { useSettingsStore } from '@/stores/settings-store'
import { useSpecialistStore } from '@/stores/specialist-store'
import { ConnectorService } from '../../../../main/connectors/service'
import { SpecialistRepository } from '../../../../main/specialist/repository'
import { SpecialistService } from '../../../../main/specialist/service'
import type { CreateSpecialistInput, UpdateSpecialistInput } from '../../../../shared/specialist'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let directory: string
let service: SpecialistService
let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'specialist-editor-regression-'))
  service = new SpecialistService(new SpecialistRepository(directory))
  useSpecialistStore.setState({ editorDrafts: {} })
  useSettingsStore.setState({
    skills: [
      {
        id: 'example',
        name: 'Example',
        displayName: 'Example',
        description: '',
        source: 'featured',
        enabled: true,
        updatedAt: ''
      }
    ],
    connectors: [],
    loadSkills: vi.fn().mockResolvedValue(undefined),
    loadConnectors: vi.fn().mockResolvedValue(undefined)
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  await rm(directory, { recursive: true, force: true })
})

const clickButton = async (label: string): Promise<void> => {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent === label
  )
  expect(button).toBeDefined()
  await act(async () => fireEvent.click(button!))
}

const readStored = async (): Promise<{ specialists: Array<Record<string, unknown>> }> =>
  JSON.parse(await readFile(join(directory, 'specialists.json'), 'utf8'))

describe('Specialist editor durable behavior regressions', () => {
  it.each([
    ['description', ''],
    ['systemPrompt', ''],
    ['both', ''],
    ['both', '   ']
  ])('S01 clears %s using %j and persists the cleared value', async (field, value) => {
    const profile = await service.create({
      name: 'Editor example',
      description: 'Old description',
      systemPrompt: 'Old system instruction'
    })
    const save = vi.fn(async (input: UpdateSpecialistInput) => {
      await service.update(input)
    })
    await act(async () =>
      root.render(
        <SpecialistEditor
          editSpecialist={profile}
          onCancel={vi.fn()}
          onSave={vi.fn()}
          onSaveEdit={save}
        />
      )
    )
    await act(async () => {
      if (field !== 'systemPrompt')
        fireEvent.change(container.querySelector('#sp-description')!, { target: { value } })
      if (field !== 'description')
        fireEvent.change(container.querySelector('#sp-system-prompt')!, { target: { value } })
    })
    await clickButton('Save changes')
    expect(save).toHaveBeenCalledOnce()
    await act(async () => {
      await save.mock.results[0].value
    })
    expect((await readStored()).specialists[0]).toMatchObject({
      revision: 2,
      description: field === 'systemPrompt' ? 'Old description' : '',
      systemPrompt: field === 'description' ? 'Old system instruction' : ''
    })
  })

  it('S01 control: omitted programmatic edits preserve existing text', async () => {
    const profile = await service.create({
      name: 'Omitted edit',
      description: 'Keep description',
      systemPrompt: 'Keep instruction'
    })
    await service.update({ id: profile.id, revision: profile.revision, displayName: 'New label' })
    expect((await readStored()).specialists[0]).toMatchObject({
      description: 'Keep description',
      systemPrompt: 'Keep instruction'
    })
  })

  it.each(['direct', 'mode toggle', 'detail round trip', 'prefilled detail round trip'])(
    'S02 preserves copied method restrictions after %s',
    async (journey) => {
      const connectorTools = [
        {
          connectorId: 'demo',
          includedMethods: ['read'],
          excludedMethods: ['danger'],
          includeToolsPattern: 'read_*',
          excludeToolsPattern: 'delete_*'
        }
      ]
      const source = await service.create({
        name: 'Restricted example',
        capabilityMode: 'selected',
        fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools },
        selectedCapabilities: { skillIds: ['example'], connectorIds: ['demo'], connectorTools }
      })
      const initialInput = await service.duplicate(source.id)
      const save = vi.fn(async (input: CreateSpecialistInput) => {
        await service.create(input)
      })
      const render = async (input?: CreateSpecialistInput): Promise<void> => {
        await act(async () =>
          root.render(
            <SpecialistEditor
              initialInput={input}
              onCancel={vi.fn()}
              onSave={save}
              onOpenSkillDetail={() => root.render(<div>Skill details</div>)}
            />
          )
        )
      }
      await render(initialInput)
      if (journey === 'mode toggle') {
        await act(async () =>
          fireEvent.click(container.querySelector('[aria-label="Full access"]')!)
        )
        await act(async () =>
          fireEvent.click(container.querySelector('[aria-label="Full access"]')!)
        )
      }
      if (journey.includes('detail round trip')) {
        await act(async () =>
          fireEvent.change(container.querySelector('#sp-description')!, {
            target: { value: 'Unsaved copied description' }
          })
        )
        await act(async () =>
          fireEvent.click(container.querySelector('[aria-label="View Example details"]')!)
        )
        expect(container.textContent).toBe('Skill details')
        await render(journey.startsWith('prefilled') ? initialInput : undefined)
        expect
          .soft(container.querySelector<HTMLInputElement>('#sp-description')!.value)
          .toBe('Unsaved copied description')
      }
      await clickButton('Create specialist')
      expect(save).toHaveBeenCalledOnce()
      await act(async () => {
        await save.mock.results[0].value
      })
      const document = await readStored()
      expect(document.specialists).toHaveLength(2)
      const dispatch = vi.fn().mockResolvedValue({ ok: true })
      const gate = new ConnectorService({
        mcpClientManager: {
          call: dispatch,
          listTools: vi.fn().mockResolvedValue([{ name: 'read' }, { name: 'danger' }])
        },
        getConnectors: () => ({
          enabledIds: [],
          autoAllowIds: [],
          customMcpServers: [
            {
              id: 'demo',
              name: 'demo',
              displayName: 'Demo',
              transport: 'stdio',
              command: 'unused-test-command',
              enabled: true
            }
          ]
        }),
        resolveApiKey: () => undefined,
        resolveSpecialistProfile: (id) => service.resolveRunnableById(id)
      })
      const call = (id: string, method: string): Promise<unknown> =>
        gate.call(
          'demo',
          method,
          {},
          { origin: 'agent', sessionId: 'copy-session', specialistId: id }
        )
      await expect(call(source.id, 'read')).resolves.toEqual({ ok: true })
      await expect(call(source.id, 'danger')).rejects.toThrow('specialist_capability_denied')
      dispatch.mockClear()
      await expect
        .soft(call(String(document.specialists[1].id), 'danger'))
        .rejects.toThrow('specialist_capability_denied')
      expect.soft(dispatch).not.toHaveBeenCalled()
      expect(document.specialists[1]).toMatchObject({
        fullAccess: source.fullAccess,
        selectedCapabilities: source.selectedCapabilities
      })
    }
  )
})
