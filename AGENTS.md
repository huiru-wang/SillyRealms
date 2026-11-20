# AGENTS.md

## Development Principles

- Prioritize correctness, maintainability, simplicity, and long-term evolvability.
- Understand the existing codebase and architecture before making changes.
- Prefer extending existing capabilities over introducing redundant implementations.
- Avoid unnecessary complexity, premature abstraction, and speculative design.
- Make focused changes and avoid modifying unrelated code.

## Critical Thinking & Decision Making

- **Do Not Blindly Agree:** Do not automatically agree with user suggestions, assumptions, or proposed solutions. Independently evaluate their technical validity, feasibility, and consequences.
- **Challenge When Necessary:** If a proposed approach introduces unnecessary complexity, architectural problems, security risks, performance issues, or conflicts with established best practices, clearly explain the concerns and recommend a better alternative.
- **Prioritize Correctness Over Agreement:** Be objective and honest. Never compromise technical quality simply to validate the user's opinions.
- **Provide Reasoned Recommendations:** When multiple approaches are viable, compare their trade-offs and recommend the most appropriate one with clear reasoning.
- **Respect Explicit Decisions:** After explaining relevant risks and trade-offs, respect the user's informed decisions unless they introduce unacceptable risks or violate essential constraints.

## Architecture & Continuous Improvement

- **Think Beyond the Current Task:** Consider existing module responsibilities, dependencies, and overall architecture. Avoid local solutions that compromise long-term maintainability.
- **Detect Architectural Issues:** Pay attention to duplicated business logic, growing module responsibilities, change coupling, unnecessary dependencies, and unclear module boundaries. Identify structural problems before they accumulate.
- **Refactor Incrementally:** When encountering relevant architectural problems, improve them through small, focused refactoring. Avoid continuously adding functionality to inappropriate modules or postponing obvious improvements until a major rewrite becomes necessary.
- **Avoid Overengineering:** Follow YAGNI and Simple Design. Do not introduce abstractions, design patterns, or additional layers for hypothetical requirements. Abstract only when actual complexity, shared responsibilities, or recurring changes justify it.
- **Review Before Completion:** After meaningful changes, briefly evaluate their architectural impact. Fix relevant issues, identify significant deferred improvements, and avoid unrelated refactoring. Only raise actionable concerns supported by concrete evidence.
- **Assess Architectural Risks:**
  - L1 - Local Improvement: Fix small, low-risk issues when practical.
  - L2 - Structural Concern: Evaluate and improve incrementally when relevant; otherwise defer.
  - L3 - Critical Risk: Do not introduce or worsen risks affecting correctness, data consistency, or core architectural boundaries without addressing them or obtaining explicit approval.

## Core Principles

1. Deliver current requirements correctly without sacrificing long-term code quality.
2. Improve architecture continuously, but only when the benefits justify the complexity and cost.
3. Prefer simple, explicit, and maintainable solutions over unnecessary abstractions.
4. Act as a critical engineering partner, not an agreeable assistant.
5. Let code express business behavior, tests verify expected behavior, and documentation explain important decisions and knowledge that code cannot express.

## Frontend UI Contract

- Follow [Studio UI SPEC](docs/design/UI-SPEC.md) for platform UI and [world component boundaries](docs/design/world-components.md) for author content.
- Reuse semantic tokens in `apps/studioV2/src/styles/theme.ts` and `tokens.css`, and shared primitives in `components/ui`. Pages own placement, not shared control colors, states or dimensions.
- All five main pages use `PageHeader`. Keep mobile detail content behind navigation with scroll-tail clearance.
- Theme changes must propagate through the validated appearance contract to official renderers without expanding author permissions.
- Keep `docs/design` factual and current: standards and contracts only, no change logs, proposals or investigation narratives.

## V2 Workspace Boundary

- Root development, build, test and startup commands target the V2 workspace.
- `apps/studioV2` connects only to `apps/serverV2`; keep the original Studio/Server independent. ServerV2 implements narrative submission/stop with user-first persistence, sliding-window context or one rolling summary, partial assistant output preservation and shared session events; see [Server V2 narrative](docs/runtime/server-v2-narrative.md). StudioV2 mounts management, author previews and the ServerV2 text narrative session page; clients and stage SDK use the current V2 contracts.
- Reuse the copied Studio UI primitives and semantic tokens within StudioV2. Its five mounted management pages use `PageHeader`; the session runtime is mounted separately and world-authoring screens remain unmounted.
- Follow [StudioV2 management](docs/runtime/studio-v2-management.md) and [Server V2 HTTP](docs/runtime/server-v2-http.md). Verify this integration at function level plus typecheck/lint; do not start services or add mock end-to-end environments for this task.

- World author previews run on a separate static origin with a read-only global-state bridge; no runtime/engine or session-start behavior. Shared SDK resource parsing accepts both original and V2 resource bases.

- StudioV2 world detail preserves the original Studio page structure and interaction model: collapsible overview, character strip, six icon tabs, opening navigation, independent content scrolling and dialogs. Adapt API contracts without replacing these with management panels.

- ServerV2 narrative APIs use `/sessions/:id/narrative` for cursor history (1–5 complete runs) and seq catch-up, submission/stop and recorded usage; the session SSE stays independent. Terminal outcomes live in each run's first entry's `extData.narrative` regardless of its role, request metrics contain provider instead of status. No runs table, replay or restart recovery. GET /sessions/:id/history is removed; use a single ordered seq range for internal model context. Clients read saved messages only from narrative/runs. Appends validate the tip in the insertion transaction.
- StudioV2's isolated static build now includes both `world-component.html` and `frame.html`; runtime/config publishes the stage origin/entryPath/debug. SessionPage composes independent narrative/history/state/world/suggestions features, one session event channel, and the isolated stage.

- ServerV2 state events use the existing session SSE and `{path,scope,value}` contract. Publish actual effective changes only after commit; global fans out to all sessions of the world, message tracks the current tip's inherited view. Empty event path replaces the whole scope; PATCH inputs still require a nonempty path. State writes and stateful entry appends are orchestrated in usecases, never published by repositories or StateService.

- ServerV2 session creation requires openingId and atomically creates the session, local initial state and first assistant entry. Substitute exact {{user}} placeholders once; preserve current global state. Emit only session.created after commit, no run/state events. Initial messages use ordinary run grouping without kind/origin; StudioV2 submits the selection while stage rendering remains deferred.

- ServerV2 context preparation is owned by usecases/context, with prepareContext and explicit public types exposed only through index.ts. Capture the accepted turn before the first async wait. Internal stages compute history, materials, model notes, compaction and final messages; the context narrative orchestrator persists successful summaries and returns the final request, parent entry and committed summary receipt. Context production code cannot depend on other usecases or EventHub/SSE; the outer narrative maps progress and preparation failures to run events.
- ServerV2 model-only notes are entry-scoped in-memory projections. Select the latest two visible assistant entries before checking output; do not backfill older entries without output. State and action note sources are independent: state notes select only stateUpdate.updates rows with status=success and serialize path/value/reason without statuses or diagnostics; action notes select valid actionSuggestions.items. Render notes only for retained entries, include them in actual input estimates, and exclude them from keyword activation and summary input. Notes do not mutate history, replay state writes or need a table/contextEligible. Edited bodies retain the original processing record; the current state snapshot remains authoritative.

- ServerV2 context compaction preserves complete run groups and current input. Rolling summaries protect five historical runs and persist only successful compaction entries with their own metrics; failed/cancelled summaries leave no entry or accounting, unknown successful usage is null. Publish run.summarizing/run.summarized, never run.phase/generating; if one summary still exceeds the budget, stop with summary_capacity_exceeded. Share the in-memory RuntimeCache from infrastructure/cache across the application. Lock before user persistence through settlement; external session writes return SESSION_WRITE_LOCKED and state writes return STATE_WRITE_LOCKED (409). Global state stays locked while any run in its world is active. Only the exact run-owned permit authorizes internal message/summary/outcome commits; release by identity before notifications and again on finalization. See [context compaction](docs/runtime/server-v2-narrative.md#自动裁剪与滚动摘要).

- ServerV2 narrative postprocess lives in usecases/narrative/postprocess. Each capability independently matches its own case-insensitive tag pair; a damaged own tag yields invalid_tag and executes no data from that capability. Never recover a block using another capability's tags. State content is JSONL with row isolation and no fixed update-count limit; suggestions retain valid items after filtering empty/invalid items, with three as a prompt target. Fixed protocol instructions override incompatible old prompt formats. Postprocess prompts must not reference input.text, history.messages or history.summary; compilation rejects these references to avoid duplicate input, history or summary injection.
- ServerV2 persists capability results in assistant.extData.output through SessionService.appendNarrativeAssistant. stateUpdate has one ordered updates list carrying row status and usable input/diagnostic fields; actionSuggestions has aggregate status and valid items. Neither capability stores results. New writes enforce this shape; SessionService read projections normalize old results without rewriting storage, pairing old successful updates by result order and preserving repeated paths/reasons; generic entry edits cannot forge or remove output. Prepare message-state candidates and changes before the atomic assistant append, then publish state.changed and nonempty action_suggestions.created after commit and lock release, before usage/terminal. Capability failures do not alter an otherwise completed run; interrupted model calls do not execute postprocess or fabricate output. Historical model-only notes are built separately by context from these saved results; output processing never reconstructs history or executes notes.

- StudioV2 stage-host owns iframe/MessagePort/appearance only. Session workspace composes feature lifetimes; history owns persisted entries, narrative owns transient model output, state owns effective scope values, suggestions owns only the current display projection. The frame SDK is a command proxy and immutable display mirror; it never repeats business recovery or optimistic state writes.
- The V2 frame and author types share the package root `@sillyrealms/sdk`; its session API returns real V2 accepted IDs and history items/entries, native events and current statuses. Do not synthesize legacy requestId, run.failed/run.phase, extensions or capabilities. Usage composition comes only from the ServerV2 persisted main-request context snapshot; its UTF-8 bytes plus conventional message overhead are not per-category billed tokens.
- A session has one SSE independent of iframe lifetime. Restore persisted runs through bounded pages on connection, overlapping the last active seq to observe an outcome-only write; no automatic narrative resubmission. Snapshot replaces model output but does not prove persistence; handoff by message ID follows durable reads. State writes reconcile actual server state; success can mean an ignored missing path. Scope replacement events use path:"".


- ServerV2 narrative logs are run-scoped single lines: local timestamp, event and compact JSON with runId/sessionId. Context returns content-free diagnostics for the selected candidate; raw provider payload/final SDK diagnostics stay outside business events and storage. Log full non-delta lifecycle, capability inputs/results and settlement; distinguish prepared output from committed persistence. Redact explicit credentials and isolate serialization/sink/observer failures from execution.
