import type { ReactNode } from 'react';

/** Marks a feature slot not built yet. Feature agents replace the component that renders this. */
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="placeholder" data-testid="placeholder">
      <strong>{title}</strong>
      <span>{children ?? 'Being built.'}</span>
    </div>
  );
}
