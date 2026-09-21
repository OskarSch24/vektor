export interface SharedApiHostStatus {
  running: boolean;
  port: number;
  token: string;
  descriptorPath: string;
  allowWrites: boolean;
  allowWritesByAdapter?: Partial<Record<'sqlite' | 'graph' | 'vault', boolean>>;
}

let current: SharedApiHostStatus | null = null;
const listeners = new Set<(status: SharedApiHostStatus) => void>();

export function publishSharedApiStatus(status: SharedApiHostStatus): void {
  current = status;
  listeners.forEach((listener) => listener(status));
}

export function subscribeSharedApiStatus(
  listener: (status: SharedApiHostStatus) => void
): () => void {
  listeners.add(listener);
  if (current) listener(current);
  return () => {
    listeners.delete(listener);
  };
}
