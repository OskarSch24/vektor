/**
 * The coordination records a shared-workspace tracker keeps next to a project,
 * as produced by `Coordination/project_tracker.py`
 * (github.com/Kian-hdr/shared-obsidian-workspace).
 *
 * They are ordinary Markdown notes with flat YAML frontmatter: one mutable
 * `work` record per workstream, plus immutable `event`, `handoff`, `decision`
 * and one `actor` record per human-agent pair. Database Studio reads them and
 * never writes them — the tracker owns its own state, and duplicating its
 * immutability rules here would put the same invariant in two places.
 *
 * Only the fields the graph actually uses are declared. The schema has more,
 * and a record carrying unknown keys is still valid; pinning all of them here
 * would break this file every time the tracker gains one.
 */

export type RecordType = 'work' | 'event' | 'handoff' | 'decision' | 'actor';

/** What the frontmatter grammar can hold. Deliberately narrow — see the parser. */
export type FrontmatterValue = string | number | boolean | null | FrontmatterValue[];

export type Frontmatter = Record<string, FrontmatterValue>;

/** One parsed record file: its frontmatter, its Markdown body, its origin. */
export interface CoordinationRecord {
  type: RecordType;
  /** File name, kept so a parse problem can name the file it came from. */
  filename: string;
  data: Frontmatter;
}

/** Impact of a change on downstream work, as the schema defines it. */
export type Impact = 'none' | 'compatible' | 'breaking' | 'unknown';

export interface WorkRecord {
  workId: string;
  title: string;
  status: string;
  revision: number;
  owner: string;
  agent: string;
  actorId: string;
  initiatedBy: string;
  objective: string;
  targets: string[];
  dependsOn: string[];
  /** `WORK-ID@revision` strings: the upstream revision this work was built on. */
  dependencyBaseline: string[];
  acceptanceTotal: number;
  acceptancePassed: number;
  currentState: string;
  blocker: string;
  nextAction: string;
  claimExpires: string;
  handoffPending: boolean;
  updated: string;
}

export interface EventRecord {
  eventId: string;
  eventType: string;
  workId: string;
  workRevision: number;
  timestamp: string;
  actorId: string;
  summary: string;
  changeKind: string;
  impact: Impact;
  statusBefore: string;
  statusAfter: string;
  changedTargets: string[];
  /** Work IDs the recorder declared as affected by this change. */
  affects: string[];
}

export interface HandoffRecord {
  handoffId: string;
  workId: string;
  timestamp: string;
  fromActor: string;
  toActor: string;
  lastVerified: string;
  nextAction: string;
  acknowledged: boolean;
}

export interface DecisionRecord {
  decisionId: string;
  decisionKey: string;
  timestamp: string;
  actorId: string;
  summary: string;
  rationale: string;
  impact: Impact;
  affects: string[];
  supersedes: string;
}

export interface ActorRecord {
  actorId: string;
  human: string;
  agent: string;
  activeWork: string[];
  lastSync: string;
  updated: string;
}

/** Everything one folder of records adds up to, before it becomes a graph. */
export interface CoordinationSet {
  work: WorkRecord[];
  events: EventRecord[];
  handoffs: HandoffRecord[];
  decisions: DecisionRecord[];
  actors: ActorRecord[];
  /** Files that could not be read, with the reason. Never silently dropped. */
  problems: string[];
}
