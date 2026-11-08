# Agent module boundaries

Status: implemented (structural reorganization, no behavior/API changes)

## Layout

```text
apps/server/src/agent/
├── index.ts                         # Public exports for server App / routes
├── runtime/
│   ├── agent-runtime.ts             # Long-lived session/world locks, cancellation, SSE
│   ├── agent-runner.ts              # One Run's stream/tool loop, events and outcome
│   └── types.ts                     # RunTask, PreparedRun, RunEvent
├── context/
│   ├── context-manager.ts           # World/preset/history preparation, budget, compaction
│   ├── prompt-builder.ts            # Prompt nodes, activation application, state rendering
│   ├── history-compactor.ts         # History compression algorithm
│   └── activation.ts                 # Character/lore/state activation rules
├── model/
│   ├── model-client.ts              # Unified streaming and abort boundary
│   └── pi-gateway.ts                # pi-ai SDK adapter and model resolution
├── tools/
│   ├── tool-executor.ts             # Tool call routing
│   └── state-tool.ts                # update_state definition and state update mechanics
├── persistence/
│   └── run-store.ts                 # Entries, sessions, transactions, parent-tip integrity
└── shared/
    └── errors.ts                    # Shared RuntimeError
```

## Dependencies and boundaries

- External server code imports `AgentRuntime`, `RuntimeError`, `PiGateway` and `ModelGateway` from `agent/index.ts`. Internal modules import their concrete dependencies directly to avoid barrel-induced cycles.
- `runtime` coordinates Run lifecycle and streams but does not implement SQL persistence, Prompt rendering or Provider-specific calls.
- `context` owns Prompt construction, history and context budget decisions. Its `ContextManager` consumes `persistence` for reading session/worldline state and `model` for summary requests; it does not commit a Run.
- `model` knows the provider SDK and stream/cancellation mechanics; it does not depend on sessions, persistence or context construction.
- `tools` invokes domain state operations; authoritative validation remains in the state domain, not in the Runner.
- `persistence` owns the atomic writes and branch-history integrity of Agent runs. General SQLite initialization and schema still live in `infrastructure/database`.
- `shared` currently contains only a shared error type. Do not introduce speculative service layers or umbrella utilities.

## Preserved invariants

The V1 session/run endpoints, SSE event names and payloads, persistence-before-stream ordering, world-level mutual exclusion, request idempotency, tip conflict detection, cancellation, message-state commit and interruption recovery remain unchanged by this directory reorganization. Historical input follows the selected branch; compaction is not a separate user-visible turn.

The earlier runtime refactor introduced a synchronous missing-preset preflight in `AgentRuntime.start()`, which is retained here. `RuntimeError` is still exported publicly through `agent/index.ts`.

This directory migration does **not** include a database/schema change, creator SDK change, provider behavior change, or Token usage accounting. Future request-level usage collection belongs at the model call boundary and should persist separately, including compaction and tool continuations.
