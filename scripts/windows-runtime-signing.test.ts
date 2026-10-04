import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { load } from 'js-yaml'

type Workflow = {
  on: {
    workflow_call: {
      inputs: Record<string, { default?: string; required?: boolean; type?: string }>
      outputs: Record<string, { value: string }>
    }
    workflow_dispatch: {
      inputs: Record<
        string,
        { default?: string; options?: string[]; required?: boolean; type?: string }
      >
    }
  }
  permissions: Record<string, string>
  jobs: Record<
    string,
    {
      environment?: string
      permissions?: Record<string, string>
      outputs?: Record<string, string>
      steps: Array<{
        id?: string
        name: string
        uses?: string
        run?: string
        with?: Record<string, unknown>
      }>
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
  expect(workflow.on.workflow_call).toMatchObject({
    inputs: {
      source_run: { required: true, type: 'string' },
      artifact_id: { required: true, type: 'string' }
    },
    outputs: { artifact_id: { value: '${{ jobs.sign.outputs.artifact_id }}' } }
  })
  expect(workflow.permissions).toEqual({ actions: 'read', contents: 'read', 'id-token': 'write' })
  expect(sign).toMatchObject({
    environment: 'windows-runtime-signing',
    permissions: { actions: 'read', contents: 'read', 'id-token': 'write' }
  })
  expect(sign.outputs).toEqual({ artifact_id: '${{ steps.upload.outputs.artifact-id }}' })
  expect(workflow.on.workflow_dispatch.inputs).not.toHaveProperty('source_kind')
  expect(workflow.on.workflow_call.inputs).not.toHaveProperty('source_kind')
  expect(findStep(steps, 'Verify source run and artifact').run).toContain(
    "$env:GITHUB_REF -ne 'refs/heads/main'"
  )
  expect(findStep(steps, 'Verify source run and artifact').run).toContain(
    "$run.event -notin @('push', 'workflow_dispatch')"
  )
  expect(findStep(steps, 'Verify source run and artifact').run).toContain(
    "$run.path -ne '.github/workflows/windows-notebook-runtime.yml'"
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
  expect(findStep(steps, 'Validate runtime layout and PE inventory').run).toContain(
    'WriteAllLines($catalogPath, $catalogEntries'
  )
  expect(findStep(steps, 'Sign runtime PE files')).toMatchObject({
    uses: 'azure/artifact-signing-action@c7ab2a863ab5f9a846ddb8265964877ef296ee82',
    with: expect.objectContaining({
      'files-catalog': '${{ github.workspace }}\\runtime-signing-files.txt',
      'timestamp-rfc3161': 'http://timestamp.acs.microsoft.com'
    })
  })
  expect(findStep(steps, 'Sign runtime PE files').with).not.toHaveProperty('files-folder')
  expect(findStep(steps, 'Sign runtime PE files').with).not.toHaveProperty('files-folder-recurse')
  expect(findStep(steps, 'Sign runtime PE files').with).not.toHaveProperty('files-folder-filter')
  expect(findStep(steps, 'Upload signed runtime artifact').with).toMatchObject({
    'retention-days': 7,
    'if-no-files-found': 'error'
  })
  expect(findStep(steps, 'Upload signed runtime artifact').id).toBe('upload')
  const text = JSON.stringify(workflow)
  expect(text).not.toContain('S3_')
  expect(steps.map((step) => step.name)).not.toContain('Publish immutable CDN components')
  expect(text).not.toContain('contents: write')
})
