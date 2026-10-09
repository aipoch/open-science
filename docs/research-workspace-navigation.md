# Research navigation and recorded-run viewing

The research name is the entry to the original research. Its immutable transcript, right-hand
Replay and question composer share one view. Saved discussions remain children of the research.
This change adds no Session type, changes neither `.science` v1 nor execution authority, and keeps
ordinary conversations on their existing path.

## Navigation contract

- Clicking a research name always opens its original imported Session, including when saved
  discussions exist. The header identifies the original record as read-only; there is no separate
  original-record child or empty discussion landing page. Saved discussions and a New discussion
  action appear below it, including the action when no discussion has been saved yet.
- The original transcript remains visible while a question is drafted. The source-specific draft
  is separate from the displayed Session: all mutating composer and execution controllers receive
  a new-conversation target, never the imported source. Only sending creates a research-owned
  discussion and selects it. Clicking the research name returns to the original record.
- Saved discussion children remain exact Session destinations. New discussion in the sidebar or
  discussion header returns to the research's unsent question; the sidebar action focuses the
  composer without clearing that draft. The original view's Ask action focuses that composer.
- Projects containing imported research remember the last explicitly opened Session, research
  or ordinary draft in a local preference. Ordinary projects keep their most-recent-Session
  behavior. Old research-workspace preferences resolve to the original research with its question
  draft; background Session updates do not replace explicit preferences.
- Exact Session links, search results and notifications still open the named Session. Ordinary
  Sessions are never reclassified because they use imported materials. Only authoritative import
  and research membership identities establish sidebar ownership.
- Deferred leave confirmations and asynchronous source lookups revalidate navigation intent,
  source import identity and destination availability before changing selection or preferences.

## Preview source and ownership

The right pane identifies its actual source and its relationship to the selected record or
conversation. The receiving source is independent of a question's submission target. Source IDs
and temporary viewer grants are not human-facing titles or inferred local Run authority.

Research navigation supplies a default preview only when there is no explicit user reference.
Explicitly opening a tab or interacting inside it makes it a user reference. Starting a discussion
retains an explicitly selected recording, file or source. Leaving research removes only automatic
defaults. Unavailable sources are disclosed rather than silently replaced with another Version.
Replay tool tabs remain runtime-only; local navigation preferences never store viewer URLs,
grants, running processes or credentials.

## Discovering saved runs

The research preview offers the original conversation, Notebook, project recordings, and Results
as independent material views. Discovery supplies verified recording choices without interrupting
playback, seeking, reading, or scrolling. The imported Notebook links to saved recordings instead
of trying to observe an author's Run. See [research Replay](research-replay-viewer.md) for the shared
clock and fullscreen layouts.

Discovery reuses the source-scoped Replay Artifact catalog. It reads exact receiving Versions in
pages of at most 32 candidates, with two concurrent 4 KB previews. Conflicting and out-of-scope
identities are rejected. Viewer targets explicitly contain only the four receiving identity
fields: presentation fields such as title and fingerprint never cross the strict IPC boundary.
Matching content is a discovery hint; main validates the full archive and media on open. Multiple
recordings and Versions remain separate. Missing files, incomplete scans and unsupported hosts
have explicit states and retry/continuation actions. Viewing never starts an experiment.

## Asking about a step

The inline question uses the existing source-specific draft key and research membership. A whole
research reference is prepared without navigating or replacing a restored step annotation.
Preparation and persistence failures block Send and offer Retry; a valid metadata-only research
may have no reconstructable replay context. Original history stays readable during preparation.

Recorded evidence can enter this draft before it has a Session ID. The destination contains
project, draft identity and optional writable Session identity. Live observation still requires
the exact execution Session. Explicit recovery from a different destination preserves the frozen
selection and the open archive.

The composer owns `appendText(draftKey, text)`: it verifies the draft and appends to its current
restored document. A stale render cannot overwrite saved text. Delivery acknowledges only actual
acceptance. Navigation, cancelled recovery and closed viewers invalidate pending handoffs.
No Ask action sends a message. A first Send uses the research membership and source context to
create a discussion; it cannot append to or change the imported Session.

## Validation

Automated coverage includes source entry and exact navigation, original transcript visibility,
source/draft isolation, first-send membership and immutable source preservation, cancellation,
stale handoffs, receiving identity checks, saved recording discovery, source labels and preview
retention. Eight-locale guards, module registration checks, types and changed-file lint apply.
Desktop journeys cover research-name navigation both before and after discussions and restart.
These tests use isolated fixtures; source navigation and viewing never constitute a new scientific
experiment or prove that the original experiment can run on another machine.
