/** Reconcile sanitized message DOM; React owns the children of keyed portal slots. */
export function updateMessageDOM(container: HTMLElement, content: DocumentFragment): void {
  const slots = new Map(Array.from(container.querySelectorAll('[data-sr-slot]'))
    .map(node => [node.getAttribute('data-sr-slot'), node]));
  const key = (node: Node | null) => node instanceof Element ? node.getAttribute('data-sr-slot') : null;
  const compatible = (a: Node, b: Node) => a.nodeType === b.nodeType && a.nodeName === b.nodeName && key(a) === key(b);
  const children = (parent: Node, source: Node) => {
    let cursor = parent.firstChild;
    for (const next of Array.from(source.childNodes)) {
      const slot = key(next), saved = slot ? slots.get(slot) : undefined;
      const target = saved && compatible(saved, next) ? saved
        : cursor && compatible(cursor, next) ? cursor : next.cloneNode(false);
      if (target !== cursor) parent.insertBefore(target, cursor);
      if (!slot || !saved || target !== saved) {
        if (target instanceof Element && next instanceof Element) {
          for (const attribute of Array.from(target.attributes))
            if (!next.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
          for (const attribute of Array.from(next.attributes))
            if (target.getAttribute(attribute.name) !== attribute.value) target.setAttribute(attribute.name, attribute.value);
        } else if (target.nodeValue !== next.nodeValue) target.nodeValue = next.nodeValue;
        if (!target.isEqualNode(next)) children(target, next);
      }
      cursor = target.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; parent.removeChild(cursor); cursor = next; }
  };
  children(container, content);
}
