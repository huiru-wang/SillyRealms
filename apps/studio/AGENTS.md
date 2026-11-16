# Studio Frontend Engineering

- Studio is the sole first-party frontend. Read root AGENTS.md, the current task plan, and relevant source/tests before changing contracts.
- Preserve existing AppShell, CSS Modules, semantic tokens and mobile navigation. Do not import retired Web platform CSS/layouts or introduce product fixtures/mock entry points.
- Server owns persistence, credentials, Run lifecycle and state validation. Host owns HTTP/SSE, input/draft, send/stop, settings and recovery; SDK owns story rendering/history/state/Portals.
- Creator components use @sillyrealms/sdk and card-local ./ID static imports only; runtime does not support the retired alias. Session Stage and world introduction/opening previews use the dedicated asset origin with sandbox="allow-scripts allow-same-origin" and their existing CSP; preview runtime/Host authorization remains readonly. Keep exact origin/source/nonce MessageChannel validation and one React instance per document.
- Stage selection depends solely on resolving stage_component. Missing target uses WorldStory; present but broken target fails. Author components need not include WorldStory. Message components resolve from components even with the official stage.
- Preserve the glass composer, measured bottom inset, editable next draft during generation, revision-based clearing, Lexical/IME/history and format semantics. setDraft does not send or add a separate undo banner.
- Preset saves use the eight-column contract and If-Match ETags. Six fixed nodes stay enabled; worldState/actionSuggestions use their node enabled flags. View full prompts and optional read-only candidate previews. Errors retain edits; deleting referenced configurations must fail visibly.
- Run root typecheck/lint/test/build and applicable browser suites. pnpm test:browser uses isolated API/storage and an offline test Provider; never use real user DB or paid calls for routine verification. Inspect 375/1280 screenshots and report untested flows.
- World prose uses description only, never summary. Lore rows show policy/world-book placement/enabled state with one bounded reading pane open at a time. World export/delete belong in the title's more menu; preserve focus return and delete confirmation. Use the existing semantic theme and shared page-header spacing.

## Interaction invariants (2026-11-10 refinement)

- Sidebar expanded/collapsed is ONE persistent rounded floating surface: same inset, radius, background, border, icon anchors and bottom-action layout.
- Animate the shell track and dependent world-page spacing together. Keep sidebar content mounted; fade labels/list with inert and aria-hidden while collapsed.
- Selected + Hover must NOT override selected colors; Hover feedback belongs to nonselected items. Keep focus-visible for keyboard users.
- Use the shared Motion Tokens for navigation and overlays, with no ornamental bounce; respect prefers-reduced-motion including zero delay.
- Mobile top-level lists use the bottom navigation; world, session and preset detail views hide it and provide a back control. Desktop sidebar collapse preferences do not affect mobile navigation.
- Extend the CDP visual regression whenever navigation behavior, selected state or responsive transitions change.

- World introductions and component opening previews run in world-component.html with a readonly global-state facade, not the session frame. Never pass world/session objects or raw transport to author code. Reject non-global scopes and non-query methods at the Host boundary, and close the frame/requests on navigation.

- Platform single-value dropdowns use `components/ui/Select` across setup, models, presets, world config, session settings and app settings. Keep theme tokens, visible labels, 44px targets, keyboard navigation, top-layer viewport placement and Escape focus behavior consistent; do not add page-local native selects. Creator iframe controls remain author-owned.

- The session composer uses one outer focus-within indicator. Do not add an inner outline/border/shadow to its contenteditable; retain visible keyboard focus for the surrounding action buttons.

- World-session sections and the session library share `SessionRow`: fill the available content width, keep update time and independent actions at the trailing edge, apply hover/focus feedback to the entire row, and truncate long titles without moving actions offscreen.
- Session usage summaries must fit completely or collapse to “用量”, based on available toolbar space; never ellipsize token counts. Center bar labels vertically and keep the cache-hit rate on the cumulative legend row. Presentation changes do not change Server usage accounting or the byte-based context composition.

- Detail previews alone reuse source-keyed compilation promises in a bounded in-memory cache; changed source invalidates, failures retry, and fresh iframes discard component state/media on switches. Static world documents and session compilation are unchanged.

- Host owns the transient action-suggestion batch. Clear it on accepted Run, preserve on rejected send, reject stale/duplicate events, and never reconstruct from history/storage. Forward action_suggestions.changed and session.connection through SRSessionAPI; WorldStory binds buttons to the assistant message and only fills drafts.

- Run metadata is minimal: entries keep requestId, run status/errorCode and two extension statuses; opening origin and summary coverage are retained. No persisted runtime snapshots, capabilities, protocol, per-item diagnostics or duplicate IDs/phases/error messages. HTTP/SSE derive phase and error text; Host/SDK consume only the two extension statuses. Offline metadata cleanup uses scripts/compact-run-metadata.ts under the data-directory lock.
