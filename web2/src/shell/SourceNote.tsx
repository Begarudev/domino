import type { Provenance } from '../data/desk.ts';

/** One quiet line under a page title: where the rows came from when they aren't live, or what failed. */
export function SourceNote({ source, error, onRetry }: { source: Provenance | null; error: string | null; onRetry?: () => void }) {
  if (error) {
    return (
      <p className="src-note bad" role="alert">
        Couldn’t load this: {error}.{onRetry && <> <button className="linkish" onClick={onRetry}>Try again</button></>}
      </p>
    );
  }
  if (source === 'fixture') return <p className="src-note" data-testid="fixture-note">Snapshot rows from today’s live O1 scan (22 Nov). People appear as role and initial only.</p>;
  if (source === 'sample') return <p className="src-note">Recorded run from 22 Nov, not live.</p>;
  return null;
}
