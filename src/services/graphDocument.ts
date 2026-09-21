import { GraphDocument } from '../types/graph';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural guard for ordinary `.graph` files. It intentionally validates the
 * stable envelope and identities, while leaving property values to the engine's
 * backwards-compatible normalisation.
 */
export function validateGraphDocument(value: unknown): GraphDocument {
  if (!isRecord(value)) throw new Error('Die Datei enthält kein JSON-Objekt.');
  if (value.version !== 1) {
    throw new Error(`Unbekannte Graph-Version: ${String(value.version ?? 'fehlt')}`);
  }
  if (!isRecord(value.metadata) || typeof value.metadata.name !== 'string') {
    throw new Error('Graph-Metadaten fehlen oder enthalten keinen Namen.');
  }
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error('Ein Graph braucht die Listen „nodes“ und „edges“.');
  }

  for (const [index, node] of value.nodes.entries()) {
    if (
      !isRecord(node) ||
      typeof node.id !== 'string' ||
      !Array.isArray(node.labels) ||
      !node.labels.every((label) => typeof label === 'string') ||
      !isRecord(node.properties)
    ) {
      throw new Error(`Knoten ${index + 1} ist nicht vollständig.`);
    }
  }

  for (const [index, edge] of value.edges.entries()) {
    if (
      !isRecord(edge) ||
      typeof edge.id !== 'string' ||
      typeof edge.type !== 'string' ||
      typeof edge.from !== 'string' ||
      typeof edge.to !== 'string' ||
      !isRecord(edge.properties)
    ) {
      throw new Error(`Kante ${index + 1} ist nicht vollständig.`);
    }
  }

  return value as unknown as GraphDocument;
}
