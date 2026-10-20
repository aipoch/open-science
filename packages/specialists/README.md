# @aipoch/specialists

Independent Specialist profile validation, capability selection, portable archives and recoverable file transactions. Versioned with the application; publishing is not required.

## Public entry points

- `@aipoch/specialists`: browser-safe domain contracts, validation and capability rules.
- `@aipoch/specialists/node`: domain composition, filesystem persistence and archive operations.

Use `createSpecialistDomain({storageDir})` to compose one catalog and one archive transaction owner. Call `domain.createArchives({catalog, ...ports})` once, then use the catalog and archive facade. The archive option `catalog` is an async capability snapshot provider; `domain.catalog` is the Specialist profile facade. Do not compose concurrent writers for the same storage directory. Repository, service and transaction constructors are private. Extend catalog policy through the factory options; call archive operations through the composed facade. Transactions and on-disk journals are implementation concerns, not a host persistence API.

```ts
import { createSpecialistDomain } from '@aipoch/specialists/node'
const domain = createSpecialistDomain({ storageDir: '/path/chosen/by/caller' })
const profile = await domain.catalog.create({ name: 'Research Analyst' })
await domain.catalog.update({
  id: profile.id,
  revision: profile.revision,
  description: 'Review evidence.'
})
```

## Environment contracts

The package has no host or sibling-package source imports. It never discovers application resources, reads global settings, contacts a marketplace, opens a dialog or invokes a model. Supply builtins and live capability catalogs explicitly. Full-access capabilities resolve against the live catalog; selected IDs remain durable references.

For bundled Skills, provide `parseSkillDocument` and a `SpecialistPackageSkillPort`. The caller owns Skill syntax and files. Missing participants reject nonempty mutations. Configure `SkillEnablementPort` and `disableNewSkills` when new Skills should initially be disabled for another consumer. The journal records only settings introduced by that transaction. Ports must preserve mutation-lock context and implement idempotent transaction recovery.

`deleteSpecialist()` acquires the injected `operationCoordinator`. External installers must acquire that same coordinator around their workflow; `install()` does not acquire it automatically. Do not reacquire the same non-reentrant queue from inside its held operation. Required relationship cleanup rejects on failure and is retried during recovery. Catalog refresh callbacks are notifications, not durable cleanup. Candidate tokens are scoped to the supplied caller identity; the host authenticates that identity.

Domain-authored `SpecialistError` messages can be mapped by a host. Unknown IO errors must not be presented as trusted messages. Product-specific managed-content policies, reserved identities, filename branding and logger are injected. Historical origin values remain serialized for compatibility; no marketplace workflow is owned here.

## Safety and integration

- **Scope:** Specialist profiles, capability selection, portable archives, and file transactions.
- **Controls:** Profile/archive validation, caller-scoped candidates, and recoverable transactions
  preserve identity and mutation rules. Host-supplied capability catalogs determine available actions.
- **Remaining risks:** A profile's role or name does not establish expertise or trustworthy behavior.
  Imported prompts and bundled Skills can influence execution; archive validation does not certify
  their instructions. Profile selection is not a runtime sandbox or a substitute for authorization.
- **Safe integration:** Review imported content and capability changes, authenticate caller identity,
  and enforce delegation permissions and execution policy in the host. See the application's
  [extension precautions](https://github.com/aipoch/open-science/blob/main/docs/usage-scope.md#extensions-remote-access-and-automation).

## Persistence and compatibility

Retains specialists.json version 2 (reads versions 1/2), portable archive schema 1, and the existing transaction journal/sidecar layout. Recovery accepts legacy embedded before/after documents and absent newlyDisabledSkillIds. Damaged authoritative data is preserved. Keep all operations for a domain behind the same owner and recovery barrier.

Catalog writes reject when a journal exists until archives are configured to recover it. Without a Skill participant, recovery requires sufficient journal and sidecar evidence that no Skill recovery is needed. Missing or corrupt evidence rejects recovery and preserves the journal; supply the participant that owns the affected Skills before retrying. A fresh catalog with no pending journal can operate without archives.

## Verification

Install the durable publication prerequisite below, then run `npm run build`, `npm run typecheck`, `npm test`, and `npm run verify:package -- --durable-files-tarball=<absolute-path>` inside this package. Verification copies sources outside the checkout, installs declared dependencies, runs its suite, packs a tarball and exercises a clean runtime/TypeScript/browser consumer. Test fixtures and scripts are package-owned; tests use explicit external participant fakes. Real host/Skill/Settings/Marketplace integration tests belong to the host.

### Durable publication dependency

This package declares `@aipoch/durable-files` as a runtime dependency. For unpublished local builds,
install its real npm tarball alongside the declared dependencies (`npm install --no-save /path/to/aipoch-durable-files-0.1.0.tgz`),
then build/typecheck/test as usual. Run the repository dispatcher with
`npm run check:packages -- --packages=specialists` to prepare that prerequisite without rerunning its
unchanged unit suite. Standalone `verify:package` accepts `-- --durable-files-tarball=<absolute-path>`.
Verification removes the source copy and consumer devDependencies before its final runtime check.
