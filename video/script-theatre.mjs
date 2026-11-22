// Pipeline check edit on the Outbound-Desk theatre take (pre-pivot UI). Not the submission script.
export function beats({ facts, has }) {
  const f = facts.main;
  const live = { kind: f.counts?.liveCalls ? 'live' : 'cache', text: f.counts?.liveCalls ? 'Live Crustdata, recorded today' : 'Cached live responses' };
  const T = 6;
  return [
    { card: { kicker: 'The paid job', title: 'Search firms earn their fee when a person starts the job.', sub: 'DOMINO does the search work itself, and proves every claim with a dated source.' }, dur: 5 },
    { take: 'main', from: 'type-start', to: 'plan', speed: 2, band: { step: 1, total: T, stepLabel: 'Request', headline: 'A request it has never seen, typed live.', sub: 'Before spending anything, DOMINO shows its plan, a credit cap and a deadline.', pills: [{ kind: 'speed', text: '2x' }] } },
    { take: 'main', from: 'theatre', to: 'kill', speed: 2, band: { step: 2, total: T, stepLabel: 'Live reads', headline: 'DOMINO reads live company, people and job-post data.', sub: 'Every call is metered against hard caps: credits, model dollars, seconds.', pills: [{ kind: 'speed', text: '2x' }, live] } },
    has('main', 'resume') && { take: 'main', from: { mark: 'kill', off: -0.5 }, to: { mark: 'resume', off: 3 }, speed: 1, band: { step: 2, total: T, stepLabel: 'Robustness', headline: 'We kill the engine mid-run.', sub: 'It resumes from its last checkpoint and repeats no paid calls.', pills: [{ kind: 'fault', text: 'Injected fault' }] } },
    { take: 'main', from: 'gate-ready', to: 'gate-end', speed: 1, band: { step: 5, total: T, stepLabel: 'Send once', headline: 'A person approves. It is delivered once.', sub: 'Approving twice is refused by the same idempotency key.', pills: [live] } },
    has('main', 'already') && { take: 'main', from: 'already', to: { mark: 'already', off: 3 }, speed: 1, band: { step: 5, total: T, stepLabel: 'Send once', headline: 'Sender killed after delivery, then retried: "already delivered, skipped".', sub: 'The team inbox received exactly one message.', pills: [{ kind: 'fault', text: 'Injected fault' }] } },
    { card: { title: 'Every claim dated. Nothing sent twice.', sub: 'DOMINO, The Search Desk' }, dur: 4 },
  ];
}
