# SillyRealms — Codex Project Instructions

- Treat a session as one continuous history for new work; do not add world-branch logic unless explicitly requested. Explain product flows before technical details.
- Context compaction measures the complete current request before every generation/continuation, then rebuilds and remeasures after bounded old-history summarization. Unknown measurement fails explicitly; see `docs/technical/context-compaction.md` and `docs/technical/runtime-context-v2.md`.
- Preset context strategies are compact (128K), standard (256K), and extended (512K), capped by the model context window.
- Implemented Direct narrative path: one bare model request emits plain story plus a `<sr_extensions>` tail containing enabled `state_update` and `action_suggestions` blocks. Narrative does not register tools, require tool calls, enter a tool loop, or send results back to the model. Architecture and execution scope follow `plan/sr-runtime-context-architecture-v2.md`; the extension failure matrix follows `plan/sr-narrative-extensions-v2.md`. Independent character-mention UI items are outside this architecture rollout. Earlier standalone state-tail documents are historical.
- Keep `update_state`, ToolExecutor and the general model/tool loop as separate capabilities. Run lifecycle, locks, streaming, validation, persistence, Usage and cancellation remain runtime responsibilities; do not describe the new narrative path as an Agent loop.
- A complete bounded extension envelope, trustworthy child framing and normal model termination are prerequisites to narrative state updates. Apply valid state items in order, skip/report invalid items, and process repeated paths in order. Short reasons are non-blocking diagnostics. Missing/invalid required state preserves story but fails the Run without state changes; a suggestion-only failure does not discard valid state. Partial/failed state blocks suggestion publication. Stop before commit discards candidates. Follow the v2 plan's failure matrix; generic tool-loop behavior remains separate.
- The v2 extension rollout uses an additive migration and preserves sessions, entries, presets, worlds/state, models, credentials, tags, app settings and original world files. Do not inherit the historical v1 session cleanup, preset-content deletion or sr_instruction removal into this work. Those are separate pending scopes; documentation edits never execute migrations.

## Project identity
SR is a local-first world-card client and runtime for multi-character narrative experiences, branching conversations, creator-defined React UIs, presets, and optional state.
- `apps/web`: React 19.2 + Vite + TypeScript + Tailwind CSS 4.
- `apps/server`: TypeScript + Hono + SQLite + SRRuntime with Pi model adapters.
- `packages/sr-sdk`: creator-facing React SDK.
- `packages/sr-ui-compiler`: creator TSX compilation.
- `docs/`: product, design, technical and data-format references.
- `plan/`: staged implementation plans.

## Source-of-truth hierarchy
Read relevant documents before proposing or changing behavior. Resolve conflicts in this order:
1. Explicit user instruction in the current task.
2. Current approved plan for the requested change.
3. `docs/PRODUCT.md` for product goals, scope and user-visible behavior.
4. `docs/technical/runtime-context-v2.md`, `docs/technical/worldstory-runtime-v1.md`, and `docs/data-formats/runtime-v2-contract.md` for implemented behavior and verification scope.
5. Relevant `docs/design/`, `docs/technical/`, and `docs/data-formats/` specifications.
6. Source code and tests as evidence of current behavior.

Some design documents describe target/future behavior, not implemented behavior. Never describe planned features as implemented. When documents conflict, report the conflict; do not silently rewrite product decisions.

## Mandatory working rules
- Start substantial tasks by inspecting repository structure, relevant docs, tests, and `git status`.
- The worktree may contain user changes. Never discard, reset, checkout, clean, overwrite, or reformat unrelated changes.
- Do not commit, push, deploy, delete user data, run destructive DB operations, or use real paid Provider calls unless explicitly requested.
- Never expose API keys, credentials, cookies, private prompts, or user content in logs.
- Before changing a public API, data model, session semantics, creator SDK contract, or iframe security boundary, inspect all consumers and tests and document compatibility impact.
- Prefer small, reviewable changes. Avoid speculative abstractions, premature cross-platform packages, new dependencies, and broad rewrites without rationale.
- Keep product decisions, architecture decisions, and implementation details separate. Record durable decisions in `docs/decisions/`.
- Use pnpm. Do not introduce npm/yarn lockfiles.
- LAN startup, exposed access and Origin restrictions are documented in `docs/technical/local-network-access.md`.
- Update relevant docs and tests when behavior or contracts change.

## SR-specific invariants
- Preserve local-first, single-user MVP scope unless explicitly changed.
- Current first-party client is Web + Server. Do not accidentally introduce Android/Desktop/cloud sync/multi-user scope.
- Server is authoritative for persistence, session/run lifecycle, state validation, and credentials. Web must not access the database directly.
- Preserve session/run concurrency, idempotency, tip conflict, history ancestry, and interruption semantics unless an approved plan changes them.
- Creator UI runs inside an isolated iframe. Treat creator code as untrusted. Never bypass Host/iframe boundaries, expose credentials, or let creator code call protected Server HTTP directly.
- Creator-facing runtime contract is based on `SRSessionAPI` and `SRStateAPI`; do not revive a public `SRSessionEventHub` API without explicit approval.
- Official `<SR.WorldStory />` must use the same public creator SDK contract as custom creator UI.
- Keep raw model/tool entries, user-visible narrative projection, and persisted state distinct.
- Event notifications must represent committed/authoritative state; do not invent delivery/replay guarantees.
- Do not weaken iframe sandboxing, CSP, import allowlists, API authorization, or state validation to make a demo work.

## Single-agent working rule
- Use one agent for this project. Do not spawn subagents or delegate work to other agents.
- The current agent owns discovery, design, architecture, implementation, verification, review, and final acceptance.
- Perform review as a separate pass over the work and verify findings with source evidence and appropriate checks.

## Skills routing
- For a substantial new feature, use `project-kickoff`.
- For product or UI changes, use `product-design`.
- For implementation across any layer, use `fullstack-engineering`.
- Before completion, use `quality-review` when the change is substantial.

## Standard delivery workflow
1. Discover: inspect repository state, read relevant docs, identify user outcome and constraints.
2. Product: define journeys, scope, rules, edge cases, and acceptance criteria.
3. Design: establish interaction model, visual direction, tokens, page specs, responsive rules, and UI states.
4. Architecture: define boundaries, data ownership, API/SDK contracts, migration/compatibility, and failure behavior.
5. Plan: split work into tasks with dependencies, owners, file boundaries, and test strategy. Seek approval for material scope/architecture changes.
6. Implement: work through bounded modules sequentially; keep contracts stable and integrate continuously.
7. Verify: run typecheck, lint, tests, build, browser flows, and visual checks. Report skipped checks.
8. Review: perform a separate QA and design/code review pass in the current agent; turn findings into explicit fixes.
9. Re-verify: rerun checks after fixes. Do not call complete while critical acceptance criteria fail.

## Quality gates
- Product: every core journey has entry, success, empty/loading/error states, cancellation/back behavior, and acceptance criteria.
- UI: coherent hierarchy; restrained typography/color/spacing; meaningful density; no generic dashboard-by-default; keyboard/focus/disabled/loading/error/empty states; responsive checks at 375px and 1280px where relevant.
- Frontend: React lifecycle correctness, stable subscriptions, no duplicate React runtime, accessible semantics, no console errors, correct iframe messaging and cleanup.
- Backend: boundary validation, explicit errors, authorization, transaction/persistence correctness, cancellation/recovery, no secret leakage, migration safety.
- Integration: API/SDK contracts tested across producer and consumer; no false claims about SSE replay or state consistency.
- QA: core end-to-end journey plus negative/boundary cases; results reproducible.
- Visual QA: inspect actual rendered screenshots and interactions, not source alone. Provide viewport, issue, severity, and actionable fix.
- Release: no critical defects, destructive operation, or unexplained failing tests.

## Commands
Run from repository root: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.
Web dev: `pnpm dev:web`. Server dev: `pnpm dev`.
Inspect package scripts before relying on a check; report exactly what ran.

## Documentation conventions
- Save proposals and plans, including product, design, and technical proposals, under `plan/`; do not place unimplemented proposals in formal `docs/`.
- Product behavior: `docs/PRODUCT.md` or product specs.
- Domain/UI contracts: `docs/design/`.
- System/API/storage/implementation status: `docs/technical/`.
- Staged implementation work: `plan/`.
- Durable architecture choices: `docs/decisions/`.
- Skills are reusable procedures, not project facts.

- Character `description` is user-facing; only `prompt` enters model context, subject to the shared load rules. `load.mode: never` disables dynamic loading for characters, lore entries, and state modules.
- Implemented Direct preset/message layout: fix the built-in message skeleton with authoritative state/capability rules after native history and before current input. Preserve custom text roles/order in the front area after style. Use the v2 plan's non-destructive compatibility view: `worldState` no longer injects tool/state rules; enabled `postHistory` text moves to the front custom area; stored legacy content and lore anchor/position fields are retained. Activated lore goes into `world_info` ordered by `load.order` then original index. Verify actual Provider payload ordering, not only the internal trace.

- Atomic SDK/Host/Server V1 and `SR.WorldStory` use the creator SDK and isolated iframe boundary; legacy state schemas and V2 routes are not compatible. Message rendering rules are display-only; platform input and draft are Host-owned. See `docs/technical/worldstory-runtime-v1.md` and `docs/data-formats/worldstory-message-render-v1.md`.

- World-card prose uses `WorldDocumentRenderer`: static world/character/opening/lore content stays in a scriptless isolated document; message content shares parsing and sanitization but stays inline inside the existing session iframe for Portal and streaming compatibility. Opening state preview is read-only and reflects message-scope whole-item overrides. See `docs/technical/worldstory-runtime-v1.md` and `docs/data-formats/worldstory-message-render-v1.md`.
