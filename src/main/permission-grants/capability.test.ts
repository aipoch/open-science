import { describe, expect, it } from 'vitest'

import {
  capabilityFromLegacyCategory,
  categoryFromTrustedToolName,
  commandPrefixPermissionCategory,
  containsSecretBearingMaterial
} from './capability'

describe('containsSecretBearingMaterial', () => {
  it.each([
    'curl --auth-token secret https://example.com',
    'curl --bearer secret https://example.com',
    'curl --oauth2-bearer secret https://example.com',
    'curl --cookie session=secret https://example.com',
    'curl --proxy-user user:secret https://example.com',
    'curl -uuser:secret https://example.com',
    "curl -u'user:secret' https://example.com",
    'curl -u="user:secret" https://example.com',
    'curl -b session=secret https://example.com',
    'curl -bsession=secret https://example.com',
    'curl -b=session=secret https://example.com',
    'CURL -b session=secret https://example.com',
    'CuRl.ExE -bsession=secret https://example.com',
    'npm config set //registry.npmjs.org/:_authToken=secret',
    'npm config set //registry.npmjs.org/:_AUTH_TOKEN=secret',
    'npm config set //registry.npmjs.org/:_auth=secret',
    'npm config set //registry.npmjs.org/:_password=secret',
    'deploy githubToken=secret',
    'deploy clientSecret=secret',
    'deploy secretAccessKey=secret',
    'deploy gpgPassphrase=secret',
    'PASSPHRASE=secret gpg --decrypt payload.gpg',
    'aws configure set aws_secret_access_key secret',
    'aws configure set aws_access_key_id key-id',
    'aws configure set profile.work.aws_session_token token',
    'aws configure set aws_security_token token',
    'gcloud auth activate-service-account --key-file credentials.json',
    'tool -KeyPath:credentials.pem',
    'docker login -p secret',
    'docker login -psecret',
    'docker login -p=secret',
    'Docker login -psecret',
    'sshpass -p secret ssh user@example.com',
    'sshpass -psecret ssh user@example.com',
    'SSHPASS -psecret ssh user@example.com',
    'redis-cli -a secret ping',
    'redis-cli -asecret ping',
    'REDIS-CLI -asecret ping',
    'mysql -psecret app',
    'mysqldump -psecret app',
    'MYSQL -psecret app',
    'MYSQLDUMP -psecret app',
    'oauth login --client-secret secret',
    'oauth login --clientSecret secret',
    'oauth login --authorization "Bearer secret"',
    'oauth login --bearer-token secret',
    'deploy --github-token secret',
    'deploy --gitlab-access-token secret',
    'deploy --client_secret=secret',
    'deploy --x-api-key secret',
    'deploy --apiKey secret',
    'deploy --aws-secret-access-key secret',
    'deploy --credentials credentials.json',
    'deploy --credentials-file credentials.json',
    'deploy --token-path .token',
    'deploy --pat secret',
    'redis-cli --pass secret',
    'gpg --passphrase secret --decrypt payload.gpg',
    'gpg --passphrase=secret --decrypt payload.gpg',
    'gpg --passphrase-file credentials.txt --decrypt payload.gpg',
    'gpg --passphrase-file=credentials.txt --decrypt payload.gpg',
    'gpg --passphrase-path credentials.txt --decrypt payload.gpg',
    'gpg -Passphrase:secret --decrypt payload.gpg',
    'Invoke-RestMethod -Credential secret',
    'Invoke-RestMethod -Credential:secret',
    'Invoke-RestMethod -AuthToken secret',
    'Invoke-RestMethod -ApiKey secret',
    'Invoke-RestMethod -ClientSecret:secret',
    'Invoke-RestMethod -BearerToken secret'
  ])('detects a credential-bearing CLI option: %s', (command) => {
    expect(containsSecretBearingMaterial(command)).toBe(true)
  })

  it.each([
    'curl --cookie-jar cookies.txt https://example.com',
    'curl -B https://example.com',
    'CURL -B https://example.com',
    'docker login --password-stdin',
    'docker build -p 8080:80 .',
    'DOCKER build -P 8080:80 .',
    'sshpass -P Password: ssh user@example.com',
    'SSHPASS -P Password: ssh user@example.com',
    'redis-cli -n 1 ping',
    'REDIS-CLI -n 1 ping',
    'mysql -P 3306 app',
    'MYSQL -P 3306 app',
    'npm config set cache=/tmp/npm',
    'aws configure set region us-east-1',
    'aws configure set output json',
    'tool --key lookup-value',
    'tool --keyframe 10',
    'tool _authTokenProvider=local',
    'tool clientSecretPolicy=strict',
    'tool passwordPolicy=strict',
    'tool passphrasePolicy=strict',
    'tool --tokenize input.txt',
    'tool --secretary Alice',
    'tool --bearer-format jwt',
    'tool --passphrase-policy strict',
    'tool --passphrase-format utf8',
    'tool --passphrases input.txt',
    'tool -Unit:test',
    'tool -CredentialProvider local',
    'tool -PasswordPolicy strict',
    'tool -CookieJar cookies.txt'
  ])('keeps a non-credential option eligible: %s', (command) => {
    expect(containsSecretBearingMaterial(command)).toBe(false)
  })
})

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
    ['python', 'analyze.py'],
    ['git', 'worktree', 'add'],
    ['powershell', '-Command', 'Get-ChildItem']
  ])('persists the proposed command group without storing its tokens: %j', (...tokens) => {
    const category = commandPrefixPermissionCategory(tokens)

    expect(category).toMatch(/^shell-group:argv-prefix:sha256:v1:[a-f0-9]{64}$/)
    expect(tokens.every((token) => !category?.includes(token))).toBe(true)
    expect(capabilityFromLegacyCategory(category!)).toMatchObject({
      kind: 'execution',
      key: 'exec:agent/shell',
      qualifier: {
        mode: 'category',
        value: expect.stringMatching(/^argv-prefix:sha256:v1:[a-f0-9]{64}$/)
      }
    })
  })

  it.each([
    [],
    'python',
    ['python', ''],
    ['python', 'upload.py', '--token', 'secret'],
    ['curl', '-uuser:secret'],
    ['curl', '-bsession=secret'],
    ['CURL.EXE', '-bsession=secret'],
    ['docker', 'login', '-psecret'],
    ['Docker', 'login', '-psecret'],
    ['sshpass', '-psecret', 'ssh', 'user@example.com'],
    ['redis-cli', '-asecret', 'ping'],
    ['mysql', '-psecret', 'app'],
    ['npm', 'config', 'set', '//registry.npmjs.org/:_authToken=secret'],
    ['aws', 'configure', 'set', 'aws_secret_access_key', 'secret'],
    ['gcloud', 'auth', 'activate-service-account', '--key-file', 'credentials.json'],
    ['gpg', '--passphrase', 'secret'],
    ['gpg', '--passphrase-file=credentials.txt'],
    ['Invoke-RestMethod', '-Credential', 'secret'],
    ['TOKEN=secret', 'python', 'upload.py'],
    ['python\nupload.py']
  ])('rejects an invalid or secret-bearing proposed command group: %j', (tokens) => {
    expect(commandPrefixPermissionCategory(tokens)).toBeUndefined()
  })

  it('keeps a malformed command group category Once-only', () => {
    expect(capabilityFromLegacyCategory('shell-group:argv-prefix:python')).toBeUndefined()
  })

  it.each([
    'git push',
    './git status',
    '/tmp/git status',
    'git\u00a0status',
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

  it.each(['generate_plan', 'update_step_status'])(
    'admits the registered Session Plan method %s to remembered permission scopes',
    (method) => {
      expect(capabilityFromLegacyCategory(`mcp:open-science-plan/${method}`)).toMatchObject({
        kind: 'mcp_tool',
        key: `mcp:open-science-plan/${method}`
      })
    }
  )

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
