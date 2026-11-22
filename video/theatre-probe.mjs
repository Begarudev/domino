import { openStudio } from './lib.mjs';
const OUT = process.argv[2]; const url = process.argv[3]; const secs = +process.argv[4] || 240;
const S = await openStudio(OUT);
await S.page.goto(url); await S.start(); S.mark('go');
let last = '';
for (let i = 0; i < secs; i++) {
  await S.hold(1000);
  const head = await S.page.locator('body').innerText().then(s => s.split('\n').slice(0, 8).join(' | ')).catch(() => '');
  const h = head.slice(0, 200);
  if (h !== last) { console.log(i, h); last = h; }
}
await S.stop();
