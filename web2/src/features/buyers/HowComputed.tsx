// "How this is computed": a small info disclosure naming the API endpoint, the rule and the data source behind a
// section, so every number on Find buyers, Outreach, Verifier and Chains is explainable. Native <details>, no deps.
import './how.css';

export function HowComputed({ endpoint, rule, source }: { endpoint: string; rule: string; source: string }) {
  return (
    <details className="how" onClick={(e) => e.stopPropagation()}>
      <summary aria-label="How this is computed" title="How this is computed">i</summary>
      <dl className="how-pop">
        <dt>Reads</dt><dd className="mono">{endpoint}</dd>
        <dt>Rule</dt><dd>{rule}</dd>
        <dt>Source</dt><dd>{source}</dd>
      </dl>
    </details>
  );
}
