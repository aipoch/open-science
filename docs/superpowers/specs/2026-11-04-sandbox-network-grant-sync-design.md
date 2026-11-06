# Notebook unsafe network authorization

## Scope

HTTPS domains, including localhost and names resolving to private, loopback, or mixed addresses,
are allowed without approval. DNS is used only for routing; address classification and address-set
changes are not authorization conditions. Normal TLS certificate checks remain enabled.

Only HTTP or literal IPv4/IPv6 connections require exact protocol, normalized host, and port
exceptions. CONNECT/SOCKS classify application bytes before connecting; ports never select protocol.

## Persistence and recovery

One-time consent requires an explicit retry and is consumed atomically by one matching execution.
Project/global grants retain scope and session provenance across persistence, restore, and tool
results. Persistent writes remain pending until committed. Revoked grants cannot report success.

Legacy missing protocols mean HTTPS. HTTPS domain exceptions and obsolete pending cards are removed;
HTTP/IP exceptions retain scope. No migration converts HTTPS into HTTP. Recovery without remaining
waits returns to idle, not a fictitious running execution.

## Settings and ownership

The single “Trusted unsafe networks” list combines manual entries and persistent session grants,
with scope and revoke actions. One-time grants are absent. Notebook public-domain groups and custom
domain controls are removed; link preview/icon permissions remain independent.

Only trusted application code handles user Settings edits and approval decisions. Agent and sandbox
code cannot modify trust settings. No inbox or automatic request replay is introduced.

## Validation

Cover HTTP 8080, HTTPS 80, localhost, IPv4/IPv6 normalization, mixed DNS, CONNECT/SOCKS protocol
boundaries and partial prefaces, approval persistence/recovery, migration, revocation, scope
isolation, and concurrent one-time consumption. Run relevant unit/process integration tests,
Settings rendering, all locale guards, type checks, and the isolated Electron approval journey.
