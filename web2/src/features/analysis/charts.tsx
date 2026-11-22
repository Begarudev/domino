// ApexCharts for the Company file: the enrich headcount series as an area chart and talent flows (in vs out per
// month) as a bar. Light theme, colour tokens from styles/colors.css, one 400 ms entrance, no loop.
import Chart from 'react-apexcharts';
import type { ApexOptions } from 'apexcharts';
import { fmtDate, fmtInt } from '../../lib/format.ts';

const css = (v: string, fb: string) =>
  (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(v).trim()) || fb;

const base = (): ApexOptions => ({
  chart: {
    toolbar: { show: false }, zoom: { enabled: false }, fontFamily: 'inherit', parentHeightOffset: 0,
    animations: { enabled: true, speed: 400, animateGradually: { enabled: false }, dynamicAnimation: { enabled: false } },
  },
  grid: { borderColor: css('--rule', '#E6E7EA'), strokeDashArray: 3, padding: { left: 4, right: 8, top: -8, bottom: 0 } },
  dataLabels: { enabled: false },
  legend: { show: false },
  tooltip: { theme: 'light' },
  xaxis: { axisBorder: { show: false }, axisTicks: { show: false }, labels: { style: { colors: css('--ink-3', '#8A8F98'), fontSize: '11px' } } },
  yaxis: { labels: { style: { colors: css('--ink-3', '#8A8F98'), fontSize: '11px' }, formatter: (v) => fmtInt(Math.round(v)) } },
});

export function HeadcountArea({ series, mark, onOpen }: { series: { date: string; count: number }[]; mark: string | null; onOpen?: () => void }) {
  const teal = css('--h-teal-dot', '#14A38B');
  const o = base();
  const opts: ApexOptions = {
    ...o,
    chart: { ...o.chart, type: 'area', events: { markerClick: () => onOpen?.(), click: () => onOpen?.() } },
    colors: [teal],
    stroke: { curve: 'straight', width: 2 },
    fill: { type: 'gradient', gradient: { shadeIntensity: 0, opacityFrom: 0.22, opacityTo: 0.02, stops: [0, 100] } },
    markers: { size: 3, strokeWidth: 0, hover: { size: 5 } },
    xaxis: { ...o.xaxis, type: 'datetime', labels: { ...o.xaxis!.labels, datetimeUTC: false, format: 'MMM yy' }, tooltip: { enabled: false } },
    tooltip: { theme: 'light', x: { formatter: (v) => fmtDate(new Date(v).toISOString().slice(0, 10), true) }, y: { formatter: (v) => `${fmtInt(v)} employees`, title: { formatter: () => '' } } },
    annotations: mark ? { xaxis: [{ x: Date.parse(mark), borderColor: css('--ink-3', '#8A8F98'), strokeDashArray: 3, label: { text: '90-day base', orientation: 'horizontal', borderWidth: 0, style: { background: 'transparent', color: css('--ink-3', '#8A8F98'), fontSize: '11px' } } }] } : {},
  };
  return (
    <div className="cf-chart" data-testid="file-headcount-chart" aria-label={`Headcount from ${fmtDate(series[0].date, true)} to ${fmtDate(series[series.length - 1].date, true)}, ${series.length} dated points.`}>
      <Chart type="area" height={168} options={opts} series={[{ name: 'Headcount', data: series.map((p) => ({ x: Date.parse(p.date), y: p.count })) }]} />
    </div>
  );
}

export interface FlowPoint { month: string; out: number; in: number }

export function FlowsBar({ points, active, onPick }: { points: FlowPoint[]; active: string | null; onPick: (month: string | null) => void }) {
  const o = base();
  const opts: ApexOptions = {
    ...o,
    chart: {
      ...o.chart, type: 'bar', stacked: false,
      events: { dataPointSelection: (_e, _c, cfg) => { const m = points[cfg?.dataPointIndex ?? -1]?.month; onPick(m && m !== active ? m : null); } },
    },
    colors: [css('--h-red-dot', '#EF4444'), css('--h-green-dot', '#22A35A')],
    plotOptions: { bar: { columnWidth: '46%', borderRadius: 3, borderRadiusApplication: 'end' } },
    states: { active: { filter: { type: 'none' } } },
    legend: { show: true, position: 'top', horizontalAlign: 'right', fontSize: '12px', markers: { size: 5 }, labels: { colors: css('--ink-2', '#4B5563') } },
    xaxis: { ...o.xaxis, categories: points.map((p) => fmtDate(p.month, true)) },
    yaxis: { ...o.yaxis, forceNiceScale: true, min: 0, tickAmount: Math.max(1, Math.min(4, Math.max(...points.map((p) => Math.max(p.in, p.out))))) },
    tooltip: { theme: 'light', shared: true, intersect: false, y: { formatter: (v) => `${v} ${v === 1 ? 'person' : 'people'}` } },
  };
  return (
    <div className="cf-chart" data-testid="file-flows-chart">
      <Chart type="bar" height={150} options={opts} series={[{ name: 'Out', data: points.map((p) => p.out) }, { name: 'In', data: points.map((p) => p.in) }]} />
    </div>
  );
}

