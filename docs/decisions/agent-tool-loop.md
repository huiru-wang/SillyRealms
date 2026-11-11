# General model and tool loop

Status: general capability retained. The [single-request narrative decision](narrative-state-tail-protocol.md) is approved and pending implementation as of 2026-11-11. It replaces mandatory narrative state-tool invocation as a design requirement, without deleting this capability.

## Retained capability

For an explicitly tool-enabled consumer, persist assistant responses, execute returned calls, persist each tool result and append it to the in-memory model conversation. Continue until the model returns no tool calls or execution stops or fails. There is no special continuation prompt for a tool-only response.

The update_state implementation and ToolExecutor remain available. State updates are evaluated independently in input order against an isolated workspace. Valid items apply; invalid items are skipped and logged without paths or values. Repeated paths are processed in order. Invalid outer tool arguments and batches over 100 items are rejected before any updates.

A partially or entirely invalid tool batch returns an error tool result with the applied count and skipped indexes/error codes and emits the existing tool.failed event. Results may be returned to the model only in a flow that actually uses the tool loop. Raw assistant/tool entries remain distinct from visible narrative. Usage accounts for each actual request.

## Narrative target

Narrative does not enter this loop, provide update_state or force tool choice. It makes one model request and handles a plain story plus state tail on the server. Run lifecycle, locks, idempotency, persistence, streams and cancellation remain in the runtime.

Tail validation reuses state-domain semantics without fabricating tool calls/results. A structurally valid array applies valid items in order and reports skipped items; repeated paths remain ordered. Tail protocol failure or a pre-commit stop does not submit state. See the [implementation contract](../technical/narrative-state-tail-runtime.md).

## Current implementation and transition

Before the approved migration is implemented, agent-runner.ts still contains the existing narrative loop and required-state-call check. This is a current-code fact, not a requirement to carry it into the new narrative path.

Separate narrative invocation from the generic loop without deleting the generic code or silently changing its stopping behavior. Retain generic-loop tests; add independent single-request narrative tests. The earlier [batched state-tool decision](mandatory-batched-state-update.md) remains historical context.
