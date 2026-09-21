import { useEffect } from 'react';

/**
 * Makes the app's own title bar drag the window.
 *
 * WKWebView has no equivalent of Electron's `-webkit-app-region: drag`, so the
 * native host puts a transparent view over the title bar strip and starts a
 * window drag on mouse down. That view would swallow clicks on the buttons up
 * there, so this hook measures every element marked `data-no-drag` and reports
 * their rects as holes to punch out of it.
 *
 * The measurement re-runs whenever the bar changes size or content — the tab
 * switcher only appears once a graph is open, and the buttons on the right come
 * and go with it.
 */
export function useWindowDrag(dependency: unknown, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const handler = window.webkit?.messageHandlers?.windowDrag;
    if (!handler) return;

    const bar = document.querySelector<HTMLElement>('[data-drag-region]');
    if (!bar) return;

    const report = () => {
      const barRect = bar.getBoundingClientRect();
      const holes = [...bar.querySelectorAll<HTMLElement>('[data-no-drag]')]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            x: rect.left,
            y: rect.top,
            w: rect.width,
            h: rect.height,
          };
        })
        // A collapsed element — hidden, or not laid out yet — would punch a
        // zero-sized hole that only costs the host a containment check.
        .filter((hole) => hole.w > 0 && hole.h > 0);

      handler.postMessage({ height: barRect.height, holes });
    };

    report();

    // ResizeObserver catches the window being resized and the bar's own content
    // reflowing; both move the buttons.
    const observer = new ResizeObserver(report);
    observer.observe(bar);
    for (const element of bar.querySelectorAll('[data-no-drag]')) observer.observe(element);

    window.addEventListener('resize', report);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [dependency, enabled]);
}
