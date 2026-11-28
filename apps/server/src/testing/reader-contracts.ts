import type { ModelReader } from '../modules/models/service.js';
import type { PresetReader } from '../modules/presets/service.js';
import type { SessionReader } from '../modules/sessions/service.js';
import type { WorldReader } from '../modules/worlds/service.js';

/** Compile-time contracts only; this function is never executed. */
export function readerContracts(world: WorldReader, session: SessionReader, preset: PresetReader, model: ModelReader): void {
  world.getState('world');
  world.require('world');
  session.get('session');
  session.require('session');
  session.getState('session');
  session.getEntry('session', 'entry');
  preset.require('preset');
  model.require('model');

  // @ts-expect-error A WorldReader cannot persist state.
  world.setState('world', {});
  // @ts-expect-error A WorldReader cannot delete worlds or their files.
  world.delete('world');
  // @ts-expect-error A SessionReader cannot persist session state.
  session.setState('session', {});
  // @ts-expect-error A SessionReader cannot persist entry state.
  session.setEntryState('session', 'entry', null);
  // @ts-expect-error A SessionReader cannot settle abandoned runs.
  session.recoverInterruptedRuns();
  // @ts-expect-error A SessionReader cannot delete a session.
  session.delete('session');
  // @ts-expect-error A PresetReader cannot create the default preset.
  preset.ensureBuiltins();
  // @ts-expect-error A PresetReader cannot change preset metadata.
  preset.update('preset', { name: 'Changed' });
  // @ts-expect-error A ModelReader cannot change connection metadata.
  model.update('model', { name: 'Changed' });
  // @ts-expect-error A ModelReader cannot delete a model.
  model.delete('model');
}
