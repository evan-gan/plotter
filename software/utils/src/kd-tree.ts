import { Point } from "./types";

interface KdNode {
  pointIndex: number;
  axis: 0 | 1;
  left: KdNode | null;
  right: KdNode | null;
}

/**
 * Static 2-D k-d tree over a fixed point set, built once and queried many
 * times. The optimizer uses it for endpoint snapping and for the ~10-nearest
 * -neighbour candidate lists that keep tour construction/improvement O(n·k)
 * instead of all-pairs.
 */
export class KdTree {
  private root: KdNode | null;
  private points: Point[];

  constructor(points: Point[]) {
    this.points = points;
    const indices = points.map((_, index) => index);
    this.root = this.build(indices, 0);
  }

  private build(indices: number[], depth: number): KdNode | null {
    if (indices.length === 0) return null;
    const axis = (depth % 2) as 0 | 1;
    const key = axis === 0 ? "x" : "y";
    indices.sort((a, b) => this.points[a][key] - this.points[b][key]);
    const median = indices.length >> 1;
    return {
      pointIndex: indices[median],
      axis,
      left: this.build(indices.slice(0, median), depth + 1),
      right: this.build(indices.slice(median + 1), depth + 1),
    };
  }

  /** Indices of all stored points within `radius` of `target`. */
  withinRadius(target: Point, radius: number): number[] {
    const hits: number[] = [];
    const radiusSq = radius * radius;
    const visit = (node: KdNode | null) => {
      if (!node) return;
      const point = this.points[node.pointIndex];
      const dx = target.x - point.x;
      const dy = target.y - point.y;
      if (dx * dx + dy * dy <= radiusSq) hits.push(node.pointIndex);
      const planeDelta = node.axis === 0 ? dx : dy;
      visit(planeDelta <= 0 ? node.left : node.right);
      // Only cross the splitting plane when the search ball reaches it.
      if (Math.abs(planeDelta) <= radius) visit(planeDelta <= 0 ? node.right : node.left);
    };
    visit(this.root);
    return hits;
  }

  /**
   * Indices of the k nearest stored points to `target`, closest first.
   * `skip` filters out unwanted candidates (e.g. the query point itself).
   */
  nearest(target: Point, k: number, skip?: (pointIndex: number) => boolean): number[] {
    // Bounded worst-list: kept sorted by distance, worst at the end.
    const best: { pointIndex: number; distSq: number }[] = [];
    const visit = (node: KdNode | null) => {
      if (!node) return;
      const point = this.points[node.pointIndex];
      const dx = target.x - point.x;
      const dy = target.y - point.y;
      const distSq = dx * dx + dy * dy;
      if (!skip || !skip(node.pointIndex)) {
        if (best.length < k || distSq < best[best.length - 1].distSq) {
          best.push({ pointIndex: node.pointIndex, distSq });
          best.sort((a, b) => a.distSq - b.distSq);
          if (best.length > k) best.pop();
        }
      }
      const planeDelta = node.axis === 0 ? dx : dy;
      visit(planeDelta <= 0 ? node.left : node.right);
      const worst = best.length < k ? Infinity : best[best.length - 1].distSq;
      if (planeDelta * planeDelta <= worst) visit(planeDelta <= 0 ? node.right : node.left);
    };
    visit(this.root);
    return best.map((entry) => entry.pointIndex);
  }
}
