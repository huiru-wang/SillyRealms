import { expect, it } from 'vitest';
import { captureScrollAnchor, restoreScrollAnchor } from '../../../packages/sr-sdk/src/story-scroll.js';

type FakeMessage = { id: string; top: number; bottom: number };
function fakeContainer(options: { scrollTop: number; scrollHeight: number; clientHeight: number; messages: FakeMessage[] }) {
  const container = {
    scrollTop: options.scrollTop,
    scrollHeight: options.scrollHeight,
    clientHeight: options.clientHeight,
    clientTop: 0,
    getBoundingClientRect: () => ({ top: 100, bottom: 100 + options.clientHeight }),
    querySelectorAll: () => options.messages.map(message => ({
      getAttribute: (name: string) => name === 'data-message-id' ? message.id : null,
      getBoundingClientRect: () => ({ top: 100 + message.top, bottom: 100 + message.bottom }),
    })),
  };
  return container as unknown as HTMLElement & { scrollTop: number; scrollHeight: number };
}

it('restores the first visible message to the same viewport offset after prepending history', () => {
  const messages = [
    { id: 'above', top: -90, bottom: -20 },
    { id: 'anchor', top: -10, bottom: 70 },
    { id: 'below', top: 80, bottom: 150 },
  ];
  const container = fakeContainer({ scrollTop: 180, scrollHeight: 900, clientHeight: 500, messages });
  const anchor = captureScrollAnchor(container);
  expect(anchor).toEqual({ messageId: 'anchor', offsetTop: -10, scrollHeight: 900 });

  messages[1]!.top += 320;
  messages[1]!.bottom += 320;
  container.scrollHeight = 1220;
  restoreScrollAnchor(container, anchor);

  expect(container.scrollTop).toBe(500);
});

it('falls back to scroll-height compensation when the captured message is unavailable', () => {
  const container = fakeContainer({ scrollTop: 200, scrollHeight: 800, clientHeight: 400, messages: [] });
  const anchor = captureScrollAnchor(container);
  container.scrollHeight = 1100;
  restoreScrollAnchor(container, anchor);
  expect(container.scrollTop).toBe(500);
});
