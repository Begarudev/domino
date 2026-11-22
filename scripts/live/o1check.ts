import { writeFileSync } from 'node:fs';
const H = { Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`, 'x-api-version': '2025-11-01', 'Content-Type': 'application/json' };
async function call(path: string, body: any, out: string) {
  for (let a = 0; a < 6; a++) {
    const res = await fetch('https://api.crustdata.com' + path, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
    const t = await res.text();
    if (res.status === 429) { console.log('429', path, 'sleep 30'); await new Promise(r => setTimeout(r, 30000)); continue; }
    const j = JSON.parse(t);
    writeFileSync(out, JSON.stringify({ retrievedAt: new Date().toISOString(), path, request: body, status: res.status, creditsHeader: res.headers.get('x-credits-used'), response: j }));
    return { j, credits: res.headers.get('x-credits-used'), status: res.status };
  }
}
const FAM: Record<string, string[]> = {
  inference: ['inference', 'serving', 'model serving', 'LLM serving'],
  ml_platform: ['ML platform', 'machine learning platform', 'ML infrastructure', 'machine learning infrastructure', 'AI infrastructure', 'AI platform', 'MLOps'],
};
const [name, cid, fam, since, tag] = process.argv.slice(2);
const kws = FAM[fam];
const job = await call('/job/search', { filters: { op: 'and', conditions: [
  { field: 'company.basic_info.company_id', type: '=', value: Number(cid) },
  { field: 'metadata.date_added', type: '=>', value: since },
  { field: 'metadata.date_added', type: '<', value: '2026-11-23' },
  { op: 'or', conditions: kws.map(k => ({ field: 'job_details.title', type: '[.]', value: k })) }] },
  sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 50,
  fields: ['crustdata_job_id', 'job_details.title', 'job_details.url', 'metadata.date_added', 'company.basic_info.name'] }, `o1/${tag}-jobs.json`);
console.log(`${name} [${fam}] family job posts since ${since}: total ${job!.j.total_count} (credits ${job!.credits})`);
for (const r of job!.j.job_listings ?? []) console.log('   ', r.metadata.date_added.slice(0, 10), r.job_details.title, r.job_details.url);
const anyjob = await call('/job/search', { filters: { op: 'and', conditions: [
  { field: 'company.basic_info.company_id', type: '=', value: Number(cid) },
  { field: 'metadata.date_added', type: '=>', value: since }, { field: 'metadata.date_added', type: '<', value: '2026-11-23' }] },
  sorts: [{ field: 'metadata.date_added', order: 'desc' }], limit: 50, fields: ['job_details.title', 'metadata.date_added'] }, `o1/${tag}-anyjobs.json`);
console.log(`   any job posts since ${since}: ${anyjob!.j.total_count}`, (anyjob!.j.job_listings ?? []).slice(0, 8).map((r: any) => r.metadata.date_added.slice(0, 10) + ' ' + r.job_details.title).join(' | '));
await new Promise(r => setTimeout(r, 4000));
const P = 'experience.employment_details.current.';
const hires = await call('/person/search', { filters: { op: 'and', conditions: [
  { field: P + 'company_id', type: '=', value: Number(cid) },
  { field: P + 'start_date', type: '=>', value: since },
  { op: 'or', conditions: kws.map(k => ({ field: P + 'title', type: '[.]', value: k })) }] }, limit: 50,
  fields: ['crustdata_person_id', 'basic_profile.name', P + 'title', P + 'start_date', P + 'name', P + 'crustdata_company_id'] }, `o1/${tag}-hires.json`);
console.log(`   family hires at ${name} starting since ${since}: total ${hires!.j.total_count} (credits ${hires!.credits}) status ${hires!.status}`);
for (const p of hires!.j.profiles ?? []) for (const c of p.experience?.employment_details?.current ?? []) if (String(c.crustdata_company_id) === cid) console.log('    ', (p.basic_profile?.name ?? '?')[0] + '.', c.title, c.start_date?.slice(0, 7));
