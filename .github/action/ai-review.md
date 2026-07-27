<!-- Supplemental workflow maintainer notes; not part of the public documentation site. -->

# AI review authentication

The `AI PR Review (Single)` workflow supports API-key and Codex subscription authentication.
Subscription auth is the default for every allowed automatic or manually dispatched pull request
review. Invalid or missing subscription credentials fall back to API-key auth. API-key auth also
remains available as an explicit override. The workflow replaces the disabled dual-review workflow
with one combined Codex review per run.

## API-key mode

Set the shared secrets:

- `OPENAI_API_KEY`
- `CODEX_BASE_URL` (the API root or full `/v1/responses` endpoint)

The combined reviewer can use review-specific credentials instead:

- `CODEX_REVIEW_API_KEY`
- `CODEX_REVIEW_BASE_URL`

For compatibility, correctness-specific and then architecture-specific credentials remain ordered
fallbacks between the review-specific and shared secrets. A scope is selected only when both its API
key and base URL are configured; keys and endpoints from different scopes are never combined.

Set the `CODEX_REVIEW_AUTH_MODE` repository variable to `api-key` to override the subscription
default. Keep API-key secrets configured for automatic fallback. Model, effort, fork, enablement,
and round-limit variables continue to apply. `CODEX_REVIEW_MODEL` and `CODEX_REVIEW_EFFORT` take
precedence; the legacy correctness variables and then architecture variables remain ordered
fallbacks. When a legacy credential scope is selected, its model and effort variables are used as a
bundle; review-specific, shared, or subscription-only configurations keep the legacy
correctness-then-architecture fallback order.

`ENABLE_CODEX_REVIEW=false` disables automatic and manually dispatched reviews. For compatibility,
legacy `CODEX_REVIEW_MODE=disabled` disables only automatic pull request events; a manual dispatch
still starts the single combined reviewer.

## Codex subscription mode

> [!WARNING]
> OpenAI recommends API keys for CI/CD and says not to use ChatGPT-managed `auth.json` automation
> for public or open-source repositories. This workflow uses a dedicated account for automatic and
> manually dispatched pull request reviews, including fork reviews allowed by `FORK_REVIEW_MODE`.
> The sandbox boundary below protects the credential from model-generated commands, but enabling
> this mode still makes the dedicated subscription available to the trusted parent process of each
> allowed review job.

Use a dedicated Codex account because `auth.json` contains access and refresh tokens. Subscription
jobs copy it into a temporary `CODEX_HOME`, remove passwordless sudo, and use a strict read-only
permission profile that denies model-generated commands access to the entire authentication
directory. The checkout is marked untrusted so PR-provided Codex configuration is ignored, and
repository instruction loading is disabled. Before review, positive and negative `codex sandbox`
probes verify that the packaged Linux sandbox can read the checkout but cannot read the credential;
the job fails closed if the sandbox or sudo boundary is ineffective. A runner-global `bwrap`
executable is not required. Every subscription review remains a trust decision because OpenAI does
not recommend ChatGPT-managed auth for public or open-source CI; automatic reviews make that
decision for every allowed pull request update.

The subscription path installs the pinned Codex CLI directly and does not pass subscription
credentials through `openai/codex-action`. API-key mode continues using the pinned action for its
Responses API proxy and key-isolation behavior.

Before checking out pull request code, the subscription path installs the pinned CLI, prepares the
packaged Linux sandbox prerequisites, verifies positive and negative filesystem probes, and sends a
fixed, low-effort, no-tool Codex request from an empty temporary directory. The same
credential-directory deny rule applies to these preflight checks. The CLI runs as the unprivileged
`nobody` user with a clean environment, so it has neither passwordless sudo nor the fallback API key
or base URL. If CLI setup, sandbox setup or probes, preflight isolation, or account authentication or
refresh fails, the workflow removes the temporary subscription credential and selects the API-key
runtime. This adds one small Codex request to each subscription review but avoids rerunning a full
review after an authentication failure.

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

Store the complete file as a repository secret. Subscription is the workflow default; set the
repository variable explicitly if you want the configuration recorded in GitHub:

```bash
AUTH_FILE="${CODEX_HOME:-$HOME/.codex}/auth.json"
gh secret set CODEX_AUTH_JSON < "$AUTH_FILE"
gh variable set CODEX_REVIEW_AUTH_MODE --body subscription
```

`OPENAI_API_KEY` and `CODEX_BASE_URL` remain available as the fallback when `CODEX_AUTH_JSON` is
missing or is not a valid managed ChatGPT credential. Model and effort variables still apply, so
select a model available to the dedicated Codex account.

### 3. Run a review

Every review allowed by `FORK_REVIEW_MODE` prefers subscription auth, whether it starts from an
automatic pull request event or a manual dispatch. To run one manually, open
**Actions → AI PR Review (Single) → Run workflow**, enter the pull request number, and run the
workflow. The single reviewer checks correctness, security, regressions, repository standards,
architecture, and integration in one Codex turn. If the subscription credential is unavailable,
the same job selects the configured API-key runtime before checkout and review execution.

### Credential refresh limitation

GitHub-hosted runners are ephemeral. Codex may refresh `auth.json` during a job, but the updated file
is discarded with that runner and is not written back to the GitHub secret. If authentication starts
returning `401` or can no longer refresh, the preflight selects API-key auth for that run. Run
`codex login` again on the trusted machine and repeat the `gh secret set CODEX_AUTH_JSON` command to
restore subscription usage. The reviewer gets one temporary credential copy per run. Newer runs
cancel an older run for the same pull request to avoid duplicate feedback and review-round
consumption.

Each workflow run starts at most one Codex review job. There is no repository-wide concurrency lock;
different pull requests can still be reviewed concurrently. Account or organization runner limits
may still queue jobs.

Never commit, log, upload as an artifact, or cache `auth.json`. For fully automatic refresh, use the
official trusted private-runner or external secret-manager pattern instead.

## References

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Maintain Codex account auth in CI/CD (advanced)](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
- [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)
