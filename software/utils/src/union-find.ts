/**
 * Disjoint-set (union-find) with path compression + union by size.
 * Used twice by the optimizer: clustering endpoints that snap together, and
 * rejecting premature subtours during greedy edge matching.
 */
export class UnionFind {
  private parent: number[];
  private size: number[];

  constructor(count: number) {
    this.parent = Array.from({ length: count }, (_, index) => index);
    this.size = new Array(count).fill(1);
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root];
    // Path compression: point every node on the walk directly at the root.
    while (this.parent[node] !== root) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  /** Merge the two sets. Returns false if they were already the same set. */
  union(a: number, b: number): boolean {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return false;
    if (this.size[rootA] < this.size[rootB]) {
      this.parent[rootA] = rootB;
      this.size[rootB] += this.size[rootA];
    } else {
      this.parent[rootB] = rootA;
      this.size[rootA] += this.size[rootB];
    }
    return true;
  }

  connected(a: number, b: number): boolean {
    return this.find(a) === this.find(b);
  }
}
