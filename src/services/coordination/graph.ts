import { GraphEdge, GraphNode, GraphSource } from '../../types/graph';
import { CoordinationRecord, CoordinationSet, Impact, WorkRecord } from '../../types/coordination';
import { edgeId, entityId } from '../../lib/graph';
import { bool, list, num, parseRecord, RecordParseError, str } from './frontmatter';

/**
 * Turns a folder of coordination records into a subgraph.
 *
 * The records are already a graph — a workstream depends on a workstream, an
 * actor owns one, a change affects several — but the tracker can only present
 * them as a table, and a table cannot answer the one question that matters
 * after a breaking change: *what else is now in doubt?* That is a walk over
 * `depends_on`, so it belongs on a canvas.
 *
 * Nothing here writes back. The tracker owns its records, including their
 * immutability rules; a second writer with its own idea of those rules would
 * be a way to corrupt them, not a feature.
 */

/** Labels are distinct from the ingest ontology on purpose — see `LABEL_COLORS`. */
export const COORDINATION_LABELS = ['Workstream', 'Actor', 'Change', 'Handoff', 'Decision', 'Target'] as const;

/**
 * Whether a workstream is still standing on the upstream revision it was built
 * on. `unknown` fails closed — the schema requires downstream work to treat an
 * undeterminable dependency as needing review, so it is never reported as
 * current.
 */
export type DependencyState = 'current' | 'stale' | 'unknown';

export interface CoordinationGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Files that could not be read and references that pointed nowhere. */
  problems: string[];
}

// MARK: - Reading records

/** Parses a folder's worth of files, keeping the failures instead of dropping them. */
export function readRecords(files: Array<{ name: string; contents: string }>): CoordinationSet {
  const set: CoordinationSet = { work: [], events: [], handoffs: [], decisions: [], actors: [], problems: [] };

  for (const file of files) {
    let record: CoordinationRecord;
    try {
      record = parseRecord(file.contents, file.name);
    } catch (err) {
      set.problems.push(
        err instanceof RecordParseError ? err.message : `${file.name}: ${err instanceof Error ? err.message : err}`
      );
      continue;
    }

    const { data } = record;
    switch (record.type) {
      case 'work':
        set.work.push({
          workId: str(data, 'work_id'),
          title: str(data, 'title'),
          status: str(data, 'status'),
          revision: num(data, 'revision'),
          owner: str(data, 'owner'),
          agent: str(data, 'agent'),
          actorId: str(data, 'actor_id'),
          initiatedBy: str(data, 'initiated_by'),
          objective: str(data, 'objective'),
          targets: list(data, 'targets'),
          dependsOn: list(data, 'depends_on'),
          dependencyBaseline: list(data, 'dependency_baseline'),
          acceptanceTotal: num(data, 'acceptance_total'),
          acceptancePassed: num(data, 'acceptance_passed'),
          currentState: str(data, 'current_state'),
          blocker: str(data, 'blocker'),
          nextAction: str(data, 'next_action'),
          claimExpires: str(data, 'claim_expires'),
          handoffPending: bool(data, 'handoff_pending'),
          updated: str(data, 'updated'),
        });
        break;

      case 'event':
        set.events.push({
          eventId: str(data, 'event_id'),
          eventType: str(data, 'event_type'),
          workId: str(data, 'work_id'),
          workRevision: num(data, 'work_revision'),
          timestamp: str(data, 'timestamp'),
          actorId: str(data, 'actor_id'),
          summary: str(data, 'summary'),
          changeKind: str(data, 'change_kind'),
          impact: impactOf(str(data, 'impact')),
          statusBefore: str(data, 'status_before'),
          statusAfter: str(data, 'status_after'),
          changedTargets: list(data, 'changed_targets'),
          affects: list(data, 'affects'),
        });
        break;

      case 'handoff':
        set.handoffs.push({
          handoffId: str(data, 'handoff_id'),
          workId: str(data, 'work_id'),
          timestamp: str(data, 'timestamp'),
          fromActor: str(data, 'from_actor'),
          toActor: str(data, 'to_actor'),
          lastVerified: str(data, 'last_verified'),
          nextAction: str(data, 'next_action'),
          acknowledged: bool(data, 'acknowledged'),
        });
        break;

      case 'decision':
        set.decisions.push({
          decisionId: str(data, 'decision_id'),
          decisionKey: str(data, 'decision_key'),
          timestamp: str(data, 'timestamp'),
          actorId: str(data, 'actor_id'),
          summary: str(data, 'summary'),
          rationale: str(data, 'rationale'),
          impact: impactOf(str(data, 'impact')),
          affects: list(data, 'affects'),
          supersedes: str(data, 'supersedes'),
        });
        break;

      case 'actor':
        set.actors.push({
          actorId: str(data, 'actor_id'),
          human: str(data, 'human'),
          agent: str(data, 'agent'),
          activeWork: list(data, 'active_work'),
          lastSync: str(data, 'last_sync'),
          updated: str(data, 'updated'),
        });
        break;
    }
  }

  return set;
}

function impactOf(value: string): Impact {
  return value === 'none' || value === 'compatible' || value === 'breaking' ? value : 'unknown';
}

// MARK: - Identity
//
// Ids follow the app's rule that the same thing seen twice lands on the same
// node. Record ids are already unique within a project, so they are used
// directly — which also means two *different* projects' records merged into one
// graph would collide on a shared id like `ARCH-001`. That is why the importer
// starts a fresh graph rather than merging into the open one.

const workNode = (workId: string) => entityId('Workstream', workId);
const actorNode = (actorId: string) => entityId('Actor', actorId);
const changeNode = (eventId: string) => entityId('Change', eventId);
const handoffNode = (handoffId: string) => entityId('Handoff', handoffId);
const decisionNode = (decisionId: string) => entityId('Decision', decisionId);

/**
 * Targets keep their full path instead of going through `entityId`, whose
 * 64-character cap would map `src/components/…/a.tsx` and `…/b.tsx` onto one
 * node once the shared prefix is long enough. A path is already a stable id.
 */
const targetNode = (path: string) => `target:${path}`.slice(0, 200);

// MARK: - Building

export function buildCoordinationGraph(set: CoordinationSet, at: Date = new Date()): CoordinationGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const problems = [...set.problems];

  const byId = new Map(set.work.map((work) => [work.workId, work]));
  const known = new Set<string>();
  const actors = new Set(set.actors.map((actor) => actor.actorId));

  const addNode = (node: GraphNode) => {
    if (known.has(node.id)) return;
    known.add(node.id);
    nodes.push(node);
  };

  /**
   * An edge is only worth drawing when both ends exist. A reference into
   * nothing means a record is missing from the folder, which the schema calls
   * a blocker — so it is reported rather than papered over with a stub node
   * that would look like real work.
   */
  const addEdge = (from: string, type: string, to: string, properties: GraphEdge['properties'] = {}, note?: string) => {
    if (!known.has(from) || !known.has(to)) {
      if (note) problems.push(note);
      return;
    }
    edges.push({ id: edgeId(from, type, to), type, from, to, properties });
  };

  // Targets first: several record types point at them, and a target that only
  // a change touched should still exist as a node.
  const addTarget = (path: string) => {
    addNode({ id: targetNode(path), labels: ['Target'], properties: { name: path, path } });
    return targetNode(path);
  };

  for (const actor of set.actors) {
    addNode({
      id: actorNode(actor.actorId),
      labels: ['Actor'],
      properties: {
        name: actor.human ? `${actor.human} · ${actor.agent}` : actor.actorId,
        actorId: actor.actorId,
        human: actor.human,
        agent: actor.agent,
        activeWork: actor.activeWork.length,
        lastSync: actor.lastSync,
        updated: actor.updated,
      },
    });
  }

  for (const work of set.work) {
    const dependencies = resolveDependencies(work, byId);
    const needsReview = dependencies.filter((entry) => entry.state !== 'current');

    addNode({
      id: workNode(work.workId),
      labels: ['Workstream'],
      properties: {
        name: work.title || work.workId,
        workId: work.workId,
        status: work.status,
        revision: work.revision,
        owner: work.owner,
        agent: work.agent,
        actorId: work.actorId,
        initiatedBy: work.initiatedBy,
        objective: work.objective,
        currentState: work.currentState,
        blocker: work.blocker,
        nextAction: work.nextAction,
        acceptance: `${work.acceptancePassed}/${work.acceptanceTotal}`,
        acceptancePassed: work.acceptancePassed,
        acceptanceTotal: work.acceptanceTotal,
        handoffPending: work.handoffPending,
        // Derived, not recorded: what the records say about each other once
        // read together. This is the whole reason the folder is worth drawing.
        needsReview: needsReview.length > 0,
        staleDependencies: needsReview.length,
        claimExpired: isExpired(work.claimExpires, at),
        claimExpires: work.claimExpires,
        targets: work.targets,
        updated: work.updated,
      },
    });
  }

  // Work-to-work edges need every workstream node to exist first.
  for (const work of set.work) {
    for (const dependency of resolveDependencies(work, byId)) {
      addEdge(
        workNode(work.workId),
        'DEPENDS_ON',
        workNode(dependency.workId),
        {
          state: dependency.state,
          needsReview: dependency.state !== 'current',
          baselineRevision: dependency.baselineRevision,
          upstreamRevision: dependency.upstreamRevision,
        },
        `${work.workId} hängt an ${dependency.workId}, wofür es keinen Record gibt.`
      );
    }

    for (const target of work.targets) {
      const id = addTarget(target);
      addEdge(workNode(work.workId), 'TOUCHES', id);
    }

    if (work.actorId && actors.has(work.actorId)) {
      addEdge(actorNode(work.actorId), 'OWNS', workNode(work.workId));
    }
  }

  for (const event of set.events) {
    const id = changeNode(event.eventId);
    addNode({
      id,
      labels: ['Change'],
      properties: {
        name: event.summary || event.eventType,
        eventId: event.eventId,
        eventType: event.eventType,
        changeKind: event.changeKind,
        impact: event.impact,
        workId: event.workId,
        workRevision: event.workRevision,
        statusBefore: event.statusBefore,
        statusAfter: event.statusAfter,
        actorId: event.actorId,
        timestamp: event.timestamp,
      },
    });

    addEdge(id, 'RECORDED_FOR', workNode(event.workId));
    if (event.actorId) addEdge(actorNode(event.actorId), 'PERFORMED', id);
    for (const affected of event.affects) {
      addEdge(
        id,
        'AFFECTS',
        workNode(affected),
        {},
        `Änderung "${event.summary}" nennt ${affected} als betroffen, wofür es keinen Record gibt.`
      );
    }
    for (const target of event.changedTargets) addEdge(id, 'CHANGED', addTarget(target));
  }

  for (const handoff of set.handoffs) {
    const id = handoffNode(handoff.handoffId);
    addNode({
      id,
      labels: ['Handoff'],
      properties: {
        name: `${handoff.fromActor} → ${handoff.toActor}`,
        handoffId: handoff.handoffId,
        workId: handoff.workId,
        fromActor: handoff.fromActor,
        toActor: handoff.toActor,
        lastVerified: handoff.lastVerified,
        nextAction: handoff.nextAction,
        acknowledged: handoff.acknowledged,
        timestamp: handoff.timestamp,
      },
    });

    addEdge(id, 'HANDS_OVER', workNode(handoff.workId));
    if (handoff.fromActor) addEdge(id, 'FROM_ACTOR', actorNode(handoff.fromActor));
    if (handoff.toActor) addEdge(id, 'TO_ACTOR', actorNode(handoff.toActor));
  }

  for (const decision of set.decisions) {
    const id = decisionNode(decision.decisionId);
    addNode({
      id,
      labels: ['Decision'],
      properties: {
        name: decision.summary || decision.decisionKey,
        decisionId: decision.decisionId,
        decisionKey: decision.decisionKey,
        rationale: decision.rationale,
        impact: decision.impact,
        actorId: decision.actorId,
        timestamp: decision.timestamp,
      },
    });

    if (decision.actorId) addEdge(actorNode(decision.actorId), 'DECIDED', id);
    for (const affected of decision.affects) addEdge(id, 'AFFECTS', workNode(affected));
    if (decision.supersedes) addEdge(id, 'SUPERSEDES', decisionNode(decision.supersedes));
  }

  return { nodes, edges, problems };
}

interface ResolvedDependency {
  workId: string;
  state: DependencyState;
  baselineRevision: number;
  upstreamRevision: number;
}

/**
 * Compares each declared dependency against the upstream record's current
 * revision. `dependency_baseline` holds `WORK-ID@revision` strings; a baseline
 * below the upstream revision is exactly the schema's definition of work that
 * needs review.
 */
function resolveDependencies(work: WorkRecord, byId: Map<string, WorkRecord>): ResolvedDependency[] {
  const baselines = new Map<string, number>();
  for (const entry of work.dependencyBaseline) {
    const at = entry.lastIndexOf('@');
    if (at === -1) continue;
    const revision = Number(entry.slice(at + 1));
    if (Number.isFinite(revision)) baselines.set(entry.slice(0, at), revision);
  }

  return work.dependsOn.map((workId) => {
    const upstream = byId.get(workId);
    const baselineRevision = baselines.get(workId) ?? 0;
    const upstreamRevision = upstream?.revision ?? 0;

    // No upstream record, or no baseline recorded for a declared dependency:
    // the comparison cannot be made, and the schema says an undeterminable
    // dependency fails closed rather than counting as current.
    let state: DependencyState = 'unknown';
    if (upstream && baselines.has(workId)) {
      state = baselineRevision < upstreamRevision ? 'stale' : 'current';
    }

    return { workId, state, baselineRevision, upstreamRevision };
  });
}

/** An expired claim is a fact about the clock, not proof the owner stopped. */
function isExpired(claimExpires: string, at: Date): boolean {
  if (!claimExpires) return false;
  const deadline = Date.parse(claimExpires);
  return Number.isFinite(deadline) && deadline < at.getTime();
}

/** The `metadata.sources` entry, so an import can be identified and removed again. */
export function coordinationSource(folder: string, nodes: GraphNode[], at: Date = new Date()): GraphSource {
  const name = folder.replace(/\/+$/, '').split('/').slice(-2).join('/') || folder;
  return {
    id: `coordination:${folder}`,
    kind: 'coordination',
    url: folder,
    title: `Koordination · ${name}`,
    ingestedAt: at.toISOString(),
    nodeIds: nodes.map((node) => node.id),
  };
}
