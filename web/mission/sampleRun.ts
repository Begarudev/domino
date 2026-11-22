// Replays docs/sample-run-events.json (a recorded real live run, names redacted by the lead) as a timed event
// stream, compressing the real gaps between events. Read-only: kill, cap and approve do nothing here.
import type { StoredEvent } from '../../shared/types.ts';
import sampleUrl from '../../docs/sample-run-events.json?url';

type Listener = (events: StoredEvent[]) => void;

export class SampleRun {
  events: StoredEvent[] = [];
  request = '';
  private all: StoredEvent[] = [];
  private listeners = new Set<Listener>();
  private i = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private speed: number;
  private ready: Promise<void>;

  constructor(speed: number) {
    this.speed = speed;
    this.ready = fetch(sampleUrl).then((r) => r.json()).then((d: { request: string; events: StoredEvent[] }) => {
      this.all = d.events;
      this.request = d.request;
    });
  }

  subscribe(_after: number, fn: Listener) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  async start() {
    await this.ready;
    this.next();
  }

  private next() {
    if (this.i >= this.all.length) return;
    const ev = this.all[this.i++];
    this.events.push(ev);
    for (const l of this.listeners) l([ev]);
    const nxt = this.all[this.i];
    if (!nxt) return;
    const gap = Date.parse(nxt.ts) - Date.parse(ev.ts);
    const wait = Math.max(25, Math.min(900, gap * 0.25)) / this.speed;
    this.timer = setTimeout(() => this.next(), wait);
  }

  kill() { return { killed: false, pid: 0 }; }
  resume() { return { pid: 0 }; }
  setLimits() {}
  decide() { return { ok: false }; }
  stop() { if (this.timer) clearTimeout(this.timer); }
}
