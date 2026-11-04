# Sandbox network grant synchronization

## Scope

Extend the existing in-session Notebook network approval flow so global destination grants are
represented by trusted backend managed private-service rules, while project grants remain only in
`destinationGrants`. Preserve exact hostname, port, and approved-address checks, explicit retry,
single-use approval, full-access exemption, and the existing conversation permission card.

## Data model

`TrustedPrivateDestination` gains optional backend metadata: `managedGrantId` and a fixed source
value identifying a global destination grant. Manual private-service rules remain metadata-free.
Global destination grants retain their project/session/record provenance and approved address set.
Revoked global grants remain as tombstones.

## Trusted backend lifecycle

`NotebookNetworkSettingsOwner` is the only writer that derives or removes managed rules. A global
approval persists the destination grant and, when the target satisfies the existing trusted-private
service validator, its derived rule together, with identical hostname, port, and approved
addresses. Public global approvals remain destination grants because Trusted private services only
accept private service targets. A project approval persists only the grant. Reconciliation on load
repairs a missing derived rule from an active eligible global grant and removes rules whose grant
has a revocation tombstone, so restart cannot restore revoked access.

Revoking a global grant removes only the rule carrying that grant's `managedGrantId`. Removing a
managed rule revokes the same global grant. Manual rules for the same target are never removed.
Untrusted managed metadata, mismatched address sets, stale DNS, and forged grant identities are
rejected. Existing DNS revalidation remains required before approval and the applied sandbox
policy uses the checked address set.

## UI and boundaries

Settings shows managed source metadata and explains that a global grant covers Notebook and Shell
execution in all projects. Agent and sandbox paths receive no private-service mutation capability;
the trusted settings backend owns the synchronization and cascade.

## Validation

Add owner/repository tests for project-only grants, global synchronization, restart repair,
bidirectional revocation, manual same-target preservation, address changes, forged metadata,
duplicates, denial, single-use and cancellation races. Update renderer tests and all eight locale
catalogs. Run focused Vitest suites, the i18n guard, Node/Web type checks, and the macOS Electron
approval/retry/restart/revocation E2E.
