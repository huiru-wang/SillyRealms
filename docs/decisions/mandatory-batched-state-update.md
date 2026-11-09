# One-request mandatory batched state update

Status: implemented (2026-11-09). Supersedes `conditional-state-review.md`.

## Behavior
- The preset `main` internal ID remains unchanged for existing presets, imports, exports, session references and world-book anchors. Its visible default name is **叙事风格**; new/default built-in prompt is empty and editable. The platform fixed system protocol is separate.
- The `worldState` context node emits a structured `【状态更新判断】` decision checklist **only when activated writable message fields exist**, immediately followed by `【可更新状态】` (definitions and current values). Activated global/session state is listed separately as `【只读状态】`.
- A generation with active writable message state sends **one** `update_state` tool and `toolChoice: required` (or the provider's equivalent `any`). The model is told to generate narrative first, then make exactly one `update_state({updates:[{path,value},...]})` call; no-change is `updates:[]`. No separate `review_state` request exists.
- The runtime requires exactly one valid named tool call, with narrative text preceding it and no additional narrative text after it. If the provider ignores the forced tool choice, omits narrative, changes order or sends invalid state, the Run fails rather than claiming success. No separate tool continuation request occurs.
- All updates are validated using the existing state domain in an isolated candidate snapshot; invalid updates, duplicate paths and more than 100 updates reject the entire batch. The authoritative state changes only on a successful Run commit.
- If there is **no** activated writable message state, no tool is supplied or required and generation remains one ordinary narrative call. Summarization/compaction is a separate mechanism and may still make requests as needed.

## Compatibility and limits
- Legacy existing prompts are never overwritten if customized. The built-in default preset's *exact* previous main/postHistory text is safely cleared on DB open, and its old default node labels are updated. Imported legacy `main` nodes with generic labels are displayed/exported as `叙事风格`; their authored prompt content is preserved.
- `update_state` tool arguments changed from a single `{path,value}` to `{updates:[{path,value}]}`; old entries and tool calls in history are stored verbatim and not rewritten. Creator-facing SRStateAPI and HTTP state update APIs remain unchanged.
- The player **内心** composer control and its platform input protocol are removed. The parser continues to recognize historical blockquotes for existing conversation display; old drafts are projected as ordinary text rather than a typed mind block.
- Forced tool-choice does **not** make models reliably generate prose before using tools. Providers that cannot return both prose and a required tool call in one response will fail under this policy. Model-specific offline/real-provider tests are recommended before relying on this for high-value sessions. No paid provider calls were used for implementation tests.
