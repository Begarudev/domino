import { useState } from 'react';
import type { Ask } from '../../../shared/types.ts';

export function AskCard(props: { ask: Ask; busy: boolean; onAnswer: (answer: string) => void }) {
  const { ask } = props;
  const [choice, setChoice] = useState(ask.default);
  return (
    <div className="ask" role="dialog" aria-labelledby="ask-q">
      <p className="ask-kind">One question before DOMINO continues</p>
      <h3 id="ask-q">{ask.question}</h3>
      <p className="ask-why">{ask.why}</p>
      <div className="ask-options" role="radiogroup" aria-label="Answers">
        {ask.options.map((o) => (
          <button key={o} type="button" role="radio" aria-checked={choice === o} className={`chip${choice === o ? ' is-on' : ''}`} onClick={() => setChoice(o)}>
            {o}{o === ask.default ? <span className="chip-note">default</span> : null}
          </button>
        ))}
      </div>
      <div className="ask-actions">
        <button type="button" className="btn btn-primary btn-sm" disabled={props.busy} onClick={() => props.onAnswer(choice)}>Answer and continue</button>
        <span className="muted">If nobody answers, the default is used.</span>
      </div>
    </div>
  );
}
