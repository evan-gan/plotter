// Pen-up path optimizer (the algorithm specified in TODO.md):
//
//  1. Merge all path endpoints within a tolerance (default 0.3 mm) using a
//     k-d tree + union-find, then greedily chain paths that share snapped
//     endpoints into continuous polylines — eliminating those pen lifts.
//  2. Treat each remaining polyline as a node with two endpoints and mutable
//     orientation. Inter-node cost = the minimum Euclidean pen-up distance
//     across all four endpoint pairings (reversal is free).
//  3. Build an initial open tour by greedy edge matching: candidate edges from
//     each node's ~10 nearest neighbours (k-d tree), sorted cheapest first,
//     rejecting any edge that would create a degree-3 node or a premature
//     subtour (union-find).
//  4. Improve to a local optimum by alternating 2-opt (segment reversal) and
//     Or-opt (relocate runs of 1–3 nodes, both orientations) using neighbour
//     lists rather than all-pairs scans, until no improving move exists.
//
// Only pen-up distance is optimized: once the path set is fixed the pen-lift
// count is constant, so distance ranks tours identically to time.

import { Point, Polyline, distance, penUpDistance } from "./types";
import { KdTree } from "./kd-tree";
import { UnionFind } from "./union-find";
import { dedupeConsecutive } from "./svg-parse";
import { splitPolylinesAtIntersections } from "./intersections";

export interface OptimizeOptions {
  /** Endpoint-merge tolerance in mm. */
  mergeToleranceMm?: number;
  /** Nearest-neighbour candidates per node for tour building/improvement. */
  neighborCount?: number;
  /** Hard cap on improvement passes (safety valve; usually converges early). */
  maxPasses?: number;
  /** Pen-up travel starts from here (the plotter origin). */
  start?: Point;
  /**
   * Split polylines at their mutual/self crossings before chaining so the pen
   * can route straight through intersections (default true). The unsplit plan
   * is always computed too; the cheaper of the two is kept, so this can only
   * help. Set false to skip the crossing search entirely.
   */
  splitAtIntersections?: boolean;
}

export interface OptimizeStats {
  polylinesBefore: number;
  polylinesAfter: number;
  penUpBeforeMm: number;
  penUpAfterMm: number;
  penLiftsBefore: number;
  penLiftsAfter: number;
  /** Whether the crossing-split plan beat the endpoint-only plan and was kept. */
  splitAtIntersectionsApplied: boolean;
}

const DEFAULT_TOLERANCE_MM = 0.3;
const DEFAULT_NEIGHBORS = 10;
const DEFAULT_MAX_PASSES = 60;
// Approximate pen-up-travel-equivalent cost of one extra pen lift, used only to
// decide whether the crossing-split plan is genuinely better than the unsplit
// one (a lift ≈ dwell + retarget time, worth ~this many mm of travel). Never
// affects the plotted geometry — only which of two valid plans is chosen.
const LIFT_PENALTY_MM = 10;

// ───────────────────────── stage 1: merge + chain ─────────────────────────

interface EndpointRef {
  lineIndex: number;
  /** 0 = first point of the polyline, 1 = last point. */
  end: 0 | 1;
}

/**
 * Cluster endpoints lying within `tolerance` of each other (k-d tree radius
 * queries + union-find), then greedily join polylines that share a cluster
 * into single longer polylines. Each endpoint joins at most one partner, and
 * a cycle guard stops closed loops from chasing their own tail.
 */
export function mergeAndChain(polylines: Polyline[], tolerance: number): Polyline[] {
  const lines = polylines.map((line) => dedupeConsecutive(line)).filter((line) => line.length >= 2);
  if (lines.length <= 1) return lines;

  const endpoints: Point[] = [];
  const refs: EndpointRef[] = [];
  lines.forEach((line, lineIndex) => {
    endpoints.push(line[0], line[line.length - 1]);
    refs.push({ lineIndex, end: 0 }, { lineIndex, end: 1 });
  });

  // Union endpoints within tolerance into snap clusters.
  const tree = new KdTree(endpoints);
  const clusters = new UnionFind(endpoints.length);
  endpoints.forEach((point, index) => {
    for (const other of tree.withinRadius(point, tolerance)) {
      if (other !== index) clusters.union(index, other);
    }
  });

  // clusterRoot → endpoint indices, so chaining can find partners fast.
  const clusterMembers = new Map<number, number[]>();
  endpoints.forEach((_, index) => {
    const root = clusters.find(index);
    const members = clusterMembers.get(root);
    if (members) members.push(index);
    else clusterMembers.set(root, [index]);
  });

  return chainLines(lines, refs, clusters, clusterMembers);
}

/** Greedy chaining pass over the snap clusters (see mergeAndChain). */
function chainLines(
  lines: Polyline[], refs: EndpointRef[], clusters: UnionFind, clusterMembers: Map<number, number[]>
): Polyline[] {
  const consumed = new Array(lines.length).fill(false);
  const endpointUsed = new Array(refs.length).fill(false);
  const chains: Polyline[] = [];

  /** Pick an unused endpoint in the same cluster belonging to another line. */
  const findPartner = (endpointIndex: number): number | null => {
    for (const member of clusterMembers.get(clusters.find(endpointIndex)) ?? []) {
      if (member === endpointIndex || endpointUsed[member]) continue;
      const candidate = refs[member];
      if (!consumed[candidate.lineIndex]) return member;
    }
    return null;
  };

  /** Oriented copy of a line so it starts at the given endpoint. */
  const oriented = (lineIndex: number, startEnd: 0 | 1): Polyline => {
    const line = lines[lineIndex];
    return startEnd === 0 ? [...line] : [...line].reverse();
  };

  for (let seedIndex = 0; seedIndex < lines.length; seedIndex++) {
    if (consumed[seedIndex]) continue;
    consumed[seedIndex] = true;
    let chain = oriented(seedIndex, 0);

    // Extend forward from the tail, then (by flipping) from the head too.
    for (let direction = 0; direction < 2; direction++) {
      let tailEndpoint = endpointIndexOf(seedIndex, direction === 0 ? 1 : 0);
      if (direction === 1) chain.reverse();
      // Re-locate the actual live tail endpoint after any prior extension:
      // track it as we splice lines on.
      let extending = true;
      while (extending) {
        const partner = findPartner(tailEndpoint);
        if (partner === null) {
          extending = false;
          break;
        }
        const next = refs[partner];
        endpointUsed[tailEndpoint] = true;
        endpointUsed[partner] = true;
        consumed[next.lineIndex] = true;
        const addition = oriented(next.lineIndex, next.end);
        chain = chain.concat(addition.slice(1)); // shared point: keep one copy
        tailEndpoint = endpointIndexOf(next.lineIndex, next.end === 0 ? 1 : 0);
      }
    }
    chains.push(dedupeConsecutive(chain));
  }
  return chains.filter((line) => line.length >= 2);
}

function endpointIndexOf(lineIndex: number, end: 0 | 1): number {
  return lineIndex * 2 + end;
}

// ───────────────────── stage 2–4: tour over chained paths ─────────────────

interface TourNode {
  index: number;
  head: Point;
  tail: Point;
}

/** Min pen-up distance between two nodes across all four endpoint pairings. */
function nodeCost(a: TourNode, b: TourNode): number {
  return Math.min(
    distance(a.head, b.head), distance(a.head, b.tail),
    distance(a.tail, b.head), distance(a.tail, b.tail)
  );
}

/**
 * Neighbour lists: for every node, the ~k nearest other nodes by endpoint
 * distance. Built from one k-d tree over all endpoints (2 per node).
 */
function buildNeighborLists(nodes: TourNode[], k: number): number[][] {
  const endpointToNode: number[] = [];
  const endpoints: Point[] = [];
  nodes.forEach((node, nodeIndex) => {
    endpoints.push(node.head, node.tail);
    endpointToNode.push(nodeIndex, nodeIndex);
  });
  const tree = new KdTree(endpoints);
  return nodes.map((node, nodeIndex) => {
    const seen = new Set<number>();
    // Query around both endpoints; over-fetch since both ends of a neighbour
    // node occupy two slots.
    for (const source of [node.head, node.tail]) {
      for (const hit of tree.nearest(source, 2 * k + 2, (i) => endpointToNode[i] === nodeIndex)) {
        seen.add(endpointToNode[hit]);
      }
    }
    return [...seen].slice(0, k);
  });
}

/**
 * Initial open tour via greedy edge matching: cheapest candidate edges first,
 * rejecting degree-3 nodes and premature subtours (union-find). Leftover path
 * fragments are then stitched nearest-first into one sequence.
 */
function greedyTour(nodes: TourNode[], neighbors: number[][]): number[] {
  const edgeSet = new Map<string, [number, number, number]>(); // key → [i, j, cost]
  nodes.forEach((node, i) => {
    for (const j of neighbors[i]) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (!edgeSet.has(key)) edgeSet.set(key, [Math.min(i, j), Math.max(i, j), nodeCost(node, nodes[j])]);
    }
  });
  const candidates = [...edgeSet.values()].sort((a, b) => a[2] - b[2]);

  const degree = new Array(nodes.length).fill(0);
  const fragments = new UnionFind(nodes.length);
  const adjacency: number[][] = nodes.map(() => []);
  for (const [i, j] of candidates) {
    if (degree[i] >= 2 || degree[j] >= 2) continue;
    if (fragments.connected(i, j)) continue; // would close a premature subtour
    fragments.union(i, j);
    degree[i]++;
    degree[j]++;
    adjacency[i].push(j);
    adjacency[j].push(i);
  }
  return stitchFragments(nodes, adjacency);
}

/** Walk the degree≤2 forest into path fragments, then join them end-to-end. */
function stitchFragments(nodes: TourNode[], adjacency: number[][]): number[] {
  const visited = new Array(nodes.length).fill(false);
  const fragments: number[][] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (visited[start] || adjacency[start].length > 1) continue;
    // Path endpoints have degree 0 or 1; walk to the other end.
    const fragment: number[] = [];
    let current = start;
    let previous = -1;
    while (current !== -1 && !visited[current]) {
      visited[current] = true;
      fragment.push(current);
      const next = adjacency[current].find((n) => n !== previous && !visited[n]);
      previous = current;
      current = next === undefined ? -1 : next;
    }
    fragments.push(fragment);
  }
  // Isolated cycles can't form here (union-find forbids them), but guard for
  // any unvisited node all the same.
  for (let index = 0; index < nodes.length; index++) {
    if (!visited[index]) {
      visited[index] = true;
      fragments.push([index]);
    }
  }

  // Stitch fragments nearest-first: repeatedly append whichever fragment's
  // head/tail is closest to the current tail.
  const tour = fragments.shift() ?? [];
  while (fragments.length > 0) {
    const tailNode = nodes[tour[tour.length - 1]];
    let bestIndex = 0;
    let bestCost = Infinity;
    let bestReversed = false;
    fragments.forEach((fragment, fragmentIndex) => {
      const headCost = nodeCost(tailNode, nodes[fragment[0]]);
      const tailCost = nodeCost(tailNode, nodes[fragment[fragment.length - 1]]);
      if (headCost < bestCost) {
        bestCost = headCost;
        bestIndex = fragmentIndex;
        bestReversed = false;
      }
      if (tailCost < bestCost) {
        bestCost = tailCost;
        bestIndex = fragmentIndex;
        bestReversed = true;
      }
    });
    const [chosen] = fragments.splice(bestIndex, 1);
    tour.push(...(bestReversed ? chosen.reverse() : chosen));
  }
  return tour;
}

/** Cheapest hop from the fixed start point to either endpoint of a node. */
function startCost(start: Point, node: TourNode): number {
  return Math.min(distance(start, node.head), distance(start, node.tail));
}

/**
 * 2-opt pass over the open tour using neighbour lists. Reversing tour[i..j]
 * replaces edges (i-1,i) and (j,j+1) with (i-1,j) and (i,j+1); with the
 * orientation-free min-pairing cost the delta needs only those four terms.
 * The plotter origin acts as a virtual fixed node before position 0, so
 * moves that change which path is drawn first are priced correctly.
 * Returns true if any improving move was applied.
 */
function twoOptPass(
  tour: number[], nodes: TourNode[], neighbors: number[][], positionOf: number[], start: Point
): boolean {
  let improved = false;
  const cost = (a: number, b: number) => nodeCost(nodes[a], nodes[b]);
  // Edge cost between tour positions; position -1 is the fixed start point.
  const edgeAt = (posA: number, posB: number) =>
    posA < 0 ? startCost(start, nodes[tour[posB]]) : cost(tour[posA], tour[posB]);
  for (let i = 0; i < tour.length - 1; i++) {
    for (const neighborNode of neighbors[tour[i]]) {
      const j = positionOf[neighborNode];
      if (j <= i) continue;
      const tailBefore = j + 1 < tour.length ? cost(tour[j], tour[j + 1]) : 0;
      const tailAfter = j + 1 < tour.length ? cost(tour[i], tour[j + 1]) : 0;
      const before = edgeAt(i - 1, i) + tailBefore;
      const after = edgeAt(i - 1, j) + tailAfter;
      if (after < before - 1e-9) {
        reverseSegment(tour, i, j, positionOf);
        improved = true;
      }
    }
  }
  return improved;
}

function reverseSegment(tour: number[], from: number, to: number, positionOf: number[]): void {
  while (from < to) {
    [tour[from], tour[to]] = [tour[to], tour[from]];
    positionOf[tour[from]] = from;
    positionOf[tour[to]] = to;
    from++;
    to--;
  }
}

/**
 * Or-opt pass: relocate runs of 1–3 consecutive nodes next to a neighbour
 * elsewhere in the tour. Run orientation is free under the min-pairing cost,
 * so trying "both orientations" collapses into the same delta; the final
 * orientation DP (orientTour) picks the actual directions.
 */
function orOptPass(
  tour: number[], nodes: TourNode[], neighbors: number[][], positionOf: number[], start: Point
): boolean {
  let improved = false;
  const cost = (a: number, b: number) => nodeCost(nodes[a], nodes[b]);
  // Position -1 is the fixed start point; past-the-end edges cost nothing.
  const edge = (a: number, b: number) => {
    if (b >= tour.length || b < 0 || a >= tour.length) return 0;
    if (a < 0) return startCost(start, nodes[tour[b]]);
    return cost(tour[a], tour[b]);
  };

  for (let runLength = 1; runLength <= 3; runLength++) {
    for (let runStart = 0; runStart + runLength <= tour.length; runStart++) {
      const runEnd = runStart + runLength - 1;
      const removalGain = edge(runStart - 1, runStart) + edge(runEnd, runEnd + 1) - edge(runStart - 1, runEnd + 1);
      if (removalGain <= 1e-9) continue;

      // Try inserting after each neighbour of the run's endpoints.
      let applied = false;
      for (const anchor of [tour[runStart], tour[runEnd]]) {
        for (const neighborNode of neighbors[anchor]) {
          const insertAfter = positionOf[neighborNode];
          if (insertAfter >= runStart - 1 && insertAfter <= runEnd + 1) continue;
          if (insertAfter < 0 || insertAfter >= tour.length) continue;
          const oldEdge = edge(insertAfter, insertAfter + 1);
          const run = tour.slice(runStart, runEnd + 1);
          const costForward =
            cost(tour[insertAfter], run[0]) +
            (insertAfter + 1 < tour.length ? cost(run[run.length - 1], tour[insertAfter + 1]) : 0);
          if (costForward - oldEdge < removalGain - 1e-9) {
            relocateRun(tour, runStart, runLength, insertAfter, positionOf);
            improved = true;
            applied = true;
            break;
          }
        }
        if (applied) break;
      }
      if (applied) runStart--; // re-examine this position after the mutation
    }
  }
  return improved;
}

/** Move tour[runStart..runStart+runLength) to sit after index `insertAfter`. */
function relocateRun(tour: number[], runStart: number, runLength: number, insertAfter: number, positionOf: number[]): void {
  const run = tour.splice(runStart, runLength);
  const target = insertAfter < runStart ? insertAfter + 1 : insertAfter + 1 - runLength;
  tour.splice(target, 0, ...run);
  for (let index = 0; index < tour.length; index++) positionOf[tour[index]] = index;
}

/**
 * Choose each node's orientation with a small DP over the fixed sequence
 * (2 states per node), minimising exact pen-up distance from `start`.
 */
function orientTour(
  tour: number[], nodes: TourNode[], start: Point
): { order: number[]; reversed: boolean[]; cost: number } {
  const count = tour.length;
  const reversed: boolean[] = new Array(count).fill(false);
  if (count === 0) return { order: tour, reversed, cost: 0 };

  const entry = (nodeIndex: number, isReversed: boolean) => (isReversed ? nodes[nodeIndex].tail : nodes[nodeIndex].head);
  const exit = (nodeIndex: number, isReversed: boolean) => (isReversed ? nodes[nodeIndex].head : nodes[nodeIndex].tail);

  const dpCost: number[][] = [];
  const dpFrom: number[][] = [];
  dpCost.push([distance(start, entry(tour[0], false)), distance(start, entry(tour[0], true))]);
  dpFrom.push([0, 0]);
  for (let step = 1; step < count; step++) {
    const row = [Infinity, Infinity];
    const from = [0, 0];
    for (let orientation = 0; orientation < 2; orientation++) {
      for (let previousOrientation = 0; previousOrientation < 2; previousOrientation++) {
        const hop = distance(exit(tour[step - 1], previousOrientation === 1), entry(tour[step], orientation === 1));
        const total = dpCost[step - 1][previousOrientation] + hop;
        if (total < row[orientation]) {
          row[orientation] = total;
          from[orientation] = previousOrientation;
        }
      }
    }
    dpCost.push(row);
    dpFrom.push(from);
  }

  let orientation = dpCost[count - 1][1] < dpCost[count - 1][0] ? 1 : 0;
  const totalCost = dpCost[count - 1][orientation];
  for (let step = count - 1; step >= 0; step--) {
    reversed[step] = orientation === 1;
    orientation = dpFrom[step][orientation];
  }
  return { order: tour, reversed, cost: totalCost };
}

// ───────────────────────────── public entry ───────────────────────────────

interface PlanSettings {
  neighborCount: number;
  maxPasses: number;
  start: Point;
  tolerance: number;
}

/**
 * Run stages 1–4 (merge → chain → greedy tour → 2-opt/Or-opt → orientation DP)
 * over one polyline set and return the ordered result. Pure function of its
 * inputs, so it can be run on both the raw and the crossing-split path sets and
 * the cheaper result kept.
 */
function planTour(lines: Polyline[], settings: PlanSettings): Polyline[] {
  const chained = mergeAndChain(lines, settings.tolerance);
  const nodes: TourNode[] = chained.map((line, index) => ({
    index,
    head: line[0],
    tail: line[line.length - 1],
  }));

  if (nodes.length === 0) return chained;
  if (nodes.length === 1) {
    // No tour to build, but orientation still matters (start near `start`).
    const { reversed } = orientTour([0], nodes, settings.start);
    return [reversed[0] ? [...chained[0]].reverse() : chained[0]];
  }

  const neighbors = buildNeighborLists(nodes, settings.neighborCount);
  const tour = greedyTour(nodes, neighbors);
  const positionOf = new Array(nodes.length).fill(0);
  tour.forEach((nodeIndex, position) => (positionOf[nodeIndex] = position));

  // Alternate 2-opt and Or-opt until a full round makes no improvement.
  for (let pass = 0; pass < settings.maxPasses; pass++) {
    const improvedTwoOpt = twoOptPass(tour, nodes, neighbors, positionOf, settings.start);
    const improvedOrOpt = orOptPass(tour, nodes, neighbors, positionOf, settings.start);
    if (!improvedTwoOpt && !improvedOrOpt) break;
  }

  // The passes only ever see local edges; a whole-tour reversal (which swaps
  // which end is drawn first) is checked explicitly.
  const forward = orientTour([...tour], nodes, settings.start);
  const backward = orientTour([...tour].reverse(), nodes, settings.start);
  const { order, reversed } = backward.cost < forward.cost ? backward : forward;
  return order.map((nodeIndex, position) =>
    reversed[position] ? [...chained[nodeIndex]].reverse() : chained[nodeIndex]
  );
}

/** Plan cost used to pick between the split and unsplit plans (see LIFT_PENALTY_MM). */
function planCost(ordered: Polyline[], start: Point): number {
  return penUpDistance(ordered, start) + LIFT_PENALTY_MM * ordered.length;
}

/**
 * Optimize a set of polylines for minimum pen-up travel.
 *
 * @returns The reordered/merged polylines plus before/after stats.
 */
export function optimizePolylines(
  polylines: Polyline[], options: OptimizeOptions = {}
): { polylines: Polyline[]; stats: OptimizeStats } {
  const start = options.start ?? { x: 0, y: 0 };
  const settings: PlanSettings = {
    tolerance: options.mergeToleranceMm ?? DEFAULT_TOLERANCE_MM,
    neighborCount: options.neighborCount ?? DEFAULT_NEIGHBORS,
    maxPasses: options.maxPasses ?? DEFAULT_MAX_PASSES,
    start,
  };

  const inputLines = polylines.filter((line) => line.length >= 2);
  const penUpBeforeMm = penUpDistance(inputLines, start);

  let ordered = planTour(inputLines, settings);
  let splitApplied = false;

  // Crossing-split plan: only worth building when splitting actually cut some
  // polylines (more pieces than inputs). Keep it only if it scores lower, so
  // splitting can never regress a plot.
  if (options.splitAtIntersections !== false) {
    const splitLines = splitPolylinesAtIntersections(inputLines);
    if (splitLines.length > inputLines.length) {
      const splitOrdered = planTour(splitLines, settings);
      if (planCost(splitOrdered, start) < planCost(ordered, start) - 1e-9) {
        ordered = splitOrdered;
        splitApplied = true;
      }
    }
  }

  return {
    polylines: ordered,
    stats: {
      polylinesBefore: inputLines.length,
      polylinesAfter: ordered.length,
      penUpBeforeMm,
      penUpAfterMm: penUpDistance(ordered, start),
      penLiftsBefore: inputLines.length,
      penLiftsAfter: ordered.length,
      splitAtIntersectionsApplied: splitApplied,
    },
  };
}
