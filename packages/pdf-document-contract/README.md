# @aipoch/pdf-document-contract

The shared PDF document-source identity contract and its validation.

## Ownership and integration

Stateless. Both PDF readers and translation owners consume the same identity definition.

Plain values only. Does not authorize access, open files, resolve project roots or own annotations.

## Public surface

Only the explicit entries in package.json exports are supported. Import through @aipoch/pdf-document-contract and its exported subpaths; src and private dist paths are not API. Generated declarations ship with the runtime. Consumers may coordinate necessary interface migrations within this repository; directory structure is not a compatibility contract.

Public entries: `.`.

## Build and verification

Run npm run build, npm test and npm pack from this package after installing its declared dependencies. In this repository, npm run build:packages builds in dependency order. In a separate consumer, supply in-repository sibling dependencies as npm pack tarballs of matching versions; no registry publication is required. Do not substitute host source aliases or root-installed undeclared dependencies.

Package tests cover the owner’s rules and lifecycle. Host tests retain transport, authorization, native resource assembly and cross-domain integration. The package-test registry selects changes in the dependency direction; a host-only edit does not run unchanged package suites. Global toolchain or uncertain changes retain conservative selection.

## Persistence and compatibility

Preserves the existing source discriminants and validation bounds; adds no persisted format or state.
