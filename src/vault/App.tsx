import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { KeyBrowser } from './components/KeyBrowser';
import { Console } from './components/Console';
import { PhaseXView } from './components/PhaseXView';
import { ServerView } from './components/ServerView';
import { NoticeBanner, type Notice } from './components/NoticeBanner';
import { Connection } from './services/redis/connection';
import type { ConnectConfig } from './services/redis/transport';
import {
  installApiHandler,
  reportConnectionChanged,
  setConnection,
  setDataChangedHandler,
} from './services/api/host';
import { vaultProjectStore } from './services/projects';
import type { ActiveTab } from './types/app';
import type { WorkspaceDisposeEvent } from '../workbench/model';

export interface VaultStudioProps {
  embedded?: boolean;
  active?: boolean;
  requestedPath?: string | null;
  requestVersion?: number;
  disposeEvent?: WorkspaceDisposeEvent;
  onSourceIntent?: () => void;
  onSourceChanged?: (source: {
    name: string;
    path?: string | null;
    fileType?: 'redis-rdb' | 'redis-aof';
  }) => void;
  /** Reports when the adapter's API and snapshot handlers are live. */
  onReadyChange?: (ready: boolean) => void;
}

/**
 * Adaptive main-frame renderer for an RDB or AOF source selected in the shared
 * Explorer. It intentionally has no connection chooser, local-store button or
 * project overview; live Redis remains backend infrastructure.
 */
export const VaultStudio: React.FC<VaultStudioProps> = ({
  active = true,
  requestedPath = null,
  requestVersion = 0,
  disposeEvent,
  onSourceIntent,
  onSourceChanged,
  onReadyChange,
}) => {
  const [connection, setActiveConnection] = useState<Connection | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('keys');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const lastRequestedPath = useRef('');
  const connectionIntent = useRef(0);
  const connectionRef = useRef<Connection | null>(null);
  const snapshotSessionRef = useRef<string | null>(null);

  useEffect(() => installApiHandler(), []);

  useEffect(() => {
    setDataChangedHandler(() => {
      onSourceIntent?.();
      setReloadToken((token) => token + 1);
    });
    return () => setDataChangedHandler(undefined);
  }, [onSourceIntent]);

  useEffect(() => {
    setConnection(connection);
    reportConnectionChanged();
  }, [active, connection]);

  // Keep the native refresh command, but deliberately expose no command that
  // can reveal the retired live-connection chooser.
  useEffect(() => {
    if (!active) return;
    const bridge = (window.vaultStudio ??= {});
    bridge.reloadKeyspace = () => setReloadToken((token) => token + 1);
    return () => {
      delete bridge.reloadKeyspace;
      delete bridge.openConnectionDialog;
    };
  }, [active]);

  const fail = useCallback((message: string) => setNotice({ tone: 'error', message }), []);

  const connectSnapshot = useCallback(async (config: ConnectConfig, intent: number) => {
    if (!config.immutable) {
      setConnectError('Live-Redis-Verbindungen werden nicht als Arbeitsraum geöffnet.');
      return false;
    }
    if (intent !== connectionIntent.current) return false;
    setConnecting(true);
    setConnectError(null);
    try {
      const next = await Connection.open(config);
      if (intent !== connectionIntent.current) {
        await next.close();
        return false;
      }

      const previous = connectionRef.current;
      connectionRef.current = next;
      setActiveConnection(next);
      setConnection(next);
      reportConnectionChanged();
      setReloadToken((token) => token + 1);
      if (previous) void previous.close();
      return true;
    } catch (error) {
      if (intent === connectionIntent.current) {
        setConnectError(error instanceof Error ? error.message : String(error));
      }
      return false;
    } finally {
      if (intent === connectionIntent.current) setConnecting(false);
    }
  }, []);

  const selectDatabase = useCallback(async (index: number) => {
    if (!connection) return;
    setBusy(true);
    try {
      await connection.selectDatabase(index);
      reportConnectionChanged();
      setReloadToken((token) => token + 1);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [connection, fail]);

  useEffect(() => {
    if (!disposeEvent?.unloadActive) return;

    // Snapshot processes and Redis transports are native resources; closing
    // their owning editor must retire both, including a pending openPath call.
    connectionIntent.current += 1;
    lastRequestedPath.current = '';
    const currentConnection = connectionRef.current;
    const currentSessionId = snapshotSessionRef.current;
    connectionRef.current = null;
    snapshotSessionRef.current = null;
    setActiveConnection(null);
    setConnection(null);
    setConnecting(false);
    setConnectError(null);
    setNotice(null);
    setBusy(false);
    reportConnectionChanged();
    if (currentConnection) void currentConnection.close();
    if (currentSessionId) void vaultProjectStore.close(currentSessionId);
  }, [disposeEvent]);

  useEffect(() => {
    if (!requestedPath) return;
    const requestKey = `${requestVersion}:${requestedPath}`;
    if (lastRequestedPath.current === requestKey) return;
    lastRequestedPath.current = requestKey;
    const intent = ++connectionIntent.current;
    let cancelled = false;

    // A source transition must stop rendering the previous snapshot before
    // the next one is opened. Otherwise an AOF error is hidden behind the last
    // successful RDB connection. The native snapshot process is disposable as
    // well, so retire its project session together with the Redis connection.
    const previousConnection = connectionRef.current;
    const previousSessionId = snapshotSessionRef.current;
    connectionRef.current = null;
    snapshotSessionRef.current = null;
    setActiveConnection(null);
    setConnection(null);
    reportConnectionChanged();
    if (previousConnection) void previousConnection.close();
    if (previousSessionId) void vaultProjectStore.close(previousSessionId);
    setConnecting(true);
    setConnectError(null);

    void vaultProjectStore
      .openPath(requestedPath)
      .then(async (opened) => {
        if (cancelled || intent !== connectionIntent.current) {
          await vaultProjectStore.close(opened.sessionId);
          return;
        }
        const connected = await connectSnapshot({
          host: opened.host,
          port: opened.port,
          db: opened.db,
          username: opened.username,
          password: opened.password,
          immutable: opened.immutable,
          displayName: opened.name || requestedPath.split('/').pop() || requestedPath,
          availableDatabases: opened.databases.length
            ? opened.databases.map((area) => area.index)
            : [opened.db],
        }, intent);
        if (connected && !cancelled && intent === connectionIntent.current) {
          snapshotSessionRef.current = opened.sessionId;
          onSourceChanged?.({
            name: opened.name || requestedPath.split('/').pop() || requestedPath,
            path: requestedPath,
            fileType: requestedPath.toLocaleLowerCase().endsWith('.rdb') ? 'redis-rdb' : 'redis-aof',
          });
          setActiveTab('phasex');
        } else {
          await vaultProjectStore.close(opened.sessionId);
        }
      })
      .catch((error) => {
        if (!cancelled && intent === connectionIntent.current) {
          setConnecting(false);
          setConnectError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
      if (connectionIntent.current === intent) connectionIntent.current += 1;
    };
  }, [connectSnapshot, onSourceChanged, requestVersion, requestedPath]);

  useEffect(() => () => {
    connectionIntent.current += 1;
    const currentConnection = connectionRef.current;
    const currentSessionId = snapshotSessionRef.current;
    connectionRef.current = null;
    snapshotSessionRef.current = null;
    setConnection(null);
    reportConnectionChanged();
    if (currentConnection) void currentConnection.close();
    if (currentSessionId) void vaultProjectStore.close(currentSessionId);
  }, []);

  useEffect(() => {
    onReadyChange?.(true);
    return () => onReadyChange?.(false);
  }, [onReadyChange]);

  return (
    <div className="h-full w-full flex flex-col bg-apple-bg text-apple-text-primary overflow-hidden">
      <TitleBar
        connection={connection}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onSelectDatabase={(index) => void selectDatabase(index)}
        onRefresh={() => setReloadToken((token) => token + 1)}
        busy={busy}
      />

      <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} />

      {!connection ? (
        <div className="flex flex-1 items-center justify-center bg-[#181818] px-6 text-center">
          <div className="max-w-sm">
            <p className="text-[11.5px] font-medium text-[#b8b8b8]">
              {connecting ? 'Speicherstand wird geöffnet…' : 'Speicherstand im Explorer auswählen'}
            </p>
            <p className={`mt-1.5 text-[10.5px] leading-4 ${connectError ? 'text-[#d88983]' : 'text-[#6f6f6f]'}`}>
              {connectError ?? 'RDB- und AOF-Dateien öffnen sich direkt im aktiven Tab.'}
            </p>
          </div>
        </div>
      ) : activeTab === 'keys' ? (
        <KeyBrowser connection={connection} reloadToken={reloadToken} onError={fail} />
      ) : activeTab === 'phasex' ? (
        <PhaseXView connection={connection} reloadToken={reloadToken} onError={fail} />
      ) : activeTab === 'console' ? (
        <Console connection={connection} writesAllowed={false} />
      ) : (
        <ServerView connection={connection} />
      )}
    </div>
  );
};
