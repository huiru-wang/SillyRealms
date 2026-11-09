export type ScrollAnchor = {
  messageId: string | null;
  offsetTop: number;
  scrollHeight: number;
};

/** Capture the first visible narrative message relative to the scroll viewport. */
export function captureScrollAnchor(container: HTMLElement): ScrollAnchor {
  const viewport = container.getBoundingClientRect();
  const viewportTop = viewport.top + container.clientTop;
  const viewportBottom = viewportTop + container.clientHeight;
  const message = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(node => {
    const rect = node.getBoundingClientRect();
    return rect.bottom > viewportTop && rect.top < viewportBottom;
  });

  return {
    messageId: message?.getAttribute('data-message-id') ?? null,
    offsetTop: message ? message.getBoundingClientRect().top - viewportTop : 0,
    scrollHeight: container.scrollHeight,
  };
}

/** Restore the captured message to its previous viewport offset after prepending history. */
export function restoreScrollAnchor(container: HTMLElement, anchor: ScrollAnchor): void {
  const message = anchor.messageId
    ? Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).find(node => node.getAttribute('data-message-id') === anchor.messageId)
    : undefined;

  if (message) {
    const viewportTop = container.getBoundingClientRect().top + container.clientTop;
    const nextOffset = message.getBoundingClientRect().top - viewportTop;
    container.scrollTop += nextOffset - anchor.offsetTop;
    return;
  }

  // Fallback for an empty viewport or a message removed while the request was pending.
  container.scrollTop += container.scrollHeight - anchor.scrollHeight;
}
