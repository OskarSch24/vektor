import { GraphDocument, GraphEdge, GraphNode, PropertyValue } from '../../types/graph';
import {
  AdaptedPhaseXRun,
  JsonPrimitive,
  JsonValue,
  LegacyPhaseXRunDocument,
  PhaseXCanonicalEdge,
  PhaseXCanonicalNode,
  PhaseXCanonicalRunDocument,
  PhaseXRunDocument,
  PhaseXRunManifest,
  PhaseXRunMetadata,
} from '../../types/phaseX';

export const PHASE_X_RUN_FORMAT = 'amq.phase-x.run';
export const PHASE_X_MANIFEST_FORMAT = 'amq.phase-x.run-manifest';
export const PHASE_X_SCHEMA_VERSION = '1.0.0';
const MAX_DEPTH = 160;
const MAX_CONTAINERS = 50_000;

const STRUCTURAL_PROPERTIES = new Set([
  'name', 'displayName', 'jsonPointer', 'parentId', 'parentPointer',
  'position', 'containerType', 'itemCount', 'propertyCount',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPhaseXFileName(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.amqrun') || lower.endsWith('.amqrun.json');
}

export function isPhaseXEnvelope(value: unknown): boolean {
  return isRecord(value) && (
    value.format === PHASE_X_RUN_FORMAT || value.format === PHASE_X_MANIFEST_FORMAT
  );
}

/** Validates the canonical 1.0.0 contract and the compact legacy MVP envelope. */
export function validatePhaseXRun(value: unknown): PhaseXRunDocument {
  if (!isRecord(value)) throw new Error('Der Phase-X-Lauf enthält kein JSON-Objekt.');
  if (value.format !== PHASE_X_RUN_FORMAT) {
    throw new Error(`Unbekanntes Phase-X-Format: ${String(value.format ?? 'fehlt')}`);
  }

  if (Object.prototype.hasOwnProperty.call(value, 'schema_version')) {
    return validateCanonicalRun(value);
  }

  if (value.version !== 1) {
    throw new Error(
      `Nicht unterstützte Legacy-Version: ${String(value.version ?? 'fehlt')}. Erwartet wird 1.`
    );
  }
  validateLegacyMetadata(value.run);
  if (!Object.prototype.hasOwnProperty.call(value, 'output')) {
    throw new Error('Im Phase-X-Lauf fehlt das Feld „output“.');
  }
  assertJsonValue(value.output, '/output');
  return value as unknown as LegacyPhaseXRunDocument;
}

function validateCanonicalRun(value: Record<string, unknown>): PhaseXCanonicalRunDocument {
  if (value.schema_version !== PHASE_X_SCHEMA_VERSION) {
    throw new Error(
      `Nicht unterstützte schema_version: ${String(value.schema_version ?? 'fehlt')}. Erwartet wird 1.0.0.`
    );
  }

  validateNamedIdentity(value.project, 'project');
  const workflow = requiredRecord(value.workflow, 'workflow');
  requiredString(workflow.id, 'workflow.id');
  requiredString(workflow.name, 'workflow.name');
  requiredString(workflow.version, 'workflow.version');

  const run = requiredRecord(value.run, 'run');
  requiredString(run.id, 'run.id');
  if (run.mode !== 'test' && run.mode !== 'production') {
    throw new Error('„run.mode“ muss „test“ oder „production“ sein.');
  }
  if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'partial') {
    throw new Error('„run.status“ muss „succeeded“, „failed“ oder „partial“ sein.');
  }
  requiredDate(run.started_at, 'run.started_at');
  requiredDate(run.finished_at, 'run.finished_at');

  if (!Array.isArray(value.roots) || !value.roots.every((id) => typeof id === 'string')) {
    throw new Error('„roots“ muss eine Liste von Knoten-IDs sein.');
  }
  if (!Array.isArray(value.nodes)) throw new Error('„nodes“ muss eine Liste sein.');
  if (!Array.isArray(value.edges)) throw new Error('„edges“ muss eine Liste sein.');
  if (!Array.isArray(value.artifacts)) throw new Error('„artifacts“ muss eine Liste sein.');
  for (const [index, item] of value.artifacts.entries()) validateCanonicalArtifact(item, index);

  const integrity = requiredRecord(value.integrity, 'integrity');
  if (integrity.algorithm !== 'sha256') throw new Error('„integrity.algorithm“ muss „sha256“ sein.');
  const checksum = requiredString(integrity.canonical_sha256, 'integrity.canonical_sha256');
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw new Error('„integrity.canonical_sha256“ muss ein SHA-256-Wert mit 64 Hex-Zeichen sein.');
  }

  const nodeIds = new Set<string>();
  for (const [index, item] of value.nodes.entries()) {
    validateCanonicalNode(item, index);
    const id = item.id;
    if (nodeIds.has(id)) throw new Error(`Knoten-ID „${id}“ kommt mehrfach vor.`);
    if (item.provenance.workflow_id !== workflow.id) {
      throw new Error(`Knoten „${id}“ verweist auf einen anderen Workflow.`);
    }
    if (item.provenance.workflow_version !== workflow.version) {
      throw new Error(`Knoten „${id}“ verweist auf eine andere Workflow-Version.`);
    }
    if (item.provenance.run_id !== run.id) {
      throw new Error(`Knoten „${id}“ verweist auf einen anderen Lauf.`);
    }
    nodeIds.add(id);
  }

  const edgeIds = new Set<string>();
  const parentByChild = new Map<string, string>();
  const ordinalsByParent = new Map<string, Set<number>>();
  for (const [index, item] of value.edges.entries()) {
    validateCanonicalEdge(item, index);
    const edge = item;
    if (edgeIds.has(edge.id)) throw new Error(`Kanten-ID „${edge.id}“ kommt mehrfach vor.`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Kante „${edge.id}“ verweist auf einen unbekannten Knoten.`);
    }
    if (edge.type === 'CONTAINS') {
      if (parentByChild.has(edge.to)) {
        throw new Error(`Knoten „${edge.to}“ hat mehr als einen CONTAINS-Elternknoten.`);
      }
      parentByChild.set(edge.to, edge.from);
      const ordinals = ordinalsByParent.get(edge.from) ?? new Set<number>();
      if (ordinals.has(edge.ordinal!)) {
        throw new Error(`CONTAINS-Position ${edge.ordinal} unter „${edge.from}“ kommt mehrfach vor.`);
      }
      ordinals.add(edge.ordinal!);
      ordinalsByParent.set(edge.from, ordinals);
    }
  }
  for (const [parent, ordinals] of ordinalsByParent) {
    for (let expected = 1; expected <= ordinals.size; expected += 1) {
      if (!ordinals.has(expected)) {
        throw new Error(`CONTAINS-Positionen unter „${parent}“ müssen lückenlos bei 1 beginnen.`);
      }
    }
  }

  const roots = value.roots as string[];
  if (nodeIds.size > 0 && roots.length === 0) {
    throw new Error('Ein Lauf mit Knoten braucht mindestens eine Root-ID.');
  }
  if (new Set(roots).size !== roots.length) throw new Error('„roots“ enthält doppelte Knoten-IDs.');
  for (const root of roots) {
    if (!nodeIds.has(root)) throw new Error(`Root „${root}“ ist kein vorhandener Knoten.`);
    if (parentByChild.has(root)) throw new Error(`Root „${root}“ darf keinen CONTAINS-Elternknoten haben.`);
  }
  validateHierarchyCoverage(roots, value.edges, nodeIds);

  return value as unknown as PhaseXCanonicalRunDocument;
}

function validateCanonicalNode(value: unknown, index: number): asserts value is PhaseXCanonicalNode {
  const node = requiredRecord(value, `nodes[${index}]`);
  requiredString(node.id, `nodes[${index}].id`);
  requiredString(node.kind, `nodes[${index}].kind`);
  requiredString(node.label, `nodes[${index}].label`);
  const data = requiredRecord(node.data, `nodes[${index}].data`);
  assertJsonValue(data, `/nodes/${index}/data`);
  if (node.raw_ref !== undefined) requiredString(node.raw_ref, `nodes[${index}].raw_ref`);
  if (node.source !== undefined) {
    const source = requiredRecord(node.source, `nodes[${index}].source`);
    requiredString(source.provider, `nodes[${index}].source.provider`);
    if (source.external_id !== undefined) {
      requiredString(source.external_id, `nodes[${index}].source.external_id`);
    }
    if (source.url !== undefined) requiredString(source.url, `nodes[${index}].source.url`);
    requiredDate(source.captured_at, `nodes[${index}].source.captured_at`);
  }
  const provenance = requiredRecord(node.provenance, `nodes[${index}].provenance`);
  requiredString(provenance.workflow_id, `nodes[${index}].provenance.workflow_id`);
  requiredString(provenance.workflow_version, `nodes[${index}].provenance.workflow_version`);
  requiredString(provenance.run_id, `nodes[${index}].provenance.run_id`);
  requiredString(provenance.transformer_version, `nodes[${index}].provenance.transformer_version`);
}

function validateCanonicalEdge(value: unknown, index: number): asserts value is PhaseXCanonicalEdge {
  const edge = requiredRecord(value, `edges[${index}]`);
  requiredString(edge.id, `edges[${index}].id`);
  requiredString(edge.type, `edges[${index}].type`);
  requiredString(edge.from, `edges[${index}].from`);
  requiredString(edge.to, `edges[${index}].to`);
  if (edge.ordinal !== undefined && (!Number.isInteger(edge.ordinal) || (edge.ordinal as number) < 1)) {
    throw new Error(`„edges[${index}].ordinal“ muss eine Ganzzahl ab 1 sein.`);
  }
  if (edge.type === 'CONTAINS' && edge.ordinal === undefined) {
    throw new Error(`CONTAINS-Kante „${String(edge.id)}“ braucht eine „ordinal“-Position.`);
  }
  const properties = requiredRecord(edge.properties, `edges[${index}].properties`);
  assertJsonValue(properties, `/edges/${index}/properties`);
}

function validateCanonicalArtifact(value: unknown, index: number): void {
  const artifact = requiredRecord(value, `artifacts[${index}]`);
  requiredString(artifact.id, `artifacts[${index}].id`);
  if (artifact.role !== 'raw' && artifact.role !== 'attachment' && artifact.role !== 'log') {
    throw new Error(`„artifacts[${index}].role“ muss „raw“, „attachment“ oder „log“ sein.`);
  }
  requiredString(artifact.media_type, `artifacts[${index}].media_type`);
  const path = requiredString(artifact.path, `artifacts[${index}].path`);
  const segments = path.replace(/\\/g, '/').split('/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || segments.some((segment) => segment === '..' || segment === '')) {
    throw new Error(`„artifacts[${index}].path“ muss ein sicherer relativer Pfad sein.`);
  }
  const checksum = requiredString(artifact.sha256, `artifacts[${index}].sha256`);
  if (!/^[a-fA-F0-9]{64}$/.test(checksum)) {
    throw new Error(`„artifacts[${index}].sha256“ muss 64 Hex-Zeichen enthalten.`);
  }
}

function validateHierarchyCoverage(
  roots: string[],
  edges: unknown[],
  allNodeIds: Set<string>
): void {
  const contains = edges as PhaseXCanonicalEdge[];
  const children = new Map<string, string[]>();
  for (const edge of contains.filter((candidate) => candidate.type === 'CONTAINS')) {
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error(`Die CONTAINS-Hierarchie enthält bei „${id}“ einen Kreis.`);
    if (visited.has(id)) return;
    active.add(id);
    for (const child of children.get(id) ?? []) visit(child);
    active.delete(id);
    visited.add(id);
  };
  for (const root of roots) visit(root);
  if (visited.size !== allNodeIds.size) {
    const missing = [...allNodeIds].filter((id) => !visited.has(id)).slice(0, 3);
    throw new Error(`Nicht alle Knoten sind über roots/CONTAINS erreichbar: ${missing.join(', ')}`);
  }
}

export function validatePhaseXManifest(value: unknown): PhaseXRunManifest {
  if (!isRecord(value)) throw new Error('Das Phase-X-Manifest enthält kein JSON-Objekt.');
  if (value.format !== PHASE_X_MANIFEST_FORMAT) {
    throw new Error(`Unbekanntes Phase-X-Manifestformat: ${String(value.format ?? 'fehlt')}`);
  }
  if (value.version !== 1) throw new Error('Das Legacy-Manifest braucht „version: 1“.');
  const run = validateLegacyMetadata(value.run);
  if (!isRecord(value.artifacts) || typeof value.artifacts.output !== 'string') {
    throw new Error('Im Phase-X-Manifest fehlt „artifacts.output“.');
  }
  const output = value.artifacts.output.trim();
  if (!output) throw new Error('„artifacts.output“ darf nicht leer sein.');
  return { format: PHASE_X_MANIFEST_FORMAT, version: 1, run, artifacts: { output } };
}

function validateLegacyMetadata(value: unknown): PhaseXRunMetadata {
  const run = requiredRecord(value, 'run');
  requiredString(run.id, 'run.id');
  requiredString(run.workflowId, 'run.workflowId');
  assertJsonValue(run, '/run');
  return run as unknown as PhaseXRunMetadata;
}

interface AdaptOptions {
  sourceName: string;
  sourcePath?: string | null;
}

/** Builds a read-only graph view without modifying or replacing the raw run. */
export function adaptPhaseXRun(value: unknown, options: AdaptOptions): AdaptedPhaseXRun {
  const document = validatePhaseXRun(value);
  return 'schema_version' in document
    ? adaptCanonicalRun(document, options)
    : adaptLegacyRun(document, options);
}

function adaptCanonicalRun(
  document: PhaseXCanonicalRunDocument,
  options: AdaptOptions
): AdaptedPhaseXRun {
  const nodeIndexById = new Map(document.nodes.map((node, index) => [node.id, index]));
  const containsEdges = document.edges.filter((edge) => edge.type === 'CONTAINS');
  const parentEdgeByChild = new Map(containsEdges.map((edge) => [edge.to, edge]));
  const nodes: GraphNode[] = document.nodes.map((node, index) => {
    const parent = parentEdgeByChild.get(node.id);
    const properties: Record<string, PropertyValue> = {
      name: node.label,
      displayName: node.label,
      kind: node.kind,
      jsonPointer: `/nodes/${index}`,
      parentId: parent?.from ?? null,
      position: parent?.ordinal ?? document.roots.indexOf(node.id),
    };
    copyScalarFields(node.data, properties, 'data.');
    if (node.raw_ref) properties.raw_ref = node.raw_ref;
    properties['provenance.workflow_id'] = node.provenance.workflow_id;
    properties['provenance.workflow_version'] = node.provenance.workflow_version;
    properties['provenance.run_id'] = node.provenance.run_id;
    properties['provenance.transformer_version'] = node.provenance.transformer_version;
    return { id: node.id, labels: [node.kind], properties };
  });
  const edges: GraphEdge[] = document.edges.map((edge) => {
    const properties: Record<string, PropertyValue> = {};
    copyScalarFields(edge.properties, properties);
    if (edge.ordinal !== undefined) properties.ordinal = edge.ordinal;
    return { id: edge.id, type: edge.type, from: edge.from, to: edge.to, properties };
  });

  const nodeIdByPointer = new Map<string, string>();
  const pointerByNodeId = new Map<string, string>();
  const fallbackRoot = document.roots[0] ?? document.nodes[0]?.id;
  if (fallbackRoot) {
    for (const key of ['', '/format', '/schema_version', '/project', '/workflow', '/run', '/roots', '/artifacts', '/integrity']) {
      nodeIdByPointer.set(key, fallbackRoot);
    }
  }
  for (const node of document.nodes) {
    const index = nodeIndexById.get(node.id)!;
    const pointer = `/nodes/${index}`;
    pointerByNodeId.set(node.id, pointer);
    mapSubtreePointers(node as unknown as JsonValue, pointer, node.id, nodeIdByPointer);
  }
  document.edges.forEach((edge, index) => {
    mapSubtreePointers(edge as unknown as JsonValue, `/edges/${index}`, edge.from, nodeIdByPointer);
  });

  const hierarchyChildren = orderedChildren(document.nodes.map((node) => node.id), containsEdges);
  const timestamp = new Date(document.run.finished_at).toISOString();
  const title = `${document.workflow.id} — ${document.workflow.name}`;
  const graph = createGraphDocument(
    title, document.run.id, timestamp, options.sourcePath, nodes, edges
  );

  return {
    document,
    graph,
    nodeIdByPointer,
    pointerByNodeId,
    hierarchyRootIds: [...document.roots],
    hierarchyChildren,
    summary: {
      runId: document.run.id,
      workflowId: document.workflow.id,
      workflowName: document.workflow.name,
      status: document.run.status,
    },
    stats: {
      containers: nodes.length,
      scalarValues: countScalars(document as unknown as JsonValue),
      graphNodes: nodes.length,
      graphEdges: edges.length,
    },
    sourceName: options.sourceName,
    sourcePath: options.sourcePath ?? null,
  };
}

function adaptLegacyRun(
  document: LegacyPhaseXRunDocument,
  options: AdaptOptions
): AdaptedPhaseXRun {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeIdByPointer = new Map<string, string>();
  const pointerByNodeId = new Map<string, string>();
  const rootId = `phase-x-run:${encodeURIComponent(document.run.id)}`;
  const title = legacyTitle(document.run);
  const rootProperties: Record<string, PropertyValue> = {
    name: title,
    runId: document.run.id,
    workflowId: document.run.workflowId,
    displayName: title,
    jsonPointer: '/run',
    parentId: null,
    position: 0,
    containerType: 'run',
    propertyCount: Object.keys(document.run).length,
  };
  copyScalarFields(document.run, rootProperties);
  nodes.push({ id: rootId, labels: ['WorkflowRun'], properties: rootProperties });
  pointerByNodeId.set(rootId, '/run');
  for (const pointer of ['', '/format', '/version', '/run']) nodeIdByPointer.set(pointer, rootId);

  let scalarValues = 2;
  let containers = 1;
  for (const [position, [key, child]] of Object.entries(document.run).entries()) {
    const pointer = appendJsonPointer('/run', key);
    if (isContainer(child)) {
      const result = addLegacyContainer({
        value: child, pointer, key, position, parentId: rootId, parentPointer: '/run',
        runId: document.run.id, nodes, edges, nodeIdByPointer, pointerByNodeId, depth: 0,
      });
      containers += result.containers;
      scalarValues += result.scalarValues;
    } else if (isJsonPrimitive(child)) {
      nodeIdByPointer.set(pointer, rootId);
      scalarValues += 1;
    }
  }

  if (isContainer(document.output)) {
    const result = addLegacyContainer({
      value: document.output, pointer: '/output', key: 'output', position: 0,
      parentId: rootId, parentPointer: '/run', runId: document.run.id,
      nodes, edges, nodeIdByPointer, pointerByNodeId, depth: 0,
    });
    containers += result.containers;
    scalarValues += result.scalarValues;
  } else {
    rootProperties.output = document.output;
    nodeIdByPointer.set('/output', rootId);
    scalarValues += 1;
  }

  const timestamp = validIso(document.run.completedAt) ?? validIso(document.run.startedAt) ?? '1970-01-01T00:00:00.000Z';
  const graph = createGraphDocument(title, document.run.id, timestamp, options.sourcePath, nodes, edges);
  return {
    document,
    graph,
    nodeIdByPointer,
    pointerByNodeId,
    hierarchyRootIds: [rootId],
    hierarchyChildren: orderedChildren(nodes.map((node) => node.id), edges),
    summary: {
      runId: document.run.id,
      workflowId: document.run.workflowId,
      workflowName: typeof document.run.workflowName === 'string' ? document.run.workflowName : document.run.workflowId,
      status: typeof document.run.status === 'string' ? document.run.status : 'loaded',
    },
    stats: { containers, scalarValues, graphNodes: nodes.length, graphEdges: edges.length },
    sourceName: options.sourceName,
    sourcePath: options.sourcePath ?? null,
  };
}

function createGraphDocument(
  title: string,
  runId: string,
  timestamp: string,
  sourcePath: string | null | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[]
): GraphDocument {
  return {
    version: 1,
    metadata: {
      name: title,
      createdAt: timestamp,
      updatedAt: timestamp,
      sources: [{
        id: `phase-x-run:${encodeURIComponent(runId)}`,
        kind: 'import',
        url: sourcePath ?? `amq://phase-x/runs/${encodeURIComponent(runId)}`,
        title,
        ingestedAt: timestamp,
        nodeIds: nodes.map((node) => node.id),
      }],
    },
    nodes,
    edges,
  };
}

interface LegacyContainerContext {
  value: JsonValue[] | { [key: string]: JsonValue };
  pointer: string;
  key: string;
  position: number;
  parentId: string;
  parentPointer: string;
  runId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeIdByPointer: Map<string, string>;
  pointerByNodeId: Map<string, string>;
  depth: number;
}

function addLegacyContainer(context: LegacyContainerContext): { containers: number; scalarValues: number } {
  if (context.depth > MAX_DEPTH) {
    throw new Error(`Die JSON-Hierarchie ist bei „${context.pointer}“ zu tief.`);
  }
  const isList = Array.isArray(context.value);
  const id = `phase-x-run:${encodeURIComponent(context.runId)}#${context.pointer}`;
  const properties: Record<string, PropertyValue> = {
    name: containerTitle(context.value, context.key, context.position),
    displayName: humaniseKey(context.key),
    jsonPointer: context.pointer,
    parentId: context.parentId,
    parentPointer: context.parentPointer,
    position: context.position,
    containerType: isList ? 'array' : 'object',
    itemCount: Array.isArray(context.value) ? context.value.length : Object.keys(context.value).length,
  };
  if (Array.isArray(context.value)) copyScalarArrayItems(context.value, properties);
  else copyScalarFields(context.value, properties);
  const labels = context.pointer === '/output'
    ? ['Output', isList ? 'Collection' : 'Object']
    : isList ? ['Collection'] : [/^\d+$/.test(context.key) ? 'Record' : 'Object'];
  context.nodes.push({ id, labels, properties });
  context.edges.push({
    id: `${context.parentId}|CONTAINS|${id}`,
    type: 'CONTAINS',
    from: context.parentId,
    to: id,
    properties: { key: context.key, ordinal: context.position, jsonPointer: context.pointer },
  });
  context.nodeIdByPointer.set(context.pointer, id);
  context.pointerByNodeId.set(id, context.pointer);

  let containers = 1;
  let scalarValues = 0;
  const entries = Array.isArray(context.value)
    ? context.value.map((child, index) => [String(index), child] as const)
    : Object.entries(context.value);
  for (let position = 0; position < entries.length; position += 1) {
    const [key, child] = entries[position];
    const pointer = appendJsonPointer(context.pointer, key);
    if (isContainer(child)) {
      const result = addLegacyContainer({
        ...context,
        value: child,
        pointer,
        key,
        position,
        parentId: id,
        parentPointer: context.pointer,
        depth: context.depth + 1,
      });
      containers += result.containers;
      scalarValues += result.scalarValues;
    } else {
      context.nodeIdByPointer.set(pointer, id);
      scalarValues += 1;
    }
  }
  if (containers > MAX_CONTAINERS) throw new Error(`Zu viele Bereiche unter „${context.pointer}“.`);
  return { containers, scalarValues };
}

function orderedChildren(
  nodeIds: string[],
  edges: Array<{ type: string; from: string; to: string; ordinal?: number; properties?: Record<string, unknown> }>
): Map<string, string[]> {
  const known = new Set(nodeIds);
  const grouped = new Map<string, Array<{ id: string; ordinal: number }>>();
  for (const edge of edges) {
    if (edge.type !== 'CONTAINS' || !known.has(edge.from) || !known.has(edge.to)) continue;
    const ordinal = edge.ordinal ?? (typeof edge.properties?.ordinal === 'number' ? edge.properties.ordinal : 0);
    const items = grouped.get(edge.from) ?? [];
    items.push({ id: edge.to, ordinal });
    grouped.set(edge.from, items);
  }
  return new Map(
    [...grouped].map(([parent, children]) => [
      parent,
      children.sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id)).map((child) => child.id),
    ])
  );
}

function copyScalarFields(
  value: Record<string, unknown>,
  target: Record<string, PropertyValue>,
  prefix = ''
): void {
  for (const [key, child] of Object.entries(value)) {
    if (!isJsonPrimitive(child)) continue;
    const candidate = `${prefix}${key}`;
    const propertyKey = STRUCTURAL_PROPERTIES.has(candidate) ? `value.${candidate}` : candidate;
    target[propertyKey] = child;
  }
}

function copyScalarArrayItems(value: JsonValue[], target: Record<string, PropertyValue>): void {
  value.forEach((child, index) => {
    if (isJsonPrimitive(child)) target[`item ${index + 1}`] = child;
  });
}

function mapSubtreePointers(
  value: JsonValue,
  pointer: string,
  nodeId: string,
  map: Map<string, string>
): void {
  const stack: Array<{ value: JsonValue; pointer: string }> = [{ value, pointer }];
  while (stack.length > 0) {
    const current = stack.pop()!;
    map.set(current.pointer, nodeId);
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => {
        stack.push({ value: child, pointer: appendJsonPointer(current.pointer, String(index)) });
      });
    } else if (isRecord(current.value)) {
      Object.entries(current.value).forEach(([key, child]) => {
        stack.push({ value: child as JsonValue, pointer: appendJsonPointer(current.pointer, key) });
      });
    }
  }
}

function countScalars(value: JsonValue): number {
  let count = 0;
  const stack: JsonValue[] = [value];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (Array.isArray(current)) stack.push(...current);
    else if (isRecord(current)) stack.push(...Object.values(current) as JsonValue[]);
    else count += 1;
  }
  return count;
}

function assertJsonValue(value: unknown, rootPointer: string): asserts value is JsonValue {
  const stack: Array<{ value: unknown; pointer: string; depth: number }> = [
    { value, pointer: rootPointer, depth: 0 },
  ];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.depth > MAX_DEPTH) {
      throw new Error(`Die JSON-Hierarchie ist bei „${current.pointer}“ zu tief.`);
    }
    if (isJsonPrimitive(current.value)) continue;
    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => stack.push({
        value: child,
        pointer: appendJsonPointer(current.pointer, String(index)),
        depth: current.depth + 1,
      }));
    } else if (isRecord(current.value)) {
      Object.entries(current.value).forEach(([key, child]) => stack.push({
        value: child,
        pointer: appendJsonPointer(current.pointer, key),
        depth: current.depth + 1,
      }));
    } else {
      throw new Error(`„${current.pointer || '/'}“ enthält keinen gültigen JSON-Wert.`);
    }
  }
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`„${path}“ muss ein Objekt sein.`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`„${path}“ muss Text enthalten.`);
  }
  return value;
}

function requiredDate(value: unknown, path: string): string {
  const result = requiredString(value, path);
  if (Number.isNaN(Date.parse(result))) throw new Error(`„${path}“ muss ein gültiger Zeitstempel sein.`);
  return result;
}

function validateNamedIdentity(value: unknown, path: string): void {
  const record = requiredRecord(value, path);
  requiredString(record.id, `${path}.id`);
  requiredString(record.name, `${path}.name`);
}

function isContainer(value: unknown): value is JsonValue[] | { [key: string]: JsonValue } {
  return Array.isArray(value) || isRecord(value);
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value));
}

function legacyTitle(run: PhaseXRunMetadata): string {
  const name = typeof run.workflowName === 'string' ? run.workflowName.trim() : '';
  return name ? `${run.workflowId} — ${name}` : `${run.workflowId} — Lauf ${run.id.slice(0, 12)}`;
}

function containerTitle(
  value: JsonValue[] | { [key: string]: JsonValue },
  key: string,
  position: number
): string {
  if (!Array.isArray(value)) {
    for (const candidate of ['name', 'title', 'label', 'id']) {
      const found = value[candidate];
      if (typeof found === 'string' && found.trim()) return found;
    }
  }
  if (/^\d+$/.test(key)) return `Eintrag ${position + 1}`;
  if (key === 'output') return 'Ergebnis';
  return humaniseKey(key);
}

function humaniseKey(value: string): string {
  return (value || 'Laufdatei')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-zäöüß])([A-ZÄÖÜ])/g, '$1 $2')
    .replace(/^./, (first) => first.toUpperCase());
}

function validIso(value: JsonValue | undefined): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function appendJsonPointer(parent: string, key: string): string {
  return `${parent}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

export function decodeJsonPointerSegment(value: string): string {
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function jsonPointerAncestors(pointer: string): string[] {
  if (!pointer) return [''];
  const result = [''];
  let current = '';
  for (const segment of pointer.split('/').slice(1, -1)) {
    current = `${current}/${segment}`;
    result.push(current);
  }
  return result;
}

export function valueAtJsonPointer(root: JsonValue, pointer: string): JsonValue | undefined {
  if (!pointer) return root;
  let current: JsonValue = root;
  for (const encoded of pointer.split('/').slice(1)) {
    const key = decodeJsonPointerSegment(encoded);
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, key)) {
      current = current[key] as JsonValue;
    } else return undefined;
  }
  return current;
}
