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
