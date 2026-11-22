// FEATURE 6: ledger (credits, tokens, USD, per-run caps; per-call rows with live/cached/injected) as a tab and as
// the drawer the top bar's ledger total opens. Replace this placeholder.
import { closeLedger, useShell } from '../../shell/ui.ts';
import { Placeholder } from '../../shell/Placeholder.tsx';

export function LedgerTab() {
  return <Placeholder title="Ledger">Every paid call, its mode, credits, tokens and USD, against the caps.</Placeholder>;
}

export function LedgerDrawer() {
  const open = useShell((s) => s.ledgerOpen);
  if (!open) return null;
  return (
    <div role="dialog" aria-label="Cost ledger" style={{ position: 'fixed', inset: '64px 0 0 auto', width: 520, background: 'var(--panel)', borderLeft: '1px solid var(--line)', padding: 24, zIndex: 20 }}>
      <button className="btn small" onClick={closeLedger}>Close</button>
      <LedgerTab />
    </div>
  );
}
