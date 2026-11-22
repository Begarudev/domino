import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../db.ts';

test('no emitted event or response carries a cached person full name or profile URL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-redact-'));
  const store = new Store(join(dir, 'r.db'));
  try {
    const response = { profiles: [
      { basic_profile: { name: 'Priya Ramaswamy', headline: 'ML Platform Engineer' }, social_handles: { professional_network_identifier: { profile_url: 'https://www.linkedin.com/in/priya-r-123' } } },
      { basic_profile: { name: 'Yusuf Okonkwo-Bello' } },
    ] };
    store.sql.prepare('INSERT INTO tool_cache (key, provider, endpoint, request_json, response_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('a'.repeat(64), 'crustdata', '/person/search', '{}', JSON.stringify(response), new Date().toISOString());
    store.createRun('run_r', 'test', 'live', 'template', { maxCredits: 1, maxModelUsd: 1, maxSeconds: 1 }, {});
    store.appendEvent('run_r', { type: 'source.read', callId: 'c1', step: 'pull_departures', endpoint: 'news_search', mode: 'live',
      query: 'Abacus.AI', totalAvailable: 1, items: [
        { kind: 'news', title: 'Priya Ramaswamy joins Arcfront from Abacus.AI', company: 'Abacus.AI', url: 'https://www.linkedin.com/in/priya-r-123',
          date: '2026-10-01', precision: 'month', signal: 'Undated search lead', matched: false },
        { kind: 'person_move', title: 'Yusuf Okonkwo-Bello left Abacus.AI', company: null, url: null, date: null, signal: null, matched: false },
      ] } as never);
    const rows = store.sql.prepare('SELECT payload_json FROM events WHERE run_id = ?').all('run_r') as { payload_json: string }[];
    const journal = rows.map(row => row.payload_json).join('\n');
    // Scan for every capitalised two-word personal name drawn from the cached profiles.
    for (const name of ['Priya Ramaswamy', 'Yusuf Okonkwo-Bello']) assert.doesNotMatch(journal, new RegExp(name));
    assert.doesNotMatch(journal, /linkedin\.com\/in\/priya/);
    assert.match(journal, /P\. joins Arcfront from Abacus\.AI/);
    assert.match(journal, /Y\. left Abacus\.AI/);
    // Person-shaped objects in a response: name -> initial; a candidate's consented "Asha K." stays.
    const snapshot = store.redactor.value({ people: [{ id: 'pe_1', name: 'Kavi Raman', title: 'VP of Engineering', companyId: 'co_a' }],
      evidence: [{ claim: 'Kavi Raman is VP of Engineering at Orbital Voice.' }], candidate: { displayName: 'Asha K.' } });
    assert.equal(snapshot.people[0].name, 'K.');
    assert.equal(snapshot.evidence[0].claim, 'K. is VP of Engineering at Orbital Voice.');
    assert.equal(snapshot.candidate.displayName, 'Asha K.');
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('employer names inside cached work history are never treated as people', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-redact-co-'));
  const store = new Store(join(dir, 'r.db'));
  try {
    const response = { profiles: [{ basic_profile: { name: 'Priya Ramaswamy' },
      experience: { employment_details: { past: [{ name: 'Amazon Web Services', title: 'SDE' }], current: [{ name: 'Hugging Face' }] } } }] };
    store.sql.prepare('INSERT INTO tool_cache (key, provider, endpoint, request_json, response_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('b'.repeat(64), 'crustdata', '/person/search', '{}', JSON.stringify(response), new Date().toISOString());
    assert.equal(store.redactor.text('Priya Ramaswamy left Amazon Web Services for Hugging Face'), 'P. left Amazon Web Services for Hugging Face');
  } finally {
    store.sql.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
