# Conditional mandatory state review for narrative Runs

Status: superseded (2026-11-09) by [mandatory-batched-state-update.md](mandatory-batched-state-update.md). Historical implementation record only.

## Why
The optional update_state tool was sent to the provider, but an auto tool-choice model could finish narration without a tool call. A stronger default preset alone cannot guarantee state consistency.

## Runtime behavior
- Initial narration remains a normal streaming call. Only activated, writable message state enables update_state. Models are not forced to use a tool while composing narrative.
- If **any** update_state tool call occurs during the run, continue the existing tool loop and do not run the fallback check. This bounds extra Token usage but does not guarantee the model considered every field.
- If narration ends with **zero** tool calls and there is at least one active writable message state field, run one compact state review using mandatory tool choice. The review is restricted to definitions of active message fields, their current values, the latest user input, and new narrative, not the full character/world-book/history context.
- The review has only one tool, review_state({updates:[]}). An empty array is a valid "nothing changed" result. A nonempty list of changes is validated against existing atomic state rules and applied atomically in memory, then persisted by the standard Run transaction.
- The provider request uses required on OpenAI-compatible APIs and any on supported Anthropic/Google/Bedrock APIs. This is runtime-managed, not a user preset or model-config option. Unsupported protocol, absent tool call and failed review all fail the Run instead of reporting a successful state review.
- No active writable message fields means no second request and no state tool.
- The fallback adds one extra model request and associated Token usage only when the model fails to call update_state; it is not a fully independent mandatory review on every turn. Provider-specific forced-tool support still requires testing with actual configured models.

## Preset
The standard narrative preset now has generic main and postHistory prompts describing the rules and no-fabricated-update principle. Fresh databases seed the prompts. On existing databases, only the pristine empty built-in sr-default-preset (exact built-in node set and no node content) is upgraded; customized presets are never overwritten. Sessions retain their preset references and pick up the updated config on subsequent Runs.

## Scope and limitations
- No change to world state schemas, app settings, creator-facing SDK, public HTTP API, or model pricing.
- No real paid provider calls in tests; fake-provider integration checks the forced path and persistence.
- This initial implementation does not add a secondary review after a successful tool call and does not retry invalid review submissions. A future enhancement may add configurable review policy and observability.
