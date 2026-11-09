# General model and tool loop

Status: implemented (2026-11-10), with mandatory state-tool choice restored on user request. Supersedes the one-request and stop-after-tool rules in `mandatory-batched-state-update.md`.

For each user Run with active writable message state, require at least one `update_state` tool call. Use `{"updates":[]}` when nothing changes. Where supported, the initial request sets the provider's required tool choice; once the state tool is called, subsequent requests use the provider's normal tool selection so the agent can finish. If the model ends without the required call, the Run fails. When no writable message state is active, no state tool is supplied or required.

Persist each assistant response and stream its narrative. When it requests tools, execute every returned call, persist each result, append the assistant response and tool results to the in-memory model conversation, and request the model again. Continue until the model returns no tool calls or the Run is stopped or fails. There is no special continuation prompt for a tool-only response.

State-tool arguments and validation are unchanged: updates are applied to the isolated Run workspace and committed under the existing completion/stopping rules; invalid calls return tool errors to the model and emit the existing failure event. Raw assistant and tool entries remain distinct from user-visible narrative. Each model request is accounted separately, including continuations, and the last narrative request supplies the latest context usage. No SDK, HTTP route, event schema, or historical entry migration is required. Cancellation and provider failure retain their existing Run semantics. No paid provider calls were made for verification.
