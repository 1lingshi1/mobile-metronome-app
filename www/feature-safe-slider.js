const DEFAULT_ACTIVATION_DISTANCE = 10;
const DEFAULT_GESTURE_DOMINANCE = 1.15;
const DEFAULT_THUMB_SIZE = 28;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function getStepPrecision(step) {
  const text = String(step);
  const decimalIndex = text.indexOf('.');
  return decimalIndex === -1 ? 0 : text.length - decimalIndex - 1;
}

export function getSliderValueFromPointer(options) {
  const {
    clientX,
    rect,
    minimum,
    maximum,
    step,
    thumbSize = DEFAULT_THUMB_SIZE
  } = options;
  const safeMinimum = Number.isFinite(minimum) ? minimum : 0;
  const safeMaximum = Number.isFinite(maximum) ? maximum : 1;
  const safeStep = Number.isFinite(step) && step > 0 ? step : 0.01;
  const targetWidth = Math.max(1, rect.width - thumbSize);
  const relativeX = clientX - rect.left - thumbSize / 2;
  const ratio = clamp(relativeX / targetWidth, 0, 1);
  const rawValue = safeMinimum + ratio * (safeMaximum - safeMinimum);
  const steppedValue = safeMinimum + Math.round((rawValue - safeMinimum) / safeStep) * safeStep;
  const precision = getStepPrecision(safeStep);

  return Number(clamp(steppedValue, safeMinimum, safeMaximum).toFixed(precision));
}

export function classifySliderGesture(
  deltaX,
  deltaY,
  activationDistance = DEFAULT_ACTIVATION_DISTANCE,
  dominance = DEFAULT_GESTURE_DOMINANCE
) {
  const horizontal = Math.abs(deltaX);
  const vertical = Math.abs(deltaY);

  if (vertical >= activationDistance && vertical > horizontal) {
    return 'scroll';
  }

  if (horizontal >= activationDistance && horizontal > vertical * dominance) {
    return 'adjust';
  }

  return 'pending';
}

export function installSafeSlider(slider, options = {}) {
  const documentRef = options.documentRef || slider.ownerDocument || globalThis.document;
  if (!slider || !documentRef || !slider.parentNode || typeof documentRef.createElement !== 'function') {
    return () => {};
  }

  const wrapper = documentRef.createElement('div');
  wrapper.className = 'settings-slider-wrap';

  const guard = documentRef.createElement('div');
  guard.className = 'settings-slider-guard';
  guard.setAttribute('aria-hidden', 'true');
  guard.setAttribute('data-settings-no-swipe', '');

  slider.parentNode.insertBefore(wrapper, slider);
  wrapper.appendChild(slider);
  wrapper.appendChild(guard);

  let gesture = null;

  const dispatchSliderEvent = (type) => {
    const EventConstructor = options.EventConstructor || globalThis.Event;
    const event = EventConstructor
      ? new EventConstructor(type, { bubbles: true })
      : { type, bubbles: true };
    slider.dispatchEvent(event);
  };

  const updateFromPointer = (clientX, rect) => {
    const nextValue = getSliderValueFromPointer({
      clientX,
      rect,
      minimum: Number(slider.min),
      maximum: Number(slider.max),
      step: Number(slider.step)
    });

    if (String(nextValue) === String(slider.value)) {
      return false;
    }

    slider.value = String(nextValue);
    dispatchSliderEvent('input');
    return true;
  };

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    gesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: slider.getBoundingClientRect(),
      active: false
    };
  };

  const handlePointerMove = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }

    if (!gesture.active) {
      const intent = classifySliderGesture(
        event.clientX - gesture.startX,
        event.clientY - gesture.startY
      );

      if (intent === 'scroll') {
        gesture = null;
        return;
      }

      if (intent !== 'adjust') {
        return;
      }

      gesture.active = true;
      if (typeof guard.setPointerCapture === 'function') {
        guard.setPointerCapture(event.pointerId);
      }
    }

    if (event.cancelable) {
      event.preventDefault();
    }
    updateFromPointer(event.clientX, gesture.rect);
  };

  const handlePointerEnd = (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }

    if (gesture.active) {
      updateFromPointer(event.clientX, gesture.rect);
      dispatchSliderEvent('change');
    }
    gesture = null;
  };

  const handlePointerCancel = () => {
    gesture = null;
  };

  const preventClick = (event) => {
    event.preventDefault();
  };

  guard.addEventListener('pointerdown', handlePointerDown, { passive: true });
  guard.addEventListener('pointermove', handlePointerMove, { passive: false });
  guard.addEventListener('pointerup', handlePointerEnd, { passive: true });
  guard.addEventListener('pointercancel', handlePointerCancel, { passive: true });
  guard.addEventListener('click', preventClick);

  return () => {
    guard.removeEventListener('pointerdown', handlePointerDown);
    guard.removeEventListener('pointermove', handlePointerMove);
    guard.removeEventListener('pointerup', handlePointerEnd);
    guard.removeEventListener('pointercancel', handlePointerCancel);
    guard.removeEventListener('click', preventClick);
    if (wrapper.parentNode) {
      wrapper.parentNode.insertBefore(slider, wrapper);
      wrapper.remove();
    }
  };
}

export function installSafeSliders(sliders, options = {}) {
  return sliders.filter(Boolean).map((slider) => installSafeSlider(slider, options));
}

export default installSafeSliders;
