import { describe, expect, it } from 'vitest'

import { capabilityFromLegacyCategory, categoryFromTrustedToolName } from './capability'

describe('capabilityFromLegacyCategory', () => {
  it.each(['WebFetch', 'web_fetch', 'WebSearch', 'provider_specific_tool'])(
    'keeps the unregistered provider-native tool %s Once-only',
    (providerName) => {
      expect(capabilityFromLegacyCategory(`tool:${providerName}`)).toBeUndefined()
    }
  )

  it.each([
    'curl -H "Authorization: Bearer abc" https://example.com',
    'TOKEN=abc python upload.py',
    'curl https://user:password@example.com/data',
    'curl https://example.com/data?api_key=abc',
    'deploy --password hunter2',
    'GITHUB_PAT=ghp_example python upload.py',
    'AWS_ACCESS_KEY_ID=AKIAEXAMPLE python upload.py',
    'curl -u user:password https://example.com',
    'curl -H "X-Auth-Token: secret" https://example.com',
    'curl --oauth2-bearer eyJhbGciOiJIUzI1NiJ9.payload.signature https://example.com',
    'sshpass -p secret ssh user@example.com',
    'curl -H "X-Custom-Auth: opaque" https://example.com'
  ])('keeps a secret-bearing exact command Once-only', (command) => {
    expect(capabilityFromLegacyCategory(`shell:${command}`)).toBeUndefined()
  })

  it('persists a content-independent exact command as a redacted digest', () => {
    expect(capabilityFromLegacyCategory('shell:git status')).toMatchObject({
      kind: 'execution',
      key: 'exec:agent/shell',
      qualifier: { mode: 'exact', value: expect.stringMatching(/^sha256:v1:/) }
    })
  })

  it.each([
    'git push',
    './git status',
    '/tmp/git status',
    'git.exe status',
    'Git status',
    'python analyze.py',
    'python /tmp/analyze.py',
    'bash analyze.sh',
    'bash ./analyze.sh',
    'node script.js',
    'Rscript analysis.R',
    'pytest tests/test_model.py',
    'bash -c analyze.sh',
    'python -c print(1)',
    'python analyze.py --token value'
  ])('keeps an unproven exact command Once-only: %s', (command) => {
    expect(capabilityFromLegacyCategory(`shell:${command}`)).toBeUndefined()
  })

  it('keeps an unregistered app-owned MCP method Once-only', () => {
    expect(
      capabilityFromLegacyCategory('mcp:open-science-notebook/reviewer_internal')
    ).toBeUndefined()
  })

  it.each([
    ['CreateAgent', 'customize:agent_create'],
    ['agent_update', 'customize:agent_update'],
    ['Publish skill', 'customize:skill_publish'],
    ['skill_edit', 'customize:skill_edit'],
    ['AttachSkill', 'customize:agent_attach_skill'],
    ['agent_detach_skill', 'customize:agent_detach_skill'],
    ['Attach connector', 'customize:agent_attach_connector'],
    ['agent_detach_connector', 'customize:agent_detach_connector'],
    ['local_exec_python', 'local_exec:python'],
    ['local-bash', 'local_exec:bash']
  ])('normalizes the registered tool name %s', (providerName, category) => {
    expect(categoryFromTrustedToolName(providerName)).toBe(category)
    expect(capabilityFromLegacyCategory(category)).toBeDefined()
  })
})
