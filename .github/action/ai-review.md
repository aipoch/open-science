<!-- Supplemental workflow maintainer notes; not part of the public documentation site. -->

# AI review authentication

The `AI PR Review` workflow supports API-key and Codex subscription authentication. API-key auth
remains the default and is the only mode used for automatic or fork pull request reviews.

## API-key mode

Set the shared fallback secrets:

- `OPENAI_API_KEY`
- `CODEX_BASE_URL` (the API root or full `/v1/responses` endpoint)

The correctness and architecture reviewers can use independent credentials:

- `CODEX_CORRECTNESS_API_KEY` and `CODEX_CORRECTNESS_BASE_URL`
- `CODEX_ARCHITECTURE_API_KEY` and `CODEX_ARCHITECTURE_BASE_URL`

Set the `CODEX_REVIEW_AUTH_MODE` repository variable to `api-key`, or leave it unset. Existing
model, effort, reviewer-selection, fork, and round-limit variables continue to apply.

## Codex subscription mode

> [!WARNING]
> OpenAI recommends API keys for CI/CD and says not to use ChatGPT-managed `auth.json` automation
> for public or open-source repositories. This workflow offers a narrower opt-in for a dedicated
> account: subscription credentials are accepted only for a manually dispatched review of a
> same-repository pull request. They are never exposed to automatic or fork review jobs, which
> continue using the configured API-key credentials.

Use a dedicated Codex account because `auth.json` contains access and refresh tokens. A malicious
same-repository change could still attempt prompt injection during review; the manual dispatch is a
trust decision, not a credential-isolation boundary.

### 1. Create file-backed credentials

On a trusted machine, configure the Codex CLI to store credentials in a file:

```toml
cli_auth_credentials_store = "file"
```

Sign in with the dedicated account:

```bash
codex login
codex login status
```

Verify the generated file without printing its tokens:

```bash
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
jq '{
  auth_mode,
  has_refresh_token: ((.tokens.refresh_token // "") != ""),
  last_refresh
}' "$AUTH_FILE"
```

Continue only when `auth_mode` is `chatgpt` and `has_refresh_token` is `true`.

### 2. Configure GitHub

Store the complete file as a repository secret, then select subscription auth:

```bash
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
gh secret set CODEX_AUTH_JSON < "$AUTH_FILE"
gh variable set CODEX_REVIEW_AUTH_MODE --body subscription
```

`OPENAI_API_KEY` and `CODEX_BASE_URL` are ignored in subscription mode. Model and effort variables
still apply, so select a model available to the dedicated Codex account.

### 3. Run a review

Open **Actions → AI PR Review → Run workflow**, enter the same-repository pull request number, and
choose `correctness`, `architecture`, or `both`. Automatic `pull_request_target` events and fork
pull requests fall back to API-key auth and continue following `FORK_REVIEW_MODE`; keep the API-key
secrets configured if those review paths should remain active.

### Credential refresh limitation

GitHub-hosted runners are ephemeral. Codex may refresh `auth.json` during a job, but the updated file
is discarded with that runner and is not written back to the GitHub secret. If authentication starts
returning `401` or can no longer refresh, run `codex login` again on the trusted machine and repeat
the `gh secret set CODEX_AUTH_JSON` command. Each reviewer gets an independent temporary credential
copy, so correctness and architecture reviews can run in parallel without a repository-wide lock.

Never commit, log, upload as an artifact, or cache `auth.json`. For fully automatic refresh, use the
official trusted private-runner or external secret-manager pattern instead.

## References

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Maintain Codex account auth in CI/CD (advanced)](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
- [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)
