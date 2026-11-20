import {WorldStory} from './world-story.js';
export {RichText} from '../rich-text.js';
export {SRAssetProvider, useSRAssetUrl, useSRAssetBaseUrl} from '../asset-context.js';
export {WorldDocumentRenderer} from './document.js';
export type {WorldDocumentRendererProps} from './document.js';
export {WorldDocumentContent} from '../world-state.js';
export type {MessageComponentProps} from '../story-context.js';
export type {SRWorldStateAPI, WorldStateQuery} from '../world-state.js';
export {
  useSRSession, useSRStateAPI, useSRState, useSRWorldStateAPI, useSRHistory, useSRStageSnapshot,
} from './context.js';
export type {SRSessionAPI, SRStateAPI} from './runtime.js';
export type {
  AcceptedRun, RunPage, RunQuery, RunStatus, SessionEvent, NarrativeEvent,
  StateScope, StateValue, StateSnapshot, StateWriteResult, StateChangedEvent,
  Suggestions, SuggestionsCreatedEvent, StageSnapshot, StageRun, StageMessage,
} from '../stage-contract.js';

/** V2 facade mapped to author imports inside the V2 frame; the legacy root entry stays unchanged. */
export const SR = {WorldStory};
