// Two charts over the run's real ledger rows: new credits by endpoint, and calls by step with average latency.
// Clicking a bar filters the calls grid below to that endpoint or step; clicking it again clears the filter.
import { useMemo } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import type { LedgerEntry } from '../../../../shared/types.ts';
import { fmtCredits, fmtInt, fmtSeconds } from '../../lib/format.ts';

export type ChartPick = { kind: 'endpoint' | 'step'; value: string } | null;

const tok = (name: string, fallback: string) =>
  (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

function base(onPick: (i: number) => void): ApexOptions {
  return {
    chart: {
      type: 'bar', toolbar: { show: false }, animations: { enabled: false }, fontFamily: 'inherit', parentHeightOffset: 0,
      events: { dataPointSelection: (_e, _c, o) => { if (o && o.dataPointIndex >= 0) onPick(o.dataPointIndex); } },
    },
    plotOptions: { bar: { horizontal: true, barHeight: '62%', borderRadius: 2, distributed: true } },
    dataLabels: { enabled: false },
    legend: { show: false },
    grid: { borderColor: tok('--h-grey-bd', '#e6e6e6'), strokeDashArray: 0, xaxis: { lines: { show: true } }, yaxis: { lines: { show: false } } },
    states: { active: { filter: { type: 'none' } }, hover: { filter: { type: 'darken' } } },
    yaxis: { labels: { style: { fontSize: '12px' }, maxWidth: 180 } },
  };
}

export function LedgerCharts({ rows, pick, onPick, stepName }: {
  rows: LedgerEntry[]; pick: ChartPick; onPick: (p: ChartPick) => void; stepName: (r: LedgerEntry) => string;
}) {
  const byEndpoint = useMemo(() => {
    const m = new Map<string, { credits: number; calls: number }>();
    for (const r of rows) { const g = m.get(r.endpoint) ?? { credits: 0, calls: 0 }; g.credits += r.credits; g.calls += 1; m.set(r.endpoint, g); }
    return [...m.entries()].sort((a, b) => b[1].credits - a[1].credits || b[1].calls - a[1].calls);
  }, [rows]);
  const byStep = useMemo(() => {
    const m = new Map<string, { label: string; calls: number; ms: number }>();
    for (const r of rows) { const g = m.get(r.step) ?? { label: stepName(r), calls: 0, ms: 0 }; g.calls += 1; g.ms += r.latencyMs; m.set(r.step, g); }
    return [...m.entries()].sort((a, b) => b[1].calls - a[1].calls);
  }, [rows, stepName]);

  if (rows.length === 0) return null;
  const blue = tok('--h-blue-dot', '#3b82f6'), teal = tok('--h-teal-dot', '#14b8a6'), grey = tok('--h-grey-dot', '#c4c4c4');
  const toggle = (kind: 'endpoint' | 'step', value: string) =>
    onPick(pick && pick.kind === kind && pick.value === value ? null : { kind, value });
  const dim = (kind: 'endpoint' | 'step', keys: string[], on: string) =>
    keys.map((k) => (!pick || pick.kind !== kind || pick.value === k ? on : grey));
  const h = (n: number) => Math.max(120, n * 30 + 40);

  const epKeys = byEndpoint.map(([k]) => k);
  const epOpts: ApexOptions = {
    ...base((i) => toggle('endpoint', epKeys[i])),
    colors: dim('endpoint', epKeys, blue),
    xaxis: { categories: epKeys, labels: { formatter: (v) => fmtCredits(Number(v)) } },
    tooltip: {
      custom: ({ dataPointIndex: i }: { dataPointIndex: number }) => {
        const [k, g] = byEndpoint[i];
        return `<div class="lg-tip"><b>${k}</b><span>${fmtCredits(g.credits)} new credits · ${fmtInt(g.calls)} ${g.calls === 1 ? 'call' : 'calls'}</span><i>Click to show only these calls</i></div>`;
      },
    },
  };
  const stKeys = byStep.map(([k]) => k);
  const stOpts: ApexOptions = {
    ...base((i) => toggle('step', stKeys[i])),
    colors: dim('step', stKeys, teal),
    xaxis: { categories: byStep.map(([, g]) => g.label), labels: { formatter: (v) => fmtInt(Number(v)) } },
    tooltip: {
      custom: ({ dataPointIndex: i }: { dataPointIndex: number }) => {
        const [, g] = byStep[i];
        return `<div class="lg-tip"><b>${g.label}</b><span>${fmtInt(g.calls)} ${g.calls === 1 ? 'call' : 'calls'} · ${fmtSeconds(g.ms / g.calls)} average latency</span><i>Click to show only these calls</i></div>`;
      },
    },
  };

  return (
    <section className="panel lg-charts" aria-label="Where the credits and calls went">
      <div className="lg-chart" data-testid="chart-endpoint">
        <div className="lg-sec-h"><h2>New credits by endpoint</h2><span>Credits spent by each data endpoint in this run. Click a bar to filter the calls.</span></div>
        <ReactApexChart type="bar" height={h(epKeys.length)} options={epOpts} series={[{ name: 'New credits', data: byEndpoint.map(([, g]) => g.credits) }]} />
      </div>
      <div className="lg-chart" data-testid="chart-step">
        <div className="lg-sec-h"><h2>Calls by step</h2><span>How many calls each step made; hover for its average latency. Click a bar to filter.</span></div>
        <ReactApexChart type="bar" height={h(stKeys.length)} options={stOpts} series={[{ name: 'Calls', data: byStep.map(([, g]) => g.calls) }]} />
      </div>
    </section>
  );
}
