// Drives the real DOMINO app through the video script and records it (CDP screencast via Playwright).
//   node video/capture.mjs main   --base http://127.0.0.1:4400 --out video/out/main [--request "..."]
//   node video/capture.mjs replay --base http://127.0.0.1:4400 --out video/out/replay
// Output per take: frames/*.jpg + frames.json (screencast timestamps), marks.json, facts.json.
// Capture order is not edit order: assemble.mjs cuts segments between marks and reorders them.
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openStudio, api, waitRun } from './lib.mjs';

const argv = process.argv.slice(2);
const take = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'main';
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[i + 1] ?? true;
const BASE = args.base || 'http://127.0.0.1:4400';
const OUT = resolve(args.out || `video/out/${take}`);
const REQUEST = args.request ||
  'We rent GPU clusters for LLM inference and fine-tuning. Which AI startups just lost the engineers who run their models, or saw their inference provider change? Book me with whoever owns infra.';
const CAP = Number(args.cap || 600);

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const S = await openStudio(OUT, { headless: !args.headed });
const { page } = S;
// Watchdog: never leave a hung browser recording forever.
const watchdog = setTimeout(async () => { console.error('watchdog: capture over time'); facts.error = 'watchdog'; writeFileSync(join(OUT, 'facts.json'), JSON.stringify(facts, null, 1)); await S.stop().catch(() => {}); process.exit(2); }, Number(args.maxmin || 9) * 60_000);
const facts = { take, base: BASE, capturedAt: new Date().toISOString(), request: take === 'main' ? REQUEST : undefined };
const terminal = s => !['running', 'queued', 'awaiting_input'].includes(s);

// Privacy: people appear as first name + last initial ("Alex Z"), matching the theatre. Companies stay named.
async function maskPeople(id) {
  const snap = await api(BASE, `/api/runs/${id}`);
  const pairs = snap.people.map(p => p.name).filter(n => n && n.includes(' '))
    .map(n => { const parts = n.trim().split(/\s+/); return [n, `${parts[0]} ${parts.at(-1)[0]}`]; });
  await page.addInitScript(pairs => { window.__maskPairs = pairs; }, pairs);
  const install = pairs => {
    window.__maskPairs = pairs;
    const fix = node => {
      if (node.nodeType === 3) {
        let t = node.nodeValue, c = false;
        for (const [a, b] of window.__maskPairs) if (t.includes(a)) { t = t.split(a).join(b); c = true; }
        if (c) node.nodeValue = t;
      } else node.childNodes?.forEach(fix);
    };
    fix(document.body);
    if (!window.__maskObs) {
      const opts = { childList: true, subtree: true, characterData: true };
      const obs = new MutationObserver(ms => {
        obs.disconnect();
        ms.forEach(m => { m.addedNodes.forEach(fix); if (m.type === 'characterData') fix(m.target); });
        obs.observe(document.body, opts);
      });
      window.__maskObs = obs;
      obs.observe(document.body, opts);
    }
  };
  await page.evaluate(install, pairs).catch(() => {});
  return () => page.evaluate(install, pairs).catch(() => {});
}

// The send-once beat needs the sender killed right after the inbox accepts. That fault is injected here and the app
// logs it ("Injected dispatcher SIGKILL after the test inbox accepted the message"); it is captioned as injected.
async function injectRunOptions() {
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() || '{}');
    body.chaos = { ...(body.chaos || {}), crashAfterDeliver: true };
    body.limits = { maxCredits: CAP, ...(body.limits || {}) };
    await route.continue({ postData: JSON.stringify(body) });
  });
}

async function pollSteps(id, until, onTick) {
  let last = null;
  for (;;) {
    const snap = await api(BASE, `/api/runs/${id}`);
    const running = snap.steps.find(s => s.status === 'running')?.step ?? null;
    if (running !== last) { S.mark(`step:${running ?? snap.status}`); last = running; }
    if (onTick) await onTick(snap, running);
    if (until(snap)) return snap;
    await S.hold(500);
  }
}

async function mainTake() {
  await injectRunOptions();
  await page.goto(`${BASE}/?chaos`);
  await S.start();
  await S.hold(1500);
  S.mark('landing');

  // 1. A request it has never seen, typed live; the landing reveals plan, credit cap and window.
  await S.click(page.locator('#ld-req'));
  S.mark('type-start');
  await page.keyboard.type(REQUEST, { delay: 24 });
  S.mark('type-end');
  await S.hold(600);
  const resp = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await S.click(page.getByRole('button', { name: /Start the run/ }));
  S.mark('start');
  const { id } = await (await resp).json();
  facts.runId = id;
  await page.locator('.ld-go').waitFor({ timeout: 30_000 }).catch(() => {});
  await S.hold(3800);
  S.mark('plan');

  // 2. The theatre on the same run: live reads, ledger, caps. Kill the engine mid-run, resume from checkpoint.
  await page.goto(`${BASE}/?view=theatre&run=${id}`);
  S.mark('theatre');
  let killed = false, resumed = false;
  await pollSteps(id, s => terminal(s.status) && s.status !== 'crashed' && resumed, async (snap, running) => {
    if (!killed && ['enrich_companies', 'cascade', 'resolve_entities', 'pull_triggers'].includes(running) && Date.now() / 1000 - S.marks.find(m => m.name === 'theatre').t > 2.5) {
      const kill = page.locator('.mc-kill');
      if (await kill.isEnabled().catch(() => false)) {
        await S.click(kill); S.mark('kill'); killed = true;
        const resumeBtn = page.locator('.mc-crash__resume:visible, .mc-resume:visible').first();
        await resumeBtn.waitFor({ timeout: 15_000 }).catch(() => {});
        await S.hold(2600);
        await S.click(resumeBtn); S.mark('resume'); resumed = true;
        await S.hold(1500);
        const after = await api(BASE, `/api/runs/${id}`);
        if (after.status === 'crashed') { facts.resumeViaApi = true; await api(BASE, `/api/runs/${id}/resume`, { method: 'POST' }); }
      }
    }
    if (!killed && terminal(snap.status)) { killed = resumed = true; facts.killSkipped = 'run finished before a kill window'; }
  });
  S.mark('run-done');
  let snap = await api(BASE, `/api/runs/${id}`);
  const name = cid => snap.companies.find(c => c.id === cid)?.name ?? cid;

  // 4. The gate: the message assembles; unsourced sentences are struck out; "I can't verify".
  const hold = page.locator('.mc-hold');
  await hold.waitFor({ timeout: 30_000 });
  S.mark('gate');
  for (let i = 0; i < 40 && !(await hold.isEnabled()); i++) await S.hold(250);
  S.mark('gate-ready');
  await S.hold(1500);

  // 5. Approve (hold), sealed, one message in the team test inbox; approving twice is refused.
  const b = await hold.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 24 });
  await S.hold(300);
  S.mark('approve');
  await page.mouse.down(); await S.hold(1500); await page.mouse.up();
  await page.locator('.mc-gate__strip').waitFor({ timeout: 20_000 }).catch(() => {});
  S.mark('sealed');
  await S.hold(2200);
  const again = page.locator('.mc-again');
  if (await again.count()) { await S.click(again); S.mark('twice'); await S.hold(3200); }
  S.mark('gate-end');

  snap = await api(BASE, `/api/runs/${id}`);
  facts.status = snap.status; facts.dataMode = snap.dataMode; facts.budget = snap.budget;
  facts.counts = {
    companies: snap.companies.length, people: snap.people.length, triggers: snap.triggers.length,
    evidence: snap.evidence.length, dated: snap.evidence.filter(e => e.observedAt).length, targets: snap.targets.length,
    drafts: snap.drafts.length, ledgerRows: snap.ledger.length,
    crustdataCalls: snap.ledger.filter(l => l.provider === 'crustdata').length,
    liveCalls: snap.ledger.filter(l => l.provider === 'crustdata' && l.mode === 'live').length,
    cachedCalls: snap.ledger.filter(l => l.mode === 'cache').length,
    modelCalls: snap.ledger.filter(l => l.mode === 'model').length,
    injected: snap.ledger.filter(l => l.injected).length, retries: snap.ledger.filter(l => l.attempt > 1).length,
    missedByHiringFilter: snap.targets.filter(t => t.netNew).length,
    watch: snap.targets.filter(t => t.hold || t.watch).map(t => ({ company: name(t.companyId), why: t.whyNow })),
    outbox: snap.outbox.length,
  };
  const ct = snap.targets.find(t => !t.hold && !t.watch && t.mechanisms.some(m => !['DIRECT', 'CAPITAL'].includes(m)) && t.decider)
    ?? snap.targets.find(t => t.decider) ?? snap.targets[0];
  const edge = snap.graph.edges.filter(e => e.to === ct.companyId).sort((a, b) => b.confidence - a.confidence)[0];
  const dr = snap.drafts.find(d => d.companyId === ct.companyId);
  facts.chain = {
    company: name(ct.companyId), mechanisms: ct.mechanisms, need: ct.need, confidence: ct.confidence, whyNow: ct.whyNow, whyNowDate: ct.whyNowDate,
    decider: ct.decider?.title, netNew: ct.netNew,
    edge: edge && { from: name(edge.from), to: name(edge.to), mechanism: edge.mechanism, rationale: edge.rationale, alternative: edge.alternative, evidence: edge.evidenceIds.length },
    draft: dr && { subject: dr.subject, cited: dr.checks.filter(c => c.status === 'cited').length, removed: dr.checks.filter(c => c.status === 'removed').length, unverifiable: dr.unverifiable.map(u => u.claim), generator: dr.generator },
  };
  const gateCo = await page.locator('.mc-gate__striptext span').first().innerText().catch(() => '');
  facts.gateText = gateCo;

  // 3b. Classic view of the same run: the chain's evidence, "could also mean", a source re-checked live,
  // and the approval receipt that reads "Already delivered, skipped".
  await page.goto(`${BASE}/?run=${id}&tab=targets`);
  const remask = await maskPeople(id);
  await page.locator('.target').first().waitFor({ timeout: 20_000 });
  await S.hold(1200);
  S.mark('classic');
  await S.click(page.locator('.target', { hasText: name(ct.companyId) }).first());
  await S.hold(700);
  const drawer = page.locator('.drawer');
  await S.zoomTo(drawer, { fill: 0.96, max: 1.9 });
  S.mark('chain-drawer');
  await S.hold(2600);
  const link = drawer.locator('.drawer-link').first();
  if (await link.count()) { await S.click(link); S.mark('edge'); await S.hold(3200); }
  const ev = drawer.locator('.ev').first();
  const recheck = ev.getByRole('button');
  if (await recheck.count()) { await S.click(recheck); S.mark('recheck'); await S.hold(2600); }
  facts.firstEvidence = await ev.innerText().catch(() => '');
  await S.unzoom(600);

  // The sent draft's approval card shows the receipt from the retried delivery.
  const sentCo = snap.outbox[0] ? name(snap.approvals.find(a => a.id === snap.outbox[0].approvalId)?.companyId) : name(ct.companyId);
  facts.sentCompany = sentCo;
  await S.click(page.getByRole('button', { name: /^Drafts/ }).first());
  await S.hold(600);
  await S.click(page.locator('.draft-tab', { hasText: sentCo }).first()).catch(() => {});
  await S.hold(800);
  const cite = page.locator('.draft-body .cite-chip').first();
  await S.zoomTo(page.locator('.draft-main'), { fill: 0.92, max: 1.8 });
  S.mark('draft');
  if (await cite.count()) { await S.click(cite); S.mark('cite'); await S.hold(2400); }
  await S.unzoom(500);
  await S.zoomTo(page.locator('.approvals'), { fill: 0.85, max: 2.2 });
  S.mark('already');
  await S.hold(3200);
  facts.approvalNotes = await page.locator('.approval-note').allInnerTexts();
  await S.unzoom(500);

  // Watchlist rows (2 of 3), if this build has them.
  await S.click(page.getByRole('button', { name: /^Ranked targets/ }).first());
  await S.hold(700);
  const watch = page.locator('.target.is-watch, .target.is-held, [data-watch], .watch');
  if (await watch.count()) {
    await S.zoomTo(page.locator('.targets'), { fill: 0.92, max: 1.8 });
    S.mark('watch');
    await S.click(watch.first());
    await S.hold(3500);
    facts.watchText = await watch.first().innerText().catch(() => '');
    await S.unzoom();
  }

  // Cost ledger, for the close.
  await S.click(page.getByRole('button', { name: /^Cost ledger/ }).first());
  await S.hold(900);
  S.mark('ledger');
  await S.hold(3000);
  snap = await api(BASE, `/api/runs/${id}`);
  facts.ledgerFinal = snap.budget;
  facts.outboxFinal = snap.outbox.length;
  S.mark('end');
  await S.hold(600);
}

async function replayTake() {
  await injectRunOptions();
  await page.goto(`${BASE}/?view=theatre&run=${args.after || ''}`);
  await S.start();
  await S.hold(1500);
  S.mark('theatre');
  const resp = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
  await S.click(page.getByRole('button', { name: /Replay 1 Sep/ }));
  S.mark('replay-start');
  const { id } = await (await resp).json();
  facts.runId = id;
  await pollSteps(id, s => !!s.replay || terminal(s.status));
  S.mark('scored');
  await page.locator('.mc-score, [class*=score]').first().waitFor({ timeout: 20_000 }).catch(() => {});
  await S.hold(14_000);
  S.mark('board');
  await S.hold(5000);
  const snap = await api(BASE, `/api/runs/${id}`);
  facts.replay = snap.replay; facts.dataMode = snap.dataMode; facts.budget = snap.budget;
  S.mark('end');
  await S.hold(500);
}

try {
  if (take === 'replay') await replayTake(); else await mainTake();
} catch (e) {
  facts.error = String(e.stack || e);
  console.error(e);
  await page.screenshot({ path: join(OUT, 'error.png') }).catch(() => {});
} finally {
  writeFileSync(join(OUT, 'facts.json'), JSON.stringify(facts, null, 1));
  await S.stop();
  clearTimeout(watchdog);
}
