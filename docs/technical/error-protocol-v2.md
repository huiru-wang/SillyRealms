# Error Protocol V2

This is the only supported public HTTP/SSE error contract. V1 `code/message/data` envelopes,
legacy `{error:{...}}` payloads, and SSE `error` or `tool.failed.code` fields are not supported.

## Ordinary HTTP JSON endpoints

Every ordinary API and `/health` JSON response has exactly four top-level properties:

```ts
type ApiResponse<T> =
  | { success: true; errorCode: null; errorMessage: ''; data: T }
  | { success: false; errorCode: ErrorCode; errorMessage: string; data: T | null };
```

`data` is always the only location for business payloads, including structured context
for failures (e.g., missing configuration fields, reference counts, validation paths).
The human-readable message is the mapped description plus any explicitly approved
public detail. Never send raw exception messages from providers, database drivers,
or credential stores. HTTP status codes continue to convey transport semantics.

The common response middleware wraps successful business JSON responses. New error
paths must call `failure(code, publicDetail?, data?)` rather than create ad hoc
error objects. The error code registry and its descriptions live in
`apps/server/src/common/error-codes.ts`.

Successful world-card export and source-file download responses deliberately
remain raw content, not envelopes. Failed export/source requests return the
normal four-field JSON error. SSE responses remain `text/event-stream`.

## Session SSE

`run.failed` contains its existing run ID and projected messages plus:

```json
{ "runId": "run-id", "messages": [], "errorCode": "PROVIDER_ERROR", "errorMessage": "模型服务调用失败" }
```

`tool.failed` contains run ID, tool call ID, tool name, and the same two error
fields. Other event types do not need empty error fields. In an explicitly
tool-enabled general flow, tool failure is not automatically a Run failure:
the tool result is passed to the model using that flow's standard loop. This
is not a requirement for the approved single-request narrative path.

Known errors are preserved through Agent Runtime, Runner and tools. Unknown
exceptions map to a safe registered code, and gateway exceptions use
`PROVIDER_ERROR`. Run failures after the user entry is committed are also
written to `ext_data.run.errorCode/errorMessage` and returned by Run status
queries. Asynchronous preflight errors can send SSE failure notifications
without creating a persisted Run, consistent with the existing run lifecycle.

## Web and creator SDK

`apps/web/src/api.ts` validates the new HTTP envelope, unwraps only `data`,
and throws an `ApiError` with `errorCode/errorMessage` on failure. The Host
uses `run.failed.errorMessage` in its notice. Creator SDK run event types
require both new fields. There is no legacy-field fallback.

## Partial state-update requests

The top-level HTTP request can succeed with `success:true` while individual
updates inside `data` fail independently. Each item reports
`success/errorCode/errorMessage` using the same success/failure conventions.
State commits and notifications retain their existing per-item semantics.

## Narrative state-tail contract (approved, pending implementation)

The [new narrative runtime](narrative-state-tail-runtime.md) supplies no tools and emits no fabricated tool.failed event. Complete JSON arrays use ordered per-item validation: valid items commit, invalid items are reported in the persisted Run stateUpdate result. A successfully committed array with skipped items completes the Run with a partial-sync notice.

Missing, truncated, malformed, oversized or repeated tails preserve confirmed story, leave state unchanged and fail the Run with registered state-tail errorCode/errorMessage. The planned codes and result shape are defined in the [plan](../../plan/sr-narrative-state-tail-protocol-v1.md). Provider and persistence errors retain their own safe codes. No retry or repair model request is introduced.

Run queries and terminal SSE must expose the same persisted stateUpdate result; Host and SDK types must be updated together when implemented. A stop before commit discards candidates; a stop after commit does not revert state or the terminal outcome. state.changed follows successful authoritative commit and actual changes.

These are target contract changes only; this document does not claim the new fields or error codes are already implemented.
