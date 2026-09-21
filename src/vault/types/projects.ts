export type VaultDatabaseFormat = 'rdb' | 'aof-multipart' | 'aof-legacy';

export type VaultDatabaseStatus = 'valid' | 'incomplete' | 'corrupt' | 'unsupported';

export interface VaultDatabaseComponent {
  name: string;
  path: string;
  size: number;
  role?: 'base' | 'incremental' | 'manifest' | 'unknown';
}

export interface VaultLogicalDatabase {
  index: number;
  keyCount: number;
  expires: number;
}

/** One complete Redis storage state. Multipart AOF files belong to one item. */
export interface VaultDatabase {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  size: number;
  /** Last modification in epoch milliseconds. */
  modified: number;
  format: VaultDatabaseFormat;
  kind: 'snapshot' | 'appendonly';
  status?: VaultDatabaseStatus;
  message?: string;
  components?: VaultDatabaseComponent[];
  databases?: VaultLogicalDatabase[];
}

export interface VaultProject {
  id: string;
  name: string;
  path: string;
  databases: VaultDatabase[];
  databaseCount: number;
  error?: string;
  truncated?: boolean;
}

export interface OpenedVaultDatabase {
  sessionId: string;
  host: string;
  port: number;
  db: number;
  name: string;
  temporary: boolean;
  username?: string;
  password?: string;
  immutable: boolean;
  databases: VaultLogicalDatabase[];
}
