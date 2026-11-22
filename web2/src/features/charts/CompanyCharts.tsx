import { useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';

// Charts for the Company file, built only from real dossier fields
// (GET /api/companies/:id/dossier): headcountSeries and talentFlows.

export type HeadcountPoint = { date: string; count: number };
export type TalentFlow = {
  direction: 'in' | 'out' | string;
  role: string;
  initial: string;
  date: string;
  precision?: string;
  otherCompanyId?: string;
  otherCompanyName?: string;
};
export type ChartsDossier = {
  asOf: string;
  headcountSeries?: HeadcountPoint[];
  talentFlows?: (TalentFlow & { evidenceIds?: string[] })[];
  rules?: { id: string; clauses?: { id: string; evidenceIds?: string[] }[] }[];
};

/** Evidence ids of departures O1 counted as conclusive (o1.window lists only those). */
function o1CountedIds(d: ChartsDossier): Set<string> | null {
  const c = d.rules?.find((r) => r.id === 'O1')?.clauses?.find((x) => x.id === 'o1.window');
  return c?.evidenceIds ? new Set(c.evidenceIds) : null;
}

const TEAL = '#0f9488';
const GREY = '#a3a3a3';
const RED = '#dc2626';
const DAY = 86_400_000;
const fmt = (n: number) => n.toLocaleString('en-US');
const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
const monthLabel = (d: string) =>
  new Date(ms(d)).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const dayLabel = (t: number) =>
  new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Same base as the restructure guard and Analysis.tsx: latest point at least 80 days before the last point. */
function baselinePoint(series: HeadcountPoint[], _asOf: string) {
  const last = series[series.length - 1];
  if (!last) return undefined;
  const cutoff = ms(last.date) - 80 * DAY;
  let best: HeadcountPoint | undefined;
  for (const p of series) if (ms(p.date) <= cutoff && (!best || ms(p.date) > ms(best.date))) best = p;
  return best;
}

export function HeadcountChart({ series, asOf }: { series: HeadcountPoint[]; asOf: string }) {
  const data = useMemo(() => [...series].sort((a, b) => ms(a.date) - ms(b.date)), [series]);
  const base = baselinePoint(data, asOf);
  const last = data[data.length - 1];
  const pct = base && last ? ((last.count - base.count) / base.count) * 100 : undefined;

  const options: ApexOptions = {
    chart: { type: 'area', toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit', animations: { enabled: false } },
    colors: [TEAL],
    stroke: { curve: 'straight', width: 2 },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.35, opacityTo: 0.02, stops: [0, 100] } },
    dataLabels: { enabled: false },
    markers: { size: 3, strokeWidth: 0, hover: { size: 5 } },
    xaxis: { type: 'datetime', labels: { datetimeUTC: true, format: 'dd MMM' } },
    yaxis: { labels: { formatter: (v) => fmt(Math.round(v)) }, forceNiceScale: true },
    grid: { borderColor: '#eeeeee', strokeDashArray: 3 },
    tooltip: {
      custom: ({ dataPointIndex }) => {
        const p = data[dataPointIndex];
        const prev = data[dataPointIndex - 1];
        const diff = prev ? p.count - prev.count : 0;
        const change = prev
          ? `${diff > 0 ? '+' : ''}${fmt(diff)} vs ${dayLabel(ms(prev.date))}`
          : 'first point';
        return `<div style="padding:8px 10px;font-size:12px"><div style="color:#737373">${dayLabel(ms(p.date))}</div><div style="font-weight:600">${fmt(p.count)} staff</div><div style="color:#737373">${change}</div></div>`;
      },
    },
    annotations: base
      ? {
          xaxis: [
            {
              x: ms(base.date),
              borderColor: '#737373',
              strokeDashArray: 4,
              label: {
                text: `90-day baseline ${dayLabel(ms(base.date))}: ${fmt(base.count)}${pct !== undefined ? ` → ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : ''}`,
                orientation: 'horizontal',
                style: { background: '#fff', color: '#404040', fontSize: '11px' },
              },
            },
          ],
        }
      : {},
  };
  return (
    <figure className="cc-card" data-testid="headcount-chart">
      <figcaption className="cc-title">
        Headcount
        {pct !== undefined && (
          <span className="cc-sub">
            {' '}{fmt(last.count)} now, {pct >= 0 ? '+' : ''}{pct.toFixed(1)}% over 90 days (restructure guard looks at this)
          </span>
        )}
      </figcaption>
      <ReactApexChart type="area" height={220} options={options} series={[{ name: 'Staff', data: data.map((p) => [ms(p.date), p.count]) }]} />
    </figure>
  );
}

/** Month-precision dates count only when the whole month is inside the 90-day window (O1/R1 rule). */
let COUNTED: Set<string> | null = null;
function countedInWindow(f: TalentFlow & { evidenceIds?: string[] }, asOf: string) {
  if (COUNTED) return (f.evidenceIds ?? []).some((id) => COUNTED!.has(id));
  const start = ms(asOf) - 89 * DAY;
  return ms(f.date) >= start && ms(f.date) <= ms(asOf);
}

export function DeparturesChart({ flows, asOf }: { flows: TalentFlow[]; asOf: string }) {
  const out = flows.filter((f) => f.direction === 'out');
  const windowStart = ms(asOf) - 89 * DAY;
  const months = useMemo(() => {
    const keys = new Set<string>();
    for (const f of out) if (ms(f.date) >= windowStart - 31 * DAY) keys.add(f.date.slice(0, 7));
    for (let t = windowStart; t <= ms(asOf); t += 28 * DAY) keys.add(new Date(t).toISOString().slice(0, 7));
    return [...keys].sort();
  }, [out, asOf, windowStart]);
  const [picked, setPicked] = useState<string | null>(null);
  if (!out.length) return null;

  const inMonth = (m: string) => out.filter((f) => f.date.slice(0, 7) === m);
  const counted = months.map((m) => inMonth(m).filter((f) => countedInWindow(f, asOf)).length);
  const notCounted = months.map((m) => inMonth(m).filter((f) => !countedInWindow(f, asOf)).length);
  const total = counted.reduce((a, b) => a + b, 0);

  const options: ApexOptions = {
    chart: {
      type: 'bar', stacked: true, toolbar: { show: false }, fontFamily: 'inherit', animations: { enabled: false },
      events: { dataPointSelection: (_e, _c, cfg) => setPicked(months[cfg?.dataPointIndex ?? -1] ?? null) },
    },
    colors: [TEAL, GREY],
    plotOptions: { bar: { columnWidth: '45%', borderRadius: 2 } },
    dataLabels: { enabled: false },
    xaxis: { categories: months.map((m) => monthLabel(m + '-01')) },
    yaxis: { min: 0, forceNiceScale: true, labels: { formatter: (v) => String(Math.round(v)) } },
    legend: { position: 'top', horizontalAlign: 'left' },
    grid: { borderColor: '#eeeeee', strokeDashArray: 3 },
    annotations: {
      yaxis: [{ y: 2, borderColor: RED, strokeDashArray: 4, label: { text: 'O1 threshold: 2 departures', style: { background: '#fff', color: RED, fontSize: '11px' } } }],
    },
    tooltip: { shared: true, intersect: false },
  };
  const list = picked ? inMonth(picked) : [];
  return (
    <figure className="cc-card" data-testid="departures-chart">
      <figcaption className="cc-title">
        Departures by month
        <span className="cc-sub"> {total} counted by O1 in the 90-day window from {dayLabel(windowStart)}. Click a bar for the moves.</span>
      </figcaption>
      <ReactApexChart
        type="bar"
        height={200}
        options={options}
        series={[{ name: 'Counted by O1', data: counted }, { name: 'Not counted', data: notCounted }]}
      />
      {picked && (
        <ul className="cc-list" data-testid="departures-list">
          {list.length === 0 && <li>No departures in {monthLabel(picked + '-01')}.</li>}
          {list.map((f, i) => (
            <li key={i}>
              {f.initial} {f.role}, {monthLabel(f.date)} → {f.otherCompanyName ?? 'unknown'}{' '}
              <span className="cc-sub">{countedInWindow(f, asOf) ? 'counted' : 'not counted by O1 (not conclusive in the window)'}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}

export function DestinationsChart({ flows, onOpenCompany }: { flows: TalentFlow[]; onOpenCompany?: (id: string) => void }) {
  const rows = useMemo(() => {
    const m = new Map<string, { id?: string; name: string; n: number }>();
    for (const f of flows) {
      if (f.direction !== 'out' || !f.otherCompanyName) continue;
      const k = f.otherCompanyId ?? f.otherCompanyName;
      const r = m.get(k) ?? { id: f.otherCompanyId, name: f.otherCompanyName, n: 0 };
      r.n++;
      m.set(k, r);
    }
    return [...m.values()].sort((a, b) => b.n - a.n).slice(0, 8);
  }, [flows]);
  if (!rows.length) return null;
  const options: ApexOptions = {
    chart: {
      type: 'bar', toolbar: { show: false }, fontFamily: 'inherit', animations: { enabled: false },
      events: { dataPointSelection: (_e, _c, cfg) => { const id = rows[cfg?.dataPointIndex ?? -1]?.id; if (id) onOpenCompany?.(id); } },
    },
    colors: [TEAL],
    plotOptions: { bar: { horizontal: true, barHeight: '55%', borderRadius: 2 } },
    dataLabels: { enabled: true, style: { fontSize: '11px' } },
    xaxis: { categories: rows.map((r) => r.name), labels: { formatter: (v) => String(Math.round(Number(v))) } },
    grid: { borderColor: '#eeeeee', strokeDashArray: 3 },
    tooltip: { y: { formatter: (v) => `${v} left for here` } },
  };
  return (
    <figure className="cc-card" data-testid="destinations-chart">
      <figcaption className="cc-title">
        Where people went
        <span className="cc-sub"> destinations of departures{onOpenCompany ? '; click a bar to open that company' : ''}</span>
      </figcaption>
      <ReactApexChart type="bar" height={Math.max(120, rows.length * 34 + 40)} options={options} series={[{ name: 'Departures', data: rows.map((r) => r.n) }]} />
    </figure>
  );
}

export function CompanyCharts({ dossier, onOpenCompany }: { dossier: ChartsDossier; onOpenCompany?: (companyId: string) => void }) {
  const hc = dossier.headcountSeries ?? [];
  const flows = dossier.talentFlows ?? [];
  COUNTED = o1CountedIds(dossier);
  return (
    <div className="cc-grid" data-testid="company-charts" style={{ display: 'grid', gap: 16 }}>
      <style>{`.cc-card{margin:0;border:1px solid #e5e5e5;border-radius:8px;padding:12px;background:#fff}.cc-title{font-weight:600;font-size:13px;margin-bottom:4px}.cc-sub{font-weight:400;color:#737373;font-size:12px}.cc-list{margin:8px 0 0;padding-left:18px;font-size:12px}`}</style>
      {hc.length > 1 && <HeadcountChart series={hc} asOf={dossier.asOf} />}
      {flows.length > 0 && <DeparturesChart flows={flows} asOf={dossier.asOf} />}
      {flows.length > 0 && <DestinationsChart flows={flows} onOpenCompany={onOpenCompany} />}
    </div>
  );
}

export default CompanyCharts;
