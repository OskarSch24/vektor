import { browserProjectSource } from './browserSource';
import { isNativeProjectHostAvailable, nativeProjectSource } from './nativeSource';
import { ProjectSource } from './types';

/**
 * The packaged macOS app scans real folders; in a plain browser we fall back to
 * a one-off folder pick so `npm run dev` stays usable.
 */
export const projectSource: ProjectSource = isNativeProjectHostAvailable()
  ? nativeProjectSource
  : browserProjectSource;

export type { ProjectSource } from './types';
