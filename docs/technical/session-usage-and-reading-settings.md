# Session Token Usage and Reading Settings

Status: implemented 2026-11-09; Runtime v2 compatibility updated 2026-11-13; SDK surface and Studio preview scope clarified 2026-11-14.

## Platform ownership

Token usage and reading preferences belong to SessionHost. They do not belong to Creator SDK state, world-card state, or model prompt configuration. The Server endpoints and persisted preference behavior below describe the production Web Host. Studio's isolated session preview uses the same SDK reading surface with local fixture data; its distinct storage boundary is described separately below.

## Usage data

SessionHost reads the existing GET /api/v1/sessions/:id/usage endpoint:
- On session mount.
- When usage.updated arrives.
- When a Run reaches a terminal event.
- When the SSE connection is re-established.

There is no polling on text deltas. A usage request failure only affects the usage panel.

### Current context composition

The provider returns one actual aggregate input-token count. It does not attribute billable tokens to system, summary, and retained history. The server therefore attaches an explicitly illustrative composition to the latest generation request:

1. systemBytes: UTF-8 serialized message size for platform System Main and preset nodes other than chatHistory and userInput.
2. summaryBytes: serialized size of the retained summary item, or zero if there is no summary.
3. historyBytes: serialized size of retained history other than the summary, plus the current user input.

The UI order is fixed: **system → summary → history**. Only segment proportions are rendered. These byte estimates are not provider tokens and are not used for billing or context-window calculations. Tool schemas and other runtime metadata are not drawn as separate segments. Direct places authoritative state/output rules after history; this remains in the system composition category. Agent retains its preset-node layout.

The composition is persisted alongside the actual latestContext Usage snapshot in the existing sessions.usage_json. Continuation requests include additional assistant/tool messages and currently do not have a composition breakdown; the latest usage remains accurate and the panel displays an unavailable composition state. Older snapshots without composition behave the same way.

### Cumulative usage

The provider-reported totalTokens remains the headline total. The visual input breakdown is:
- Ordinary input = max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
- Cache read
- Cache write
- Output

Cache read and cache write are subsets of inputTokens. They are split out of ordinary input for display, never added to the input total a second time. The visual bar is based on the disjoint input/output components; it does not rewrite the provider-reported total if the provider reports a different aggregate.

## Responsive usage panel

- Desktop: compact two-column panel below the platform top bar. Context composition and cumulative usage are visible without a large card.
- Mobile: one-line collapsed summary by default.
- Expanded mobile details are an absolutely positioned panel below the summary row. The summary row remains in layout, so expanding details does not resize the iframe or shift the story scroll position.
- The panel uses stable semantic colors and textual labels; color is never the only encoding.

## Session settings dialog

The existing title, preset, and model controls are moved from the inline settings row into a native modal dialog. The dialog supports Escape, backdrop click, focus behavior, and mobile sizing.

Reading font:
- Default: 16px.
- Range: 13–21px, step 1px.
- Saved to localStorage under a session-specific key.
- Live preview applies immediately; Cancel restores the previously saved value.
- The font preference applies to the built-in WorldStory message body only. Creator-authored custom React UI is not forcibly restyled; it can opt in using --sr-story-font-size.

Host sends appearance {fontSize} over the existing MessageChannel. The frame validates the range and sets --sr-story-font-size on the document root.

## Shared SDK surface and Studio preview

The frame build entry imports `@sillyrealms/sdk/world-story.css`. Web and Studio use this SDK subpath for the official `.sr-story` surface; Studio does not import legacy Web platform styles. The stylesheet keeps author-owned page layouts outside its scope and accepts the limited `--sr-story-*` appearance variables.

The official state panel uses the actual WorldStory container width: `clientWidth >= 960` enables docked mode, while smaller containers use an initially closed dialog. A narrow author column inside a wide iframe must still use dialog mode. `showState={false}` removes the official trigger, panel, and dialog.

Studio sends validated appearance values to its opaque-origin local preview iframe. Font size still defaults to 16px, ranges from 13px to 21px, previews immediately, and returns to the previous value on Cancel. Studio saves this preview preference only in current-document memory; it does not write the production Web localStorage key or add another persistent namespace. Its context composition is explicitly illustrative, and fixture runs/state/history do not call Server or generate provider billing records. Refresh restores the fixture.

The Host owns the composer in both applications. Studio reuses the existing Lexical component with local styles; normal Enter creates a newline, Enter in a semantic block exits the block, and Cmd/Ctrl+Enter sends. Removing the speech/instruction shortcuts preserves manual plain-text escaping and external formatted drafts. The input remains editable during active generation, and send responses may clear only the submitted draft revision. See [WorldStory runtime](worldstory-runtime-v1.md) for the complete input and preview boundary.

## Font stability and scroll anchoring

The iframe root sets text-size-adjust: 100% and -webkit-text-size-adjust: 100% to disable mobile browser automatic text inflation/adjustment. The built-in WorldStory body uses --sr-story-font-size and defaults to 16px instead of the previous fixed 13px. The platform composer input remains 16px on mobile to avoid iOS focus zoom.

Before an appearance change, WorldStory captures the first visible message and its viewport-relative offset, plus whether the reader is at the bottom. After style recalculation:
- If the reader was at the bottom, restore the bottom.
- Otherwise, restore the captured message anchor.

The browser regression fixture renders 200 actual WorldStory messages, verifies stable computed font size at 5/50/200 message counts on desktop and mobile, checks middle-message anchor preservation, bottom anchoring, cancel behavior, and per-session persistence.

## Verification

Browser tests:
- Host usage order and usage.updated refresh.
- Modal settings and font preview/cancel.
- Desktop and mobile panel layout.
- Mobile expansion overlays without changing iframe height.
- 200-message WorldStory at 1280px and 375px, with 5/50/200 DOM-count checks.
- Font changes preserve both a middle reading anchor and bottom anchoring.

## Runtime v2 and current-request budgeting

Direct uses one actual generation request for both visible narrative and the hidden extension tail. Agent continues to account for each generation/tool continuation. Summary requests remain separate. The budget meter is independent of these actual Usage totals and is explicitly estimated; it never fabricates a provider usage record.

Context composition classifies the fixed platform state/output message as system, keeps assistant summary separate, and classifies native history/current input consistently. Custom preset text remains in the structural preset/system category regardless of its model role. See [current-request compaction](context-compaction.md).

The additive v1 → v2 upgrade preserves sessions, entries, usage fields, presets and reading preferences. No session/font-key cleanup is part of this rollout. Session settings now add Direct/Agent selection and inherited capability overrides; capability-only changes can be saved while busy for the next Run. API and migration details are in [Runtime v2 contracts](../data-formats/runtime-v2-contract.md).
