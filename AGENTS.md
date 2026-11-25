# AGENTS.md

## World Authoring

- For creating or iterating an SR world, read [sr-world-author](skills/sr-world-author/SKILL.md). For adapting a SillyTavern work, read [sr-tavern-migrate](skills/sr-tavern-migrate/SKILL.md).
- Follow the [creator guides](docs/creator/README.md), [current world format](docs/reference/world-card.md), and [SDK](docs/sdk/README.md). Reuse `examples/worlds` and the repository's `world:check` / `world:pack` commands. Report static checks, actual import, and playtesting separately.
- Skills are repository-local workflows. Do not assume that copying a skill folder installs its referenced documentation or tools.

## Planning Deliverables

- 所有涉及代码变更的方案，必须附树形结构的变更文件目录，标明计划新增、修改、删除的文件及简要用途；目录树描述计划范围，不代表代码已经实施。

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

- Follow [Web UI SPEC](docs/design/UI-SPEC.md) for platform UI and [world component boundaries](docs/design/world-components.md) for author content.
- Reuse semantic tokens in `apps/web/src/styles/theme.ts` and `tokens.css`, and shared primitives in `components/ui`. Pages own placement, not shared control colors, states or dimensions.
- All five main pages use `PageHeader`. Keep mobile detail content behind navigation with scroll-tail clearance.
- Theme changes must propagate through the validated appearance contract to official renderers without expanding author permissions.
- Keep `docs/design` factual and current: standards and contracts only, no change logs, proposals or investigation narratives.

## Workspace Boundary

- State `rules` are optional author hints. Validate supplied rule paths and nonblank strings on card import or definition edits; never require root, nested or array coverage. Prompt assembly renders only supplied rules for active message roots. Rules do not authorize or veto state writes.

- Author character prompts and lore content remain literal on import. Only render selected source fields, once: exact {{user}} and visible state paths, blank invalid/missing state paths, preserve unknown custom placeholders. Presets keep strict syntax and their existing aggregate variables. Never scan substituted values or assembled messages.

- Linux single-server deployments use the root `./deploy.sh` on a main-branch clone. Reuse the saved configuration, original data root and credential master key across updates. See [single-server deployment](deploy/README.md).
- Server startup reads the tracked `initial-data/manifest.json`. Install missing presets and settings in one synchronous transaction, then await each missing world ZIP import before listening. Stable IDs preserve existing user data and identify deleted built-ins for reinstall.
- Server defaults to the repository-level `data/` directory for SQLite and imported worlds. `SERVER_DATA_ROOT` overrides both together.
- Run development, debugger and built-preview modes from the root with `pnpm dev`, `pnpm debug` and `pnpm start`. Each runs the loopback API, Web host and isolated stage. Local Web and stage support LAN clients on ports 5176 and 5177 with exact origin checks. See [startup and debugging](README.md).
- `apps/web` connects only to `apps/server`. Server implements narrative submission/stop with user-first persistence, sliding-window context or one rolling summary, partial assistant output preservation and shared session events; see [Server narrative](docs/runtime/server-narrative.md). Web mounts management, author previews and the Server text narrative session page; clients and stage SDK use the current V2 contracts.
- Reuse the copied Web UI primitives and semantic tokens within Web. Its five mounted management pages use `PageHeader`; the session runtime is mounted separately and world-authoring screens remain unmounted.
- Follow [Web management](docs/runtime/web-management.md) and [Server HTTP](docs/runtime/server-http.md). Verify this integration at function level plus typecheck/lint; do not start services or add mock end-to-end environments for this task.

- World author previews run on a separate static origin with a read-only global-state bridge; no runtime/engine or session-start behavior. Shared SDK resource parsing uses the world resources endpoint.
- World detail owns up to 10 author-preview iframes at stable DOM positions, keyed by introduction/opening identity. Evict first opened (FIFO), never promote on revisit/retry. Tab switches hide retained instances; eviction/retry/detail exit destroys the corresponding bridge, and detail exit aborts shared source loads. Share source requests within the detail; management metadata changes must not remount previews. Hidden previews pause HTML media/CSS animations, not arbitrary author JavaScript; retain the read-only isolation contract.

- Web world detail preserves the page structure and interaction model: collapsible overview, character strip, six icon tabs, opening navigation, independent content scrolling and dialogs. Adapt API contracts without replacing these with management panels.

- Server narrative APIs use `/sessions/:id/narrative` for cursor history (1–5 complete runs) and seq catch-up, submission/stop and recorded usage; the session SSE stays independent. Terminal outcomes live in each run's first entry's `extData.narrative` regardless of its role, request metrics contain provider instead of status. No runs table, replay or restart recovery. GET /sessions/:id/history is removed; use a single ordered seq range for internal model context. The narrative stop reason for an output length limit is `output_limit_reached` in both SSE and saved history. Clients read saved messages only from narrative/runs. Appends validate the tip in the insertion transaction.
- Web's isolated static build includes both `world-component.html` and `frame.html`. Runtime/config publishes the stage origin/entryPath/debug. With an authorized sessionId it also returns capabilities.characterSprite.available from the active preset and world catalog. SessionPage composes independent narrative/history/state/world/suggestions features, one session event channel, and the isolated stage.

- Server state events use the existing session SSE and `{path,scope,value}` contract. Publish actual effective changes only after commit; global fans out to all sessions of the world, message tracks the current tip's inherited view. Empty event path replaces the whole scope; PATCH inputs still require a nonempty path. State writes and stateful entry appends are orchestrated in usecases, never published by repositories or StateService.

- Server session creation requires openingId and atomically creates the session, local initial state and first assistant entry. Substitute exact {{user}} placeholders once; preserve current global state. Emit only session.created after commit, no run/state events. New opening entries record each initialized message-state root in extData.output as a successful update and carry empty suggestions. Initial messages use ordinary run grouping without kind/origin; Web submits the selection while stage rendering remains deferred.

- Server context preparation is owned by usecases/context, with prepareContext and explicit public types exposed only through index.ts. The only narrative prepareContext business input is sessionId; signal/permit/progress are execution controls. Capture current history, actual-tip state and configuration before the first async wait, without caller kind, input text or user/run IDs. Only a trailing ordinary user message moves to input.text; an assistant tail or empty session has no input node. Internal stages compute history, materials, model notes, compaction and final messages; prepare.ts persists successful summaries at the captured tip in its run after rechecking tip/source, and returns the final request, nullable parent entry and committed summary receipt. Context production code cannot depend on other usecases or EventHub/SSE; the outer narrative maps progress and preparation failures to run events.
- The required system node worldState precedes chatHistory and renders selected state facts at the captured tip. The three aggregate variables state.global, state.session and state.message contain values and descriptions; only JSON message roots carry a type label. Only the optional stateUpdate capability may use {{state.update.message}} for activated message root names and supplied rules. Built-in narrative enables it. Its instructions, protocol and model write authorization require active message roots; its historical notes require any applicable state material. Missing/disabled stateUpdate grants no roots. actionSuggestions and characterSprite retain their independent conditions, including a nonempty catalog for sprite prompts. Enabled capability prompts must be nonblank. Keep strict reads and compilation without inserting or migrating nodes or replacing author prompts.

- Server model-only notes are entry-scoped in-memory projections. Select the latest two visible assistant entries before checking output; do not backfill older entries without output. State notes select successful stateUpdate.updates rows and serialize path/value/reason; action notes select valid items; sprite notes serialize the exact message's success/partial_success items. Append only enabled and available sources, in state_update/action_suggestions/character_sprite order, to retained assistant prose with a blank line before the first block and one newline between blocks. Missing/failed sprite results, malformed stored data and source read/serialization failures render `<character_sprite></character_sprite>`; the sprite source must catch these failures itself. Empty enabled state/action sources use zero JSONL rows / an inline empty array. Disabled or unavailable sources add no block. Include notes in actual input estimates and exclude them from keyword activation and summaries. Notes never rewrite messages, replay state, emit SSE or need a table/contextEligible; edited bodies retain the original processing record.

- Server context compaction consumes the full captured history and preserves complete run groups plus any trailing unanswered user run. Reuse the newest valid summary by coverage/sourceHash, never a summary covering that protected run. Rolling summaries protect five historical runs in addition to the pending user run and persist only successful compaction entries with their own metrics; failed/cancelled summaries leave no entry or accounting, unknown successful usage is null. Publish run.summarizing/run.summarized, never run.phase/generating; if one summary still exceeds the budget, stop with summary_capacity_exceeded. Share the in-memory RuntimeCache from infrastructure/cache across the application. Lock before user persistence through settlement; external session writes return SESSION_WRITE_LOCKED and state writes return STATE_WRITE_LOCKED (409). Global state stays locked while any run in its world is active. Only the exact run-owned permit authorizes internal message/summary/outcome commits; release by identity before notifications and again on finalization. See [context compaction](docs/runtime/server-narrative.md#自动裁剪与滚动摘要).

- Server narrative postprocess lives in usecases/narrative/postprocess. Each capability independently matches its own case-insensitive tag pair; a damaged own tag yields invalid_tag and executes no data from that capability. Never recover a block using another capability's tags. Parsing is driven by actual model output and never receives presets or enabled flags. State content is JSONL with row isolation and no fixed update-count limit; suggestions retain valid items after filtering empty/invalid items, with three as a prompt target. character_sprite is a full flat JSONL snapshot of position/characterId/spriteId: characterId and position are each unique, the first fully valid row wins, and rejected rows reserve neither key. Seven positions allow up to seven accepted items; no two-person limit or cross-message merge. Missing sprite tags create no result; explicit empty tags are success+[], partial valid rows form partial_success, and all invalid rows form invalid_items+[]. Capability prompts cannot reference input.text/history.messages/history.summary; saving/import and compilation reject those references.
- Server persists capability results in assistant.extData.output through SessionService.appendNarrativeAssistant. stateUpdate keeps one ordered updates list; actionSuggestions keeps status/items; characterSprite keeps status/items and optional errors with nonempty-data-row line numbers starting at one. No capability stores a redundant results list. New writes validate the contract; existing state/action read normalization remains scoped to those formats. Invalid persisted sprite structures project processing_error+[] with CHARACTER_SPRITE_STORED_RESULT_INVALID without rewriting storage. Generic entry edits cannot forge/remove output. After assistant commit and lock release, publish state.changed, eligible action_suggestions.created, and applicable character_sprite.changed, then usage/terminal. Sprite success/partial_success events carry complete items, including success+[] for clearing; all-invalid/tag/error outcomes emit no sprite event. A later run-outcome write failure does not suppress an already committed sprite snapshot. Capability failures do not change an otherwise completed run; interrupted model calls do not fabricate output.

- Character sprites are an independent Server capability. Capture the full validated world catalog before the first await even when its prompt is disabled; model-visible metadata excludes asset URLs and character prompts. Query the catalog through GET /api/v1/worlds/:id/character-sprites and a single message through GET /api/v1/sessions/:id/entries/:entryId/character-sprites; the latter uses SessionService.getMessageCharacterSprites, validates session ownership and never inherits another message. Resources reuse the existing world resources endpoint. The Web session host displays floating sprites above the isolated stage and owns the official composer toggle. Resolve committed snapshots by messageId via the shared session channel and history parent chain. An explicit empty snapshot clears the stage.

- Web stage-host owns iframe/MessagePort/appearance only. Session workspace composes feature lifetimes; history owns persisted entries, narrative owns transient model output, state owns effective scope values, suggestions owns only the current display projection. The frame SDK is a command proxy and immutable display mirror; it never repeats business recovery or optimistic state writes.
- The V2 frame and author types share the package root `@sillyrealms/sdk`; its session API returns real V2 accepted IDs and history items/entries, native events and current statuses. Do not synthesize legacy requestId, run.failed/run.phase, extensions or capabilities. Usage composition comes only from the Server persisted main-request context snapshot; its UTF-8 bytes plus conventional message overhead are not per-category billed tokens.
- Latest-reply regeneration reuses the saved user and runId, deletes the old assistant before generation, and reserves a fresh assistantEntryId as execution identity. Session.deleteEntry only maintains the parent chain and tip; narrative owns atomic deletion/outcome reset and publishes message.deleted plus effective state changes after commit under the run lock. Context remains session-state-only. No restoration on failure; retry user-only rounds. Stop requires runId and assistantEntryId. Usage sums surviving entries.
- Deletion receipts and run.created carry actual tipEntryId and deletedMessageIds; clients deduplicate user messages by ID and isolate executions by assistantEntryId. Reconnect/explicit sync replace bounded recent history and invalidate stale pages; afterSeq alone cannot discover deletion or seq reuse.

- A session has one SSE independent of iframe lifetime. Replace persisted runs through bounded recent pages on connection; normal terminal catch-up overlaps the last active seq to observe an outcome-only write; no automatic narrative resubmission. Snapshot replaces model output but does not prove persistence; handoff by message ID follows durable reads. State writes reconcile actual server state; success can mean an ignored missing path. Scope replacement events use path:"".


- Server narrative logs are run-scoped single lines: local timestamp, event and compact JSON with runId/sessionId. Context returns content-free diagnostics for the selected candidate; raw provider payload/final SDK diagnostics stay outside business events and storage. Log full non-delta lifecycle, capability inputs/results and settlement; distinguish prepared output from committed persistence. Redact explicit credentials and isolate serialization/sink/observer failures from execution.

- Presets store optional temperature, topP, frequencyPenalty and presencePenalty independently of the model. Carry the accepted snapshot to both narrative and summary calls. Only the Pi adapter applies verified route- and mode-specific overrides; preserve explicit zero, exact precision and omitted keys through Web and portable files.

- A session stage declares up to five composer buttons with useSRComposerButtons. The Host owns layout and forwards clicks on the bound port for the displayed revision. Author callbacks live in the frame. See [SDK session](docs/sdk/session.md#usesrcomposerbuttonsbuttons).

- AI reply assist uses an independent reply_assist preset and usecases/reply-assist. Session creation and edits use runtimeConfig for narrativePresetId, apiModelConfigId, replyAssistPresetId, replyAssistGoal and fontSize. A session can override the application default at creation or later. A null value follows the current default at submission. Its read-only context uses the session goal (sessions.runtime_config JSON key replay_assist_goal, {{session.reply.assist.goal}}) and current draft. Narrative and reply assist share session admission. Host-only draft events use the session SSE and never enter the stage or persisted history.
