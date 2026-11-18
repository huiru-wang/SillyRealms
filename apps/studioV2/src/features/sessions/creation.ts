type WorldSelection = {
  characters: readonly {id:string;player_selectable?:boolean}[];
  defaultPresetId: string|null;
  defaultApiModelConfigId: string|null;
};

/** A world-page selection must not silently become a different playable character. */
export function initialSessionSelection(world:WorldSelection, characterId?:string) {
  const character=characterId===undefined
    ?world.characters.find(item=>item.player_selectable)
    :world.characters.find(item=>item.id===characterId&&item.player_selectable);
  return {
    character:character?.id??'',
    preset:world.defaultPresetId??'',
    model:world.defaultApiModelConfigId??'',
  };
}
