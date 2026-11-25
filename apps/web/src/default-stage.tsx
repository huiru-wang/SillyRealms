import {SR, useSRActionSuggestions} from '@sillyrealms/sdk';

/** The official layout owns the action area; WorldStory stays a reading surface. */
export function DefaultStage() {
  const {items} = useSRActionSuggestions();
  return (
    <div className="sr-default-stage">
      <div className="sr-default-stage-story">
        <SR.WorldStory />
      </div>
      {items.length > 0 && (
        <div className="sr-default-stage-actions">
          <SR.ActionSuggestions />
        </div>
      )}
    </div>
  );
}
