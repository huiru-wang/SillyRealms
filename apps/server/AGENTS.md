# Server Engineering Instructions

- Read root `AGENTS.md`, the current task plan, and relevant source/tests before changing behavior; use current documents in `docs/` when applicable.
- Stack: TypeScript ESM, Hono, Pi Agent packages, SQLite, Zod, Vitest. Node >=22.19. Use pnpm.
- Keep HTTP route handlers thin. Keep domain rules in domain/services and runtime orchestration in the agent/runtime layer. Follow existing patterns before introducing new layers.
- Treat SQLite files in `db/` as user data. Never delete, recreate, migrate, or seed the real local DB in routine tests. Tests use temporary isolated DBs.
- Never log API keys, credentials, full private prompts, or sensitive user content. Debug logging must be opt-in and redacted.
- Validate external inputs at boundaries. Preserve structured error semantics and API compatibility.
- Preserve run/session mutual exclusion, request idempotency, expected-tip conflict checks, persistence-before-streaming, cancellation, interruption and history ancestry unless approved otherwise.
- Keep Raw Pi Entries, narrative projection and state snapshots distinct.
- State updates must be validated and committed by Server. Events must correspond to committed data; do not claim durable replay unless implemented.
- Any schema change requires explicit migration/backup/rollback design and tests using temporary databases.
- For API or SDK changes, inspect Web and SDK consumers and add contract/integration tests.
- Before completion run Server typecheck, lint and test; report skipped checks.
- Do not commit or push unless explicitly requested.
