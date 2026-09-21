import { GraphDocument } from '../../types/graph';
import { files } from '../nativeHost';
import { buildCoordinationGraph, coordinationSource, readRecords } from './graph';

/**
 * Reading a coordination folder into a graph document.
 *
 * The result is a *projection*: a fresh graph built from the records as they
 * are on disk right now, with `graphPath` left unset by the caller so nothing
 * is ever written back. Re-running the import is how it is refreshed — which
 * also means the graph can never drift from the records without anyone
 * noticing, because it holds nothing of its own.
 */

export interface CoordinationImport {
  document: GraphDocument;
  /** The folder actually read, which may be a `Coordination/Items` below the pick. */
  folder: string;
  name: string;
  recordCount: number;
  /** Unreadable files and references pointing at records that are not there. */
  problems: string[];
}

/** Where the tracker keeps its records, relative to a project root. */
const ITEMS = 'Coordination/Items';

export async function importCoordinationFolder(picked: string, at: Date = new Date()): Promise<CoordinationImport> {
  const { folder, contents } = await resolveFolder(picked);

  const set = readRecords(contents.files);
  const recordCount = set.work.length + set.events.length + set.handoffs.length + set.decisions.length + set.actors.length;
  if (recordCount === 0 && set.problems.length === 0) {
    throw new Error(
      `In "${folder}" liegen keine Koordinations-Records. Erwartet wird ein Projektordner mit ${ITEMS}/.`
    );
  }

  const { nodes, edges, problems } = buildCoordinationGraph(set, at);
  if (contents.skipped > 0) {
    problems.push(`${contents.skipped} Datei(en) wurden übersprungen — zu groß oder nicht lesbar.`);
  }

  const name = projectNameOf(folder);
  const source = coordinationSource(folder, nodes, at);

  return {
    document: {
      version: 1,
      metadata: {
        name,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        sources: [source],
      },
      nodes,
      edges,
    },
    folder,
    name,
    recordCount,
    problems,
  };
}

/**
 * Accepts either the project root or the records folder itself. Someone who
 * knows the layout picks `Coordination/Items`; everyone else picks the project.
 * Trying the nested path first costs one failed call and saves an explanation.
 */
async function resolveFolder(picked: string) {
  const root = picked.replace(/\/+$/, '');
  if (!root.endsWith(ITEMS)) {
    try {
      const nested = `${root}/${ITEMS}`;
      return { folder: nested, contents: await files.readFolder(nested, '.md') };
    } catch {
      // Not a project root, or no coordination layer in it — read the pick
      // itself, which is the case where the user pointed straight at the records.
    }
  }
  return { folder: root, contents: await files.readFolder(root, '.md') };
}

/** The project the records belong to, not the folder they happen to sit in. */
function projectNameOf(folder: string): string {
  const parts = folder.replace(/\/+$/, '').split('/');
  if (parts.length >= 3 && parts[parts.length - 2] === 'Coordination' && parts[parts.length - 1] === 'Items') {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 1] || folder;
}
