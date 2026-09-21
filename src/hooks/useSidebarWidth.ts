import { useCallback, useEffect, useRef, useState } from 'react';

const WIDTH_STORAGE_KEY = 'vektor.sidebar.width';
const DEFAULT_WIDTH = 252;
const MIN_WIDTH = 180;
const MAX_WIDTH = 520;

const clamp = (value: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));

function readWidth(): number {
  try {
    const saved = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
    return Number.isFinite(saved) && saved > 0 ? clamp(saved) : DEFAULT_WIDTH;
  } catch {
    // Blocked storage must not cost the sidebar its width.
    return DEFAULT_WIDTH;
  }
}

/**
 * Width of the Explorer, draggable at its right edge and remembered across
 * restarts. Double-click on the handle returns to the default.
 */
export function useSidebarWidth() {
  const [width, setWidth] = useState(readWidth);
  const [isDragging, setIsDragging] = useState(false);
  const originRef = useRef({ pointerX: 0, width: DEFAULT_WIDTH });

  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // See readWidth.
    }
  }, [width]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      originRef.current = { pointerX: event.clientX, width };
      setIsDragging(true);
    },
    [width]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const { pointerX, width: startWidth } = originRef.current;
      setWidth(clamp(startWidth + (event.clientX - pointerX)));
    },
    []
  );

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
  }, []);

  const reset = useCallback(() => setWidth(DEFAULT_WIDTH), []);

  return { width, isDragging, handleProps: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick: reset } };
}
