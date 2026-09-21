import { AdaptedPhaseXRun, JsonValue, PhaseXRunDocument } from '../../types/phaseX';
import { files } from '../nativeHost';
import {
  adaptPhaseXRun,
  PHASE_X_MANIFEST_FORMAT,
  PHASE_X_RUN_FORMAT,
  validatePhaseXManifest,
} from './adapter';

interface ImportOptions {
  filename: string;
  path: string | null;
}

/** Opens either a self-contained run or a manifest pointing at its raw output. */
export async function importPhaseXDocument(
  parsed: unknown,
  options: ImportOptions
): Promise<AdaptedPhaseXRun> {
  if (!isRecord(parsed)) throw new Error('Der Phase-X-Lauf enthält kein JSON-Objekt.');

  if (parsed.format === PHASE_X_RUN_FORMAT) {
    return adaptPhaseXRun(parsed, { sourceName: options.filename, sourcePath: options.path });
  }

  if (parsed.format !== PHASE_X_MANIFEST_FORMAT) {
    throw new Error(
      'Die Datei trägt einen Phase-X-Laufnamen, enthält aber weder „amq.phase-x.run“ noch „amq.phase-x.run-manifest“.\n' +
        'Die Datei wurde nicht als gewöhnlicher Graph geöffnet, damit keine Daten falsch interpretiert werden.'
    );
  }

  const manifest = validatePhaseXManifest(parsed);
  if (!options.path) {
    throw new Error(
      'Dieses Manifest verweist auf eine zweite Datei. Öffne es in Vektor.app oder verwende eine selbstständige .amqrun.json-Datei.'
    );
  }

  const outputPath = resolveRelativeArtifact(options.path, manifest.artifacts.output);
  const outputFile = await files.read(outputPath);
  let output: JsonValue;
  try {
    output = JSON.parse(outputFile.contents) as JsonValue;
  } catch (err) {
    throw new Error(
      `„${manifest.artifacts.output}“ enthält kein gültiges JSON: ${err instanceof Error ? err.message : err}`
    );
  }

  const document: PhaseXRunDocument = {
    format: PHASE_X_RUN_FORMAT,
    version: 1,
    run: manifest.run,
    output,
  };
  return adaptPhaseXRun(document, { sourceName: options.filename, sourcePath: options.path });
}

function resolveRelativeArtifact(manifestPath: string, relative: string): string {
  const normalised = relative.trim().replace(/\\/g, '/');
  const segments = normalised.split('/');
  if (
    normalised.startsWith('/') ||
    /^[A-Za-z]:/.test(normalised) ||
    segments.some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error('Artefaktpfade im Phase-X-Manifest müssen sichere, relative Pfade sein.');
  }
  const slash = manifestPath.lastIndexOf('/');
  const directory = slash >= 0 ? manifestPath.slice(0, slash) : '';
  return `${directory}/${normalised}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
