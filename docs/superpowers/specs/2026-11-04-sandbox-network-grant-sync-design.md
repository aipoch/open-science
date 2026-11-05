# Sandbox network grant synchronization

## Scope

Extend the existing in-session Notebook network approval flow so HTTPS domain grants remain in the
ordinary destination-grant chain, while HTTP and literal IP access require an explicit trusted
private-service rule. Preserve exact hostname, port, and protocol matching, explicit retry,
single-use approval, full-access exemption, and the existing conversation permission card.

## Data model

`TrustedPrivateDestination` gains an optional protocol (`http` or `https`) and keeps optional
backend metadata for compatibility. Manual private-service rules remain Settings-owned. Global
destination grants retain their project/session/record provenance and optional protocol.

## Trusted backend lifecycle

`NotebookNetworkSettingsOwner` remains the only writer for trusted private-service rules. A global
approval persists as a destination grant; it does not project ordinary HTTPS approvals into the
trusted private-service list. Revoked global grants remain as tombstones.

Existing managed metadata is retained only for backwards-compatible cleanup. Manual rules for the
same target remain owned by Settings. Trusted rules may include HTTP, localhost, and literal IP
targets. DNS answers are used only to route a request; public/private classification, approved
address-set matching, and DNS revalidation are not authorization conditions.

## UI and boundaries

Settings shows protocol-scoped trusted service entries and keeps their persistence behind the
Settings owner. Agent and sandbox paths receive no private-service mutation capability; the trusted
settings backend owns the synchronization and cascade.

## Validation

Add owner/repository tests for project-only grants, protocol-scoped global grants, manual trusted
service persistence, forged metadata, duplicates, denial, single-use and cancellation races.
Update renderer tests and all eight locale catalogs. Run focused Vitest suites, the i18n guard,
package type checks, and the available gateway/integration coverage.
