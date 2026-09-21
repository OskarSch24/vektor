import { Project, ProjectFileNode } from '../../types/projects';
import { callHost, hasChannel } from '../rpc';
import { files } from '../../../services/nativeHost';
import { ProjectSource } from './types';

type RpcAction = 'list' | 'add' | 'remove' | 'refresh';

/**
 * Scanning a large folder tree can genuinely take a while, so these calls get a
 * far longer leash than the rest of the bridge.
 */
const CALL_TIMEOUT_MS = 120_000;

const call = <T,>(action: RpcAction, payload: Record<string, unknown> = {}): Promise<T> =>
  callHost<T>('projects', action, payload, CALL_TIMEOUT_MS);

export function isNativeProjectHostAvailable(): boolean {
  return hasChannel('projects');
}

/** Projects backed by real folders on disk, scanned and persisted by the app. */
export const nativeProjectSource: ProjectSource = {
  kind: 'native',
  isPersistent: true,

  list: () => call<Project[]>('list'),
  add: () => call<Project | null>('add'),
  remove: (projectId) => call<void>('remove', { id: projectId }),
  refresh: (projectId) => call<Project | null>('refresh', { id: projectId }),

  async readFile(file: ProjectFileNode): Promise<ArrayBuffer> {
    // The host copies the file into a one-shot URL rather than marshalling the
    // bytes through JavaScript, which would triple the memory for large files.
    const { url } = await files.stage(file.path);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`"${file.name}" konnte nicht gelesen werden (HTTP ${response.status}).`);
    }
    return response.arrayBuffer();
  },
};
