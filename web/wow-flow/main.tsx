// Standalone harness for the talent-flow centrepiece (fixture data).
//   ?slot=1        render at the app's slot size (780x540) instead of full window
//   ?s=12.5        start paused at story second 12.5 (for screenshots)
//   ?filter=1      hiring-filter view     ?speed=1.5   playback speed
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Selection } from '../src/centrepiece/contract.ts';
import { TalentFlow } from '../src/centrepiece/flow/TalentFlow.tsx';
import { FIXTURE_LAYOUT, FIXTURE_SNAPSHOT } from '../src/centrepiece/flow/fixture.ts';

const q = new URLSearchParams(location.search);

function App() {
  const slot = q.get('slot') === '1';
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  const [sel, setSel] = useState<Selection | null>(null);
  useEffect(() => {
    const on = () => setSize({ w: innerWidth, h: innerHeight });
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  const w = slot ? 780 : size.w, h = slot ? 540 : size.h;
  const s = q.get('s');
  return (
    <TalentFlow
      snapshot={FIXTURE_SNAPSHOT} events={[]} running={false} selection={sel}
      onSelect={(x) => { setSel(x); if (x) console.log('select', x); }}
      hiringFilterView={q.get('filter') === '1'}
      reducedMotion={q.get('reduced') === '1' || matchMedia('(prefers-reduced-motion: reduce)').matches}
      width={w} height={h} replayToken={0}
      layoutHints={FIXTURE_LAYOUT}
      initialS={s !== null ? Number(s) : undefined}
      speed={q.get('speed') ? Number(q.get('speed')) : 1}
    />
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
setTimeout(() => (document.querySelector('.tf-root') as HTMLElement | null)?.focus(), 50);
