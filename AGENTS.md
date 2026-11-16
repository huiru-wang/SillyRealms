# SillyRealms — Codex Project Instructions

- Treat a session as one continuous history for new work; do not add world-branch logic unless explicitly requested. Explain product flows before technical details.
- Context compaction runs once during preparation: estimate complete input, trigger at 100% of max_context_tokens, target 60%; rolling summary makes at most one complete call, sliding window keeps a continuous suffix. Freeze sources before awaits and activate from final retained history, summary and input.
- Presets use eight columns: id, name, description, model_parameters, context_strategy, config_json, created_at, updated_at. context_strategy owns numeric budgets, strategy and summary_prompt. Input cap is min(80% model window, window-output-1024); legal requests above soft target proceed.
- Runtime follows plan/sr-context-output-runtime-refactor-v8.md. All narrative/summary instructions come from the bound preset; resources/presets/default.json is initialization data, never a runtime fallback. Six required system nodes and optional worldState/actionSuggestions postprocess nodes use one uniform schema. No Agent execution, session capability overrides or legacy preset formats.
- Compile nodes once per candidate/final context through context/node-compiler.ts. WorldInfo reads only activated lore; chatHistory contains session state descriptions, summary and native-role history. Postprocess instructions follow current input. No active writable message roots means omit the entire worldState node. JSON state rules stay in root descriptions; no nested check engine.
- Narrative makes one tool-free model call. runtime/postprocess parses independent state_update then action_suggestions blocks, with bounded trustworthy framing and normal termination. Structural failure discards all candidates; valid state items apply in order, invalid items yield partial state and block suggestions. Suggestion-only failure preserves valid state. Cancellation before commit discards candidates.
- Accepted input persists before 202 in run_preparations; summary/user handoff, failure settlement and state commits are atomic. Run lifecycle, locks, streaming, Usage and cancellation stay runtime-owned.
- Suggestions are ephemeral: after commit and terminal event emit action_suggestions.changed with sessionId/runId/assistant messageId and exactly three strings. Never persist suggestion text, raw tail or candidates. Host stores the latest batch in memory, clears on a new accepted Run, verifies latest Run on reconnect, and forwards through SRSessionAPI. Refresh/reentry does not restore suggestions; no replay guarantee.
- Database v6 is target-only. The explicitly invoked scripts/reset-runtime-data.ts replaces retired preset/session/entry/preparation tables and clears preset tag references, preserving current worlds/global state, models, credentials and original files. Startup rejects older schemas; no compatibility migrations. Routine verification always uses isolated storage.

## Project identity
SR is a local-first world-card client and runtime for multi-character narrative experiences, branching conversations, creator-defined React UIs, presets, and optional state.
- `apps/studio`: React 19.2 + Vite + TypeScript + CSS Modules and Studio semantic tokens; the only first-party frontend.
- `apps/server`: TypeScript + Hono + SQLite + SRRuntime with Pi model adapters.
- `packages/sr-sdk`: creator-facing React SDK.
- `packages/sr-ui-compiler`: creator TSX compilation.
- `docs/`: product and design documents only.
- `plan/`: staged implementation plans.

## Source-of-truth hierarchy
Read relevant documents before proposing or changing behavior. Resolve conflicts in this order:
1. Explicit user instruction in the current task.
2. Current approved plan for the requested change.
3. Existing product documents in `docs/` for product goals, scope and user-visible behavior.
4. Relevant `docs/design/` specifications.
5. Source code and tests as evidence of implemented behavior and verification scope.

Some design documents describe target/future behavior, not implemented behavior. Never describe planned features as implemented. When documents conflict, report the conflict; do not silently rewrite product decisions.

## Mandatory working rules
- Start substantial tasks by inspecting repository structure, relevant docs, tests, and `git status`.
- The worktree may contain user changes. Never discard, reset, checkout, clean, overwrite, or reformat unrelated changes.
- Do not commit, push, deploy, delete user data, run destructive DB operations, or use real paid Provider calls unless explicitly requested.
- Never expose API keys, credentials or cookies in logs. The user-authorized `SILLYREALMS_DEBUG=1` mode may print complete model messages and unparsed output with credential redaction; ordinary diagnostics must not include private prompts or user content.
- Before changing a public API, data model, session semantics, creator SDK contract, or iframe security boundary, inspect all consumers and tests and assess compatibility impact.
- Prefer small, reviewable changes. Avoid speculative abstractions, premature cross-platform packages, new dependencies, and broad rewrites without rationale.
- Keep product decisions, architecture decisions, and implementation details separate.
- Use pnpm. Do not introduce npm/yarn lockfiles.
- Update relevant tests when behavior or contracts change.

## SR-specific invariants
- Session SSE sends an immediate comment to flush development proxies. Server shutdown rejects new requests, closes event streams, cancels and settles active Runs before closing SQLite and releasing the directory lock; its deadline must precede the dev watcher's forced kill. Test restarts with temporary storage. Transient connection failures preserve drafts and allow initial stage loading to retry on reconnect; never auto-resubmit a Run.
- Preserve local-first, single-user MVP scope unless explicitly changed.
- Current first-party client is Studio + Server. Do not accidentally introduce Android/Desktop/cloud sync/multi-user scope.
- Server is authoritative for persistence, session/run lifecycle, state validation, and credentials. Studio must not access the database directly.
- Preserve session/run concurrency, idempotency, tip conflict, history ancestry, and interruption semantics unless an approved plan changes them.
- Creator UI runs inside an isolated iframe. Treat creator code as untrusted. Never bypass Host/iframe boundaries, expose credentials, or let creator code call protected Server HTTP directly.
- Creator-facing runtime contract is based on `SRSessionAPI` and `SRStateAPI`; do not revive a public `SRSessionEventHub` API without explicit approval.
- Official `<SR.WorldStory />` must use the same public creator SDK contract as custom creator UI.
- Keep model responses, visible narrative projection, and persisted state distinct.
- Terminal Run and state notifications must represent committed/authoritative state. Narrative deltas and running snapshots are explicitly provisional in-memory content, persisted at response end/stop/failure; process death can lose that unfinished text. Do not invent delivery/replay guarantees.
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
Studio dev: `pnpm dev:studio`; both apps: `pnpm dev:all`. Server dev: `pnpm dev`. Production: `pnpm build && pnpm start`.
Inspect package scripts before relying on a check; report exactly what ran.

## Documentation conventions
- Save proposals and plans, including product, design, and technical proposals, under `plan/`; do not place unimplemented proposals in formal `docs/`.
- Keep only product and design documents in `docs/`; do not add technical, data-format, or architecture-decision documents there.
- Product behavior: product documents in `docs/`.
- Domain/UI contracts: `docs/design/`.
- Staged implementation work: `plan/`.
- Code changes do not require automatic updates to documentation or `AGENTS.md`; update them when explicitly requested.
- Skills are reusable procedures, not project facts.

- Character `description` is user-facing; only `prompt` enters model context, subject to the shared load rules. `load.mode: never` disables dynamic loading for characters, lore entries, and state modules.


- Atomic SDK/Host/Server V1 and `SR.WorldStory` use the creator SDK and isolated iframe boundary; legacy state schemas and V2 routes are not compatible. Message rendering rules are display-only; platform input and draft are Host-owned.

- World-card prose uses `WorldDocumentRenderer`: static character/lore content and plain opening fallback stay in a scriptless isolated document; world introduction and component openings use the separate readonly world-component iframe; message content shares parsing and sanitization but stays inline inside the existing session iframe for Portal and streaming compatibility. Opening state preview is read-only and reflects message-scope whole-item overrides.

- `SR.WorldStory` merges paged history, UTF-16-offset deltas and Host recovery snapshots through one reducer. Preserve stable message IDs, terminal authority, memoized historical rendering and keyed React portal slots. No durable SSE replay or list virtualization is implied.

## Studio production frontend and creator components


- apps/web is retired. All first-party runtime, composer, Worker, tests and business UI live in Studio. Do not reintroduce product fixtures, preview transports or mock entry points; test-only fixtures remain under test/tests.
- Author imports use @sillyrealms/sdk exclusively. components is an array of {id,component}; stage_component selects an ID. Missing main or unknown target selects official WorldStory; an existing broken entry fails visibly. Never inspect or inject WorldStory into author components.
- message_render.rules[].replacement.component references components IDs; no component_source. Static ./ID default imports are card-local, cached in the isolated iframe, with cycle/unknown-module errors and no external resolution. Preserve React singleton, sandbox/CSP, Host HTTP/SSE and SDK authority boundaries.
- Preset UI uses the eight-column Server contract, ETag conflict checks, fixed nodes and postprocess switches; show complete prompt templates and read-only candidate previews. Save failures preserve drafts; deletion honors references.
- Existing UI format conversion is an explicit offline tool, not automatic startup migration. Never execute it on the user's DB without explicit authorization.

- Introduction/opening component frames expose readonly global state through useSRWorldStateAPI (useSRStateAPI is a restricted runtime alias). No session/message scope, writes, Session API or subscriptions. Host independently authorizes each request. Opening content is the first assistant text and bypasses message_render; preview components are separate and receive no regex groups. See docs/design/world-components.md.

- WorldStory prose uses sanitized Markdown/GFM with static task markers and display-only paired Chinese/ASCII double-quote coloring. Preserve code/HTML/URL/image/author-component boundaries, source offsets, SR-RP protocol semantics and stable Portal DOM; see docs/SDK/components.md.

- Session Stage uses a stable independent origin with sandbox="allow-scripts allow-same-origin" so eligible images can reuse browser HTTP cache across reentry. Preserve the existing resource CSP. Detail introduction/opening previews share the isolated asset origin through a separate readonly world-component.html entry; static documents remain unchanged. Platform must not serve frame.html or world-component.html, Stage must not serve APIs, and Stage retries preserve Host drafts and never resubmit Runs. See plan/sr-stage-independent-origin-v1.md.

- Run metadata is minimal: entries keep requestId, run status/errorCode and two extension statuses; opening origin and summary coverage are retained. No persisted runtime snapshots, capabilities, protocol, per-item diagnostics or duplicate IDs/phases/error messages. HTTP/SSE derive phase and error text; Host/SDK consume only the two extension statuses. Offline metadata cleanup uses scripts/compact-run-metadata.ts under the data-directory lock.
