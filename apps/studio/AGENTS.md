# SillyRealms Studio UI Rules (Design Exploration)

- This app is the new UI exploration baseline; **do not import legacy apps/web CSS, tokens, or platform layouts**.
- Read `plan/sr-studio-static-ui-design-v1.md`, `docs/design/studio-reference-decisions.md`, and the latest approved actual-browser screenshots before visual changes.
- Source hierarchy: user-approved live visual > user-provided concept reference > design decisions > current local component design.
- New screens reuse AppShell, Sidebar, existing UI primitives, semantic CSS custom properties and established interaction patterns.
- Studio is gradually replacing Web. World lists and details use read-only Server APIs and may use the official SDK's isolated document renderer; other prototype features remain separate until explicitly integrated. Do not expose Provider credentials or relax the iframe security boundary.
- Do not implement by embedding screenshots as page backgrounds; use real DOM/CSS/React and independent cover assets.
- Default dark palette is exploratory until approval; use /lab/colors for controlled color experiments without changing layout.
- Prefer small visual decisions over speculative UI abstractions. Do not create a standalone design-system package yet.
- Verify using `pnpm --filter @sillyrealms/studio typecheck`, `build`, and `test:visual` against a running Vite server.
- After user acceptance: promote validated tokens and patterns to formal design system. Never overwrite an approved visual reference merely to pass visual tests.
- The platform UI design rules must not leak into future creator iframe styling or alter the existing runtime security boundary.

## Interaction invariants (2026-11-10 refinement)

- Sidebar expanded/collapsed is ONE persistent rounded floating surface: same inset, radius, background, border, icon anchors and bottom-action layout.
- Animate the shell track and dependent world-page spacing together. Keep sidebar content mounted; fade labels/list with inert and aria-hidden while collapsed.
- Selected + Hover must NOT override selected colors; Hover feedback belongs to nonselected items. Keep focus-visible for keyboard users.
- Use the shared Motion Tokens for navigation and overlays, with no ornamental bounce; respect prefers-reduced-motion including zero delay.
- Mobile Drawer must show labels and data regardless of persisted desktop collapsed state.
- Extend the CDP visual regression whenever navigation behavior, selected state or responsive transitions change.
