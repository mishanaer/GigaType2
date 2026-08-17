const DEFAULT_CONTROL_PANEL_WIDTH = 500;
const MIN_USABLE_DISPLAY_HEIGHT = 360;
const DISPLAY_MARGIN = 48;

function isFiniteRect(rect) {
  return (
    rect &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

function isUsableDisplayArea(rect, requiredWidth = DEFAULT_CONTROL_PANEL_WIDTH) {
  return (
    isFiniteRect(rect) && rect.width >= requiredWidth && rect.height >= MIN_USABLE_DISPLAY_HEIGHT
  );
}

function getUsableDisplayArea(display, requiredWidth = DEFAULT_CONTROL_PANEL_WIDTH) {
  if (isUsableDisplayArea(display?.workArea, requiredWidth)) {
    return display.workArea;
  }

  // During Windows sign-in Explorer can temporarily publish a tiny/empty
  // workArea even though the physical display bounds are already correct.
  // Falling back to bounds prevents a fixed 500px renderer from being
  // permanently squeezed into a 320px BrowserWindow.
  if (isUsableDisplayArea(display?.bounds, requiredWidth)) {
    return display.bounds;
  }

  return null;
}

function calculateControlPanelBounds({ currentBounds, display, requestedHeight, requestedWidth }) {
  const explicitWidth = requestedWidth !== undefined;
  const width = Math.ceil(Number(explicitWidth ? requestedWidth : currentBounds?.width));
  const height = Math.ceil(Number(requestedHeight));

  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(width) || width <= 0) {
    return null;
  }

  const layoutWidth = explicitWidth ? Math.max(DEFAULT_CONTROL_PANEL_WIDTH, width) : width;
  const area = getUsableDisplayArea(display, layoutWidth);
  if (!area) {
    return null;
  }

  const minHeight = explicitWidth ? 1 : 360;
  const maxHeight = Math.max(minHeight, area.height - DISPLAY_MARGIN);
  const nextHeight = Math.max(minHeight, Math.min(height, maxHeight));
  const nextWidth = layoutWidth;
  const centerX = currentBounds.x + currentBounds.width / 2;
  const centerY = currentBounds.y + currentBounds.height / 2;
  const maxX = area.x + area.width - nextWidth;
  const maxY = area.y + area.height - nextHeight;

  return {
    minWidth: layoutWidth,
    minHeight,
    bounds: {
      x: Math.max(area.x, Math.min(Math.round(centerX - nextWidth / 2), maxX)),
      y: Math.max(area.y, Math.min(Math.round(centerY - nextHeight / 2), maxY)),
      width: nextWidth,
      height: nextHeight,
    },
  };
}

module.exports = {
  DEFAULT_CONTROL_PANEL_WIDTH,
  calculateControlPanelBounds,
  getUsableDisplayArea,
  isUsableDisplayArea,
};
