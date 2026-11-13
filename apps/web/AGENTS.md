# Web / Creator UI Engineering Instructions

- Read root `AGENTS.md`, the current task plan, and relevant source/tests before changing behavior; use current documents in `docs/` when applicable.
- Stack: React 19.2, React DOM 19.2, Vite, TypeScript, Tailwind CSS 4, React Router, SR SDK and UI compiler.
- Distinguish trusted Platform Host code from untrusted Creator iframe code. Host owns authentication, Server HTTP/SSE, authoritative stores and permission projection. Creator UI uses public SR SDK only.
- Never expose protected Server endpoints, credentials, private state, or Host internals to creator code. Preserve iframe sandbox, CSP, import allowlist, MessageChannel validation and error fallback.
- Do not create a second React/ReactDOM runtime inside the creator bundle. Use platform-provided compatible runtime and existing compiler conventions.
- Use public `SRSessionAPI` and `SRStateAPI`. Do not add a public EventHub or private host bridge API without an approved design decision.
- Hooks must subscribe/unsubscribe safely, avoid render-time side effects, preserve stable references, and avoid whole-page rerenders for token-level updates.
- UI work must follow approved design direction and tokens. Avoid generic AI dashboard layouts, excessive cards, gratuitous gradients, arbitrary shadows and inconsistent radii.
- Every important page needs loading, empty, error, disabled, active and success states where applicable. Verify keyboard/focus behavior and narrow layouts (at least 375px) and desktop (at least 1280px).
- Validate real browser rendering and interactions for visual changes; typecheck/build alone is not Visual QA.
- Before completion run Web typecheck and build; run root checks when cross-package behavior changes.
- Do not commit or push unless explicitly requested.

- Reconnect publishes `run.snapshot` through the public SDK event contract, including unfinished narrative content. WorldStory merges snapshots/deltas by stable IDs and UTF-16 offsets, repairs gaps through public history reads, and never resurrects a terminal Run. Keep history rows memoized and React portal slots stable during DOM reconciliation.
