# Context usage and history compaction

When preparing a new message, the server compares the latest narrative model request's reported input plus output tokens with the effective model/preset context window, less the configured output allowance, 1,024 tokens of safety reserve, and 2,048 tokens reserved for the next input. Input includes provider-reported cached input. This is a lagged estimate of the preceding request's context, not a measurement of the message being prepared. It is separate from the Session usage panel, which displays the last request's input tokens.

If the threshold is reached, the server summarizes older history while keeping the latest five user turns intact. The previous summary is included in the new summary, and original entries remain intact. If there are at most five turns, no new summary is created. If the most recent narrative request has no usable usage, the model changes, or a legacy snapshot lacks output usage, the same five-turn rule is used as a fallback. An unavailable latest request clears the old context snapshot; summary requests do not replace it.

Presets select `compact` (131,072), `standard` (262,144), or `extended` (524,288); the effective capacity is the smaller of the strategy target and the selected model's context window. New presets default to `standard`. The first database upgrade to this format replaces old presets with a new standard preset and switches existing sessions, world defaults, and the app default to it in one transaction. Old preset content and preset tag assignments are removed; session history and world data remain. The migration runs only once. Imported presets must use the new format.

Automatic provider overflow retry is not implemented. A new large input, fixed prompt, or output may still exceed the provider window before the next usage-based check. Summary requests are split using a fixed character limit, not a Token count; a provider error fails preparation without discarding original history.

The structural byte proportions shown in the usage panel are illustrative only and do not drive compression.

## Approved narrative transition (pending implementation, 2026-11-11)

The [single-request narrative plan](../../plan/sr-narrative-state-tail-protocol-v1.md) keeps compaction independent. Summary remains an assistant message before native user/assistant history. Dynamic authoritative state and output rules follow retained history and precede current input; only clean stories, never state tails or raw tool records, feed narrative history and summaries.

Narrative Usage comes from its one actual generation request and includes the invisible state tail. Summary requests remain separately accounted; neither a tail failure nor compaction supplies an automatic narrative repair request.

The version-1 preset replacement described above is historical migration behavior, not a template for this rollout. The later explicitly authorized upgrade uses a new version gate, preserves other preset content and non-session data, and clears entries followed by sessions once. This documentation update does not run that cleanup or alter the existing compaction implementation.
