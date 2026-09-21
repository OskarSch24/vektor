import { GraphDocument } from './graph';

/** Values that can occur in a canonical Phase-X run document. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PhaseXRunMetadata {
  [key: string]: JsonValue | undefined;
  /** Stable id of this one execution, not of the workflow definition. */
  id: string;
  workflowId: string;
  workflowName?: string;
  phase?: string;
  category?: string;
  status?: string;
  environment?: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Portable, self-contained Phase-X result. The raw output stays untouched in
 * `output`; Database Studio only derives a view from it while opening the file.
 */
export interface LegacyPhaseXRunDocument {
  format: 'amq.phase-x.run';
  version: 1;
  run: PhaseXRunMetadata;
  output: JsonValue;
}

export interface PhaseXCanonicalNode {
  id: string;
  kind: string;
  label: string;
  data: { [key: string]: JsonValue };
  raw_ref?: string;
  source?: PhaseXCanonicalSource;
  provenance: {
    workflow_id: string;
    workflow_version: string;
    run_id: string;
    transformer_version: string;
  };
}

export interface PhaseXCanonicalSource {
  provider: string;
  external_id?: string;
  url?: string;
  captured_at: string;
}

export interface PhaseXCanonicalEdge {
  id: string;
  type: string;
  from: string;
  to: string;
  ordinal?: number;
  properties: { [key: string]: JsonValue };
}

export interface PhaseXCanonicalArtifact {
  id: string;
  role: 'raw' | 'attachment' | 'log';
  media_type: string;
  path: string;
  sha256: string;
}

/** Canonical hand-off contract shared by Phase X and its viewers. */
export interface PhaseXCanonicalRunDocument {
  format: 'amq.phase-x.run';
  schema_version: '1.0.0';
  project: { id: string; name: string };
  workflow: { id: string; name: string; version: string };
  run: {
    id: string;
    mode: 'test' | 'production';
    status: 'succeeded' | 'failed' | 'partial';
    started_at: string;
    finished_at: string;
  };
  roots: string[];
  nodes: PhaseXCanonicalNode[];
  edges: PhaseXCanonicalEdge[];
  artifacts: PhaseXCanonicalArtifact[];
  integrity: { algorithm: 'sha256'; canonical_sha256: string };
}

export type PhaseXRunDocument = PhaseXCanonicalRunDocument | LegacyPhaseXRunDocument;

/**
 * Small package descriptor for runs whose output is deliberately kept in a
 * separate JSON file. Artifact paths are relative to the manifest.
 */
export interface PhaseXRunManifest {
  format: 'amq.phase-x.run-manifest';
  version: 1;
  run: PhaseXRunMetadata;
  artifacts: {
    output: string;
  };
}

export type PhaseXEnvelope = PhaseXRunDocument | PhaseXRunManifest;

export interface PhaseXRunStats {
  containers: number;
  scalarValues: number;
  graphNodes: number;
  graphEdges: number;
}

/** Everything both views need after one validated import. */
export interface AdaptedPhaseXRun {
  /** Canonical data shown by the hierarchy view. Never mutated by the graph. */
  document: PhaseXRunDocument;
  /** Read-only projection drawn by the existing graph engine. */
  graph: GraphDocument;
  /** Every JSON location points at its own or its nearest container node. */
  nodeIdByPointer: Map<string, string>;
  /** One canonical JSON location per actual graph node. */
  pointerByNodeId: Map<string, string>;
  /** Ordered strictly from `roots` and `CONTAINS.ordinal`. */
  hierarchyRootIds: string[];
  hierarchyChildren: Map<string, string[]>;
  summary: {
    runId: string;
    workflowId: string;
    workflowName: string;
    status: string;
  };
  stats: PhaseXRunStats;
  sourceName: string;
  sourcePath: string | null;
}
