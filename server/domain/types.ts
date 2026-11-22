// Domain-internal types shared by the data layer (server/crustdata, server/domain) and the engine (server/engine).
import type { Company, DataMode, Evidence, GraphNode, IsoDate, IsoDateTime, Person, Trigger } from '../../shared/types.ts';

// A company as seen in ONE response, before entity resolution. `key` is unique per mention.
export interface CompanyMention {
  key: string;                          // e.g. 'job_search:123:company' — stable for the same raw record
  name: string;
  domain?: string | null;
  linkedinUrl?: string | null;
  crustdataId?: number | string | null;
  industry?: string | null;
  categories?: string[];
  headcount?: number | null;
  headcountGrowthPct?: Company['headcountGrowthPct'];
  hq?: string | null;
  foundedYear?: number | null;
  lastFunding?: Company['lastFunding'];
  acquisitions?: AcquisitionEvent[];
  ambiguousIdentity?: boolean;
  competitorDomains?: string[];         // detected competitor domains, matched against resolved entities
  firmographicsAsOf?: IsoDate | null;   // dated snapshot preferred over undated firmographics
  competitorNames?: string[];           // peers/competitors as named by the source
  evidenceIds: string[];
}

export interface AcquisitionEvent {
  acquirer: string;
  acquired: string;
  acquirerId?: number | string | null;
  acquiredId?: number | string | null;
  date: IsoDate | null;
  sourceUrl?: string;
  fixtureOnly?: boolean;
}

export interface ResolvedCompany extends Company {
  categories?: string[];
  acquisitions?: AcquisitionEvent[];
  ambiguousIdentity?: boolean;
}

export interface MoveTrigger extends Trigger {
  move?: {
    currentTitle: string;
    previousTitle?: string | null;
    datePrecision: 'day' | 'month';
    startInterval?: [IsoDate, IsoDate];
    previousEndInterval?: [IsoDate, IsoDate];
  };
}

export interface ReasonedNode extends GraphNode {
  whyNow?: string;
  whyNowDate?: IsoDate | null;
  hold?: { reasons: string[] };
  watch?: { reason: string };
}

// A person as seen in ONE response. Minimal personal data only.
export interface PersonMention {
  key: string;
  name: string;
  title: string;
  companyKey: string | null;            // CompanyMention.key of the current employer
  linkedinUrl?: string | null;
  startedAt?: IsoDate | null;
  pastEmployers: Person['pastEmployers'];   // companyId here holds a CompanyMention.key when known
  evidenceIds: string[];
}

// Before resolve_entities, Trigger.companyId / relatedCompanyId / personId hold mention KEYS;
// the engine remaps them with the idMap returned by resolveEntities.
export interface TriggerBatch {
  mentions: CompanyMention[];
  people: PersonMention[];
  triggers: Trigger[];
  evidence: Evidence[];
}

// One sentence-sized fact the drafter may use. Only claims with verifiable evidence may appear in a message body.
export interface Claim {
  n: number;                            // citation marker number, 1-based
  text: string;                         // "3 of your ML infrastructure engineers joined Gamma Agents since 4 Sep"
  evidenceIds: string[];
  verifiable: boolean;                  // false => goes to Draft.unverifiable, never into the body
  reason?: string;                      // why not verifiable
  recipientCompany?: string;
  sellerCompany?: string;
  numbers: string[];                    // every number/date token the sentence may contain (checked by verifyDraft)
}

export interface SellerProfile {
  company: string;                      // the vendor DOMINO works for (demo profile)
  offering: string;                     // "managed GPU inference"
  oneLiner: string;
  senderName: string;                   // who signs the message
  team: { name: string; pastEmployers: { name: string; from?: IsoDate | null; to?: IsoDate | null }[] }[];
  customers: string[];                  // existing accounts (warm-path signal)
  meeting: { title: string; durationMin: number; slots: IsoDateTime[] };
  acquisitionEvents?: AcquisitionEvent[];
  companyFamilies?: { parent: string; members: string[] }[];
  displacementEvents: { provider: string; product: string; kind: 'acquired' | 'shutdown' | 'repriced'; date: IsoDate; sourceUrl: string; note: string; fixtureOnly?: boolean }[];
}

// Replay outcome fact: a dated sign, AFTER asOf, that a company showed the need.
export interface OutcomeFact {
  companyKey: string;                   // mention key or canonical id (engine maps to canonical)
  date: IsoDate;
  kind: 'job_post' | 'hire';
  title?: string;
  summary: string;
  evidenceIds: string[];
}

export interface ParseMeta {
  mode: DataMode;
  retrievedAt: IsoDateTime;
  asOf: IsoDate;
  windowDays: number;
  endpoint: string;                     // e.g. '/job/search'
}

export class NonsenseError extends Error {
  detail: string;
  constructor(detail: string) { super(`tool returned nonsense: ${detail}`); this.detail = detail; }
}
