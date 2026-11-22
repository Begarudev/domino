import json,re,sys,calendar
from collections import defaultdict
from datetime import date, timedelta
src, asof = sys.argv[1], date.fromisoformat(sys.argv[2])
LAG = int(sys.argv[4]) if len(sys.argv) > 4 else 0
KNOWN = asof - timedelta(days=LAG)
WIN0 = asof - timedelta(days=90)
FAM = [('inference', r'inference|serving'),
       ('mlops', r'\bml ?ops\b|mlops'),
       ('ml_platform', r'ml ?platform|machine learning platform|ml ?infra|machine learning infra|ai platform|ai infra|ml systems|model deployment'),
       ('gpu_llm_infra', r'\bgpu\b|cuda|llm ?(infra|platform|ops)|distributed (training|inference)')]
HW = re.compile(r'asic|rtl|physical design|gpu design|verification|silicon|hardware|layout|analog|chip|\bsoc\b', re.I)
NONENG = re.compile(r'business development|marketing|sales|recruit|account (executive|manager)|talent|ambassador|intern\b', re.I)
def fam(t):
  if not t or HW.search(t) or NONENG.search(t): return None
  for f, rx in FAM:
    if re.search(rx, t, re.I): return f
def month(s):
  y,m = int(s[:4]), int(s[5:7]); return date(y,m,1), date(y,m,calendar.monthrange(y,m)[1])
d = json.load(open(src))
by = defaultdict(list)
for p in d['profiles']:
  emp = p['experience']['employment_details']
  cur = [r for r in emp.get('current') or [] if r.get('start_date')]
  for r in emp.get('past') or []:
    f = fam(r.get('title')); cid = r.get('crustdata_company_id')
    if not f or not cid or not r.get('end_date'): continue
    e0, e1 = month(r['end_date'])
    if e1 <= WIN0 - timedelta(days=31) or e0 > asof: continue
    nxt = [c for c in cur if month(c['start_date'])[1] <= KNOWN and c.get('crustdata_company_id') != cid and month(c['start_date'])[1] >= e0 and (month(c['start_date'])[0] - e1).days <= 60]
    if not nxt: continue
    c = min(nxt, key=lambda c: c['start_date'])
    hc = r.get('company_headcount_latest')
    by[(cid, r['name'], f)].append(dict(person=p.get('crustdata_person_id'), initial=(p['basic_profile']['name'] or '?')[:1],
      title=r['title'], end=r['end_date'][:7], conclusive=e0 > WIN0 and e1 <= asof, hirer=c['name'], hirer_id=c.get('crustdata_company_id'),
      start=c['start_date'][:7], newtitle=c['title'], hc=hc))
universe = {}
for (cid, name, f), deps in by.items():
  universe.setdefault(cid, dict(company=name, company_id=cid, headcount_latest=deps[0]['hc'], families=[]))['families'].append(f)
json.dump(list(universe.values()), open(sys.argv[3].replace('.json','-universe.json'),'w'), indent=1)
out = []
for (cid, name, f), deps in by.items():
  deps = list({x['person']: x for x in deps}.values())
  hc = deps[0]['hc']
  conc = [x for x in deps if x['conclusive']]
  possible = len(deps)
  if possible < 2: continue
  reasons = []
  if hc is None or not (20 <= hc <= 5000): reasons.append(f'headcount {hc} outside 20–5,000')
  if hc and len(deps) / hc > 0.4: reasons.append('movers exceed 40% of headcount')
  if len(conc) < 2: reasons.append('month-only dates cannot settle the 90-day window')
  hirers = {x['hirer'] for x in deps}
  out.append(dict(company=name, company_id=cid, family=f, headcount=hc, departures=sorted(deps, key=lambda x: x['end']),
    conclusive=len(conc), last_departure_month=max(x['end'] for x in conc) if conc else max(x['end'] for x in deps),
    same_hirer=len(hirers) == 1, hirers=sorted(hirers), size_guard=reasons))
out.sort(key=lambda r: (-r['conclusive'], r['company']))
json.dump(out, open(sys.argv[3], 'w'), indent=1)
print('families x companies with >=2 possible departures:', len(out))
for r in out:
  print(f"{r['company']} [{r['family']}] hc={r['headcount']} conclusive={r['conclusive']}/{len(r['departures'])} last={r['last_departure_month']} guards={r['size_guard']}")
  for x in r['departures']: print(f"    {x['initial']}. {x['title'][:50]} left {x['end']} -> {x['hirer']} ({x['start']}) conclusive={x['conclusive']}")
