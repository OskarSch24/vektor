import { Project, ProjectFileNode } from '../../types/projects';

/**
 * Where projects come from. The native macOS host scans real folders and keeps
 * them across launches; the browser fallback works on a one-off folder pick and
 * only lives as long as the tab.
 */
export interface ProjectSource {
  readonly kind: 'native' | 'browser';
  /** Whether added projects survive a restart. */
  readonly isPersistent: boolean;
  list(): Promise<Project[]>;
  /** Opens a folder picker. Resolves to `null` when the user cancels. */
  add(): Promise<Project | null>;
  remove(projectId: string): Promise<void>;
  /** Re-scans a folder. Resolves to `null` if the project is gone. */
  refresh(projectId: string): Promise<Project | null>;
  readFile(file: ProjectFileNode): Promise<ArrayBuffer>;
}

/** `SQLite format 3\0` — the first 16 bytes of every SQLite database file. */
const SQLITE_MAGIC = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];

export function hasSqliteHeader(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC.length) return false;
  return SQLITE_MAGIC.every((byte, index) => bytes[index] === byte);
}

/** `PK\x03\x04` — every .xlsx workbook is a ZIP container. */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export function hasZipHeader(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((byte, index) => bytes[index] === byte);
}

/**
 * A `.json` file only becomes a project entry if it holds a list of records —
 * otherwise every config file in a repository would show up as a "database".
 */
export function looksLikeJsonRecordList(head: string): boolean {
  const trimmed = head.replace(/^\ufeff/, '').trimStart();
  return trimmed.startsWith('[');
}
