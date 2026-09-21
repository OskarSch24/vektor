import { GraphEdge, GraphNode } from '../types/graph';

/**
 * A force-directed layout with Barnes-Hut approximation.
 *
 * The naive all-pairs repulsion is O(n²) per tick, which stops being viable at
 * roughly a thousand nodes — well within what a few ingested videos produce. The
 * quadtree below approximates distant clusters by their centre of mass, which
 * brings a tick down to O(n log n) and keeps the canvas interactive on graphs of
 * tens of thousands of nodes.
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Degree-derived, so hubs are drawn larger and repel more. */
  mass: number;
  /** Set while the user drags a node; the simulation then leaves it alone. */
  pinned: boolean;
}

export interface LayoutOptions {
  repulsion: number;
  springLength: number;
  springStrength: number;
  gravity: number;
  damping: number;
}

/**
 * Tuned on a synthetic graph of one hub with 500 neighbours and 300 leaves —
 * the shape a whole-site import produces. The earlier values (repulsion 6400,
 * gravity 0.012) let that graph settle at 2150 units across and, when the hub
 * was dragged at 5 % zoom, flung nodes 6000 units sideways. A first, tighter
 * tuning (1600 / 0.04) packed the same graph into a uniform disc with no
 * visible structure. These settle at roughly 1200 across: hubs and their
 * neighbourhoods stay distinguishable, and a drag moves the neighbourhood
 * along instead of scattering it. Measured, not guessed.
 */
export const DEFAULT_LAYOUT: LayoutOptions = {
  repulsion: 2400,
  springLength: 90,
  springStrength: 0.035,
  gravity: 0.025,
  damping: 0.82,
};

/** Barnes-Hut opening angle: larger is faster and coarser. */
const THETA = 0.9;

/**
 * Two guards that keep a dense graph from flying apart.
 *
 * Repulsion falls off with the square of the distance, so two nodes that end
 * up nearly on top of each other — which happens every time a hub with hundreds
 * of neighbours is dragged — would push each other with a force that has no
 * upper bound. SOFTENING treats anything closer than that many units as being
 * that far apart. MAX_SPEED caps how far a node can travel in one step, so even
 * a large force moves it, rather than launching it off the canvas.
 */
const SOFTENING = 24;
const MAX_SPEED = 18;

export class ForceLayout {
  private nodes = new Map<string, LayoutNode>();
  private links: Array<{ source: string; target: string }> = [];
  private options: LayoutOptions = { ...DEFAULT_LAYOUT };
  /** Cools from 1 to 0 so the graph settles instead of jittering forever. */
  private alpha = 1;

  get temperature(): number {
    return this.alpha;
  }

  /**
   * Syncs the simulation with the current graph. Nodes that already have a
   * position keep it, so an ingest run that adds ten nodes does not reshuffle
   * the layout the user has been reading.
   */
  sync(graphNodes: GraphNode[], graphEdges: GraphEdge[]): void {
    const degrees = new Map<string, number>();
    for (const edge of graphEdges) {
      degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
      degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
    }

    const present = new Set<string>();
    let placementIndex = 0;

    for (const node of graphNodes) {
      present.add(node.id);
      const degree = degrees.get(node.id) ?? 0;
      const existing = this.nodes.get(node.id);

      if (existing) {
        existing.mass = 1 + Math.sqrt(degree);
        continue;
      }

      // New nodes start on a golden-angle spiral rather than at random, which
      // gives the simulation an even starting distribution and avoids the
      // clumps a uniform random seed produces.
      const angle = placementIndex * 2.399963;
      const radius = 30 * Math.sqrt(placementIndex + 1);
      placementIndex += 1;

      this.nodes.set(node.id, {
        id: node.id,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
        mass: 1 + Math.sqrt(degree),
        pinned: false,
      });
    }

    for (const id of [...this.nodes.keys()]) {
      if (!present.has(id)) this.nodes.delete(id);
    }

    // A handful of nodes joining a settled graph should slot in, not restart
    // the whole layout — during a whole-site import that happened every few
    // seconds and kept a thousand nodes in perpetual motion.
    const hadNodes = placementIndex < graphNodes.length;
    this.alpha = Math.max(this.alpha, hadNodes && placementIndex > 0 ? 0.3 : hadNodes ? this.alpha : 0.9);

    this.links = graphEdges
      .filter((edge) => present.has(edge.from) && present.has(edge.to))
      .map((edge) => ({ source: edge.from, target: edge.to }));
  }

  /** Restarts the cooling schedule, e.g. after new nodes arrived. */
  reheat(alpha = 0.9): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  /**
   * Keeps the simulation gently alive while the user drags a node, so its
   * neighbours follow, without the full restart that would send the rest of the
   * graph into motion again.
   */
  keepWarm(alpha = 0.12): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  isPinned(id: string): boolean {
    return this.nodes.get(id)?.pinned ?? false;
  }

  /** Releases every node the user parked somewhere. */
  unpinAll(): void {
    for (const node of this.nodes.values()) node.pinned = false;
    this.reheat(0.4);
  }

  getNode(id: string): LayoutNode | undefined {
    return this.nodes.get(id);
  }

  getNodes(): LayoutNode[] {
    return [...this.nodes.values()];
  }

  setPosition(id: string, x: number, y: number, pinned: boolean): void {
    const node = this.nodes.get(id);
    if (!node) return;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    node.pinned = pinned;
  }

  configure(options: Partial<LayoutOptions>): void {
    this.options = { ...this.options, ...options };
    this.reheat(0.5);
  }

  /** Advances the simulation by one frame. Returns false once it has settled. */
  tick(): boolean {
    if (this.alpha < 0.005 || this.nodes.size === 0) return false;

    const nodes = [...this.nodes.values()];
    const { repulsion, springLength, springStrength, gravity, damping } = this.options;

    const tree = QuadTree.build(nodes);
    for (const node of nodes) {
      if (node.pinned) continue;
      const force = tree.force(node, repulsion * this.alpha);
      node.vx += force.x;
      node.vy += force.y;
    }

    for (const link of this.links) {
      const source = this.nodes.get(link.source);
      const target = this.nodes.get(link.target);
      if (!source || !target) continue;

      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const displacement = (distance - springLength) * springStrength * this.alpha;
      const fx = (dx / distance) * displacement;
      const fy = (dy / distance) * displacement;

      if (!source.pinned) {
        source.vx += fx / source.mass;
        source.vy += fy / source.mass;
      }
      if (!target.pinned) {
        target.vx -= fx / target.mass;
        target.vy -= fy / target.mass;
      }
    }

    for (const node of nodes) {
      if (node.pinned) continue;
      // Pull towards the origin so disconnected components do not drift out of
      // the viewport for good.
      node.vx -= node.x * gravity * this.alpha;
      node.vy -= node.y * gravity * this.alpha;

      node.vx *= damping;
      node.vy *= damping;

      const speed = Math.hypot(node.vx, node.vy);
      if (speed > MAX_SPEED) {
        node.vx = (node.vx / speed) * MAX_SPEED;
        node.vy = (node.vy / speed) * MAX_SPEED;
      }

      node.x += node.vx;
      node.y += node.vy;
    }

    this.alpha *= 0.985;
    return true;
  }

  /** Bounding box of the laid-out graph, used to fit the view. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of this.nodes.values()) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }

    if (!Number.isFinite(minX)) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
  }
}

/**
 * A quadtree over node positions. Each cell knows the total mass and centre of
 * mass of everything inside it, which is what makes the Barnes-Hut
 * approximation possible.
 */
class QuadTree {
  private children: QuadTree[] | null = null;
  private body: LayoutNode | null = null;
  private mass = 0;
  private centreX = 0;
  private centreY = 0;

  private constructor(
    private readonly x: number,
    private readonly y: number,
    private readonly size: number
  ) {}

  static build(nodes: LayoutNode[]): QuadTree {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    }

    const size = Math.max(maxX - minX, maxY - minY, 1) * 1.05;
    const tree = new QuadTree(minX, minY, size);
    for (const node of nodes) tree.insert(node, 0);
    return tree;
  }

  private insert(node: LayoutNode, depth: number): void {
    this.mass += node.mass;
    this.centreX += node.x * node.mass;
    this.centreY += node.y * node.mass;

    // A depth cap keeps coincident positions — two nodes at exactly the same
    // spot — from recursing until the stack gives out.
    if (depth > 24) return;

    if (this.children) {
      this.child(node).insert(node, depth + 1);
      return;
    }

    if (!this.body) {
      this.body = node;
      return;
    }

    const existing = this.body;
    this.body = null;
    this.subdivide();
    this.child(existing).insert(existing, depth + 1);
    this.child(node).insert(node, depth + 1);
  }

  private subdivide(): void {
    const half = this.size / 2;
    this.children = [
      new QuadTree(this.x, this.y, half),
      new QuadTree(this.x + half, this.y, half),
      new QuadTree(this.x, this.y + half, half),
      new QuadTree(this.x + half, this.y + half, half),
    ];
  }

  private child(node: LayoutNode): QuadTree {
    const half = this.size / 2;
    const right = node.x >= this.x + half ? 1 : 0;
    const bottom = node.y >= this.y + half ? 1 : 0;
    return this.children![bottom * 2 + right];
  }

  /** Net repulsive force on `target` from everything in this subtree. */
  force(target: LayoutNode, strength: number): { x: number; y: number } {
    if (this.mass === 0) return { x: 0, y: 0 };

    const comX = this.centreX / this.mass;
    const comY = this.centreY / this.mass;
    let dx = comX - target.x;
    let dy = comY - target.y;
    let distance = Math.hypot(dx, dy);

    if (this.body === target && !this.children) return { x: 0, y: 0 };

    if (this.children === null || this.size / (distance || 0.01) < THETA) {
      if (distance < 0.01) {
        // Two nodes on top of each other have no defined direction; nudge them
        // apart deterministically so the layout does not stall.
        dx = (target.id.charCodeAt(0) % 7) - 3 || 1;
        dy = (target.id.charCodeAt(1) % 7) - 3 || 1;
        distance = Math.hypot(dx, dy);
      }
      // Softened inverse square: the force levels off below SOFTENING units
      // instead of growing without bound as two nodes overlap.
      const softened = distance * distance + SOFTENING * SOFTENING;
      const magnitude = (-strength * this.mass) / softened;
      return { x: (dx / distance) * magnitude, y: (dy / distance) * magnitude };
    }

    let x = 0;
    let y = 0;
    for (const child of this.children) {
      const partial = child.force(target, strength);
      x += partial.x;
      y += partial.y;
    }
    return { x, y };
  }
}
