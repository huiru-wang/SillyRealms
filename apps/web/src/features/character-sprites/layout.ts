import type {CharacterSpriteItem} from '../../../../../packages/sr-sdk/src/stage-contract.ts';

type Side = 'left' | 'right';
type PositionedSprite = {side: Side; item: CharacterSpriteItem};

/** Keep the action group centered by reserving the toggle width on both edges. */
export function stackComposerActions(width: number, toggleWidth: number, buttons: number[], gap: number) {
  if (!buttons.length) return false;
  const groupWidth = buttons.reduce((sum, size) => sum + size, 0) + gap * (buttons.length - 1);
  return groupWidth + 2 * (toggleWidth + gap) > width;
}

/** Narrow stages show one figure on the right; wide stages can show one on each side. */
export function layoutSprites(items: readonly CharacterSpriteItem[], width: number, height: number): PositionedSprite[] {
  if (!width || height < 220 || !items.length) return [];
  if (width < 1040) {
    const item = items[0];
    return [{item, side: 'right'}];
  }
  const slots = new Map(items.map(item => [item.position, item]));
  const middle = [slots.get('center'), slots.get('truecenter'), slots.get('top')].filter((v): v is CharacterSpriteItem => !!v);
  let left = slots.get('left') ?? slots.get('topleft');
  let right = slots.get('right') ?? slots.get('topright');
  right ??= middle.shift();
  left ??= middle.shift();
  const result: PositionedSprite[] = [];
  if (left) result.push({item: left, side: 'left'});
  if (right) result.push({item: right, side: 'right'});
  return result;
}
