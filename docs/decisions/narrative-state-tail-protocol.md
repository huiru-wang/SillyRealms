# Narrative generation with a state tail

Status: approved design, pending implementation (2026-11-11). This documentation revision does not execute migrations or delete sessions.

Detailed contract: [implementation plan](../../plan/sr-narrative-state-tail-protocol-v1.md). Implementation mapping: [narrative runtime](../technical/narrative-state-tail-runtime.md).

## Decision

A narrative Run makes exactly one narrative model request. The model emits plain Markdown story followed by one state tail when writable message state is active. There is no story wrapper. The runtime streams and persists only confirmed story text, validates the complete tail, processes its array in order, commits eligible state and terminates the Run.

The narrative path is not an Agent loop. It supplies no update_state tool, requests no forced tool choice, executes no tools and sends no tool results back to a model. Existing update_state, ToolExecutor and the general model/tool loop remain available as separate capabilities. Context compaction remains an independent request mechanism.

Run lifecycle, world/session mutual exclusion, idempotency, tip checks, persistence-before-streaming, Usage, cancellation and recovery remain runtime responsibilities.

## Message order

The fixed built-in skeleton is:

1. Platform narrative rules as the first system message.
2. Style as a separate system message.
3. Optional custom preset messages, retaining their original role and relative order.
4. Separate system messages for player, active characters and active lore.
5. Assistant summary when present.
6. Native user/assistant history in its original order.
7. Platform system message containing the authoritative current state and output rules.
8. Current user input, once and last.

Custom messages occupy only the front area after style, not the history or trailing state/input area. All activated lore is placed in world_info, sorted by load.order then original item index. Actual Provider payloads must preserve the required roles and positions; internal trace ordering alone is insufficient.

## State and failure semantics

A unique complete tail, valid JSON array, size/item bounds and normal model termination are prerequisites to applying any item. The JSON payload limit is 262,144 UTF-8 bytes, including whitespace, and 100 array items.

Once the array is accepted, valid items are processed in order and invalid items are skipped and reported. Repeated and parent/child paths keep their input order; each value is a complete replacement. Item validation failure does not reject other valid items or fail an otherwise successfully committed Run. Results are persisted and returned with the Run; no tool failure event is fabricated.

Missing, truncated, malformed, oversized or repeated tails and illegal trailing content leave state unchanged, preserve confirmed story and fail the Run with a state-unsynchronized notice. No automatic retry or additional model repair request is made. Stop observed before the final commit discards all candidate state, even after parsing; a committed result is not rolled back by a later stop.

Raw responses, when retained, are always nonNarrative. Both future prompt history and displayed history use the clean story projection.

## Presets, lore and input

- Remove worldState and postHistory definitions, defaults, editor controls and orchestration, and remove these nodes from existing presets in the later migration.
- Preserve other preset content, identities, tags, budgets and custom roles; normalize custom order into the designated front area.
- Remove retired lore anchor/position configuration, including worldState. Preserve entries, content, activation and order; normalize both existing runtime data and legacy imports with explicit reports.
- Preserve original world source files and their hashes. Normalized detail/export and original-source download intentionally serve different representations.
- Remove sr_instruction-specific composer, parsing and display functionality. Ordinary narration/dialogue input remains.

## One-time session cleanup

After implementation is explicitly authorized, perform a versioned upgrade while holding the data-directory lock and before constructing Runtime or serving HTTP. Back up consistently, normalize the approved preset/lore fields, explicitly delete all entries followed by all sessions, verify protected data and record the new version in the same transaction. entries.session_id has no cascading foreign key.

Preserve worlds and their global state, presets other than the specified structural edits, model configurations, credentials, app settings, world/preset tags and source files. Never delete worlds or the database directory as a shortcut. Do not reuse the old version-1 preset-replacement migration. Fresh databases and unsupported legacy databases require distinct handling.

Only old session-specific browser preferences and transient session views are invalidated. No general localStorage reset is permitted. This is a destructive operation planned for the implementation upgrade, not performed by this documentation change.

## Supersession and rollout

This decision replaces mandatory narrative state-tool invocation, preset-controlled world-state placement and the old instruction-session compatibility requirement as design constraints. It does not remove the [general tool-loop capability](agent-tool-loop.md).

Current runtime code still uses the previous narrative tool path until the implementation tasks and acceptance checks in the plan are completed. The previous tool-loop and batched-tool decisions are implementation history, not requirements to preserve that narrative behavior.
