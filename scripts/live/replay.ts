import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const H = { Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`, 'x-api-version': '2025-11-01', 'Content-Type': 'application/json' };
let credits = 0, calls = 0;
async function call(path: string, body: any, tag: string) {
  const file = `replay/${tag}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')).response;   // cache: never refetch
  for (let a = 0; a < 8; a++) {
    const res = await fetch('https://api.crustdata.com' + path, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
    const t = await res.text();
    if (res.status === 429) { console.log('429', tag); await new Promise(r => setTimeout(r, 30000)); continue; }
    if (!res.ok) throw new Error(`${tag} ${res.status} ${t.slice(0, 300)}`);
    const j = JSON.parse(t); calls++; credits += Number(res.headers.get('x-credits-used') ?? 0);
    writeFileSync(file, JSON.stringify({ label: 'live-cached', retrievedAt: new Date().toISOString(), path, request: body, creditsHeader: res.headers.get('x-credits-used'), response: j }));
    await new Promise(r => setTimeout(r, path === '/person/search' ? 16000 : 2500));
    return j;
  }
  throw new Error('429 forever ' + tag);
}
async function pages(path: string, body: any, key: string, tag: string, max = 10) {
  const rows: any[] = []; let cursor: string | null = null;
  for (let i = 0; i < max; i++) {
    const j = await call(path, cursor ? { ...body, cursor } : body, `${tag}-p${i}`);
    rows.push(...(j[key] ?? [])); cursor = j.next_cursor; if (!cursor || !(j[key] ?? []).length) break;
  }
  return rows;
}
const FAM: Record<string, string[]> = {
  inference: ['inference', 'serving'], mlops: ['MLOps', 'ML Ops'],
  ml_platform: ['ML platform', 'machine learning platform', 'ML infrastructure', 'machine learning infrastructure', 'AI infrastructure', 'AI platform', 'ML systems'],
  gpu_llm_infra: ['GPU', 'CUDA', 'LLM infrastructure', 'LLM platform', 'distributed training'],
};
const famOf = (t: string) => Object.entries(FAM).filter(([, ks]) => ks.some(k => t.toLowerCase().includes(k.toLowerCase()))).map(([f]) => f);
const allKw = [...new Set(Object.values(FAM).flat())];
const universe = JSON.parse(readFileSync(process.argv[2], 'utf8')) as any[];
const predicted = JSON.parse(readFileSync(process.argv[3], 'utf8')) as any[];
const ids = universe.map(u => Number(u.company_id));
const chunks = <T>(a: T[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
// 1. headcount as of 1 Sep (enrich timeseries)
const hc = new Map<number, { asOf: number | null; growth: number | null; points: any[] }>();
for (const [i, chunk] of chunks(ids, 25).entries()) {
  const j = await call('/company/enrich', { crustdata_company_ids: chunk, fields: ['basic_info', 'headcount'] }, `enrich-${i}`);
  for (const r of j ?? []) for (const m of (r.matches ?? []).slice(0, 1)) {
    const c = m.company_data; if (!c) continue;
    const id = Number(c.crustdata_company_id ?? c.basic_info?.crustdata_company_id);
    const ts = (c.headcount?.timeseries ?? []).filter((p: any) => p.date && p.date.slice(0, 10) <= '2026-09-01').sort((a: any, b: any) => a.date.localeCompare(b.date));
    const last = ts.at(-1);
    const prev = last && ts.filter((p: any) => { const d = (Date.parse(last.date) - Date.parse(p.date)) / 864e5; return d >= 28 && d <= 35; }).at(-1);
    hc.set(id, { asOf: last?.employee_count ?? null, growth: last && prev && prev.employee_count ? (last.employee_count / prev.employee_count - 1) * 100 : null, points: ts.slice(-3) });
  }
}
const inIcp = (id: number) => { const h = hc.get(id)?.asOf; return h != null && h >= 20 && h <= 5000; };
const icp = ids.filter(inIcp);
const J = 'company.basic_info.company_id';
// 2. any job post (2 Aug, 1 Sep]
const anyPosts = await pages('/job/search', { filters: { op: 'and', conditions: [{ field: J, type: 'in', value: icp },
  { field: 'metadata.date_added', type: '>', value: '2026-08-02' }, { field: 'metadata.date_added', type: '<', value: '2026-09-02' }] },
  fields: ['company.basic_info.crustdata_company_id', 'metadata.date_added', 'job_details.title'], sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 1000 }, 'job_listings', 'anypost-aug');
// 3. family posts before cutoff (replacement check for O1) and after (outcome)
const famFilter = { op: 'or', conditions: allKw.map(k => ({ field: 'job_details.title', type: '[.]', value: k })) };
const prePosts = await pages('/job/search', { filters: { op: 'and', conditions: [{ field: J, type: 'in', value: icp },
  { field: 'metadata.date_added', type: '=>', value: '2026-06-01' }, { field: 'metadata.date_added', type: '<', value: '2026-09-02' }, famFilter] },
  fields: ['company.basic_info.crustdata_company_id', 'metadata.date_added', 'job_details.title', 'job_details.url'], sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 1000 }, 'job_listings', 'fampost-pre');
const postPosts = await pages('/job/search', { filters: { op: 'and', conditions: [{ field: J, type: 'in', value: icp },
  { field: 'metadata.date_added', type: '=>', value: '2026-09-02' }, { field: 'metadata.date_added', type: '<', value: '2026-11-01' }, famFilter] },
  fields: ['company.basic_info.crustdata_company_id', 'metadata.date_added', 'job_details.title', 'job_details.url'], sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 1000 }, 'job_listings', 'fampost-outcome');
// 4. family hires Sep–Oct (outcome) at icp companies
const P = 'experience.employment_details.current.';
const hires = await pages('/person/search', { filters: { op: 'and', conditions: [{ field: P + 'company_id', type: 'in', value: icp },
  { field: P + 'start_date', type: '=>', value: '2026-09-01' }, { field: P + 'start_date', type: '=<', value: '2026-10-31' },
  { op: 'or', conditions: allKw.map(k => ({ field: P + 'title', type: '[.]', value: k })) }] }, limit: 200,
  fields: ['crustdata_person_id', P + 'title', P + 'start_date', P + 'crustdata_company_id'] }, 'profiles', 'famhire-outcome', 5);
const cid = (r: any) => Number(r.company?.basic_info?.crustdata_company_id);
const outcomes = new Map<number, { f: string; date: string; kind: string; what: string; url?: string }[]>();
const push = (id: number, o: any) => { if (!outcomes.has(id)) outcomes.set(id, []); outcomes.get(id)!.push(o); };
for (const r of postPosts) for (const f of famOf(r.job_details?.title ?? '')) push(cid(r), { f, date: r.metadata.date_added.slice(0, 10), kind: 'job_post', what: r.job_details.title, url: r.job_details.url });
for (const p of hires) for (const c of p.experience?.employment_details?.current ?? []) if (icp.includes(Number(c.crustdata_company_id)) && c.start_date >= '2026-09-01')
  for (const f of famOf(c.title ?? '')) push(Number(c.crustdata_company_id), { f, date: c.start_date.slice(0, 7), kind: 'hire', what: c.title });
// arms
const name = new Map(universe.map(u => [Number(u.company_id), u.company]));
const o1 = predicted.filter(p => inIcp(Number(p.company_id)) && p.conclusive >= 2 && !p.size_guard.filter((g: string) => !g.startsWith('headcount')).length);
const o1rows = o1.map(p => {
  const id = Number(p.company_id), since = p.last_departure_month + '-01';
  const replaced = prePosts.filter(r => cid(r) === id && r.metadata.date_added.slice(0, 10) >= since && famOf(r.job_details.title).includes(p.family));
  const hit = (outcomes.get(id) ?? []).filter(o => o.f === p.family);
  return { company: p.company, family: p.family, headcountSep1: hc.get(id)?.asOf, departures: p.departures.map((d: any) => `${d.initial}. ${d.title} left ${d.end} -> ${d.hirer} (${d.start})${d.conclusive ? '' : ' [month-only, not conclusive]'}`),
    replacementBeforeCutoff: replaced.map(r => r.metadata.date_added.slice(0, 10) + ' ' + r.job_details.title), predicted: replaced.length === 0, outcome: hit[0] ?? null, outcomes: hit.length };
});
const anyIds = [...new Set(anyPosts.map(cid))].filter(id => icp.includes(id));
const hcIds = icp.filter(id => (hc.get(id)?.growth ?? -1) >= 30);
const famHit = (id: number) => (outcomes.get(id) ?? []).length > 0;
const pred = o1rows.filter(r => r.predicted);
const summary = {
  label: 'live-cached', asOf: '2026-09-01', outcomeWindow: '(2026-09-01, 2026-10-31]', retrievedAt: new Date().toISOString(),
  factsDatedAfterCutoffUsedForPrediction: 0,
  universe: { companiesWithFamilyDeparture: ids.length, at20to5000Sep1: icp.length, enriched: hc.size },
  O1: { predicted: pred.length, hits: pred.filter(r => r.outcome).length, held: o1rows.length - pred.length, rows: o1rows },
  baselineAnyJobPost30d: { picks: anyIds.length, hits: anyIds.filter(famHit).length, picksList: anyIds.map(id => name.get(id)) },
  baselineHeadcount30: { picks: hcIds.length, hits: hcIds.filter(famHit).length, picksList: hcIds.map(id => `${name.get(id)} +${hc.get(id)!.growth!.toFixed(1)}%`) },
  universeBaseRate: { companies: icp.length, withFamilyOutcome: icp.filter(famHit).length },
  creditsThisScript: credits, callsThisScript: calls,
};
writeFileSync('replay-summary.json', JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, O1: { ...summary.O1, rows: undefined }, baselineAnyJobPost30d: { ...summary.baselineAnyJobPost30d, picksList: undefined } }, null, 1));
for (const r of o1rows) console.log(r);
