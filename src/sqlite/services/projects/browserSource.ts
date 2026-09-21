import { Project, ProjectFileNode, ProjectFolderNode, ProjectNode } from '../../types/projects';
import { detectFormat } from '../importers';
import { hasSqliteHeader, hasZipHeader, ProjectSource } from './types';

/**
 * Browser fallback used by `npm run dev`. A folder is picked once through a
 * `webkitdirectory` input; the resulting `File` handles stay valid for the life
 * of the page, so these projects are deliberately not persisted.
 */

interface BrowserProject extends Project {
  files: Map<string, File>;
}

const projects = new Map<string, BrowserProject>();

function pickDirectory(): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    // Not in the TS DOM lib, but supported by every browser this app targets.
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';

    let settled = false;
    const finish = (value: FileList | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => finish(input.files));
    // There is no cancel event in older engines; `focus` on the window is the
    // conventional fallback so a cancelled pick does not hang forever.
    input.addEventListener('cancel', () => finish(null));

    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Decides whether a file belongs in the project tree. The extension picks the
 * format, the first bytes confirm it — a text file named `daten.db` must not
 * show up as a database, and a `.json` config must not show up as a table.
 */
async function isSupportedDataFile(file: File): Promise<boolean> {
  const format = detectFormat(file.name);
  if (format === null) return false;
  // An empty file with a database extension is an empty database, not a wrong one.
  if (file.size === 0) return format === 'sqlite';

  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    switch (format) {
      case 'sqlite':
        return hasSqliteHeader(head);
      case 'xlsx':
        return hasZipHeader(head);
      case 'json':
      case 'csv':
      case 'document':
      case 'parquet':
      case 'arrow':
      case 'duckdb':
      case 'connection':
        return true;
    }
  } catch {
    return false;
  }
}

/** Turns a flat list of relative paths into a pruned folder tree. */
function buildTree(projectId: string, rootName: string, files: File[]): {
  children: ProjectNode[];
  fileCount: number;
} {
  const root: ProjectFolderNode = {
    kind: 'folder',
    id: projectId,
    name: rootName,
    path: '',
    children: [],
  };

  for (const file of files) {
    // `webkitRelativePath` always starts with the picked folder's own name.
    const segments = (file.webkitRelativePath || file.name).split('/').slice(1);
    const filename = segments.pop();
    if (!filename) continue;

    let parent = root;
    let walkedPath = '';
    for (const segment of segments) {
      walkedPath = walkedPath ? `${walkedPath}/${segment}` : segment;
      const existing = parent.children.find(
        (child): child is ProjectFolderNode => child.kind === 'folder' && child.name === segment
      );
      if (existing) {
        parent = existing;
      } else {
        const folder: ProjectFolderNode = {
          kind: 'folder',
          id: `${projectId}:${walkedPath}`,
          name: segment,
          path: walkedPath,
          children: [],
        };
        parent.children.push(folder);
        parent = folder;
      }
    }

    const relativePath = walkedPath ? `${walkedPath}/${filename}` : filename;
    parent.children.push({
      kind: 'file',
      id: `${projectId}:${relativePath}`,
      name: filename,
      path: relativePath,
      size: file.size,
      modified: file.lastModified,
      format: detectFormat(filename) ?? 'sqlite',
    });
  }

  sortTree(root.children);
  return { children: root.children, fileCount: files.length };
}

/** Folders first, then files, each alphabetically — like Finder. */
function sortTree(nodes: ProjectNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, 'de', { numeric: true, sensitivity: 'base' });
  });
  for (const node of nodes) {
    if (node.kind === 'folder') sortTree(node.children);
  }
}

export const browserProjectSource: ProjectSource = {
  kind: 'browser',
  isPersistent: false,

  async list() {
    return [...projects.values()];
  },

  async add() {
    const picked = await pickDirectory();
    if (!picked || picked.length === 0) return null;

    const all = Array.from(picked);
    const rootName = all[0]?.webkitRelativePath?.split('/')[0] || 'Projekt';
    const checks = await Promise.all(all.map(isSupportedDataFile));
    const databases = all.filter((_, index) => checks[index]);

    const id = `browser:${rootName}:${Date.now()}`;
    const { children, fileCount } = buildTree(id, rootName, databases);

    const project: BrowserProject = {
      id,
      name: rootName,
      path: rootName,
      children,
      fileCount,
      files: new Map(
        databases.map((file) => [
          `${id}:${(file.webkitRelativePath || file.name).split('/').slice(1).join('/')}`,
          file,
        ])
      ),
    };

    projects.set(id, project);
    return project;
  },

  async remove(projectId) {
    projects.delete(projectId);
  },

  async refresh(projectId) {
    // A browser folder pick is a snapshot; re-scanning would need a new pick.
    return projects.get(projectId) ?? null;
  },

  async readFile(file: ProjectFileNode) {
    const handle = [...projects.values()]
      .map((project) => project.files.get(file.id))
      .find(Boolean);
    if (!handle) {
      throw new Error(`"${file.name}" ist nicht mehr verfügbar. Bitte den Ordner erneut hinzufügen.`);
    }
    return handle.arrayBuffer();
  },
};
