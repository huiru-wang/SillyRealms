# Session Token Usage and Reading Settings

Status: implemented 2026-11-09.

## Platform ownership

Token usage and reading preferences belong to SessionHost. They do not belong to Creator SDK state, world-card state, or model prompt configuration.

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

The UI order is fixed: **system → summary → history**. Only segment proportions are rendered. These byte estimates are not provider tokens and are not used for billing or context-window calculations. Tool schemas and other runtime metadata are not drawn as separate segments; dynamic state text remains in the system segment with its containing preset node.

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
