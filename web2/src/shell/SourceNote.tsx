import type { Provenance } from '../data/desk.ts';

/** Says plainly where a panel's data came from when it isn't live, and what went wrong when a call failed. */
export function SourceNote({ source, error }: { source: Provenance | null; error: string | null }) {
  if (error) return <div className="banner bad" role="alert">Couldn’t load this: {error}. It retries when you reopen the page.</div>;
  if (source === 'fixture') return <div className="banner" data-testid="fixture-note">Fixture data: built from today’s live O1 result while this API is being finished. People appear only as role and initial.</div>;
  if (source === 'sample') return <div className="banner">Recorded run from 22 Nov, not live.</div>;
  return null;
}
