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
- Reuse semantic tokens in `apps/studio/src/styles/theme.ts` and `tokens.css`, and shared primitives in `components/ui`. Pages own placement, not shared control colors, states or dimensions.
- All five main pages use `PageHeader`. Keep mobile detail content behind navigation with scroll-tail clearance.
- Theme changes must propagate through the validated appearance contract to official renderers without expanding author permissions.
- Keep `docs/design` factual and current: standards and contracts only, no change logs, proposals or investigation narratives.

## V2 Workspace Boundary

- `apps/studioV2` connects only to `apps/serverV2`; keep the original Studio/Server independent. ServerV2 implements single-call narrative submission/stop with user-first persistence, partial assistant output preservation and shared session events; see [Server V2 narrative](docs/runtime/server-v2-narrative.md). The current frontend remains management and author preview only: world library, presets, model configurations, settings, and basic sessions; narrative runtime UI, summaries and narrative extensions are not migrated.
- Reuse the copied Studio UI primitives and semantic tokens within StudioV2. Its five mounted management pages use `PageHeader`; runtime/world-authoring screens are not mounted.
- Follow [StudioV2 management](docs/runtime/studio-v2-management.md) and [Server V2 HTTP](docs/runtime/server-v2-http.md). Verify this integration at function level plus typecheck/lint; do not start services or add mock end-to-end environments for this task.

- World author previews run on a separate static origin with a read-only global-state bridge; no runtime/engine or session-start behavior. Shared SDK resource parsing accepts both original and V2 resource bases.

- StudioV2 world detail preserves the original Studio page structure and interaction model: collapsible overview, character strip, six icon tabs, opening navigation, independent content scrolling and dialogs. Adapt API contracts without replacing these with management panels.

- ServerV2 narrative APIs use `/sessions/:id/narrative` for five-run history, seq catch-up, saved-run details, submission/stop and recorded usage; the session SSE stays independent. Terminal outcomes live only in the user entry's `extData.narrative`, request metrics contain provider instead of status. No runs table, replay or restart recovery.
- StudioV2's isolated static build now includes both `world-component.html` and `frame.html`; runtime/config publishes the stage origin/entryPath/debug. This exposes the document entry only, not a mounted or fully adapted narrative UI/SDK transport.

- ServerV2 state events use the existing session SSE and `{path,scope,value}` contract. Publish actual effective changes only after commit; global fans out to all sessions of the world, message tracks the current tip's inherited view. Empty event path replaces the whole scope; PATCH inputs still require a nonempty path. State writes and stateful entry appends are orchestrated in usecases, never published by repositories or StateService.
