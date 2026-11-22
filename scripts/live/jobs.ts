import { writeFileSync } from 'node:fs';
const [phrase, after, out] = process.argv.slice(2);
const body = { filters: { op: 'and', conditions: [
  { field: 'metadata.date_added', type: '=>', value: after },
  { field: 'metadata.date_added', type: '<', value: '2026-11-23' },
  { field: 'content.description', type: '[.]', value: phrase } ] },
  sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 100,
  fields: ['crustdata_job_id', 'job_details.title', 'job_details.url', 'company.basic_info', 'company.headcount.total', 'company.locations', 'location.country', 'content.description', 'metadata.date_added'] };
for (let attempt = 0; attempt < 5; attempt++) {
  const res = await fetch('https://api.crustdata.com/job/search', { method: 'POST', headers: { Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`, 'x-api-version': '2025-11-01', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const t = await res.text();
  if (res.status === 429) { await new Promise(r => setTimeout(r, 20000)); continue; }
  const j = JSON.parse(t);
  writeFileSync(out, JSON.stringify({ retrievedAt: new Date().toISOString(), request: body, status: res.status, creditsHeader: res.headers.get('x-credits-used'), response: j }));
  console.log(phrase, res.status, 'total', j.total_count, 'got', j.job_listings?.length, 'credits', res.headers.get('x-credits-used'));
  const cos = new Map<string, any[]>();
  for (const r of j.job_listings ?? []) { const n = r.company?.basic_info?.name; if (!cos.has(n)) cos.set(n, []); cos.get(n)!.push(r); }
  for (const [n, rs] of [...cos].slice(0, 25)) {
    const d = rs[0].content?.description ?? ''; const i = d.toLowerCase().indexOf(phrase.toLowerCase());
    console.log(`  ${n} (${rs[0].company?.headcount?.total}) x${rs.length} ${rs[0].metadata?.date_added?.slice(0,10)} "${rs[0].job_details?.title}" …${d.slice(Math.max(0,i-60), i+60).replace(/\s+/g,' ')}…`);
  }
  break;
}
