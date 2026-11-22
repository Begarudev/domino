// Pure layout: RunSnapshot -> positions of every tile and spacer on the table.
// Table axes: x runs left (trigger companies) to right (predicted companies), z toward the viewer, y up.
import type { RunSnapshot, GraphNode, GraphEdge, ReplayOutcome, Evidence, Mechanism } from '../../../../shared/types.ts';

export type V2 = [number, number]; // (x, z) on the table

export const TILE = { w: 1.25, h: 2.2, d: 0.34 };       // company tile
export const SPACER = { w: 0.4, h: 0.95, d: 0.12 };     // connector tile along an edge
export const SPACING = 0.5;                              // centre-to-centre distance between spacers

export type TileRole = 'trigger' | 'target' | 'baseline';
export type OutcomeState = 'pending' | 'hit' | 'miss' | 'none';

export interface TileSpec {
  key: string;                // unique per tile ("n:co_x" or "b:co_x")
  companyId: string;
  name: string;
  role: TileRole;
  pos: V2;
  dir: V2;                    // fall direction (unit)
  width: number;
  keyNumber: string;          // big etched number
  keyCaption: string;         // small line under it
  mechanism: Mechanism | null;
  confidence: number | null;
  netNew: boolean;
  alsoBaseline: boolean;      // a plain hiring filter also returns it
  outcome: ReplayOutcome | null;
  outcomeDay: number | null;  // days after asOf when the outcome happened (replay), null = never / no replay
  evidenceIds: string[];
  incomingEdgeIds: string[];
}

export interface SpacerSpec { edgeId: string; index: number; pos: V2; dir: V2; last: boolean }

export interface LaneSpec {
  edge: GraphEdge;
  from: string;               // tile key
  to: string;                 // tile key
  spacers: SpacerSpec[];
  mid: V2;                    // label anchor
}

export interface TableLayout {
  tiles: TileSpec[];
  lanes: LaneSpec[];
  spacers: SpacerSpec[];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  asOf: string;
  horizonEnd: string | null;
  horizonDays: number;        // 0 for live runs
  isReplay: boolean;
  baselineZ: number | null;
}

const norm = (v: V2): V2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const add = (a: V2, b: V2, k = 1): V2 => [a[0] + b[0] * k, a[1] + b[1] * k];
const perp = (v: V2): V2 => [-v[1], v[0]];
const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1];

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(Date.parse(iso + 'T00:00:00Z') + Math.round(days) * 86400000);
  return d.toISOString().slice(0, 10);
}

function firstNumber(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d+\s+of\s+\d+)/);
  return m ? m[1] : null;
}

const MECH_WORD: Record<Mechanism, string> = {
  TALENT_DRAIN: 'talent drain', DISPLACEMENT: 'displacement', CONTAGION: 'contagion', CAPITAL: 'capital', DIRECT: 'direct',
};
export const mechWord = (m: Mechanism | null) => (m ? MECH_WORD[m] : '');

function bezier(p0: V2, p1: V2, p2: V2, p3: V2, t: number): V2 {
  const u = 1 - t;
  return [
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
  ];
}

// Sample a cubic bezier at equal arc length.
function sampleCurve(p0: V2, p1: V2, p2: V2, p3: V2, step: number): { pos: V2; dir: V2 }[] {
  const fine: V2[] = [];
  for (let i = 0; i <= 200; i++) fine.push(bezier(p0, p1, p2, p3, i / 200));
  const out: { pos: V2; dir: V2 }[] = [];
  let acc = 0; let next = 0;
  for (let i = 1; i < fine.length; i++) {
    const seg = Math.hypot(fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]);
    while (acc + seg >= next) {
      const t = (next - acc) / (seg || 1);
      const pos: V2 = [fine[i - 1][0] + (fine[i][0] - fine[i - 1][0]) * t, fine[i - 1][1] + (fine[i][1] - fine[i - 1][1]) * t];
      out.push({ pos, dir: norm([fine[i][0] - fine[i - 1][0], fine[i][1] - fine[i - 1][1]]) });
      next += step;
    }
    acc += seg;
  }
  return out;
}

export function buildLayout(snap: RunSnapshot): TableLayout {
  const nodes = snap.graph.nodes;
  const edges = [...snap.graph.edges].sort((a, b) => a.order - b.order);
  const replay = snap.replay;
  const isReplay = !!replay;
  const asOf = replay?.asOf ?? snap.intent?.asOf ?? snap.createdAt.slice(0, 10);
  const horizonEnd = replay?.horizonEnd ?? null;
  const horizonDays = horizonEnd ? Math.max(1, dayDiff(asOf, horizonEnd)) : 0;
  const baselineIds = new Set(snap.baseline.hiringFilterCompanyIds);

  const outcomeFor = (companyId: string, side: 'domino' | 'baseline'): ReplayOutcome | null => {
    if (!replay) return null;
    const pref = replay.outcomes.filter((o) => o.companyId === companyId);
    const wanted = pref.find((o) => (side === 'domino' ? o.predictedBy === 'domino' || o.predictedBy === 'both'
      : o.predictedBy === 'baseline_first_order' || o.predictedBy === 'both'));
    return wanted ?? pref[0] ?? null;
  };

  // Every node that is the source of an edge, or has tier 0, sits on the trigger column.
  const sourceIds = new Set(edges.map((e) => e.from));
  const isTrigger = (n: GraphNode) => n.tier === 0 || (sourceIds.has(n.id) && !edges.some((e) => e.to === n.id));
  const triggers = nodes.filter(isTrigger);
  const targets = nodes.filter((n) => !isTrigger(n));

  const span = Math.max(targets.length, 3);
  const targetZSpread = Math.max(9, span * 2.15);
  const triggerZSpread = Math.max(4, triggers.length * 3.4);
  const triggerX = -6.2;
  const targetX = 5.2;

  // Triggers: evenly spaced in z, ordered by their first edge order.
  const trigOrder = [...triggers].sort((a, b) => {
    const oa = Math.min(...edges.filter((e) => e.from === a.id).map((e) => e.order), 999);
    const ob = Math.min(...edges.filter((e) => e.from === b.id).map((e) => e.order), 999);
    return oa - ob;
  });
  const trigPos = new Map<string, V2>();
  trigOrder.forEach((n, i) => {
    const z = trigOrder.length === 1 ? 0 : -triggerZSpread / 2 + (triggerZSpread * i) / (trigOrder.length - 1);
    trigPos.set(n.id, [triggerX, z]);
  });

  // Targets: on a gentle arc, sorted by the z of their source then edge order, so lanes don't cross.
  const firstIn = (id: string) => edges.find((e) => e.to === id);
  const tgtOrder = [...targets].sort((a, b) => {
    const ea = firstIn(a.id); const eb = firstIn(b.id);
    const za = ea ? trigPos.get(ea.from)?.[1] ?? 0 : 0; const zb = eb ? trigPos.get(eb.from)?.[1] ?? 0 : 0;
    return za - zb || (ea?.order ?? 0) - (eb?.order ?? 0);
  });
  const tgtPos = new Map<string, V2>();
  tgtOrder.forEach((n, i) => {
    const t = tgtOrder.length === 1 ? 0.5 : i / (tgtOrder.length - 1);
    const z = -targetZSpread / 2 + targetZSpread * t;
    const x = targetX - Math.pow((t - 0.5) * 2, 2) * 1.6;
    tgtPos.set(n.id, [x, z]);
  });

  const tiles: TileSpec[] = [];
  const lanes: LaneSpec[] = [];
  const tileByCompany = new Map<string, TileSpec>();

  // Trigger tiles: wide enough that a single fall strikes every lane's first spacer.
  for (const n of trigOrder) {
    const out = edges.filter((e) => e.from === n.id);
    const p = trigPos.get(n.id)!;
    let dir: V2 = [1, 0];
    if (out.length) {
      const sum = out.reduce<V2>((acc, e) => { const t = tgtPos.get(e.to); return t ? add(acc, norm([t[0] - p[0], t[1] - p[1]])) : acc; }, [0, 0]);
      dir = norm(sum);
    }
    const width = Math.max(TILE.w, out.length * 0.62 + 0.25);
    const ev0 = out[0];
    const keyNumber = firstNumber(ev0?.label) ?? String(out.length);
    const keyCaption = ev0 ? (n.mechanisms.includes('DISPLACEMENT') ? 'provider change' : `${out.length} downstream`) : 'trigger';
    const spec: TileSpec = {
      key: 'n:' + n.id, companyId: n.id, name: n.name, role: 'trigger', pos: p, dir, width,
      keyNumber, keyCaption: firstNumber(ev0?.label) ? 'engineers left' : `${out.length === 1 ? 'company' : 'companies'} exposed`,
      mechanism: n.mechanisms[0] ?? null, confidence: n.confidence, netNew: n.netNew, alsoBaseline: baselineIds.has(n.id),
      outcome: null, outcomeDay: null, evidenceIds: n.evidenceIds, incomingEdgeIds: [],
    };
    void keyCaption;
    tiles.push(spec); tileByCompany.set(n.id, spec);
  }

  for (const n of tgtOrder) {
    const inc = edges.filter((e) => e.to === n.id);
    const p = tgtPos.get(n.id)!;
    const src = inc[0] ? trigPos.get(inc[0].from) ?? [triggerX, 0] as V2 : [triggerX, 0] as V2;
    const dir = norm([p[0] - src[0], (p[1] - src[1]) * 0.55]);
    const oc = outcomeFor(n.id, 'domino');
    const day = oc && oc.hit && oc.outcomeDate ? Math.max(0, dayDiff(asOf, oc.outcomeDate)) : null;
    const spec: TileSpec = {
      key: 'n:' + n.id, companyId: n.id, name: n.name, role: 'target', pos: p, dir, width: TILE.w,
      keyNumber: n.confidence != null ? `${Math.round(n.confidence * 100)}%` : '?',
      keyCaption: n.confidence != null ? 'predicted' : "can't verify",
      mechanism: n.mechanisms[0] ?? null, confidence: n.confidence, netNew: n.netNew, alsoBaseline: baselineIds.has(n.id),
      outcome: oc, outcomeDay: day, evidenceIds: n.evidenceIds, incomingEdgeIds: inc.map((e) => e.id),
    };
    tiles.push(spec); tileByCompany.set(n.id, spec);
  }

  // Lanes of spacers.
  const outCount = new Map<string, number>();
  for (const e of edges) {
    const a = tileByCompany.get(e.from); const b = tileByCompany.get(e.to);
    if (!a || !b) continue;
    const siblings = edges.filter((x) => x.from === e.from && tileByCompany.has(x.to));
    // order siblings by lateral position of their target so lanes don't cross at the start
    const side = perp(a.dir);
    const sorted = [...siblings].sort((x, y) => dot(tileByCompany.get(x.to)!.pos, side) - dot(tileByCompany.get(y.to)!.pos, side));
    const k = sorted.length; const i = sorted.findIndex((x) => x.id === e.id);
    outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
    const lateral = k === 1 ? 0 : (-(k - 1) / 2 + i) * ((a.width - 0.45) / Math.max(1, k - 1));
    const p0 = add(add(a.pos, a.dir, TILE.h * 0.62), side, lateral);
    const p3 = add(b.pos, b.dir, -(TILE.d / 2 + SPACER.h * 0.48));
    const L = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
    const p1 = add(p0, a.dir, L * 0.38);
    const p2 = add(p3, b.dir, -L * 0.34);
    const samples = sampleCurve(p0, p1, p2, p3, SPACING);
    // make sure the final spacer sits exactly at p3 (leaning distance to the target is what matters)
    if (samples.length) {
      const last = samples[samples.length - 1];
      if (Math.hypot(last.pos[0] - p3[0], last.pos[1] - p3[1]) > SPACING * 0.5) samples.push({ pos: p3, dir: b.dir });
      else samples[samples.length - 1] = { pos: p3, dir: b.dir };
    }
    const spacers: SpacerSpec[] = samples.map((s, idx) => ({ edgeId: e.id, index: idx, pos: s.pos, dir: s.dir, last: idx === samples.length - 1 }));
    lanes.push({ edge: e, from: a.key, to: b.key, spacers, mid: bezier(p0, p1, p2, p3, 0.62) });
  }

  // Baseline lane: the hiring filter's picks, a straight row along the front edge. No chain feeds them.
  let baselineZ: number | null = null;
  if (snap.baseline.hiringFilterCompanyIds.length && isReplay) {
    const ids = snap.baseline.hiringFilterCompanyIds;
    baselineZ = -targetZSpread / 2 - 2.0;
    const n = ids.length; const gap = 1.85;
    ids.forEach((cid, i) => {
      const c = snap.companies.find((x) => x.id === cid);
      const oc = outcomeFor(cid, 'baseline');
      const day = oc && oc.hit && oc.outcomeDate ? Math.max(0, dayDiff(asOf, oc.outcomeDate)) : null;
      tiles.push({
        key: 'b:' + cid, companyId: cid, name: c?.name ?? cid, role: 'baseline',
        pos: [triggerX - 1.6 + i * gap, baselineZ!], dir: [0, -1], width: TILE.w * 0.92,
        keyNumber: 'filter', keyCaption: 'is hiring', mechanism: 'DIRECT', confidence: null, netNew: false, alsoBaseline: true,
        outcome: oc, outcomeDay: day, evidenceIds: c?.evidenceIds ?? [], incomingEdgeIds: [],
      });
    });
  }

  const spacers = lanes.flatMap((l) => l.spacers);
  const xs = tiles.map((t) => t.pos[0]); const zs = tiles.map((t) => t.pos[1]);
  return {
    tiles, lanes, spacers,
    bounds: { minX: Math.min(...xs, -6) - 1.5, maxX: Math.max(...xs, 5) + 1.5, minZ: Math.min(...zs, -4) - 1.5, maxZ: Math.max(...zs, 4) + 1.5 },
    asOf, horizonEnd, horizonDays, isReplay, baselineZ,
  };
}

export function evidenceById(snap: RunSnapshot): Map<string, Evidence> {
  return new Map(snap.evidence.map((e) => [e.id, e]));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return 'undated';
  const d = new Date(Date.parse(iso.slice(0, 10) + 'T00:00:00Z'));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
export function fmtFull(iso: string | null | undefined): string {
  if (!iso) return 'undated';
  return `${fmtDay(iso)} ${iso.slice(0, 4)}`;
}
