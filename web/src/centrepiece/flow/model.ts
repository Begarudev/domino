// Turns a RunSnapshot into a time-lapse "story": every element has the story second (s) at which it appears,
// so the renderer is a pure function of s. Scrubbing, screenshots and replays all fall out of that.
import type { Draft, Evidence, GraphEdge, Mechanism, RunSnapshot } from '../../../../shared/types.ts';

export const SERVING_RE = /inferenc|serving|ml platform|mlops|gpu|ml infra|model serv|triton|vllm|cuda|llm/i;
export const RIVER_MIN = 2;          // rule O1: 2+ dated departures in one role family
export const FLIGHT = 1.35;          // story seconds a move particle is in the air

// story segments (seconds)
const INTRO = 1.0;
const ACT1 = 8.0;
const FREEZE_HOLD = 3.0;
const ACT2 = 9.5;
const DRAIN_HOLD = 3.4;   // the clock pauses on the first drain so the caption can be read
const SCORE_HOLD = 2.6;
const ZOOM = 1.8;
const SENTENCE = 1.05;
const TAIL = 2.5;

export type Phase = 'intro' | 'see' | 'freeze' | 'forward' | 'score' | 'zoom' | 'letter' | 'done';

export interface FlowCompany { id: string; name: string; headcount: number; x: number; y: number; seed: number }
export interface FlowMove { id: string; day: number; from: string; to: string; title: string; serving: boolean; afterFreeze: boolean; sArrive: number }
export interface FlowRiver { key: string; from: string; to: string; moves: FlowMove[]; sForm: number; edgeId: string | null; label: string; family: string; predicted: boolean; replacedDay: number | null }
export interface FlowNeed {
  companyId: string; need: string; mechanism: Mechanism; confidence: number | null; sBloom: number;
  dated: number; undated: number; crack: boolean; netNew: boolean; weak: boolean; departures: number;
}
export interface FlowLink { edgeId: string; from: string; to: string; mechanism: Mechanism; sAppear: number; label: string }
export interface FlowShock { companyId: string; s: number; label: string }
export interface FlowPrediction {
  companyId: string; by: 'domino' | 'filter'; sPlace: number; hit: boolean; sLand: number | null;
  outcome: string; outcomeDay: number | null; netNew: boolean;
}
export interface FlowSentence {
  text: string; status: 'cited' | 'no_claim' | 'removed'; evidence: Evidence[]; note?: string;
  sStart: number; sLand: number;
}
export interface FlowLetter {
  companyId: string; kind: 'draft' | 'why'; to: string; subject: string; writtenOn: string;
  sentences: FlowSentence[]; unverifiable: { claim: string; reason: string }[]; sStart: number;
}
export interface Score { predicted: number; hits: number }

export interface FlowModel {
  mode: 'replay' | 'live';
  fixture: boolean;
  companies: FlowCompany[];
  byId: Map<string, FlowCompany>;
  moves: FlowMove[];
  rivers: FlowRiver[];
  needs: FlowNeed[];
  links: FlowLink[];
  shocks: FlowShock[];
  predictions: FlowPrediction[];
  letter: FlowLetter | null;
  focusId: string | null;
  filterIds: Set<string>;
  score: { domino: Score; filter: Score; headcount: Score; leaks: number; netNewHits: number } | null;
  // time
  d0: number; dFreeze: number; dEnd: number;
  sSee0: number; sFreeze: number; sForward0: number; sEnd: number; sScore: number; sZoom: number; sLetter: number; total: number;
  edgeById: Map<string, GraphEdge>;
  segs: Seg[];
  sDrain0: number | null; sDrain1: number | null; drainKey: string | null;   // the paused "drain" beat
}
export interface Seg { s0: number; s1: number; d0: number; d1: number }

export const dayOf = (iso: string) => Math.round(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / 86400000);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(day: number, year = false): string {
  const d = new Date(day * 86400000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
}

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** Role family of a set of job titles, for labels ("inference", "ML platform"). */
export function familyOf(titles: string[]): string {
  const t = titles.join(' ').toLowerCase();
  const inf = (t.match(/inferenc|serving|llm/g) ?? []).length, plat = (t.match(/platform|mlops|ml infra/g) ?? []).length;
  if (inf === 0 && plat === 0) return /gpu|cuda/.test(t) ? 'GPU infrastructure' : 'engineering';
  return inf >= plat ? 'inference' : 'ML platform';
}

export function shortNeed(need: string): string {
  const head = need.split(/[:;,(]/)[0].trim();
  return head.length > 44 ? `${head.slice(0, 42)}…` : head;
}

export function buildModel(snap: RunSnapshot, hints?: Record<string, { x: number; y: number }>, opts: { letter?: boolean } = {}): FlowModel {
  const evById = new Map(snap.evidence.map((e) => [e.id, e]));
  const edgeById = new Map(snap.graph.edges.map((e) => [e.id, e]));
  const replay = snap.intent?.runKind === 'replay' || !!snap.replay;
  const asOfIso = snap.replay?.asOf ?? snap.intent?.asOf ?? snap.createdAt.slice(0, 10);
  const endIso = snap.replay?.horizonEnd ?? snap.intent?.horizonEnd ?? asOfIso;
  const dFreeze = dayOf(asOfIso);
  const dEnd = replay ? Math.max(dayOf(endIso), dFreeze + 1) : dFreeze;
  // the time-lapse starts a few weeks before the first dated move (at most 90 days before the freeze)
  const moveDays = snap.triggers.filter((t) => t.kind === 'hire' || t.kind === 'departure')
    .flatMap((t) => t.evidenceIds.map((id) => evById.get(id)?.observedAt).filter((d): d is string => !!d).map(dayOf))
    .filter((d) => d >= dFreeze - 120 && d <= dFreeze);
  const d0 = moveDays.length ? Math.max(dFreeze - 90, Math.min(dFreeze - 30, Math.min(...moveDays) - 21)) : dFreeze - 90;

  // ---- moves (one per dated evidence row on a hire/departure trigger with a counterpart company) ----
  const seen = new Set<string>();
  const moves: FlowMove[] = [];
  for (const t of snap.triggers) {
    if ((t.kind !== 'hire' && t.kind !== 'departure') || !t.relatedCompanyId) continue;
    const from = t.kind === 'hire' ? t.relatedCompanyId : t.companyId;
    const to = t.kind === 'hire' ? t.companyId : t.relatedCompanyId;
    for (const id of t.evidenceIds) {
      const e = evById.get(id);
      if (!e || !e.observedAt || seen.has(id)) continue;
      if (!/person/.test(e.source.endpoint)) continue;
      seen.add(id);
      const day = dayOf(e.observedAt);
      if (day < d0 || day > dEnd) continue;
      const title = /hired an? (.+?) (whose|from)/i.exec(e.claim)?.[1] ?? 'engineer';
      moves.push({ id, day, from, to, title, serving: SERVING_RE.test(e.claim), afterFreeze: day > dFreeze, sArrive: 0 });
    }
  }
  moves.sort((a, b) => a.day - b.day);

  // focus account (the letter's company): top non-held target with a draft
  const top = [...snap.targets].filter((t) => !t.hold?.reasons?.length).sort((a, b) => a.rank - b.rank)[0];
  const held = new Set(snap.targets.filter((t) => t.hold?.reasons?.length).map((t) => t.companyId));
  const draft: Draft | undefined = snap.drafts.find((d) => d.id === top?.draftId) ?? snap.drafts.find((d) => !held.has(d.companyId));
  const focusGuess = draft?.companyId ?? top?.companyId ?? null;

  // the drain beat: the first serving-engineer river that forms before the freeze (the focus company's, if it has one)
  const drainEdge = (from: string, to: string) => snap.graph.edges.find((e) => e.mechanism === 'TALENT_DRAIN' && e.to === from && e.from === to) ?? null;
  const formDayOf = (from: string, to: string, days: number[]): number | null => {
    for (let i = RIVER_MIN - 1; i < days.length; i++) if (days[i] - days[i - RIVER_MIN + 1] <= 90) return days[i];
    return drainEdge(from, to) && days.length >= 2 ? days[days.length - 1] : null;
  };
  // a pair is a prediction only when the graph says so (a non-weak node at the losing company), or, with no graph, by count
  const graphHasNeeds = snap.graph.nodes.some((n) => n.need);
  const predictedAt = (id: string) => graphHasNeeds ? snap.graph.nodes.some((n) => n.id === id && n.need && n.status !== 'unverifiable' && n.mechanisms.includes('TALENT_DRAIN')) : true;
  let drainKey: string | null = null;
  let dDrain: number | null = null;
  {
    const byPair = new Map<string, number[]>();
    for (const m of moves) if (m.serving && m.day <= dFreeze) byPair.set(`${m.from}>${m.to}`, [...(byPair.get(`${m.from}>${m.to}`) ?? []), m.day]);
    for (const [key, days] of byPair) {
      const [from, to] = key.split('>');
      const fd0 = formDayOf(from, to, days);
      if (fd0 === null || fd0 <= d0 || !predictedAt(from)) continue;
      const fd = days[days.length - 1];   // the beat lands on the last departure before the freeze
      const better = dDrain === null || (from === focusGuess && !drainKey?.startsWith(`${focusGuess}>`)) || (fd < dDrain && !drainKey?.startsWith(`${focusGuess}>`));
      if (better) { drainKey = key; dDrain = fd; }
    }
  }

  // time mapping: piecewise-linear segments of (story seconds -> day); holds have d0 === d1
  const segs: Seg[] = [];
  let tt = 0;
  const seg = (dur: number, a: number, b: number) => { segs.push({ s0: tt, s1: tt + dur, d0: a, d1: b }); tt += dur; };
  seg(INTRO, d0, d0);
  let sDrain0: number | null = null, sDrain1: number | null = null;
  if (dDrain !== null) {
    seg(ACT1 * (dDrain - d0) / (dFreeze - d0), d0, dDrain);
    sDrain0 = tt; seg(DRAIN_HOLD, dDrain, dDrain); sDrain1 = tt;
    seg(Math.max(0.7, ACT1 * (dFreeze - dDrain) / (dFreeze - d0)), dDrain, dFreeze);
  } else seg(ACT1, d0, dFreeze);
  const sSee0 = INTRO;
  const sFreeze = tt;
  if (replay) seg(FREEZE_HOLD, dFreeze, dFreeze); else seg(0.8, dFreeze, dFreeze);
  const sForward0 = tt;
  if (replay) seg(ACT2, dFreeze, dEnd);
  const sEnd = tt;
  const sScore = sEnd;
  const sZoom = replay ? sScore + SCORE_HOLD : sEnd + 0.6;
  const sLetter = sZoom + ZOOM;
  const sOfDay = (day: number): number => {
    if (day <= d0) return sSee0;
    for (const g of segs) if (g.d1 > g.d0 && day >= g.d0 && day <= g.d1) return g.s0 + ((day - g.d0) / (g.d1 - g.d0)) * (g.s1 - g.s0);
    return day <= dFreeze ? sFreeze : sEnd;
  };
  for (const m of moves) m.sArrive = sOfDay(m.day);

  // ---- companies ----
  const ids = new Set<string>();
  snap.companies.forEach((c) => ids.add(c.id));
  const companies: FlowCompany[] = [...ids].map((id) => {
    const c = snap.companies.find((x) => x.id === id)!;
    return { id, name: c.name, headcount: c.headcount ?? 50, x: 0.5, y: 0.5, seed: hash(id) };
  });
  layout(companies, moves, hints);
  const byId = new Map(companies.map((c) => [c.id, c]));
  const validMoves = moves.filter((m) => byId.has(m.from) && byId.has(m.to));

  // ---- rivers ----
  const pairs = new Map<string, FlowMove[]>();
  for (const m of validMoves) if (m.serving) pairs.set(`${m.from}>${m.to}`, [...(pairs.get(`${m.from}>${m.to}`) ?? []), m]);
  const rivers: FlowRiver[] = [];
  for (const [key, ms] of pairs) {
    const [from, to] = key.split('>');
    const edge = snap.graph.edges.find((e) => e.mechanism === 'TALENT_DRAIN' && e.to === from && e.from === to) ?? null;
    let sForm = Infinity;
    for (let i = RIVER_MIN - 1; i < ms.length; i++) {
      if (ms[i].day - ms[i - RIVER_MIN + 1].day <= 90) { sForm = ms[i].sArrive; break; }
    }
    if (edge && sForm === Infinity && ms.length >= 2) sForm = ms[ms.length - 1].sArrive;
    const predicted = predictedAt(from);
    if (!predicted) sForm = Infinity;
    const last = ms.filter((mv) => mv.day <= dFreeze).at(-1)?.day ?? ms[ms.length - 1].day;
    const repl = snap.triggers.find((t) => t.companyId === from && t.kind === 'job_post' && SERVING_RE.test(t.summary) && dayOf(t.date) >= ms[0].day && dayOf(t.date) <= last + 30);
    const family = familyOf(ms.map((mv) => mv.title));
    rivers.push({ key, from, to, moves: ms, sForm, edgeId: edge?.id ?? null, label: edge?.label ?? `${ms.length} ${family} engineers left`, family, predicted, replacedDay: repl ? dayOf(repl.date) : null });
  }

  // ---- needs ----
  const needs: FlowNeed[] = [];
  for (const n of snap.graph.nodes) {
    if (!n.need || !byId.has(n.id)) continue;
    const cross = n.mechanisms.filter((m) => m !== 'DIRECT' && m !== 'CAPITAL');
    if (!cross.length) continue;
    const rows = n.evidenceIds.map((id) => evById.get(id)).filter((e): e is Evidence => !!e);
    const datedRows = rows.filter((e) => e.verifiable && e.observedAt && dayOf(e.observedAt) <= dFreeze);
    const lastDay = Math.max(d0, ...datedRows.map((e) => dayOf(e.observedAt!)));
    const river = rivers.find((r) => r.from === n.id && r.sForm < Infinity);
    let sBloom = sOfDay(lastDay) + 0.25;
    if (cross[0] === 'TALENT_DRAIN' && river) sBloom = river.sForm + 0.55;
    needs.push({
      companyId: n.id, need: shortNeed(n.need), mechanism: cross[0], confidence: n.confidence,
      sBloom: Math.min(sBloom, sFreeze - 0.1), dated: datedRows.length, undated: rows.length - datedRows.length,
      crack: cross.includes('TALENT_DRAIN') && n.status !== 'unverifiable', netNew: n.netNew, weak: n.status === 'unverifiable',
      departures: validMoves.filter((mv) => mv.from === n.id && mv.serving && mv.day <= dFreeze).length,
    });
  }

  // ---- links & shocks ----
  const links: FlowLink[] = snap.graph.edges
    .filter((e) => (e.mechanism === 'DISPLACEMENT' || e.mechanism === 'CONTAGION') && byId.has(e.from) && byId.has(e.to))
    .map((e) => ({ edgeId: e.id, from: e.from, to: e.to, mechanism: e.mechanism, sAppear: Math.min(sOfDay(e.observedAt ? dayOf(e.observedAt) : dFreeze) + 0.3, sFreeze - 0.2), label: e.label }));
  const shocks: FlowShock[] = snap.triggers
    .filter((t) => t.kind === 'post' && byId.has(t.companyId))
    .map((t) => ({ companyId: t.companyId, s: sOfDay(dayOf(t.date)), label: t.summary }));

  // ---- predictions ----
  const predictions: FlowPrediction[] = [];
  const filterIds = new Set(snap.baseline.hiringFilterCompanyIds);
  const netNewOf = (id: string) => snap.graph.nodes.find((n) => n.id === id)?.netNew ?? !filterIds.has(id);
  if (replay && snap.replay) {
    let i = 0;
    for (const o of snap.replay.outcomes) {
      if (!byId.has(o.companyId)) continue;
      const bys: ('domino' | 'filter')[] = o.predictedBy === 'both' ? ['domino', 'filter'] : o.predictedBy === 'domino' ? ['domino'] : o.predictedBy === 'baseline_first_order' ? ['filter'] : [];
      for (const by of bys) {
        if (predictions.some((p) => p.companyId === o.companyId && p.by === by)) continue;
        const od = o.outcomeDate ? dayOf(o.outcomeDate) : null;
        predictions.push({
          companyId: o.companyId, by, sPlace: sFreeze + 0.7 + i++ * 0.32, hit: o.hit && od !== null,
          sLand: o.hit && od !== null ? sOfDay(od) : null, outcome: o.outcome, outcomeDay: od, netNew: netNewOf(o.companyId),
        });
      }
    }
  } else {
    let i = 0;
    for (const t of snap.targets) if (byId.has(t.companyId)) predictions.push({ companyId: t.companyId, by: 'domino', sPlace: sFreeze + 0.2 + i++ * 0.25, hit: false, sLand: null, outcome: '', outcomeDay: null, netNew: t.netNew });
    for (const id of filterIds) if (byId.has(id)) predictions.push({ companyId: id, by: 'filter', sPlace: sFreeze + 0.2 + i++ * 0.25, hit: false, sLand: null, outcome: '', outcomeDay: null, netNew: false });
  }

  const score = replay && snap.replay ? {
    domino: snap.replay.domino, filter: snap.replay.baselineFirstOrder, headcount: snap.replay.baselineHeadcount,
    leaks: snap.replay.factsAfterAsOfUsed,
    netNewHits: predictions.filter((p) => p.by === 'domino' && p.hit && p.netNew).length,
  } : null;

  // ---- letter ----
  const focusId = draft?.companyId ?? top?.companyId ?? needs[0]?.companyId ?? null;
  let letter: FlowLetter | null = null;
  if (opts.letter && focusId && byId.has(focusId)) {
    const tgt = snap.targets.find((t) => t.companyId === focusId);
    let t = sLetter + 0.25;
    const mk = (text: string, status: FlowSentence['status'], evidence: Evidence[], note?: string): FlowSentence => {
      const dur = status === 'cited' ? SENTENCE : status === 'removed' ? SENTENCE * 0.9 : SENTENCE * 0.6;
      const s: FlowSentence = { text, status, evidence, note, sStart: t, sLand: t + (status === 'cited' ? 0.8 : 0.45) };
      t += dur;
      return s;
    };
    if (draft) {
      const sentences = draft.checks.map((c) => mk(c.sentence, c.status, c.evidenceIds.map((id) => evById.get(id)).filter((e): e is Evidence => !!e), c.note));
      const who = tgt?.decider ? `${tgt.decider.name}, ${tgt.decider.title}` : 'the person who decides';
      letter = { companyId: focusId, kind: 'draft', to: who, subject: draft.subject, writtenOn: fmtDay(replay ? dFreeze : dEnd, true), sentences, unverifiable: draft.unverifiable, sStart: sLetter };
    } else {
      const node = snap.graph.nodes.find((n) => n.id === focusId);
      const rows = (node?.evidenceIds ?? []).map((id) => evById.get(id)).filter((e): e is Evidence => !!e);
      const sentences = rows.filter((e) => e.verifiable).slice(0, 5).map((e) => mk(`${e.claim}.`, 'cited', [e]));
      const unverifiable = rows.filter((e) => !e.verifiable).map((e) => ({ claim: e.claim, reason: 'No dated source' }));
      letter = { companyId: focusId, kind: 'why', to: byId.get(focusId)!.name, subject: node?.need ?? 'Why this account', writtenOn: fmtDay(replay ? dFreeze : dEnd, true), sentences, unverifiable, sStart: sLetter };
    }
    const endS = (letter.sentences.at(-1)?.sLand ?? sLetter) + TAIL;
    return finish(endS);
  }
  return finish(opts.letter ? sLetter + TAIL : sZoom + 1.5);

  function finish(total: number): FlowModel {
    return {
      mode: replay ? 'replay' : 'live', fixture: snap.dataMode === 'fixture', companies, byId, moves: validMoves, rivers,
      needs, links, shocks, predictions, letter, focusId, filterIds, score, d0, dFreeze, dEnd,
      sSee0, sFreeze, sForward0, sEnd, sScore, sZoom, sLetter, total, edgeById, segs, sDrain0, sDrain1, drainKey,
    };
  }
}

/** Date (as a day number, fractional) shown on the clock at story second s. */
export function dayAt(m: FlowModel, s: number): number {
  for (const g of m.segs) if (s >= g.s0 && s <= g.s1) return g.s1 > g.s0 ? g.d0 + ((s - g.s0) / (g.s1 - g.s0)) * (g.d1 - g.d0) : g.d1;
  return s < 0 ? m.d0 : m.mode === 'live' ? m.dFreeze : m.dEnd;
}

export function sAtDay(m: FlowModel, day: number): number {
  if (day <= m.d0) return m.sSee0;
  for (const g of m.segs) if (g.d1 > g.d0 && day >= g.d0 && day <= g.d1) return g.s0 + ((day - g.d0) / (g.d1 - g.d0)) * (g.s1 - g.s0);
  return day <= m.dFreeze ? m.sFreeze : m.sEnd;
}

/** Chapter (1-based) and chapter count for the narrative caption. */
export function chapterAt(m: FlowModel, s: number): { n: number; of: number } {
  const of = (m.mode === 'replay' ? 4 : 2) + (m.letter ? 1 : 0);
  const c2 = m.sDrain0 !== null ? m.sDrain0 - 0.15 : m.sFreeze;
  if (s < c2) return { n: 1, of };
  if (s < m.sFreeze) return { n: 2, of };
  if (m.mode === 'live') return { n: m.letter && s >= m.sZoom ? 3 : 2, of };
  if (s < m.sForward0) return { n: 3, of };
  if (s < m.sZoom || !m.letter) return { n: 4, of };
  return { n: 5, of };
}

export function phaseAt(m: FlowModel, s: number): Phase {
  if (s < m.sSee0) return 'intro';
  if (s < m.sFreeze) return 'see';
  if (s < m.sForward0) return 'freeze';
  if (s < m.sEnd) return 'forward';
  if (s < m.sZoom) return m.mode === 'replay' ? 'score' : 'forward';
  if (s < m.sLetter) return 'zoom';
  if (s < m.total - 0.01) return 'letter';
  return 'done';
}

// Force layout used when the caller gives no positions (real runs). Deterministic.
function layout(cs: FlowCompany[], moves: FlowMove[], hints?: Record<string, { x: number; y: number }>) {
  const missing = cs.filter((c) => !hints?.[c.id]);
  cs.forEach((c) => { const h = hints?.[c.id]; if (h) { c.x = h.x; c.y = h.y; } });
  if (!missing.length) return;
  if (missing.length < cs.length) hints = undefined;   // partial hints: lay everything out together
  const n = cs.length;
  cs.forEach((c, i) => {
    if (hints?.[c.id]) return;
    const a = (i / n) * Math.PI * 2 + c.seed;
    c.x = 0.5 + Math.cos(a) * (0.3 + 0.1 * c.seed);
    c.y = 0.5 + Math.sin(a) * (0.3 + 0.1 * c.seed);
  });
  const weight = new Map<string, number>();
  for (const m of moves) {
    const k = m.from < m.to ? `${m.from}|${m.to}` : `${m.to}|${m.from}`;
    weight.set(k, (weight.get(k) ?? 0) + (m.serving ? 3 : 1));
  }
  const idx = new Map(cs.map((c, i) => [c.id, i]));
  for (let it = 0; it < 400; it++) {
    const fx = new Float64Array(n), fy = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const dx = cs[i].x - cs[j].x, dy = cs[i].y - cs[j].y;
      const d2 = Math.max(dx * dx + dy * dy, 1e-4);
      const f = 0.0016 / d2;
      fx[i] += dx * f; fy[i] += dy * f; fx[j] -= dx * f; fy[j] -= dy * f;
    }
    for (const [k, w] of weight) {
      const [a, b] = k.split('|').map((id) => idx.get(id));
      if (a === undefined || b === undefined) continue;
      const dx = cs[b].x - cs[a].x, dy = cs[b].y - cs[a].y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const f = 0.004 * Math.min(w, 8) * (d - 0.25);
      fx[a] += (dx / d) * f; fy[a] += (dy / d) * f; fx[b] -= (dx / d) * f; fy[b] -= (dy / d) * f;
    }
    for (let i = 0; i < n; i++) {
      if (hints?.[cs[i].id]) continue;
      fx[i] += (0.5 - cs[i].x) * 0.01; fy[i] += (0.5 - cs[i].y) * 0.01;
      cs[i].x += Math.max(-0.02, Math.min(0.02, fx[i]));
      cs[i].y += Math.max(-0.02, Math.min(0.02, fy[i]));
    }
  }
  const xs = cs.map((c) => c.x), ys = cs.map((c) => c.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // keep the shape: one scale for both axes, centred, with a margin that grows when there are few companies
  const margin = n <= 4 ? 0.22 : 0.06;
  const sc = (1 - 2 * margin) / Math.max(x1 - x0, y1 - y0, 1e-3);
  cs.forEach((c) => { c.x = 0.5 + (c.x - (x0 + x1) / 2) * sc; c.y = 0.5 + (c.y - (y0 + y1) / 2) * sc; });
}
