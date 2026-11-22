// Search Desk: enrich adapter parse (recorded response shape, fictional data, no live call), matching, and the
// candidate + intro pipelines end to end over HTTP in fixture mode (consent filtering, send-once).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { Evidence } from '../../shared/types.ts';
import type { Candidate, CompanySummary, CompanyView, Departure, IntroPreview, IntroRequest, Opening, OpeningForCandidate } from '../../shared/desk.ts';
import { waitFor } from '../../scripts/smoke.ts';
import { displayName, enrichFixture, linkedinProfileUrl, parseEnrich, personEnrich } from '../crustdata/person-enrich.ts';
import { Store } from '../db.ts';
import { defaultLimits, root } from '../env.ts';
import { classifyProfile, openingsForCandidate } from './match.ts';
import { introClaims } from '../engine/candidate-steps.ts';

const meta = { mode: 'live' as const, retrievedAt: '2026-11-22T09:00:00.000Z', asOf: '2026-11-22', windowDays: 0, endpoint: '/person/enrich' };
const PROFILE = 'https://www.linkedin.com/in/fictional-test-profile/';

// Recorded response shape (field names and nesting as returned by /person/enrich); every value is fictional.
const recorded = [{
  matched_on: PROFILE, match_type: 'professional_network_profile_url', match_status: 'matched',
  matches: [{
    confidence_score: 0.97,
    person_data: {
      crustdata_person_id: 4242,
      basic_profile: { name: 'Mira Quillfeather', headline: 'Inference engineer, LLM serving', current_title: 'Senior Inference Engineer',
        location: { country: 'India', raw: 'Bengaluru' } },
      skills: { professional_network_skills: ['vLLM', 'CUDA', 'Python', 'Kubernetes'] },
      experience: { employment_details: {
        current: [{ name: 'Fictional Serving Co', title: 'Senior Inference Engineer', start_date: '2024-05-01T00:00:00Z', end_date: null, crustdata_company_id: 7 }],
        past: [{ name: 'Imaginary Cloud', title: 'Backend Engineer', start_date: '2021-01-01', end_date: '2024-04-01' }],
      } },
      social_handles: { professional_network_identifier: { profile_url: PROFILE } },
    },
  }],
}];

describe('person enrich adapter', () => {
  test('builds a minimal, consent-scoped request', () => {
    assert.deepEqual(personEnrich.build({ profileUrl: PROFILE, shareHistory: false, shareSkills: true }),
      { professional_network_profile_urls: [PROFILE], fields: ['basic_profile', 'skills'] });
  });

  test('parses a recorded-shape response into consented evidence and a display name only', () => {
    const result = parseEnrich(recorded, { profileUrl: PROFILE, shareHistory: true, shareSkills: true }, meta);
    const person = result.people[0];
    assert.equal(person.name, 'Mira Q.');
    assert.equal(person.title, 'Senior Inference Engineer');
    assert.deepEqual(person.pastEmployers.map(role => [role.name, role.from, role.to]),
      [['Fictional Serving Co', '2024-05-01', null], ['Imaginary Cloud', '2021-01-01', '2024-04-01']]);
    const fields = result.evidence.map(row => row.source.field);
    assert.deepEqual(fields, ['basic_profile.headline', 'basic_profile.current_title', 'skills.professional_network_skills',
      'experience.employment_details.current[0]', 'experience.employment_details.past[0]']);
    for (const row of result.evidence) {
      assert.equal(row.source.provider, 'crustdata');
      assert.equal(row.source.endpoint, '/person/enrich');
      assert.equal(row.source.url, PROFILE);
      assert.ok(row.verifiable && row.observedAt);
    }
    const text = JSON.stringify(result);
    assert.ok(!text.includes('Quillfeather'), 'the full surname is never kept');
    assert.ok(!text.includes('Bengaluru'), 'location is not requested by the desk');
  });

  test('drops history and skills the candidate did not consent to', () => {
    const result = parseEnrich(recorded, { profileUrl: PROFILE, shareHistory: false, shareSkills: false }, meta);
    assert.deepEqual(result.evidence.map(row => row.source.field), ['basic_profile.headline', 'basic_profile.current_title']);
    assert.deepEqual(result.people[0].pastEmployers, []);
  });

  test('not found and redacted profiles yield nothing', () => {
    const empty = [{ matched_on: PROFILE, match_type: 'professional_network_profile_url', match_status: 'not_found', matches: [] }];
    assert.deepEqual(parseEnrich(empty, { profileUrl: PROFILE, shareHistory: true, shareSkills: true }, meta), { evidence: [], people: [] });
    assert.throws(() => parseEnrich({ profiles: [] }, { profileUrl: PROFILE, shareHistory: true, shareSkills: true }, meta), /nonsense/);
  });

  test('validates LinkedIn profile URLs and shortens names', () => {
    assert.equal(linkedinProfileUrl('https://linkedin.com/in/some-one'), 'https://www.linkedin.com/in/some-one/');
    assert.equal(linkedinProfileUrl('https://in.linkedin.com/in/some-one/'), 'https://www.linkedin.com/in/some-one/');
    for (const bad of ['http://www.linkedin.com/in/x1', 'https://www.linkedin.com/company/acme', 'https://evil.com/in/x1',
      'https://linkedin.com.evil.com/in/x1', 'https://www.linkedin.com/in/x1/details/skills', 'javascript:alert(1)']) {
      assert.equal(linkedinProfileUrl(bad), null, bad);
    }
    assert.equal(displayName('Asha Kestrel'), 'Asha K.');
    assert.equal(displayName('Asha van der Berg'), 'Asha B.');
    assert.equal(displayName('Cher'), 'Cher');
    assert.equal(displayName(''), 'Candidate');
  });

  test('the fixture candidate is labelled fictional', () => {
    const result = parseEnrich(enrichFixture(personEnrich.build({ profileUrl: PROFILE, shareHistory: true, shareSkills: true })),
      { profileUrl: PROFILE, shareHistory: true, shareSkills: true }, { ...meta, mode: 'fixture' });
    assert.equal(result.people[0].name, 'Asha K.');
    assert.match(String(result.evidence[0].value), /fictional/);
  });
});

// ---------- seeded openings scan (fictional companies) ----------

const evidence = (id: string, claim: string, observedAt: string): Evidence => ({
  id, claim, value: claim, observedAt, retrievedAt: '2026-11-22T08:00:00.000Z', mode: 'fixture', verifiable: true,
  source: { provider: 'crustdata', endpoint: '/person/search', recordId: id, field: 'start_date' },
});
const seedEvidence = [
  evidence('ev_drain_a', 'An ML Platform Engineer started at another employer in Oct 2026.', '2026-10-01'),
  evidence('ev_drain_b', 'A second ML Platform Engineer started at another employer in Oct 2026.', '2026-10-01'),
  evidence('ev_no_post', 'No ML platform job post at Orbitline Fictional since 1 Oct (checked 22 Nov).', '2026-11-22'),
  evidence('ev_held', 'Two inference engineers moved to the acquirer.', '2026-09-01'),
];
const openings: Opening[] = [{
  id: 'op_orbit_mlp', companyId: 'co_orbit', companyName: 'Orbitline Fictional', roleFamily: 'ml_platform',
  roleTitle: 'ML Platform Engineer', status: 'open', confidence: 0.7, predictedAt: '2026-11-22', rule: 'O1',
  reasons: [
    { kind: 'talent_drain', label: '2 ML Platform Engineers moved on in Oct 2026', date: '2026-10-01', evidenceId: 'ev_drain_a' },
    { kind: 'no_replacement', label: '0 ML platform job posts or hires since 1 Oct', date: '2026-11-22', evidenceId: 'ev_no_post' },
    { kind: 'news', label: 'Replacement window closes by 30 Nov (provisional)', date: null, evidenceId: null },
  ],
  evidenceIds: ['ev_drain_a', 'ev_drain_b', 'ev_no_post'], runId: 'run_seed_openings',
}, {
  id: 'op_kestrel_inf', companyId: 'co_kestrel', companyName: 'Kestrel Fictional', roleFamily: 'inference',
  roleTitle: 'Inference Engineer', status: 'held', confidence: 0.5, predictedAt: '2026-11-22', rule: 'O1',
  reasons: [], holdReasons: ['acqui-hire'], evidenceIds: ['ev_held'], runId: 'run_seed_openings',
}];
const departures: Departure[] = [
  { id: 'dp_1', companyId: 'co_orbit', role: 'ML Platform Engineer', roleFamily: 'ml_platform', initial: 'R.', date: '2026-10-01',
    precision: 'month', toCompanyId: null, toCompanyName: 'Elsewhere Fictional', evidenceId: 'ev_drain_a' },
  { id: 'dp_2', companyId: 'co_orbit', role: 'ML Platform Engineer', roleFamily: 'ml_platform', initial: 'T.', date: '2026-10-01',
    precision: 'month', toCompanyId: null, toCompanyName: 'Another Fictional', evidenceId: 'ev_drain_b' },
];

describe('intro claims', () => {
  test('a watch is never worded as a prediction', () => {
    const candidate = { id: 'c', status: 'ready', linkedinUrl: '', displayName: 'Asha K.', headline: null, roleFamily: 'ml_platform',
      skills: [], history: [], samples: [], consent: { shareHistory: false, shareSkills: false, shareSamples: false, discoverable: false },
      confirmedAt: null, evidenceIds: [], runId: '', parsedBy: 'rules' } as Candidate;
    const rows = new Map(seedEvidence.map(row => [row.id, row]));
    const [open] = introClaims(openings[0], candidate, [], rows);
    assert.match(open.text, /^DOMINO predicts an ML Platform Engineer opening at Orbitline Fictional after .+ October 2026$/);
    assert.ok(open.verifiable);
    const [watch] = introClaims({ ...openings[0], status: 'watch', watch: { have: 1, need: 2 } }, candidate, [], rows);
    assert.match(watch.text, /^DOMINO is watching Orbitline Fictional for a possible ML Platform Engineer opening/);
  });
});

describe('matching', () => {
  test('rules classify a profile and every fit reason is sourced or marked cant_verify', () => {
    assert.equal(classifyProfile('ML Platform Engineer', null, ['Kubernetes']), 'ml_platform');
    assert.equal(classifyProfile('Software Engineer', 'Inference and model serving', []), 'inference');
    assert.equal(classifyProfile('Designer', null, []), null);
    const candidate = { displayName: 'Asha K.', headline: null, roleFamily: 'ml_platform' as const, skills: ['Kubernetes', 'Ray', 'Figma'],
      history: [], consent: { shareHistory: false, shareSkills: true, shareSamples: false, discoverable: true } };
    const ranked = openingsForCandidate(candidate, openings, seedEvidence);
    assert.deepEqual(ranked.map(row => row.id), ['op_orbit_mlp'], 'held openings are never offered');
    for (const reason of ranked[0].fit) {
      if (reason.status === 'verified') assert.ok(reason.profileField || reason.evidenceId, reason.text);
    }
    assert.ok(ranked[0].fit.some(reason => reason.status === 'cant_verify' && /provisional/.test(reason.text)));
    assert.ok(ranked[0].fit.some(reason => reason.status === 'cant_verify' && /history was not shared/.test(reason.text)));
  });
});

// ---------- HTTP, fixture mode ----------

describe('search desk over HTTP (fixture mode)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domino-desk-test-'));
  const dbPath = join(dir, 'test.db');
  let server: ChildProcess;
  let base = '';

  before(async () => {
    const store = new Store(dbPath);
    const runId = 'run_seed_openings';
    store.createRun(runId, 'seed', 'fixture', 'template', defaultLimits, {}, 'openings');
    store.recordEvent(runId, { type: 'evidence.added', evidence: seedEvidence });
    const outputs = {
      scope_search: { roleFamilies: ['ml_platform'], asOf: '2026-11-22', runKind: 'live', horizonEnd: null, cohort: 'test', assumptions: [] },
      pull_departures: { departures, evidence: [] },
      resolve_departures: { companies: [
        { id: 'co_orbit', name: 'Orbitline Fictional', aliases: [], headcount: 120, evidenceIds: [] },
        { id: 'co_kestrel', name: 'Kestrel Fictional', aliases: [], headcount: 300, evidenceIds: [] },
      ], departures, evidence: [] },
      check_replacements: { replacements: [], staleCompanyIds: [], evidence: [] },
      detect_openings: { openings, funnel: { runId: 'run_seed_openings', rule: 'O1', lockedAt: '2026-11-22T08:38:00Z', snapshot: 'fixture', stages: [{ id: 'departures', label: 'Dated departures', count: 2 }] } },
    } as const;
    for (const [step, output] of Object.entries(outputs)) {
      store.setOutput(runId, step as keyof typeof outputs, output);
      store.recordEvent(runId, { type: 'step.completed', step: step as keyof typeof outputs, summary: 'seeded', durationMs: 0 });
    }
    store.recordEvent(runId, { type: 'run.status', status: 'completed' });
    store.sql.close();

    server = spawn(process.execPath, ['server/index.ts'], {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, DOMINO_PORT: '0', DOMINO_DATA: 'fixture', DOMINO_DB: dbPath, DOMINO_OUTBOX: join(dir, 'outbox'),
        ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', CRUSTDATA_API_KEY: '' },
    });
    let banner = '';
    server.stdout!.on('data', bytes => { banner += bytes; });
    base = await waitFor(async () => banner.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], 8000);
  });

  after(async () => {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async <T>(path: string, body?: unknown, expect = [200, 201]): Promise<T> => {
    const res = await fetch(base + path, body === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.ok(expect.includes(res.status), `${path} returned HTTP ${res.status}: ${await res.clone().text()}`);
    return res.json() as Promise<T>;
  };
  const onboard = async (consent: Candidate['consent'], samples?: string[]) => {
    const { candidateId, runId } = await call<{ candidateId: string; runId: string }>('/api/candidates',
      { linkedinUrl: 'https://www.linkedin.com/in/fictional-asha', consent, samples });
    assert.match(runId, /^run_/);
    return waitFor(async () => {
      const candidate = await call<Candidate & { evidence: Evidence[] }>(`/api/candidates/${candidateId}`);
      assert.notEqual(candidate.status, 'failed');
      return candidate.status === 'ready' ? candidate : undefined;
    }, 20_000);
  };
  const all = { shareHistory: true, shareSkills: true, shareSamples: true, discoverable: true };

  test('rejects anything but a LinkedIn profile URL', async () => {
    await call('/api/candidates', { linkedinUrl: 'https://example.com/in/x', consent: all }, [400]);
    await call('/api/candidates', { linkedinUrl: 'https://www.linkedin.com/in/x1', consent: { shareHistory: true } }, [400]);
  });

  test('onboards, matches, and sends a candidate-requested intro exactly once', async () => {
    const candidate = await onboard(all, ['Built a feature store; mail me at someone@example.com']);
    assert.equal(candidate.displayName, 'Asha K.');
    assert.equal(candidate.fixture, true);
    assert.equal(candidate.roleFamily, 'ml_platform');
    assert.equal(candidate.parsedBy, 'rules');
    assert.match(candidate.fieldSource ?? '', /confirm each field/);
    assert.ok(candidate.skills.includes('Kubeflow'));
    assert.equal(candidate.history.length, 2);
    assert.deepEqual(candidate.samples, ['Built a feature store; mail me at [contact redacted]']);
    assert.ok(!JSON.stringify(candidate).includes('Kestrel'.concat('l')), 'no full fixture surname');
    assert.ok(candidate.evidence.length >= 4 && candidate.evidence.every(row => row.source.endpoint === '/person/enrich'));

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const read = db.prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'source.read'").get(candidate.runId);
    db.close();
    assert.match(String(read?.payload_json), /"endpoint":"person_enrich"/);

    await call(`/api/candidates/${candidate.id}/intros`, { openingId: 'op_orbit_mlp' }, [409]);
    const confirmed = await call<Candidate>(`/api/candidates/${candidate.id}/confirm`, {});
    assert.ok(confirmed.confirmedAt);

    const ranked = await call<OpeningForCandidate[]>(`/api/candidates/${candidate.id}/openings`);
    assert.deepEqual(ranked.map(row => row.id), ['op_orbit_mlp']);
    assert.ok(ranked[0].fit.some(reason => reason.status === 'verified' && reason.profileField === 'roleFamily'));
    assert.ok(ranked[0].fit.some(reason => reason.status === 'verified' && reason.evidenceId === 'ev_drain_a'));
    assert.ok(ranked[0].fit.some(reason => reason.status === 'cant_verify'));
    assert.ok(!('matchScore' in ranked[0]) && !('confidence' in ranked[0]), 'no bare scores leave the API');

    const preview = await call<IntroPreview>(`/api/candidates/${candidate.id}/intros/preview?openingId=op_orbit_mlp`);
    assert.deepEqual(preview.shared.map(field => field.field), ['displayName', 'title', 'skills', 'history']);
    assert.ok(preview.withheld.some(field => field.field === 'contact'));
    assert.equal((await call<{ stages: unknown[] }>('/api/openings/funnel')).stages.length, 1);

    await call(`/api/candidates/${candidate.id}/intros`, { openingId: 'op_kestrel_inf' }, [409]);
    const intro = await call<IntroRequest>(`/api/candidates/${candidate.id}/intros`, { openingId: 'op_orbit_mlp' });
    assert.equal(intro.direction, 'candidate_to_company');
    const ready = await waitFor(async () => {
      const rows = await call<IntroRequest[]>(`/api/candidates/${candidate.id}/intros`);
      const row = rows.find(item => item.id === intro.id);
      return row?.status === 'awaiting_approval' ? row : undefined;
    }, 20_000);
    assert.match(ready.message, /Hello Orbitline Fictional hiring team/);
    assert.match(ready.message, /DOMINO predicts an ML Platform Engineer opening at Orbitline Fictional after .+ in October 2026 \[1\]\. No .+ \[2\]/);
    assert.match(ready.message, /Asha K\. lists the current title ML Platform Engineer \[\d\]/);
    assert.ok(ready.evidenceIds?.includes('ev_drain_a'));
    assert.ok(!/managed GPU inference/.test(ready.message));

    const again = await call<IntroRequest>(`/api/candidates/${candidate.id}/intros`, { openingId: 'op_orbit_mlp' });
    assert.equal(again.id, intro.id, 'a repeated request reuses the intro');

    const first = await call<{ receipt?: { status: string } }>(`/api/approvals/${ready.approvalId}`, { decision: 'approve' });
    assert.equal(first.receipt?.status, 'delivered');
    const retry = await call<{ duplicate?: boolean }>(`/api/approvals/${ready.approvalId}`, { decision: 'approve' });
    assert.equal(retry.duplicate, true);
    const view = await call<CompanyView>('/api/companies/co_orbit');
    const sent = view.intros.find(item => item.id === intro.id);
    assert.equal(sent?.status, 'delivered');
    assert.equal(sent?.receipt?.idempotencyKey.length, 16);
    assert.ok(!/"(score|matchScore|confidence)"/.test(JSON.stringify({ openings: view.openings, matches: view.matches })));
    assert.deepEqual(await call(`/api/candidates/${candidate.id}/inbox`), [], 'candidate-requested intros are not inbox items');
  });

  test('company view: drain as role + initial, discoverable matches only, company-to-candidate intro reaches the inbox', async () => {
    const hidden = await onboard({ shareHistory: false, shareSkills: true, shareSamples: false, discoverable: false }, ['secret sample']);
    assert.deepEqual(hidden.history, []);
    assert.deepEqual(hidden.samples, []);
    assert.ok(hidden.evidence.every(row => !row.source.field?.startsWith('experience.')), 'no history evidence without consent');
    await call(`/api/candidates/${hidden.id}/confirm`, {});

    const summary = await call<CompanySummary[]>('/api/companies');
    assert.deepEqual(summary.map(row => [row.id, row.openings, row.departures90d]), [['co_orbit', 1, 2], ['co_kestrel', 0, 0]]);
    const view = await call<CompanyView>('/api/companies/co_orbit');
    assert.equal(view.runId, 'run_seed_openings');
    assert.deepEqual(view.departures.map(row => [row.role, row.initial, row.date]), [['ML Platform Engineer', 'R.', '2026-10-01'], ['ML Platform Engineer', 'T.', '2026-10-01']]);
    assert.ok(view.matches.length >= 1);
    assert.ok(view.matches.every(match => match.candidateId !== hidden.id), 'non-discoverable candidates stay hidden');
    assert.ok(view.evidence.some(row => row.id === 'ev_no_post'));
    await call('/api/companies/co_orbit/intros', { candidateId: hidden.id, openingId: 'op_orbit_mlp' }, [404]);

    const target = view.matches[0];
    const intro = await call<IntroRequest>('/api/companies/co_orbit/intros', { candidateId: target.candidateId, openingId: 'op_orbit_mlp' });
    assert.equal(intro.direction, 'company_to_candidate');
    const pending = await waitFor(async () => {
      const rows = await call<IntroRequest[]>(`/api/candidates/${target.candidateId}/intros`);
      return rows.find(row => row.id === intro.id && row.status === 'awaiting_approval');
    }, 20_000);
    assert.match(pending.message, /^Hello Asha K\.,/);
    assert.deepEqual(await call(`/api/candidates/${target.candidateId}/inbox`), [], 'nothing in the inbox before the send-once outbox delivers');
    const sent = await call<{ receipt?: { status: string } }>(`/api/approvals/${pending.approvalId}`, { decision: 'approve' });
    assert.equal(sent.receipt?.status, 'delivered');
    const inbox = await call<IntroRequest[]>(`/api/candidates/${target.candidateId}/inbox`);
    assert.deepEqual(inbox.map(row => [row.id, row.status]), [[intro.id, 'delivered']]);
    assert.ok(inbox[0].receipt?.receivedAt);

    const hiddenPreview = await call<IntroPreview>(`/api/candidates/${hidden.id}/intros/preview?openingId=op_orbit_mlp`);
    assert.deepEqual(hiddenPreview.shared.map(field => field.field), ['displayName', 'title', 'skills']);
    assert.ok(hiddenPreview.withheld.some(field => field.field === 'history'));
  });
});
