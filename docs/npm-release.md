# npm Package Release

The `@aipoch/open-science` SDK and CLI use a version and release tag namespace independent of the
desktop application. Desktop releases use `v*`; npm releases use `npm-v*`.

## One-time setup

1. Ensure the `aipoch` scope exists on npm and the publishing account can create
   `@aipoch/open-science` as a public package.
2. Create a GitHub Environment named `npm`. Add required reviewers to keep publishing behind an
   explicit approval.
3. Because Trusted Publisher cannot be configured until the package exists, add a short-lived npm
   publish token as the `NPM_TOKEN` secret in that environment for the first release only.
4. After the first release, configure the package's npm Trusted Publisher with:
   - organization or user: `aipoch`
   - repository: `open-science`
   - workflow: `publish-npm.yml`
   - environment: `npm`
5. Delete `NPM_TOKEN` from the GitHub Environment. Future releases authenticate with GitHub OIDC;
   no long-lived npm credential is required.

The publish job requests `id-token: write` and uses `npm publish --provenance`, so npm records signed
provenance for the released tarball.

## Release process

1. Update `packages/open-science/package.json` to the intended semantic version in a pull request.
2. Merge the pull request after the CLI/SDK tests and package-content checks pass.
3. Run **Publish npm package** manually on the target commit. Manual runs build, dry-run publish, and
   upload the tarball without changing npm.
4. Create and push a tag that exactly matches `npm-v<package-version>`:

   ```bash
   git tag -a npm-v0.1.0 -m "@aipoch/open-science 0.1.0"
   git push origin npm-v0.1.0
   ```

5. Approve the protected `npm` environment. The workflow publishes the same tarball produced by the
   verify job.

`scripts/validate-npm-release.mjs` rejects mismatched tags before the publish job can start. npm also
rejects attempts to overwrite an existing version, so every release requires a version increment.
