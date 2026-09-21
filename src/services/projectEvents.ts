const listeners = new Set<() => void>();

export function notifyProjectsChanged(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeProjectsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
