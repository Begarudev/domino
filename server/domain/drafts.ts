import sellerJson from '../../config/seller.json' with { type: 'json' };
import type { CascadeGraph, Company, Decider, Draft, DraftSentenceCheck, Evidence, Target, Trigger } from '../../shared/types.ts';
import { formatDay, isoDay, stableId } from './facts.ts';
import type { Claim, SellerProfile } from './types.ts';

const config = sellerJson as SellerProfile;
const markerPattern = /\[(\d+)\]/g;
const numberPattern = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?\b|\b\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}\b|[$€₹£]?\d+(?:[,.:]\d+)*(?:%|[kmb]\b)?/gi;
const tokens = (text: string) => [...new Set(text.replace(markerPattern, '').match(numberPattern) ?? [])];
const canonicalToken = (value: string) => value.toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');

function isPublicCompanyFact(row: Evidence) {
  if (row.source.provider !== 'crustdata' || !row.source.url) return false;
  const field = row.source.field ?? '';
  return field === '$.job_details.title' ||
    /^\$\.funding\.(?:last_|milestones\[)/.test(field) ||
    /^\$\.headcount\.(?:total$|timeseries(?:\[\d+\]\.employee_count)?$|growth_percent\.)/.test(field);
}

export function buildClaims(target: Target, company: Company, triggers: Trigger[], evidence: Evidence[], graph: CascadeGraph): Claim[] {
  if (target.companyId !== company.id || target.hold) return [];
  const own = new Set([
    ...company.evidenceIds,
    ...triggers.filter(trigger => trigger.companyId === company.id && ['job_post', 'post', 'headcount_jump', 'funding'].includes(trigger.kind))
      .flatMap(trigger => trigger.evidenceIds),
  ]);
  const supportsNeed = new Set(graph.edges.filter(edge => edge.to === company.id).flatMap(edge => edge.evidenceIds));
  const unique = new Map<string, Evidence>();
  for (const row of evidence) {
    if (!own.has(row.id) || !isPublicCompanyFact(row)) continue;
    // Shrinking headcount is a fact, but not one to open a first message with.
    if (row.source.field?.includes('growth_percent') && typeof row.value === 'number' && row.value <= 0) continue;
    const date = row.observedAt ?? '';
    const descriptiveKey = (row.source.field?.includes('headcount') ? 'headcount:' : '') + String(row.value ?? row.claim) + '|' + date;
    const existing = unique.get(descriptiveKey);
    if (!existing || (supportsNeed.has(row.id) && !supportsNeed.has(existing.id))) unique.set(descriptiveKey, row);
  }
  const rows = [...unique.values()].sort((a, b) => {
    const relevance = (row: Evidence) => Number(supportsNeed.has(row.id)) * 2 +
      Number(target.mechanisms.includes('DISPLACEMENT') && row.source.field === '$.job_details.title');
    return Number(b.verifiable && Boolean(b.observedAt)) - Number(a.verifiable && Boolean(a.observedAt)) ||
      relevance(b) - relevance(a) || (b.observedAt ?? '').localeCompare(a.observedAt ?? '') || a.id.localeCompare(b.id);
  });
  return rows.map((row, index) => {
    const text = row.claim.replace(/over ([136]|12)m through /g, (_, months: string) =>
      months === '1' ? 'in the month to ' : `in the ${months} months to `)
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, value => isoDay(value) ? formatDay(value) : value);
    return {
      n: index + 1, text, evidenceIds: [row.id], recipientCompany: company.name, sellerCompany: config.company,
      verifiable: row.verifiable && !!row.observedAt,
      reason: !row.observedAt ? 'The public record has no date for this fact.' : !row.verifiable ? 'The source could not be verified.' : undefined,
      numbers: tokens(text),
    };
  });
}

const SLOT_FORMAT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
});

function meetingCopy(seller: SellerProfile) {
  const slots = seller.meeting.slots.slice(0, 2).flatMap(slot => {
    const time = new Date(slot);
    return Number.isFinite(time.getTime()) ? [SLOT_FORMAT.format(time).replace(/\s+at\s+/i, ', ') + ' IST'] : [];
  });
  return `Would you have 20 minutes to discuss your plans${slots.length ? ' on ' + slots.join(' or ') : ''}?`;
}

function offerQuestion(offering: string, drain: boolean) {
  const offer = offering.replace(/[.!?]+$/, '');
  return drain && /inference/i.test(offer)
    ? `Are you planning to run serving in-house, or would ${offer} help?`
    : `Would ${offer} be useful for the work ahead?`;
}

function subjectLine(target: Target, company: string | undefined, offering: string) {
  const focus = target.mechanisms.includes('TALENT_DRAIN') ? 'Keeping inference capacity covered'
    : target.mechanisms.includes('DISPLACEMENT') ? 'Inference integration planning' : offering;
  return company ? `${focus} at ${company}` : focus;
}

// Greeting, meeting invitation and sign-off are fixed seller copy, added around the model's (verified) body.
export function draftFrame(decider: Decider | null, seller: SellerProfile) {
  return {
    greeting: decider ? 'Hi ' + decider.name.trim().split(/\s+/)[0] + ',' : 'Hi,',
    cta: meetingCopy(seller),
    signoff: 'Thanks,\n' + seller.senderName,
  };
}

export function templateDraft(target: Target, decider: Decider | null, claims: Claim[], seller: SellerProfile): Draft {
  const subject = subjectLine(target, claims.find(claim => claim.recipientCompany)?.recipientCompany, seller.offering);
  const greeting = decider ? 'Hi ' + decider.name.trim().split(/\s+/)[0] + ',' : 'Hi,';
  const pitch = offerQuestion(seller.offering, target.mechanisms.includes('TALENT_DRAIN'));
  const cta = meetingCopy(seller);
  const signoff = 'Thanks,\n' + seller.senderName;
  const lines = [greeting, pitch, cta, signoff];
  const wordCount = (value: string) => value.trim().split(/\s+/).length;
  const room = 110 - wordCount(lines.join(' '));
  const included: Claim[] = [];
  let remaining = room;
  for (const claim of claims.filter(item => item.verifiable && item.evidenceIds.length)) {
    if (included.length >= 2) break;
    const words = wordCount(claim.text) + 1;
    if (words > remaining) continue;
    included.push(claim);
    remaining -= words;
  }
  const cited = included.map(claim => claim.text.replace(/[.!?]+$/, '') + '. [' + claim.n + ']');
  const body = target.hold ? '' : [greeting, ...(cited.length ? [cited.join(' ')] : []), pitch, cta, signoff].join('\n\n');
  const checks: DraftSentenceCheck[] = [
    { sentence: greeting, status: 'no_claim', evidenceIds: [] },
    ...included.map((claim, i): DraftSentenceCheck => ({ sentence: cited[i], status: 'cited', evidenceIds: claim.evidenceIds })),
    ...lines.slice(1).map((sentence): DraftSentenceCheck => ({ sentence, status: 'no_claim', evidenceIds: [] })),
  ];
  return {
    id: stableId('dr_', target.companyId, decider?.personId ?? '', body), companyId: target.companyId, personId: decider?.personId ?? null,
    subject, body, citations: included.flatMap(claim => claim.evidenceIds.map(evidenceId => ({ marker: claim.n, evidenceId }))),
    checks, unverifiable: claims.filter(claim => !claim.verifiable).map(claim => ({
      claim: claim.text, reason: claim.reason || 'No dated evidence was supplied.',
    })),
    generator: 'template', verified: !target.hold,
    meeting: { title: seller.meeting.title, durationMin: 20, proposedSlots: [...seller.meeting.slots] },
  };
}

export function llmDraftPrompt(target: Target, decider: Decider | null, claims: Claim[], seller: SellerProfile): { system: string; user: string } {
  const usable = claims.filter(claim => claim.verifiable && claim.evidenceIds.length);
  return {
    system: 'Write the middle of a first outreach email, 70 words or fewer. Return JSON with subject and body. The body has NO greeting, NO meeting invitation and NO sign-off: the system adds those. State factual sentences only from the numbered public facts about the recipient, preserving their numbers and dates exactly, and put each sentence’s [n] citations at its end. Use at most two facts and pick the ones that best show why now. Write like a person, not a report: no percentages with decimals beyond one place, no ISO dates. Then ask about the seller’s offer as one question, using the supplied question or a close variant. Do not mention engineers moving, departure counts, outside companies, inferred needs as facts, or any unlisted fact.',
    user: [
      `Recipient ${decider?.name ?? 'company team'} at ${claims.find(claim => claim.recipientCompany)?.recipientCompany ?? 'the target company'}.`,
      `Suggested subject ${subjectLine(target, claims.find(claim => claim.recipientCompany)?.recipientCompany, seller.offering)}.`,
      `Seller ${seller.company}, offering ${seller.offering}, sender ${seller.senderName}.`,
      offerQuestion(seller.offering, target.mechanisms.includes('TALENT_DRAIN')),
      meetingCopy(seller),
      'Numbered facts:',
      ...usable.map(claim => `[${claim.n}] ${claim.text}`),
    ].join('\n'),
  };
}

const sentenceBreaks = new Intl.Segmenter('en', { granularity: 'sentence' });

function splitSentences(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split(/\n/)) {
    for (const { segment } of sentenceBreaks.segment(line.trim())) {
      let sentence = segment.trim();
      const markers = sentence.match(/^(?:\[\d+\]\s*)+/)?.[0];
      if (markers && parts.length) {
        parts[parts.length - 1] += ' ' + markers.trim();
        sentence = sentence.slice(markers.length);
      }
      if (sentence) parts.push(sentence);
    }
  }
  return parts;
}

function permittedCopy(sentence: string, names: string[]) {
  if (/^(?:(?:hi|hello|dear)(?:\s+[^.!?\d,]+)?|(?:thanks|thank you|best|regards|cheers|sincerely|warmly)),?$/i.test(sentence)) return true;
  if ([config.senderName, meetingCopy(config), offerQuestion(config.offering, true),
    offerQuestion(config.offering, false)].includes(sentence)) return true;
  if (/^(?:would (?:you|it)|could we|are you open to|do you have|can we)\b[^.!?]*\?$/i.test(sentence) &&
      !/\b(?:since|recently|raised|founded|grew|hired|left|moved|posted|employees|engineers|million|billion)\b/i.test(sentence) &&
      tokens(sentence).every(value => value === '20' || tokens(meetingCopy(config)).includes(value))) return true;
  if (/^(?:I hope you(?:'re|’re| are) well|Hope you(?:'re|’re| are) well|Thanks for your time)[.!]?$/i.test(sentence)) return true;
  if (sentence === `We offer ${config.offering}.` || sentence === config.oneLiner) return true;
  return names.includes(sentence.trim());
}

const sentenceStarters = new Set(['A', 'An', 'And', 'As', 'At', 'Could', 'Do', 'For', 'From', 'Have', 'Here', 'I',
  'If', 'In', 'It', 'Let', 'May', 'Our', 'Please', 'See', 'That', 'The', 'Their', 'They', 'This', 'To',
  'We', 'What', 'Would', 'You', 'Your']);

function properWords(sentence: string) {
  const text = sentence.replace(markerPattern, '');
  return [...text.matchAll(/\b\p{Lu}[\p{L}'’-]*/gu)].flatMap(word =>
    sentenceStarters.has(word[0]) && (word.index ?? 0) <= 2 ? [] : [word[0]]);
}

function factual(sentence: string, names: string[]) {
  if (tokens(sentence).length) return true;
  let text = sentence;
  for (const name of names) {
    if (name) text = text.replaceAll(name, ' ');
  }
  return properWords(text).length > 0 ||
    /\b(?:raised|hired|founded|acquired|reported|posted|announced|reached|grew|deployed|poached|departed|moved)\b/i.test(text);
}

function claimWordingAllowed(sentence: string, claims: Claim[], names: string[]) {
  if (/\b(?:engineers? (?:left|departed|moved)|left for|poached|departures?)\b/i.test(sentence)) return false;
  const words = new Set([...claims.flatMap(claim => properWords(claim.text)), ...names.flatMap(properWords),
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
    'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  return properWords(sentence).every(word => words.has(word));
}

export function verifyDraft(draft: { subject: string; body: string }, claims: Claim[], evidence: Evidence[]):
  Pick<Draft, 'body' | 'citations' | 'checks' | 'unverifiable' | 'verified'> {
  const rows = new Map(evidence.map(row => [row.id, row]));
  const claimRows = new Map(claims.map(claim => [claim.n, claim]));
  const approved = (claim: Claim) => claim.verifiable && claim.evidenceIds.length > 0 &&
    claim.evidenceIds.every(id => {
      const row = rows.get(id);
      return Boolean(row?.verifiable && row.observedAt);
    });
  const allowed = new Map(claims.filter(approved).map(claim => [claim.n, claim]));
  const names = [...new Set([config.company, ...claims.flatMap(claim => [claim.recipientCompany, claim.sellerCompany]).filter((name): name is string => Boolean(name))])];
  const citations = new Map<string, Draft['citations'][number]>();
  const checks: DraftSentenceCheck[] = [];
  let signoff = false;
  const body = draft.body.split(/\n\s*\n/).map(paragraph => splitSentences(paragraph).flatMap(sentence => {
    const markers = [...new Set([...sentence.matchAll(markerPattern)].map(match => Number(match[1])))];
    const numbers = tokens(sentence);
    const evidenceIds = [...new Set(markers.flatMap(marker => allowed.get(marker)?.evidenceIds ?? []))];
    const citedNumbers = new Set(markers.flatMap(marker => allowed.get(marker)?.numbers ?? []).map(canonicalToken));
    const citedClaims = markers.flatMap(marker => allowed.get(marker) ?? []);
    if (markers.length && citedClaims.length === markers.length && numbers.every(value => citedNumbers.has(canonicalToken(value))) &&
      claimWordingAllowed(sentence, citedClaims, names)) {
      checks.push({ sentence, status: 'cited', evidenceIds });
      for (const marker of markers) for (const evidenceId of allowed.get(marker)!.evidenceIds) {
        citations.set(marker + ':' + evidenceId, { marker, evidenceId });
      }
      signoff = false;
      return [sentence];
    }
    const sender = signoff && /^[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,2}$/u.test(sentence);
    signoff = /^(?:thanks|best|regards|cheers|sincerely|warmly),?$/i.test(sentence);
    if (!markers.length && (sender || permittedCopy(sentence, names) || !factual(sentence, names))) {
      checks.push({ sentence, status: 'no_claim', evidenceIds: [] });
      return [sentence + (signoff ? '\n' : '')];
    }
    checks.push({
      sentence, status: 'removed', evidenceIds: [],
      note: markers.some(marker => claimRows.has(marker) && !allowed.has(marker)) ? 'Cited evidence is unverified or undated.'
        : 'A factual sentence needs valid citations for its facts and number or date tokens.',
    });
    return [];
  }).join(' ').replace(/\n /g, '\n').trim()).filter(Boolean).join('\n\n');
  const unverifiable = claims.filter(claim => !approved(claim)).map(claim => ({
    claim: claim.text, reason: claim.reason || 'The claim has no complete and verifiable dated evidence.',
  }));
  return { body, citations: [...citations.values()], checks, unverifiable, verified: true };
}
