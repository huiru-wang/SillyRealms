import { describe, expect, it, vi } from 'vitest';
import { EventHub } from './event-hub.js';

describe('EventHub', () => {
  it('delivers complete events in order only to the selected session and instance', () => {
    const hub = new EventHub();
    const current = vi.fn(), other = vi.fn(), separate = vi.fn();
    hub.subscribe('session-a', current);
    hub.subscribe('session-b', other);
    new EventHub().subscribe('session-a', separate);
    const events = [
      { event: 'run.completed', data: { runId: 'first' } },
      { event: 'state.changed', data: { value: 12 } },
      { event: 'run.created', data: { runId: 'second' } },
    ];
    for (const event of events) hub.publish('session-a', event);
    expect(current.mock.calls).toEqual(events.map(event => [event]));
    expect(other).not.toHaveBeenCalled();
    expect(separate).not.toHaveBeenCalled();
  });

  it('does not propagate subscriber exceptions to business code or other subscribers', () => {
    const hub = new EventHub();
    hub.subscribe('session', () => { throw new Error('subscriber failed'); });
    const healthy = vi.fn();
    hub.subscribe('session', healthy);
    expect(() => hub.publish('session', { event: 'result.saved', data: {} })).not.toThrow();
    expect(healthy).toHaveBeenCalledOnce();
  });

  it('removes duplicate subscriptions independently and makes stale cleanup harmless', () => {
    const hub = new EventHub(), listener = vi.fn();
    const first = hub.subscribe('session', listener);
    const second = hub.subscribe('session', listener);
    first();
    hub.publish('session', { event: 'first', data: {} });
    expect(listener).toHaveBeenCalledOnce();
    second();
    hub.subscribe('session', listener);
    first(); second();
    hub.publish('session', { event: 'second', data: {} });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not replay events published before subscribing', () => {
    const hub = new EventHub(), listener = vi.fn();
    hub.publish('session', { event: 'old', data: {} });
    hub.subscribe('session', listener);
    expect(listener).not.toHaveBeenCalled();
    hub.publish('session', { event: 'new', data: {} });
    expect(listener).toHaveBeenCalledWith({ event: 'new', data: {} });
  });
});
