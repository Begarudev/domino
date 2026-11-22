import { writeFileSync } from 'node:fs';
const [phrase, after, out] = process.argv.slice(2);
const body: any = { filters: { op: 'and', conditions: [
  { field: 'date_posted', type: '=>', value: after },
  { field: 'text', type: '[.]', value: phrase } ] },
  sorts: [{ field: 'date_posted', order: 'desc' }], limit: 50 };
for (let a = 0; a < 5; a++) {
  const res = await fetch('https://api.crustdata.com/social_post/search', { method: 'POST', headers: { Authorization: `Bearer ${process.env.CRUSTDATA_API_KEY}`, 'x-api-version': '2025-11-01', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const t = await res.text();
  if (res.status === 429) { await new Promise(r => setTimeout(r, 20000)); continue; }
  let j: any; try { j = JSON.parse(t); } catch { console.log(res.status, t.slice(0, 300)); break; }
  writeFileSync(out, JSON.stringify({ retrievedAt: new Date().toISOString(), request: body, status: res.status, creditsHeader: res.headers.get('x-credits-used'), response: j }));
  console.log(phrase, res.status, 'total', j.total_count, 'got', j.posts?.length, 'credits', res.headers.get('x-credits-used'), res.ok ? '' : t.slice(0, 300));
  for (const p of (j.posts ?? []).slice(0, 15)) { const tx = p.text ?? ''; const i = tx.toLowerCase().indexOf(phrase.toLowerCase());
    console.log(`  ${p.date_posted?.slice(0,10)} ${p.actor?.actor_type} ${p.actor?.name} @ ${p.actor?.company_name ?? ''} | …${tx.slice(Math.max(0,i-80), i+80).replace(/\s+/g,' ')}… ${p.share_url}`); }
  break;
}
