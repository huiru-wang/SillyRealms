# SillyRealms Studio UI Rules (Design Exploration)

- This app is the new UI exploration baseline; **do not import legacy apps/web CSS, tokens, or platform layouts**.
- Read `plan/sr-studio-static-ui-design-v1.md`, `docs/design/studio-reference-decisions.md`, and the latest approved actual-browser screenshots before visual changes.
- Source hierarchy: user-approved live visual > user-provided concept reference > design decisions > current local component design.
- New screens reuse AppShell, Sidebar, existing UI primitives, semantic CSS custom properties and established interaction patterns.
- This phase is static-only: no Server API, SDK, Provider credentials, Session streaming, or real imported files.
- Do not implement by embedding screenshots as page backgrounds; use real DOM/CSS/React and independent cover assets.
- Default dark palette is exploratory until approval; use /lab/colors for controlled color experiments without changing layout.
- Prefer small visual decisions over speculative UI abstractions. Do not create a standalone design-system package yet.
- Verify using `pnpm --filter @sillyrealms/studio typecheck`, `build`, and `test:visual` against a running Vite server.
- After user acceptance: promote validated tokens and patterns to formal design system. Never overwrite an approved visual reference merely to pass visual tests.
- The platform UI design rules must not leak into future creator iframe styling or alter the existing runtime security boundary.
