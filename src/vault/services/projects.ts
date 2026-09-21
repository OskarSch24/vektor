import { callHost, hasChannel } from './rpc';
import type {
  OpenedVaultDatabase,
  VaultDatabase,
  VaultDatabaseComponent,
  VaultProject,
} from '../types/projects';

type ProjectAction = 'list' | 'add' | 'remove' | 'refresh' | 'open' | 'close';

interface UnifiedProject {
  id: string;
  name: string;
  path: string;
  error?: string;
  redisDatabases?: VaultDatabase[];
  redisDatabaseCount?: number;
  redisTruncated?: boolean;
  databases?: VaultDatabase[];
  databaseCount?: number;
  truncated?: boolean;
}

const CALL_TIMEOUT_MS = 120_000;
const MAX_BROWSER_DATABASES = 500;
let browserProjects: VaultProject[] = [];

const projectChannel = 'projects' as const;
const call = <T,>(action: ProjectAction, payload: Record<string, unknown> = {}): Promise<T> =>
  callHost<T>(projectChannel, action, payload, CALL_TIMEOUT_MS);

function asVaultProject(project: UnifiedProject): VaultProject {
  const databases = project.redisDatabases ?? project.databases ?? [];
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    databases,
    databaseCount: project.redisDatabaseCount ?? project.databaseCount ?? databases.length,
    truncated: project.redisTruncated ?? project.truncated,
    error: project.error,
  };
}

export function isNativeProjectHostAvailable(): boolean {
  return hasChannel(projectChannel);
}

export const vaultProjectStore = {
  isPersistent: isNativeProjectHostAvailable(),

  async list(): Promise<VaultProject[]> {
    if (!isNativeProjectHostAvailable()) return browserProjects;
    return (await call<UnifiedProject[]>('list')).map(asVaultProject);
  },

  async add(): Promise<VaultProject | null> {
    if (!isNativeProjectHostAvailable()) return Promise.resolve(null);
    const project = await call<UnifiedProject | null>('add');
    return project ? asVaultProject(project) : null;
  },

  async addBrowserFolder(files: FileList | File[]): Promise<VaultProject | null> {
    const project = await createBrowserProject(Array.from(files));
    if (!project) return null;
    browserProjects = [...browserProjects.filter((entry) => entry.id !== project.id), project];
    return project;
  },

  async remove(projectId: string): Promise<void> {
    if (isNativeProjectHostAvailable()) {
      await call<void>('remove', { id: projectId });
      return;
    }
    browserProjects = browserProjects.filter((project) => project.id !== projectId);
  },

  async refresh(projectId: string): Promise<VaultProject | null> {
    if (isNativeProjectHostAvailable()) {
      const project = await call<UnifiedProject | null>('refresh', { id: projectId });
      return project ? asVaultProject(project) : null;
    }
    return Promise.resolve(browserProjects.find((project) => project.id === projectId) ?? null);
  },

  open(databaseId: string): Promise<OpenedVaultDatabase> {
    if (!isNativeProjectHostAvailable()) {
      return Promise.reject(
        new Error('Speicherstände lassen sich nur in der macOS-App öffnen. Die Browser-Vorschau zeigt die Projektübersicht.')
      );
    }
    return call<OpenedVaultDatabase>('open', { databaseId });
  },

  openPath(path: string): Promise<OpenedVaultDatabase> {
    if (!isNativeProjectHostAvailable()) {
      return Promise.reject(new Error('Speicherstände lassen sich nur in der macOS-App öffnen.'));
    }
    return call<OpenedVaultDatabase>('open', { path });
  },

  async close(sessionId: string): Promise<void> {
    if (isNativeProjectHostAvailable()) await call<void>('close', { sessionId });
  },
};

async function createBrowserProject(files: File[]): Promise<VaultProject | null> {
  if (files.length === 0) return null;

  const rootName = browserPath(files[0]).split('/')[0] || 'Ausgewählter Ordner';
  const projectId = `browser:${rootName.toLocaleLowerCase()}`;
  const byPath = new Map(files.map((file) => [browserPath(file), file]));
  const claimed = new Set<string>();
  const databases: VaultDatabase[] = [];

  for (const [path, manifest] of byPath) {
    if (!path.toLocaleLowerCase().endsWith('.aof.manifest')) continue;
    const directory = parentPath(path);
    const components: VaultDatabaseComponent[] = [component(manifest, path, 'manifest')];
    claimed.add(path);

    let names: Array<{ name: string; role: 'base' | 'incremental' }> = [];
    let parseFailed = false;
    try {
      const text = await manifest.text();
      names = text
        .split(/\r?\n/)
        .map((line) => line.match(/^file\s+([^\s]+).*?\stype\s+([bi])(?:\s|$)/))
        .filter((match): match is RegExpMatchArray => Boolean(match))
        .map((match) => ({
          name: match[1],
          role: match[2] === 'b' ? 'base' : 'incremental',
        }));
      parseFailed = names.length === 0;
    } catch {
      parseFailed = true;
    }

    const missing: string[] = [];
    for (const entry of names) {
      const componentPath = directory ? `${directory}/${entry.name}` : entry.name;
      const file = byPath.get(componentPath);
      if (!file) {
        missing.push(entry.name);
        continue;
      }
      claimed.add(componentPath);
      components.push(component(file, componentPath, entry.role));
    }

    const status = parseFailed ? 'corrupt' : missing.length > 0 ? 'incomplete' : 'unsupported';
    databases.push({
      id: `${projectId}:${path}`,
      name: storageName(directory, rootName, 'AOF-Speicherstand'),
      path,
      relativePath: pathAfterRoot(path),
      size: components.reduce((sum, item) => sum + item.size, 0),
      modified: Math.max(...components.map((item) => byPath.get(item.path)?.lastModified ?? manifest.lastModified)),
      format: 'aof-multipart',
      kind: 'appendonly',
      status,
      message: parseFailed
        ? 'Die AOF-Beschreibung konnte nicht gelesen werden.'
        : missing.length > 0
          ? `${missing.length} zugehörige Datei${missing.length === 1 ? ' fehlt' : 'en fehlen'}.`
          : 'Diese Sicherung wird erkannt, aber zum Schutz deines Macs nicht direkt gestartet. Öffne stattdessen den laufenden Speicher oder eine RDB-Sicherung.',
      components,
    });
  }

  const orphanParts = new Map<string, Array<[string, File]>>();
  for (const [path, file] of byPath) {
    if (claimed.has(path) || !/\.aof\.\d+\.(?:base\.rdb|incr\.aof)$/i.test(path)) continue;
    const directory = parentPath(path);
    orphanParts.set(directory, [...(orphanParts.get(directory) ?? []), [path, file]]);
  }
  for (const [directory, parts] of orphanParts) {
    const components = parts.map(([path, file]) => {
      claimed.add(path);
      return component(file, path, path.toLocaleLowerCase().endsWith('.base.rdb') ? 'base' : 'incremental');
    });
    const representative = parts[0][0];
    databases.push({
      id: `${projectId}:${representative}`,
      name: storageName(directory, rootName, 'AOF-Speicherstand'),
      path: representative,
      relativePath: pathAfterRoot(representative),
      size: components.reduce((sum, item) => sum + item.size, 0),
      modified: Math.max(...parts.map(([, file]) => file.lastModified)),
      format: 'aof-multipart',
      kind: 'appendonly',
      status: 'incomplete',
      message: 'Die AOF-Beschreibung fehlt. Dieser Speicherstand ist nicht vollständig.',
      components,
    });
  }

  for (const [path, file] of byPath) {
    if (claimed.has(path)) continue;
    const lower = path.toLocaleLowerCase();
    const format = lower.endsWith('.rdb') ? 'rdb' : lower.endsWith('.aof') ? 'aof-legacy' : null;
    if (!format) continue;
    databases.push({
      id: `${projectId}:${path}`,
      name: standaloneName(path, rootName),
      path,
      relativePath: pathAfterRoot(path),
      size: file.size,
      modified: file.lastModified,
      format,
      kind: format === 'rdb' ? 'snapshot' : 'appendonly',
      status: format === 'rdb' ? 'valid' : 'unsupported',
      message: format === 'rdb'
        ? undefined
        : 'Diese Sicherung wird erkannt, aber zum Schutz deines Macs nicht direkt gestartet. Öffne stattdessen den laufenden Speicher oder eine RDB-Sicherung.',
      components: [component(file, path, format === 'rdb' ? 'base' : 'incremental')],
    });
  }

  databases.sort((left, right) => right.modified - left.modified || left.name.localeCompare(right.name, 'de'));
  const truncated = databases.length > MAX_BROWSER_DATABASES;
  const visible = databases.slice(0, MAX_BROWSER_DATABASES);
  return {
    id: projectId,
    name: rootName,
    path: rootName,
    databases: visible,
    databaseCount: databases.length,
    truncated,
  };
}

function browserPath(file: File): string {
  return file.webkitRelativePath || file.name;
}

function parentPath(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function pathAfterRoot(path: string): string {
  return path.includes('/') ? path.slice(path.indexOf('/') + 1) : path;
}

function component(
  file: File,
  path: string,
  role: VaultDatabaseComponent['role']
): VaultDatabaseComponent {
  return { name: file.name, path, size: file.size, role };
}

function storageName(directory: string, rootName: string, fallback: string): string {
  const parts = directory.split('/').filter(Boolean);
  const leaf = parts[parts.length - 1];
  if (
    !leaf ||
    leaf === rootName ||
    ['appendonly', 'appendonlydir'].includes(leaf.toLocaleLowerCase())
  ) return fallback;
  return leaf;
}

function standaloneName(path: string, rootName: string): string {
  const pathParts = path.split('/');
  const filename = pathParts[pathParts.length - 1] || path;
  const stem = filename.replace(/\.(?:rdb|aof)$/i, '');
  if (!/^(?:dump|vault|appendonly)$/i.test(stem)) return stem;
  const directoryParts = parentPath(path).split('/').filter(Boolean);
  const directory = directoryParts[directoryParts.length - 1];
  return directory && directory !== rootName ? directory : 'Phase-X-Speicherstand';
}
