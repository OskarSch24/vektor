export interface MarkdownBuffer {
  path: string;
  /** Contents on disk as of the last read or write. */
  saved: string;
  text: string;
}

/**
 * Open notes, keyed by the tab's session identity. They outlive the editor
 * component, which unmounts whenever another kind of tab is in front, so
 * unsaved text survives a tab switch. Kept apart from the editor so the shell
 * can release a closed tab's buffer without loading the editor bundle.
 */
export const markdownBuffers = new Map<string, MarkdownBuffer>();

export function releaseMarkdownBuffer(sessionKey: string): void {
  markdownBuffers.delete(sessionKey);
}
