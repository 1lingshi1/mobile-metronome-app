const DEFAULT_HORIZONTAL_THRESHOLD = 72;
const DEFAULT_VERTICAL_TOLERANCE = 64;
const DEFAULT_MAX_DURATION = 900;

export function installSettingsSwipe(options = {}) {
  const direction = options.direction === 'right' ? 'right' : 'left';
  const target = options.target;
  const documentRef = options.documentRef || document;
  const locationRef = options.location || globalThis.location;

  if (!target || !locationRef) {
    return () => {};
  }

  let startPoint = null;

  const handleTouchStart = (event) => {
    if (event.touches.length !== 1) {
      startPoint = null;
      return;
    }

    const touch = event.touches[0];
    const targetElement = touch.target && typeof touch.target.closest === 'function' ? touch.target : null;
    if (targetElement && targetElement.closest('input, button, a, [data-settings-no-swipe]')) {
      startPoint = null;
      return;
    }

    startPoint = {
      x: touch.clientX,
      y: touch.clientY,
      time: globalThis.performance ? globalThis.performance.now() : Date.now()
    };
  };

  const handleTouchEnd = (event) => {
    if (!startPoint || event.changedTouches.length !== 1) {
      startPoint = null;
      return;
    }

    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - startPoint.x;
    const deltaY = touch.clientY - startPoint.y;
    const duration = (globalThis.performance ? globalThis.performance.now() : Date.now()) - startPoint.time;
    startPoint = null;

    if (duration > DEFAULT_MAX_DURATION || Math.abs(deltaY) > DEFAULT_VERTICAL_TOLERANCE) {
      return;
    }

    if (Math.abs(deltaX) < DEFAULT_HORIZONTAL_THRESHOLD || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) {
      return;
    }

    if (direction === 'left' && deltaX < 0) {
      locationRef.assign(target);
    } else if (direction === 'right' && deltaX > 0) {
      locationRef.assign(target);
    }
  };

  documentRef.addEventListener('touchstart', handleTouchStart, { passive: true });
  documentRef.addEventListener('touchend', handleTouchEnd, { passive: true });

  return () => {
    documentRef.removeEventListener('touchstart', handleTouchStart);
    documentRef.removeEventListener('touchend', handleTouchEnd);
  };
}

export default installSettingsSwipe;