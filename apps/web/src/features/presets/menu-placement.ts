type VerticalBounds = {top: number; bottom: number};

/** Keep the menu inside both its scroll pane and the visible viewport. */
export function presetMenuPlacement(anchor: VerticalBounds, boundary: VerticalBounds, viewport: VerticalBounds, height: number) {
  const top = Math.max(boundary.top, viewport.top), bottom = Math.min(boundary.bottom, viewport.bottom);
  if (anchor.bottom <= top || anchor.top >= bottom) return null;
  const gap = 4, edge = 8;
  const above = Math.max(0, anchor.top - top - edge - gap);
  const below = Math.max(0, bottom - anchor.bottom - edge - gap);
  const upwards = height > below && above > below;
  const maxHeight = upwards ? above : below;
  return maxHeight > 0 ? {above: upwards, maxHeight} : null;
}
