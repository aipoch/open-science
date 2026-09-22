# Public Zotero libraries

The built-in Zotero Connector reads publicly accessible online user and group libraries through
[Zotero Web API v3](https://www.zotero.org/support/dev/web_api/v3/basics). Its five read tools use the
existing Connector authorization, argument validation and generated Skill flows.

Supply a numeric user or group ID, not a username or group name. `zotero_list_groups` lists a user's
publicly visible groups; a listed group does not necessarily expose its library or notes publicly.
No API key is required or accepted. Private-library authentication and citation export are outside
this first implementation.

## Existing custom Zotero Connectors

The built-in Connector reserves both the route name and ID `zotero`. An existing custom MCP
Connector using either identity remains in Settings but becomes unavailable. Calls to
`host.mcp("zotero", ...)` resolve to the built-in tools; unknown methods do not fall back to the
custom server. Disabling the built-in Connector does not release its reserved name.

The generated `mcp-zotero/SKILL.md` is replaced with the built-in tool documentation when enabled,
or removed when disabled. This affects generated guidance, not the stored custom server
configuration. This release does not automatically migrate custom identities, credentials or
permission rules.

To keep using an existing custom server:

1. Add a custom Connector with an unused route name and ID, for example `zotero-lab`. Changing
   only the display name of the old entry does not change its immutable route or ID.
2. Reuse the server's command/arguments or URL and bind credentials through the existing Settings
   controls. Verify the replacement works before removing the old entry.
3. Update saved `host.mcp` calls and Specialist Connector selections/tool rules to the new identity.
   Review Allow/Ask/Block rules for both entries: existing rules referring to `zotero` may now apply
   to the built-in Connector. The generated custom Skill uses the new route name.

## Tools

| Tool                       | Input and behavior                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `zotero_list_groups`       | `user_id`; list publicly visible groups.                                                                           |
| `zotero_list_collections`  | `library_type`, `library_id`; list top-level collections, or immediate subcollections of `collection_key`.         |
| `zotero_search_items`      | Library identity; optional `query`, `tag`, `item_type`, `collection_key`, `sort`, `direction`, `include_children`. |
| `zotero_get_item`          | Library identity and `item_key`; return bibliographic/item JSON.                                                   |
| `zotero_get_item_children` | Library identity and `item_key`; return accessible child notes and attachment metadata.                            |

`library_type` is `user` or `group`. Item and collection keys are eight uppercase letters/digits.
Search uses phrase matching over title, creator and year. Tag and item-type filters retain Zotero's
Boolean search syntax. Searches exclude trash and return top-level items by default;
`include_children: true` includes matching publicly accessible child notes/attachments.

## Pagination and failures

List tools accept `start` (default 0) and `limit` (default 25, maximum 100). Each call returns one
page: `records`, `total_results`, `records_returned`, `start`, `limit`, `next_start`, and
`library_version`. Repeat with `next_start` until it is null. Missing totals remain unknown; a full
page without totals remains potentially incomplete. `library_version` is a string or null when the
response has no version header, including group listings. Compare non-null versions and restart
traversal if they change. Missing versions cannot establish a consistent snapshot, even if two
pages both return null. Upstream links are never followed.

The transport policy applies only to Zotero tools requesting the exact Zotero API origin. It adds
the API version header, rejects redirects and retains `Backoff` and 429/503 `Retry-After` deadlines
across calls, including failed or cancelled calls. Malformed or overflowing values are not retained.
Other Connectors are not delayed. Shared timeouts, cancellation and response-size limits remain in
the common request engine. Access-denied errors explain the public-library limitation.

There is no response cache, credential storage, Settings command or SDK contract extension.
Note HTML is returned as data; attachment links are metadata, not downloaded content. Local Zotero
databases, private libraries, PDF downloads, full-text parsing, writes and citation exports are not
supported.

## Focused checks

- Tool behavior, throttling, shared transport, schemas and dispatch:
  `npm test -- src/main/connectors/descriptors/zotero.test.ts src/main/connectors/engine.test.ts src/main/connectors/registry.test.ts src/main/connectors/service.test.ts`
- Generated guidance and translated Settings descriptions:
  `npm test -- src/main/connectors/skill-doc.test.ts src/renderer/src/i18n/resources.test.ts`
- Module ownership and transitive test registrations:
  `npm test -- scripts/ci/validate-module-impact.test.ts scripts/ci/audit-module-ownership.test.ts scripts/ci/module-consumer-coverage.test.ts`
