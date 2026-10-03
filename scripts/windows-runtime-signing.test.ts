import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { load } from 'js-yaml'

type Workflow = {
  on: {
    workflow_dispatch: {
      inputs: Record<string, { required?: boolean; type?: string }>
    }
  }
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      environment?: string
      permissions?: Record<string, string>
      steps: Array<{ name: string; uses?: string; run?: string; with?: Record<string, unknown> }>
    }
  >
}

const readWorkflow = async (): Promise<Workflow> =>
  load(await readFile('.github/workflows/windows-runtime-sign.yml', 'utf8')) as Workflow

const findStep = (
  steps: Workflow['jobs']['sign']['steps'],
  name: string
): Workflow['jobs']['sign']['steps'][number] => {
  const step = steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}

it('signs a verified runtime artifact without granting CDN publication access', async () => {
  const workflow = await readWorkflow()
  const sign = workflow.jobs.sign
  const steps = sign.steps
  expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
    source_run: { required: true, type: 'string' },
    artifact_id: { required: true, type: 'string' }
  })
  expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read', 'id-token': 'write' })
  expect(sign).toMatchObject({
    environment: 'windows-signing',
    permissions: { actions: 'read', contents: 'read', 'id-token': 'write' }
  })
  expect(findStep(steps, 'Verify source run and artifact').run).toContain(
    "name -ne 'Prepare Windows Notebook runtime'"
  )
  expect(findStep(steps, 'Download unsigned runtime').with).toMatchObject({
    'artifact-ids': '${{ inputs.artifact_id }}',
    'run-id': '${{ inputs.source_run }}'
  })
  expect(findStep(steps, 'Azure login').uses).toBe(
    'azure/login@a641126d1b8aa4d1fa005f4f92df94a3a4c4c906'
  )
  expect(findStep(steps, 'Sign in to Azure Artifact Signing').run).toContain(
    'AZURE_SIGNING_PUBLISHER'
  )
  expect(findStep(steps, 'Sign runtime PE files')).toMatchObject({
    uses: 'azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82',
    with: expect.objectContaining({
      'files-folder': '${{ github.workspace }}\\runtime-to-sign',
      'files-folder-filter': 'exe,dll,node',
      'files-folder-recurse': true,
      'timestamp-rfc3161': 'http://timestamp.acs.microsoft.com'
    })
  })
  expect(findStep(steps, 'Upload signed runtime artifact').with).toMatchObject({
    'retention-days': 7,
    'if-no-files-found': 'error'
  })
  const text = JSON.stringify(workflow)
  expect(text).not.toContain('S3_')
  expect(steps.map((step) => step.name)).not.toContain('Publish immutable CDN components')
  expect(text).not.toContain('contents: write')
})
