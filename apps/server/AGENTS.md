# Server Engineering Instructions

- Read root `AGENTS.md`, the current task plan, and relevant source/tests before changing behavior; use current documents in `docs/` when applicable.
- Stack: TypeScript ESM, Hono, Pi Agent packages, SQLite, Zod, Vitest. Node >=22.19. Use pnpm.
- Keep HTTP route handlers thin. Keep domain rules in domain/services and runtime orchestration in `src/runtime/`. Follow existing patterns before introducing new layers.
- Treat SQLite files in `db/` as user data. Never delete, recreate, migrate, or seed the real local DB in routine tests. Tests use temporary isolated DBs.
- Never log API keys, credentials or cookies. Explicit `SILLYREALMS_DEBUG=1` enables user-authorized full model input/output logs; redact credential fields and the active API key. All HTTP, event and model debug records occupy one physical line. Scope model calls by Run/request/phase and bound accepted Runs with BEGIN/END; see `docs/technical/debug-logging.md`.
- Validate external inputs at boundaries. Preserve structured error semantics and API compatibility.
- Preserve run/session mutual exclusion, request idempotency, expected-tip conflict checks, persistence-before-streaming, cancellation, interruption and history ancestry unless approved otherwise.
- Keep Raw Pi Entries, narrative projection and state snapshots distinct.
- State updates and terminal events must be committed by Server. Streaming narrative deltas/running snapshots are provisional memory only; do not claim durable replay.
- Any schema change requires explicit migration/backup/rollback design and tests using temporary databases.
- For API or SDK changes, inspect Web and SDK consumers and add contract/integration tests.
- Before completion run Server typecheck, lint and test; report skipped checks.
- Do not commit or push unless explicitly requested.

- Context preparation uses `runtime/context/compaction/` once per Run; single-call summary, no batching or continuation compaction. Count full input but reduce only eligible history. Final activation uses only the selected context.
- Persist accepted input and usage journal atomically in schema v3 `run_preparations` before 202. Preparation failure retains input; GET may return it, SSE and Usage must not add it. Do not publish terminal results that failed to persist.

- Do not restore the removed BPE/tokenizer measurement path. Fixed estimation lives in compaction/estimator.ts; keep payload preview/fingerprints and verified Direct message ordering independent of token counting.

- History endpoints read a bounded suffix of complete Runs via `domain/session/history-page.ts`; cursor membership checks read headers only. Do not reload full ancestry payloads for display pagination. Full-chain validation remains part of Run preparation.
- Model-config deletion uses a synchronous credential deletion inside the SQLite delete transaction, with SQL deletion checked first. No await may split this sequence. Keychain and SQLite are separate resources, not a distributed atomic transaction.

- Narrative text is persisted once per model response at completion, or at stop/failure; never update Entry payload per delta. Keep stable IDs in the Run memory snapshot and final storage. Accepted inputs and Usage journals remain durable before/through generation.
