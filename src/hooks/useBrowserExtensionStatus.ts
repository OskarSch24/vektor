import { useCallback, useEffect, useRef, useState } from 'react';
import {
  initialBrowserExtensionConnection,
  readBrowserExtensionConnection,
  type BrowserExtensionConnection,
} from '../services/browserExtension';

/**
 * Small shell-safe status hook. "connected" is only returned after an actual
 * browser-extension request has reached this process; a bare listener is
 * deliberately labelled "listening".
 */
export function useBrowserExtensionStatus(pollIntervalMs = 4_000) {
  const [status, setStatus] = useState<BrowserExtensionConnection>(
    initialBrowserExtensionConnection
  );
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const next = await readBrowserExtensionConnection();
    if (request === generation.current) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    let active = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (active && document.visibilityState !== 'hidden') void refresh();
    }, Math.max(1_000, pollIntervalMs));
    return () => {
      active = false;
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [pollIntervalMs, refresh]);

  return { ...status, refresh };
}
