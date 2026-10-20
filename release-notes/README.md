# In-app release notes

Each stable release has one directory named after the version without the leading `v`:

```text
release-notes/
  0.19.0/
    en.md
    zh-Hans.md
    zh-Hant.md
    ja.md
    ko.md
    fr.md
    ru.md
    de.md
    es.md
```

The files contain the concise Markdown shown in the update dialog. `en.md` is also the authoritative
GitHub Release body and Zenodo description, so it must be present before a stable tag is published.

`en.md` is required because it is the fallback for missing translations and the compatibility source
for electron-updater feeds used by older clients. The eight translated files are optional; when one is
missing, current clients identify the fallback and show English.

`Mirror to website` reads `release-notes/<version>/` when it builds `version.json`. Its `dry_run` input
executes the same local manifest and feed transformations with sparse installer placeholders, while
skipping AWS credentials, historical blockmap backfill, and every S3 write.

For historical releases that predate this directory, the mirror workflow preserves the legacy path:
it reads and condenses the GitHub Release body into English notes. A historical release therefore does
not need a repository directory unless localized backfill is wanted.

## Scope, safety, and privacy disclosures

Review each release for changes to functional boundaries, security controls, and data handling.
When a change affects a user's deployment or approval decision, include a concise scope/safety
notice in that release's notes, alongside the relevant feature or fix:

- Name the affected feature, version, platform, execution path, and setup requirements.
- Describe new permissions, external recipients, data categories, persistent access, or changed
  defaults, including compatibility or reduced-protection modes.
- State important known limitations, their impact, and a practical mitigation or workaround. Link
  the relevant [limitation entry](../docs/known-limitations.md) and owning module documentation.
- Separate implemented controls and completed verification from experimental work, unmeasured
  behavior, and future plans. An integrity check or replay result is not a general safety claim.
- For a resolved limitation, record the fixed version and verification scope. For a security fix,
  coordinate publication with the [security policy](../SECURITY.md); do not expose an undisclosed
  vulnerability through release-note drafts.

Update the [security model](../docs/security.md), [intended-use guide](../docs/usage-scope.md), and
affected package README notices when their facts change. Keep critical warnings consistent in
provided translations. Use version/tag-pinned repository URLs for release-specific details so
historical notes do not silently acquire a later version's claims. Review the items above even when
no new notice is needed; do not add boilerplate sections asserting an absence of risk.

## Nightly release prerequisite

Nightly publishing reuses one long-lived GitHub prerelease and moves its `nightly` tag only after the
replacement assets upload successfully. The release and tag must both exist before enabling
`.github/workflows/nightly-publish.yml`; do not delete or recreate the release during routine
operation. Creating a GitHub Release while the Zenodo integration is enabled can archive another
nightly version permanently.

If only the tag is missing, restore it to the commit represented by the current nightly assets before
rerunning the workflow. If the release is missing, disable the Zenodo integration before recreating
the long-lived prerelease, verify that Zenodo did not archive it, and then re-enable the integration.
The workflow intentionally fails closed in either case instead of attempting an unsafe automatic
bootstrap.

## Recovering a stale nightly

A manual full **Nightly** run produces desktop and five-platform CLI artifacts but does not publish.
After it succeeds on `main`, validate and promote the same run explicitly:

```bash
gh workflow run nightly-publish.yml --ref main -f source_run_id=<run-id> -F dry_run=true
# Inspect the successful dry-run before publishing.
gh workflow run nightly-publish.yml --ref main -f source_run_id=<run-id> -F dry_run=false
```

The recovery path shares automatic publication's lock, checks and tag advancement. It rejects foreign
repositories, other workflows/branches, incomplete or unsuccessful runs, missing CLI artifacts,
failed advisory jobs, corrupt files and commits outside main history. Duplicate or older publications
are skipped. Both paths preserve the existing Release identity and move the tag after asset uploads.

Use a newly completed full run when metadata or CLI artifacts have expired (five-day retention).
Historical desktop-only runs cannot be promoted through the complete desktop/CLI publication path.
CLI archives use the same nightly version and commit as desktop packages; Linux CLI deb/rpm packages,
npm and Homebrew publication are not part of nightly. No application-data migration is involved.
