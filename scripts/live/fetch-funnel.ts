import { writeFileSync, existsSync, readFileSync } from 'node:fs';
const P = 'experience.employment_details.';
const KW = ['inference', 'serving', 'ML platform', 'ML infrastructure', 'MLOps', 'GPU', 'LLM infrastructure', 'AI infrastructure', 'ML systems', 'machine learning platform', 'machine learning infrastructure', 'model deployment'];
const conds: any[] = [{ field: P + 'current.start_date', type: '=>', value: '2026-08-24' },
  { op: 'or', conditions: KW.map(k => ({ field: P + 'past.title', type: '[.]', value: k })) }];
const fields = ['basic_profile.name', 'crustdata_person_id', 'social_handles.professional_network_identifier.profile_url', ...['current', 'past'].flatMap(k => ['name', 'title', 'start_date', 'end_date', 'crustdata_company_id', 'company_headcount_latest', 'company_website', 'company_industries'].map(f => `${P}${k}.${f}`))];
const dir = process.argv[2];
let page = 0, cursor: string | null = null;
const state = `${dir}/state.json`;
if (existsSync(state)) ({ page, cursor } = JSON.parse(readFileSync(state, 'utf8')));
while (true) {
  const body: any = { filters: { op: 'and', conditions: conds }, limit: 200, fields };
  if (cursor) body.cursor = cursor;
  const res = await fetch('https://api.crustdata.com/person/search', { method: 'POST', headers: { Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`, 'x-api-version': '2025-11-01', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
  const t = await res.text();
  if (res.status === 429) { console.log(new Date().toISOString(), 'page', page, '429, sleeping 60s'); await new Promise(r => setTimeout(r, 60000)); continue; }
  if (!res.ok) { console.log('HTTP', res.status, t.slice(0, 300)); process.exit(1); }
  const j = JSON.parse(t);
  const retrievedAt = new Date().toISOString();
  writeFileSync(`${dir}/page-${page}.json`, JSON.stringify({ retrievedAt, request: body, creditsHeader: res.headers.get('x-credits-used'), total_count: j.total_count, next_cursor: j.next_cursor, profiles: j.profiles }));
  console.log(retrievedAt, 'page', page, 'got', j.profiles.length, 'total', j.total_count, 'credits', res.headers.get('x-credits-used'));
  cursor = j.next_cursor; page++;
  writeFileSync(state, JSON.stringify({ page, cursor }));
  if (!cursor || !j.profiles.length) break;
  await new Promise(r => setTimeout(r, 20000));
}
console.log('DONE pages', page);
