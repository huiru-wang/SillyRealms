import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { Measurement } from '../../src/runtime/context/budget.js';

/** Deterministic fake-provider tokenizer. Production never imports or special-cases this path. */
export async function fakeMeasurement(_model: Model<Api>, context: Context): Promise<Measurement> {
  return { tokens: Math.ceil(JSON.stringify(context).length / 4),
    method: 'test-fixture', quality: 'estimated', version: 'fake/1' };
}
