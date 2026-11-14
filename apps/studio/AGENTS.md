# SillyRealms Studio UI Rules (Design Exploration)

- This app is the new UI exploration baseline; **do not import legacy apps/web CSS, tokens, or platform layouts**.
- Read `docs/design/studio-reference-decisions.md`, the applicable current design plan (session surface: `plan/sr-story-stage-worldstory-design.md`), and the latest approved actual-browser screenshots before visual changes.
- Source hierarchy: user-approved live visual > user-provided concept reference > design decisions > current local component design.
- New screens reuse AppShell, Sidebar, existing UI primitives, semantic CSS custom properties and established interaction patterns.
- Studio is gradually replacing Web. World lists and details use read-only Server APIs and the SDK's isolated document renderer. Session samples use the real SDK through a local isolated preview transport; they are not connected to production Server sessions or Providers. Keep other prototype features separate until explicitly integrated. Do not expose Provider credentials or relax the iframe security boundary.
- Do not implement by embedding screenshots as page backgrounds; use real DOM/CSS/React and independent cover assets.
- Default dark palette is exploratory until approval; use /lab/colors for controlled color experiments without changing layout.
- Prefer small visual decisions over speculative UI abstractions. Do not create a standalone design-system package yet.
- Verify using `pnpm --filter @sillyrealms/studio typecheck`, `build`, and the applicable current visual suites against a running Vite server: `STUDIO_SESSIONS_ONLY=1` / `STUDIO_PRESETS_ONLY=1` with `test:visual`, plus `test:visual:world-api` and `test:visual:mobile-nav`. The API-path suites require a non-mock build and intercept fixture responses. The unfiltered legacy `test:visual` still assumes obsolete static worlds/navigation; record its failure and remaining coverage gaps rather than claiming it passed or silently removing coverage.
- After user acceptance: promote validated tokens and patterns to formal design system. Never overwrite an approved visual reference merely to pass visual tests.
- The platform UI design rules must not leak into future creator iframe styling or alter the existing runtime security boundary.

## Interaction invariants (2026-11-10 refinement)

- Sidebar expanded/collapsed is ONE persistent rounded floating surface: same inset, radius, background, border, icon anchors and bottom-action layout.
- Animate the shell track and dependent world-page spacing together. Keep sidebar content mounted; fade labels/list with inert and aria-hidden while collapsed.
- Selected + Hover must NOT override selected colors; Hover feedback belongs to nonselected items. Keep focus-visible for keyboard users.
- Use the shared Motion Tokens for navigation and overlays, with no ornamental bounce; respect prefers-reduced-motion including zero delay.
- Mobile top-level lists use the bottom navigation; world, session, preset and model detail views hide it and provide a back control. Desktop sidebar collapse preferences do not affect mobile navigation.
- Extend the CDP visual regression whenever navigation behavior, selected state or responsive transitions change.

## Session preview and SDK boundaries (2026-11-14)

- The Host owns platform controls, composer and draft. The official `SR.WorldStory` owns story history, streaming, reading scroll, state UI, suggestions and message component Portals; do not build a parallel fixture message renderer in the Host.
- Load `@sillyrealms/sdk/world-story.css` explicitly in each session iframe entry. This SDK stylesheet is permitted and shared with Web; it is not legacy platform CSS. Keep selectors scoped to `.sr-story`, use the limited `--sr-story-*` appearance variables, and leave author page layouts outside that surface untouched.
- State layout uses the actual WorldStory container width: docked at `clientWidth >= 960`, an initially closed overlay below it. Test a narrow author column inside a wide iframe. `showState={false}` must remove the official trigger, panel and overlay.
- Reuse `apps/web/src/features/sessions/composer/RoleplayComposer.tsx` through its four props: `value`, `disabled`, `onChange`, `onSubmit`. This editor module is the intentional cross-app exception; style it locally and do not import Web platform layouts, CSS or tokens. Keep a single React/ReactDOM instance per document.
- The speech/instruction shortcut buttons are removed. Preserve Lexical nodes, HistoryPlugin, serialization, paste, IME handling, block exit and length/trailing-line behavior. Ordinary typed/pasted quotes or protocol tags retain plain-text escaping; initial/external values and SDK `setDraft` retain formatted-draft parsing. Do not silently enable handwritten tag syntax or promise byte-for-byte round trips.
- Plain Enter/Shift+Enter create newlines; Enter inside an existing semantic block exits to narration; Cmd/Ctrl+Enter sends. Active generation must leave the next draft editable unless the stage is fatally unavailable. Preserve draft revision protection, rejected-send drafts and revision-scoped `setDraft` undo.
- Session previews use the real SDK in an opaque-origin `sandbox="allow-scripts"` iframe with nonce/source checks and MessageChannel. Use only bundled trusted samples. Do not add `allow-same-origin`, run arbitrary world-card source, add direct Server access from the iframe, or duplicate Server lifecycle/persistence rules in fixtures.
- Preview runs/state/history and font preferences live only in memory; refresh restores fixtures. Clearly label usage composition as illustrative. Real Server session integration remains a separate task; do not present local simulated state events as persisted authority.
- Bound the stage to the available workspace and let the SDK reading region scroll. Preserve reading anchors when Host controls or appearance resize it; keep input actions reachable when the mobile visual viewport shrinks.
- Verify the session integration with the running Studio server and `STUDIO_SESSIONS_ONLY=1 pnpm --filter @sillyrealms/studio test:visual`, plus the applicable full regression gates. Screenshots under `tests/visual/output/` are development evidence until the user explicitly approves them; never infer approval from a test pass.
