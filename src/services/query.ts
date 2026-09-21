import { GraphEdge, GraphNode, PropertyValue, QueryResult } from '../types/graph';
import { graphEngine } from './graphEngine';

/**
 * A deliberately small Cypher subset — enough to answer the questions this app
 * actually creates data for, without pretending to be a graph database.
 *
 * Supported:
 *
 *   MATCH (a:Person)                      RETURN a
 *   MATCH (a:Page)-[r:MENTIONS]->(b)      RETURN a.title, b.name, r.weight
 *   MATCH (a)-[r]-(b) WHERE a.name CONTAINS "Berlin" AND b.kind <> "video"
 *     RETURN a, b ORDER BY a.name DESC LIMIT 50
 *   MATCH (a:Topic) RETURN a.name, count(*) AS n ORDER BY n DESC
 *
 * Not supported, and reported as such rather than silently mis-answered:
 * variable-length paths, multi-hop patterns, OPTIONAL MATCH, and every write
 * clause (CREATE / MERGE / SET / DELETE) — the graph is edited through the
 * inspector and through ingest, not through the query box.
 */

// MARK: - Tokenizer

type TokenKind = 'ident' | 'string' | 'number' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  position: number;
}

const PUNCT = ['<>', '<=', '>=', '->', '<-', '=~', '(', ')', '[', ']', '{', '}', ',', ':', '.', '=', '<', '>', '-', '*'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const char = input[i];

    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\' && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
          continue;
        }
        value += input[i];
        i += 1;
      }
      if (i >= input.length) throw new QueryError('Nicht geschlossenes Anführungszeichen', i);
      i += 1;
      tokens.push({ kind: 'string', value, position: i });
      continue;
    }

    if (/[0-9]/.test(char) || (char === '-' && /[0-9]/.test(input[i + 1] ?? '') && lastIsOperand(tokens) === false)) {
      let value = '';
      if (char === '-') {
        value = '-';
        i += 1;
      }
      while (i < input.length && /[0-9.]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'number', value, position: i });
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'ident', value, position: i });
      continue;
    }

    const punct = PUNCT.find((p) => input.startsWith(p, i));
    if (punct) {
      tokens.push({ kind: 'punct', value: punct, position: i });
      i += punct.length;
      continue;
    }

    throw new QueryError(`Unerwartetes Zeichen "${char}"`, i);
  }

  tokens.push({ kind: 'eof', value: '', position: input.length });
  return tokens;
}

/** True when the previous token could end an operand, so `-` is an operator. */
function lastIsOperand(tokens: Token[]): boolean {
  const last = tokens[tokens.length - 1];
  if (!last) return false;
  if (last.kind === 'number' || last.kind === 'string' || last.kind === 'ident') return true;
  return last.value === ')' || last.value === ']';
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly position: number
  ) {
    super(message);
    this.name = 'QueryError';
  }
}

// MARK: - AST

interface NodePattern {
  variable: string | null;
  labels: string[];
  properties: Record<string, PropertyValue>;
}

interface EdgePattern {
  variable: string | null;
  types: string[];
  /** `out` = `-[]->`, `in` = `<-[]-`, `any` = `-[]-`. */
  direction: 'out' | 'in' | 'any';
  properties: Record<string, PropertyValue>;
}

interface MatchClause {
  start: NodePattern;
  /** At most one hop; longer patterns are rejected with a clear message. */
  hop: { edge: EdgePattern; end: NodePattern } | null;
}

type Condition =
  | { kind: 'compare'; left: Accessor; operator: string; right: PropertyValue }
  | { kind: 'and'; left: Condition; right: Condition }
  | { kind: 'or'; left: Condition; right: Condition }
  | { kind: 'not'; inner: Condition }
  | { kind: 'label'; variable: string; label: string };

interface Accessor {
  variable: string;
  property: string | null;
}

interface ReturnItem {
  /** `count(*)` and `count(x)` are the only aggregates. */
  aggregate: 'count' | null;
  accessor: Accessor | null;
  alias: string;
}

interface Query {
  match: MatchClause;
  where: Condition | null;
  returns: ReturnItem[];
  orderBy: { column: string; descending: boolean } | null;
  limit: number | null;
}

// MARK: - Parser

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Query {
    this.expectKeyword('MATCH');
    const match = this.parseMatch();

    let where: Condition | null = null;
    if (this.peekKeyword('WHERE')) {
      this.index += 1;
      where = this.parseCondition();
    }

    this.expectKeyword('RETURN');
    const returns = this.parseReturn();

    let orderBy: Query['orderBy'] = null;
    if (this.peekKeyword('ORDER')) {
      this.index += 1;
      this.expectKeyword('BY');
      const column = this.parseOrderColumn();
      let descending = false;
      if (this.peekKeyword('DESC')) {
        descending = true;
        this.index += 1;
      } else if (this.peekKeyword('ASC')) {
        this.index += 1;
      }
      orderBy = { column, descending };
    }

    let limit: number | null = null;
    if (this.peekKeyword('LIMIT')) {
      this.index += 1;
      const token = this.next();
      if (token.kind !== 'number') throw new QueryError('LIMIT erwartet eine Zahl', token.position);
      limit = Number.parseInt(token.value, 10);
    }

    const trailing = this.peek();
    if (trailing.kind !== 'eof') {
      throw new QueryError(`Unerwartetes "${trailing.value}" am Ende der Abfrage`, trailing.position);
    }

    return { match, where, returns, orderBy, limit };
  }

  private parseMatch(): MatchClause {
    const start = this.parseNodePattern();

    if (!this.peekPunct('-') && !this.peekPunct('<-')) {
      return { start, hop: null };
    }

    const edge = this.parseEdgePattern();
    const end = this.parseNodePattern();

    if (this.peekPunct('-') || this.peekPunct('<-')) {
      throw new QueryError(
        'Mehr als ein Beziehungs-Schritt wird nicht unterstützt. Formuliere zwei Abfragen.',
        this.peek().position
      );
    }

    return { start, hop: { edge, end } };
  }

  private parseNodePattern(): NodePattern {
    this.expectPunct('(');
    let variable: string | null = null;
    const labels: string[] = [];

    if (this.peek().kind === 'ident') {
      variable = this.next().value;
    }
    while (this.peekPunct(':')) {
      this.index += 1;
      const label = this.next();
      if (label.kind !== 'ident') throw new QueryError('Label erwartet', label.position);
      labels.push(label.value);
    }

    const properties = this.peekPunct('{') ? this.parsePropertyMap() : {};
    this.expectPunct(')');
    return { variable, labels, properties };
  }

  private parseEdgePattern(): EdgePattern {
    let direction: EdgePattern['direction'] = 'any';

    if (this.peekPunct('<-')) {
      this.index += 1;
      direction = 'in';
    } else {
      this.expectPunct('-');
    }

    let variable: string | null = null;
    const types: string[] = [];
    let properties: Record<string, PropertyValue> = {};

    if (this.peekPunct('[')) {
      this.index += 1;
      if (this.peek().kind === 'ident') variable = this.next().value;
      while (this.peekPunct(':')) {
        this.index += 1;
        const type = this.next();
        if (type.kind !== 'ident') throw new QueryError('Beziehungstyp erwartet', type.position);
        types.push(type.value);
        // `[:A|:B]` is written with a pipe in Cypher; this subset accepts the
        // repeated-colon form only, which the editor's completion produces.
      }
      if (this.peekPunct('*')) {
        throw new QueryError('Pfade variabler Länge werden nicht unterstützt', this.peek().position);
      }
      if (this.peekPunct('{')) properties = this.parsePropertyMap();
      this.expectPunct(']');
    }

    if (direction === 'in') {
      this.expectPunct('-');
      return { variable, types, direction, properties };
    }

    if (this.peekPunct('->')) {
      this.index += 1;
      return { variable, types, direction: 'out', properties };
    }

    this.expectPunct('-');
    return { variable, types, direction: 'any', properties };
  }

  private parsePropertyMap(): Record<string, PropertyValue> {
    this.expectPunct('{');
    const properties: Record<string, PropertyValue> = {};

    while (!this.peekPunct('}')) {
      const key = this.next();
      if (key.kind !== 'ident') throw new QueryError('Eigenschaftsname erwartet', key.position);
      this.expectPunct(':');
      properties[key.value] = this.parseLiteral();
      if (this.peekPunct(',')) this.index += 1;
    }

    this.expectPunct('}');
    return properties;
  }

  private parseCondition(): Condition {
    let left = this.parseAnd();
    while (this.peekKeyword('OR')) {
      this.index += 1;
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Condition {
    let left = this.parseUnary();
    while (this.peekKeyword('AND')) {
      this.index += 1;
      left = { kind: 'and', left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Condition {
    if (this.peekKeyword('NOT')) {
      this.index += 1;
      return { kind: 'not', inner: this.parseUnary() };
    }
    if (this.peekPunct('(')) {
      this.index += 1;
      const inner = this.parseCondition();
      this.expectPunct(')');
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): Condition {
    const variableToken = this.next();
    if (variableToken.kind !== 'ident') {
      throw new QueryError('Variable erwartet', variableToken.position);
    }

    // `WHERE a:Person` — a label test rather than a property comparison.
    if (this.peekPunct(':')) {
      this.index += 1;
      const label = this.next();
      if (label.kind !== 'ident') throw new QueryError('Label erwartet', label.position);
      return { kind: 'label', variable: variableToken.value, label: label.value };
    }

    let property: string | null = null;
    if (this.peekPunct('.')) {
      this.index += 1;
      const key = this.next();
      if (key.kind !== 'ident') throw new QueryError('Eigenschaftsname erwartet', key.position);
      property = key.value;
    }

    const operatorToken = this.next();
    const operator =
      operatorToken.kind === 'ident' ? operatorToken.value.toUpperCase() : operatorToken.value;

    const known = ['=', '<>', '<', '>', '<=', '>=', 'CONTAINS', 'STARTS', 'ENDS', 'IN'];
    if (!known.includes(operator)) {
      throw new QueryError(`Unbekannter Operator "${operatorToken.value}"`, operatorToken.position);
    }

    // `STARTS WITH` / `ENDS WITH` are two words in Cypher.
    let finalOperator = operator;
    if (operator === 'STARTS' || operator === 'ENDS') {
      this.expectKeyword('WITH');
      finalOperator = operator === 'STARTS' ? 'STARTS WITH' : 'ENDS WITH';
    }

    return {
      kind: 'compare',
      left: { variable: variableToken.value, property },
      operator: finalOperator,
      right: this.parseLiteral(),
    };
  }

  private parseLiteral(): PropertyValue {
    const token = this.next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'ident') {
      const upper = token.value.toUpperCase();
      if (upper === 'TRUE') return true;
      if (upper === 'FALSE') return false;
      if (upper === 'NULL') return null;
    }
    throw new QueryError(`Wert erwartet, gefunden "${token.value}"`, token.position);
  }

  private parseReturn(): ReturnItem[] {
    const items: ReturnItem[] = [];

    do {
      const token = this.next();
      if (token.kind !== 'ident') throw new QueryError('RETURN erwartet eine Variable', token.position);

      let item: ReturnItem;

      if (token.value.toLowerCase() === 'count' && this.peekPunct('(')) {
        this.index += 1;
        let accessor: Accessor | null = null;
        if (this.peekPunct('*')) {
          this.index += 1;
        } else {
          const variable = this.next();
          if (variable.kind !== 'ident') throw new QueryError('Variable erwartet', variable.position);
          accessor = { variable: variable.value, property: null };
        }
        this.expectPunct(')');
        item = { aggregate: 'count', accessor, alias: 'count' };
      } else {
        let property: string | null = null;
        if (this.peekPunct('.')) {
          this.index += 1;
          const key = this.next();
          if (key.kind !== 'ident') throw new QueryError('Eigenschaftsname erwartet', key.position);
          property = key.value;
        }
        item = {
          aggregate: null,
          accessor: { variable: token.value, property },
          alias: property ? `${token.value}.${property}` : token.value,
        };
      }

      if (this.peekKeyword('AS')) {
        this.index += 1;
        const alias = this.next();
        if (alias.kind !== 'ident') throw new QueryError('Alias erwartet', alias.position);
        item.alias = alias.value;
      }

      items.push(item);
    } while (this.consumePunct(','));

    return items;
  }

  private parseOrderColumn(): string {
    const token = this.next();
    if (token.kind !== 'ident') throw new QueryError('ORDER BY erwartet eine Spalte', token.position);
    if (this.peekPunct('.')) {
      this.index += 1;
      const key = this.next();
      if (key.kind !== 'ident') throw new QueryError('Eigenschaftsname erwartet', key.position);
      return `${token.value}.${key.value}`;
    }
    return token.value;
  }

  // MARK: Token helpers

  private peek(): Token {
    return this.tokens[this.index];
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token.kind === 'eof') throw new QueryError('Abfrage endet unerwartet', token.position);
    this.index += 1;
    return token;
  }

  private peekKeyword(keyword: string): boolean {
    const token = this.peek();
    return token.kind === 'ident' && token.value.toUpperCase() === keyword;
  }

  private expectKeyword(keyword: string): void {
    if (!this.peekKeyword(keyword)) {
      throw new QueryError(`"${keyword}" erwartet`, this.peek().position);
    }
    this.index += 1;
  }

  private peekPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private consumePunct(value: string): boolean {
    if (!this.peekPunct(value)) return false;
    this.index += 1;
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.peekPunct(value)) {
      throw new QueryError(`"${value}" erwartet, gefunden "${this.peek().value || 'Ende'}"`, this.peek().position);
    }
    this.index += 1;
  }
}

// MARK: - Execution

type Binding = Record<string, GraphNode | GraphEdge>;

function isNode(value: GraphNode | GraphEdge): value is GraphNode {
  return 'labels' in value;
}

function matchesNode(node: GraphNode, pattern: NodePattern): boolean {
  if (!pattern.labels.every((label) => node.labels.includes(label))) return false;
  return Object.entries(pattern.properties).every(([key, value]) => node.properties[key] === value);
}

function matchesEdge(edge: GraphEdge, pattern: EdgePattern): boolean {
  if (pattern.types.length > 0 && !pattern.types.includes(edge.type)) return false;
  return Object.entries(pattern.properties).every(([key, value]) => edge.properties[key] === value);
}

function resolve(binding: Binding, accessor: Accessor): PropertyValue {
  const entity = binding[accessor.variable];
  if (!entity) return null;

  if (accessor.property === null) {
    // A bare variable renders as its most identifying property, so a result
    // grid stays readable without the user naming a property every time.
    if (isNode(entity)) {
      const label = entity.labels[0] ?? 'Node';
      const name =
        entity.properties.name ?? entity.properties.title ?? entity.properties.text ?? entity.id;
      return `(:${label} ${String(name)})`;
    }
    return `[:${entity.type}]`;
  }

  const value = entity.properties[accessor.property];
  return value === undefined ? null : value;
}

function evaluate(condition: Condition, binding: Binding): boolean {
  switch (condition.kind) {
    case 'and':
      return evaluate(condition.left, binding) && evaluate(condition.right, binding);
    case 'or':
      return evaluate(condition.left, binding) || evaluate(condition.right, binding);
    case 'not':
      return !evaluate(condition.inner, binding);
    case 'label': {
      const entity = binding[condition.variable];
      return Boolean(entity && isNode(entity) && entity.labels.includes(condition.label));
    }
    case 'compare': {
      const left = resolve(binding, condition.left);
      return compare(left, condition.operator, condition.right);
    }
  }
}

function compare(left: PropertyValue, operator: string, right: PropertyValue): boolean {
  switch (operator) {
    case '=':
      return left === right;
    case '<>':
      return left !== right;
    case 'CONTAINS':
      return String(left ?? '').toLowerCase().includes(String(right ?? '').toLowerCase());
    case 'STARTS WITH':
      return String(left ?? '').toLowerCase().startsWith(String(right ?? '').toLowerCase());
    case 'ENDS WITH':
      return String(left ?? '').toLowerCase().endsWith(String(right ?? '').toLowerCase());
    case 'IN':
      return Array.isArray(right) ? right.includes(String(left)) : false;
    default: {
      // Ordering comparisons on incomparable values are false rather than an
      // error — the same way Cypher treats a missing property.
      if (typeof left !== 'number' || typeof right !== 'number') {
        if (typeof left === 'string' && typeof right === 'string') {
          const order = left.localeCompare(right);
          if (operator === '<') return order < 0;
          if (operator === '>') return order > 0;
          if (operator === '<=') return order <= 0;
          if (operator === '>=') return order >= 0;
        }
        return false;
      }
      if (operator === '<') return left < right;
      if (operator === '>') return left > right;
      if (operator === '<=') return left <= right;
      if (operator === '>=') return left >= right;
      return false;
    }
  }
}

/** Runs a query against the loaded graph. Throws `QueryError` on bad syntax. */
export function runQuery(source: string): QueryResult {
  const startedAt = performance.now();
  const query = new Parser(tokenize(source)).parse();

  const bindings: Binding[] = [];
  const startVariable = query.match.start.variable ?? '__start';

  for (const node of graphEngine.getNodes()) {
    if (!matchesNode(node, query.match.start)) continue;

    if (!query.match.hop) {
      bindings.push({ [startVariable]: node });
      continue;
    }

    const { edge: edgePattern, end: endPattern } = query.match.hop;
    const edgeVariable = edgePattern.variable ?? '__edge';
    const endVariable = endPattern.variable ?? '__end';

    for (const edge of graphEngine.incidentEdges(node.id)) {
      if (!matchesEdge(edge, edgePattern)) continue;

      const outgoing = edge.from === node.id;
      if (edgePattern.direction === 'out' && !outgoing) continue;
      if (edgePattern.direction === 'in' && outgoing) continue;

      const otherId = outgoing ? edge.to : edge.from;
      const other = graphEngine.getNode(otherId);
      if (!other || !matchesNode(other, endPattern)) continue;

      bindings.push({ [startVariable]: node, [edgeVariable]: edge, [endVariable]: other });
    }
  }

  const filtered = query.where ? bindings.filter((b) => evaluate(query.where!, b)) : bindings;

  const columns = query.returns.map((item) => item.alias);
  const hasAggregate = query.returns.some((item) => item.aggregate !== null);
  let rows: PropertyValue[][];

  if (hasAggregate) {
    rows = aggregate(query, filtered);
  } else {
    rows = filtered.map((binding) =>
      query.returns.map((item) => (item.accessor ? resolve(binding, item.accessor) : null))
    );
  }

  if (query.orderBy) {
    const columnIndex = columns.indexOf(query.orderBy.column);
    if (columnIndex >= 0) {
      const direction = query.orderBy.descending ? -1 : 1;
      rows = [...rows].sort((a, b) => direction * compareValues(a[columnIndex], b[columnIndex]));
    }
  }

  if (query.limit !== null) rows = rows.slice(0, query.limit);

  // Which entities the result touches, so the canvas can highlight them. This
  // uses the unlimited binding set on purpose: highlighting should follow the
  // match, not the display cut-off applied by LIMIT.
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  for (const binding of filtered) {
    for (const entity of Object.values(binding)) {
      if (isNode(entity)) nodeIds.add(entity.id);
      else edgeIds.add(entity.id);
    }
  }

  return {
    columns,
    rows,
    nodeIds: [...nodeIds],
    edgeIds: [...edgeIds],
    durationMs: performance.now() - startedAt,
  };
}

/** Groups by every non-aggregated return item and counts the group members. */
function aggregate(query: Query, bindings: Binding[]): PropertyValue[][] {
  const groupItems = query.returns.filter((item) => item.aggregate === null);
  const groups = new Map<string, { key: PropertyValue[]; count: number }>();

  for (const binding of bindings) {
    const key = groupItems.map((item) => (item.accessor ? resolve(binding, item.accessor) : null));
    const hash = JSON.stringify(key);
    const existing = groups.get(hash);
    if (existing) existing.count += 1;
    else groups.set(hash, { key, count: 1 });
  }

  return [...groups.values()].map((group) => {
    let keyIndex = 0;
    return query.returns.map((item) =>
      item.aggregate === 'count' ? group.count : group.key[keyIndex++]
    );
  });
}

function compareValues(a: PropertyValue, b: PropertyValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a ?? '').localeCompare(String(b ?? ''));
}
