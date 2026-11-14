# Session Token Usage and Reading Settings

Status: implemented 2026-11-09; Runtime v2 compatibility updated 2026-11-13; SDK/Studio presentation updated 2026-11-14. The current UI and Studio acceptance are complete, with both builds passing. The supplemental Web font run passed 7/8; native End-to-bottom/following remains an unresolved verification limitation.

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

The frame build entry imports `@sillyrealms/sdk/world-story.css`. Web and Studio share this scoped official surface. User messages form a narrower, lightly accented surface at the reading column's right edge; narrative messages use a wider, subtle surface on the left. Source labels, left-aligned body text, message identity and Portals remain. The stylesheet accepts limited `--sr-story-*` appearance variables while author-owned outer layouts retain their own styles.

The official state panel uses the actual WorldStory container width: `clientWidth >= 960` enables docked mode, while smaller containers use an initially closed dialog. A narrow author column inside a wide iframe must still use dialog mode. `showState={false}` removes the official trigger, panel, and dialog.

Studio sends validated appearance values to its opaque-origin local preview iframe. Font size still defaults to 16px, ranges from 13px to 21px, previews immediately, and returns to the previous value on Cancel. Studio saves this preview preference only in current-document memory; it does not write the production Web localStorage key or add another persistent namespace. Its context composition is explicitly illustrative, and fixture runs/state/history do not call Server or generate provider billing records. Refresh restores the fixture.

The Host owns the composer in both applications. Studio uses one floating glass row, with collapse on the left, an initially single-line editor that grows with wrapping in the middle, and send/stop on the right. The stage extends behind it. The surface follows mobile navigation's translucency, blur and edge highlights, with readable reduced-transparency and unsupported-filter fallbacks. Top explanations, a separate footer, fill/undo notices and send-success notices are removed; actual send failures remain visible. The shared editor placeholder is “写下你的回应…”.

The same Lexical four-prop interface, semantic nodes, HistoryPlugin, IME and serialization remain. Normal Enter creates a newline, Enter in a semantic block exits the block, and Cmd/Ctrl+Enter sends. Studio removes its independent setDraft undo status/UI; production Web's separate undo UI stays in its existing scope. Input remains editable during generation, and pending/draft revision protection prevents a late send response from clearing later edits. See [WorldStory runtime](worldstory-runtime-v1.md) for the complete boundary.

Studio measures the floating composer's actual obstruction and sends a validated presentation value through the existing appearance channel as `--sr-story-bottom-inset`, defaulting to `0px`. ResizeObserver calculates editor room from stage height and measured non-editor chrome, including errors and margins, using a 96px stage-space budget and a 44px editor minimum. Long drafts scroll internally, and error height is capped for the available viewport so the state dialog's close control remains reachable. The budget is not an absolute 96px guarantee at arbitrarily short heights. Story scrolling, the latest control, docked state and the trusted composed sidebar reserve the measured inset; a modal state dialog reduces its bounds instead of also adding the same internal padding. This does not add a public business SDK operation, relax iframe permissions or force arbitrary author layouts to consume the variable.

## Font stability and scroll anchoring

The iframe root sets text-size-adjust: 100% and -webkit-text-size-adjust: 100% to disable mobile browser automatic text inflation/adjustment. The built-in WorldStory body uses --sr-story-font-size and defaults to 16px instead of the previous fixed 13px. The platform composer input remains 16px on mobile to avoid iOS focus zoom.

Before an appearance change, WorldStory captures the first visible message and its viewport-relative offset, plus whether the reader is at the bottom. After style recalculation:
- If the reader was at the bottom, restore the bottom.
- Otherwise, restore the captured message anchor.

The browser regression fixture renders 200 actual WorldStory messages, verifies stable computed font size at 5/50/200 message counts on desktop and mobile, checks middle-message anchor preservation, bottom anchoring, cancel behavior, and per-session persistence.

## Verification

For the current glass/input-layout and message-boundary revision, Studio and Web builds (including typechecks) passed; Web retains its existing non-blocking large-chunk notice. Studio was rebuilt after the editor-room correction. The production session suite at `http://127.0.0.1:4174` completed with exit 0 and empty stderr (`session-dc8221be68d760aded383f7d`), covering history/Portal/anchors, state, drafts, streaming/stop, themes and security, six widths, the 390×280 short viewport, reduced transparency, and combined send-error/multiline/dialog cases. Desktop, mobile, multiline and short-error screenshots were inspected.

The final working-tree rerun of the eight-case Web font regression used the original runner (`session-f16676fb009ab33281cb3073`) and exited 1 with seven PASS results. Native End-to-bottom/following was not reliable in the current Mac headless automation, and the post-End content-growth assertion did not execute after timeout. This is an unresolved verification item, with no established attribution to a pre-existing defect or the current CSS revision. Temporary runner/trace/CSS experiments were removed; `apps/web/test/composer/run.mjs` has no diff and SDK scroll TypeScript is unchanged. Do not report all gates green. First-phase evidence remains historical; current results and limitations are recorded in the design plan's section 11. No real Safari/Firefox or mobile-keyboard result is implied.

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
