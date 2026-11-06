// WBS tree helpers: index maps built once per task list, O(n) flatten on expand / collapse / filter.

export interface TreeIndex {
  /** Child indices per task index (in file order). */
  children: number[][];
  roots: number[];
  depth: Int16Array;
  parent: Int32Array;
}

/** `parentOf(i)` returns the parent's index or -1. Tasks must be in outline (file) order. */
export function buildTree(n: number, parentOf: (i: number) => number): TreeIndex {
  const children: number[][] = Array.from({ length: n }, () => []);
  const roots: number[] = [];
  const parent = new Int32Array(n).fill(-1);
  const depth = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const p = parentOf(i);
    if (p >= 0 && p !== i) { children[p].push(i); parent[i] = p; } else roots.push(i);
  }
  const stack = roots.map((r) => [r, 0] as [number, number]);
  while (stack.length) {
    const [i, d] = stack.pop()!;
    depth[i] = d;
    for (const c of children[i]) stack.push([c, d + 1]);
  }
  return { children, roots, depth, parent };
}

export interface FlatRow {
  /** Task index. */
  i: number;
  depth: number;
  hasKids: boolean;
  expanded: boolean;
  /** Ancestor kept only as context for a filtered match (muted). */
  ctx: boolean;
}

/**
 * Visible rows. Without a filter: depth-first, children of collapsed nodes hidden.
 * With `match`: every match plus its ancestors (as context rows); collapse state still applies to matches' subtrees.
 */
export function flatten(tree: TreeIndex, isExpanded: (i: number) => boolean, match: ((i: number) => boolean) | null): FlatRow[] {
  const out: FlatRow[] = [];
  let keep: Uint8Array | null = null;
  if (match) {
    // 1 = match, 2 = has matching descendant
    keep = new Uint8Array(tree.children.length);
    const post = (i: number): boolean => {
      let any = false;
      for (const c of tree.children[i]) if (post(c)) any = true;
      const m = match(i);
      keep![i] = m ? 1 : any ? 2 : 0;
      return m || any;
    };
    for (const r of tree.roots) post(r);
  }
  const visit = (i: number) => {
    if (keep && !keep[i]) return;
    const kids = tree.children[i];
    const hasKids = kids.length > 0;
    const ctx = !!keep && keep[i] === 2;
    // Filtering opens the path to matches; a match's own children follow the user's expand state.
    const expanded = hasKids && (ctx || isExpanded(i));
    out.push({ i, depth: tree.depth[i], hasKids, expanded, ctx });
    if (expanded) for (const c of kids) visit(c);
  };
  for (const r of tree.roots) visit(r);
  return out;
}
