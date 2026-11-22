// The table: physics world, tiles, spacers, camera director and post effects.
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Environment, Lightformer, Html } from '@react-three/drei';
import {
  Physics, RigidBody, CuboidCollider, InstancedRigidBodies,
  type RapierRigidBody, type InstancedRigidBodyProps,
} from '@react-three/rapier';
import { EffectComposer, DepthOfField, Bloom, Vignette } from '@react-three/postprocessing';
import { TILE, SPACER, type TableLayout, type TileSpec, fmtFull, addDays } from './layout.ts';
import { makeFace, slateTexture, poolTexture } from './faces.ts';
import type { Hud, TileStatus } from './store.ts';
import { useHud } from './store.ts';
import type { RunSnapshot, Evidence } from '../../../../shared/types.ts';
import type { Selection } from '../contract.ts';

export const COLORS = {
  amber: new THREE.Color('#f3a43b'),
  jade: new THREE.Color('#3fbf8f'),
  ash: new THREE.Color('#6d737a'),
  ivory: new THREE.Color('#ffffff'),
  spacerIdle: new THREE.Color('#e9e1cd'),
  spacerAmber: new THREE.Color('#f0c98c'),
  spacerJade: new THREE.Color('#a6dcc4'),
  spacerAsh: new THREE.Color('#7b8087'),
};

const DYNAMIC = 0 as never; // rapier RigidBodyType.Dynamic

interface TileHandle { spec: TileSpec; rb: RapierRigidBody | null; face: THREE.MeshPhysicalMaterial; side: THREE.MeshPhysicalMaterial; pool: THREE.MeshBasicMaterial; releasedAt: number | null }

export interface DirectorOptions {
  layout: TableLayout;
  hud: Hud;
  reducedMotion: boolean;
  hiringFilterView: boolean;
  selectedCompany: string | null;
  autoplay: boolean;
}

function yawOf(dir: [number, number]) { return Math.atan2(dir[0], dir[1]); }

function tiltOf(rb: RapierRigidBody): number {
  const q = rb.rotation();
  const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
  return Math.acos(Math.max(-1, Math.min(1, upY)));
}

function tip(rb: RapierRigidBody, dir: [number, number], h: number, k: number) {
  const p = rb.translation();
  rb.wakeUp();
  rb.applyImpulseAtPoint({ x: dir[0] * k, y: 0, z: dir[1] * k }, { x: p.x, y: p.y + h * 0.42, z: p.z }, true);
}

// ---------------------------------------------------------------- tiles

function CompanyTile({ spec, register, onPick, hud }: {
  spec: TileSpec; register: (h: TileHandle) => void; onPick: (s: TileSpec) => void; hud: Hud;
}) {
  const rb = useRef<RapierRigidBody>(null);
  const width = spec.width;
  const face = useMemo(() => makeFace(spec, width), [spec, width]);
  const mats = useMemo(() => {
    const faceMat = new THREE.MeshPhysicalMaterial({
      map: face.map, bumpMap: face.bump, bumpScale: 0.9, emissiveMap: face.glow, emissive: new THREE.Color('#000000'),
      roughness: 0.34, clearcoat: 0.8, clearcoatRoughness: 0.22, sheen: 0.2,
    });
    const sideMat = new THREE.MeshPhysicalMaterial({ color: '#e6dec9', roughness: 0.38, clearcoat: 0.7, clearcoatRoughness: 0.25, emissive: new THREE.Color('#000000') });
    const poolMat = new THREE.MeshBasicMaterial({ map: poolTexture(), color: COLORS.amber, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    return { faceMat, sideMat, poolMat };
  }, [face]);
  useEffect(() => () => { face.map.dispose(); face.bump.dispose(); face.glow.dispose(); mats.faceMat.dispose(); mats.sideMat.dispose(); mats.poolMat.dispose(); }, [face, mats]);

  useEffect(() => {
    register({ spec, rb: rb.current, face: mats.faceMat, side: mats.sideMat, pool: mats.poolMat, releasedAt: null });
  }, [spec, mats, register]);

  const yaw = yawOf(spec.dir);
  const materialArray = [mats.sideMat, mats.sideMat, mats.sideMat, mats.sideMat, mats.faceMat, mats.faceMat];
  const pinned = spec.role !== 'trigger';
  const density = spec.role === 'trigger' ? 1.4 : 1.0;
  void hud;
  return (
    <group>
      <RigidBody
        ref={rb}
        type={pinned ? 'fixed' : 'dynamic'}
        colliders={false}
        position={[spec.pos[0], TILE.h / 2 + 0.001, spec.pos[1]]}
        rotation={[0, yaw, 0]}
        friction={0.6}
        restitution={0}
        linearDamping={0.05}
        angularDamping={0.15}
        ccd
      >
        <CuboidCollider args={[width / 2, TILE.h / 2, TILE.d / 2]} density={density} friction={0.6} />
        <mesh
          castShadow receiveShadow material={materialArray}
          onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); onPick(spec); }}
          onPointerOver={(e) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
          onPointerOut={() => { document.body.style.cursor = ''; }}
        >
          <boxGeometry args={[width, TILE.h, TILE.d]} />
        </mesh>
      </RigidBody>
      {/* light pool on the slate under the tile */}
      <mesh position={[spec.pos[0], 0.012, spec.pos[1]]} rotation={[-Math.PI / 2, 0, 0]} material={mats.poolMat} renderOrder={2}>
        <planeGeometry args={[width * 3.4, width * 3.4]} />
      </mesh>
    </group>
  );
}

// ---------------------------------------------------------------- spacers

function Spacers({ layout, bodies, onPickEdge }: {
  layout: TableLayout; bodies: React.MutableRefObject<RapierRigidBody[] | null>; onPickEdge: (edgeId: string) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const instances = useMemo<InstancedRigidBodyProps[]>(() => layout.spacers.map((s, i) => ({
    key: `sp_${s.edgeId}_${s.index}_${i}`,
    position: [s.pos[0], SPACER.h / 2 + 0.001, s.pos[1]],
    rotation: [0, yawOf(s.dir), 0],
  })), [layout]);
  useEffect(() => {
    const m = meshRef.current; if (!m) return;
    for (let i = 0; i < layout.spacers.length; i++) m.setColorAt(i, COLORS.spacerIdle);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [layout]);
  return (
    <InstancedRigidBodies ref={bodies} instances={instances} colliders="cuboid" friction={0.55} restitution={0} density={1} angularDamping={0.1}>
      <instancedMesh
        ref={meshRef}
        args={[undefined, undefined, instances.length]}
        castShadow receiveShadow
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const id = e.instanceId; if (id == null) return;
          onPickEdge(layout.spacers[id].edgeId);
        }}
      >
        <boxGeometry args={[SPACER.w, SPACER.h, SPACER.d]} />
        <meshPhysicalMaterial color="#ffffff" roughness={0.36} clearcoat={0.6} clearcoatRoughness={0.3} />
      </instancedMesh>
    </InstancedRigidBodies>
  );
}

// ---------------------------------------------------------------- table

function Table({ layout }: { layout: TableLayout }) {
  const tex = useMemo(() => slateTexture(), []);
  const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const cz = (layout.bounds.minZ + layout.bounds.maxZ) / 2;
  return (
    <RigidBody type="fixed" colliders={false} position={[0, 0, 0]} friction={0.9}>
      <CuboidCollider args={[60, 0.5, 60]} position={[0, -0.5, 0]} friction={0.9} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]} receiveShadow>
        <planeGeometry args={[120, 120]} />
        <meshStandardMaterial map={tex} color="#2c353c" roughness={0.78} metalness={0.05} />
      </mesh>
    </RigidBody>
  );
}

// ---------------------------------------------------------------- cards

function cardEvidence(spec: TileSpec, snap: RunSnapshot, ev: Map<string, Evidence>): Evidence | null {
  if (spec.outcome && spec.outcome.evidenceIds.length) return ev.get(spec.outcome.evidenceIds[0]) ?? null;
  const ids = spec.evidenceIds;
  const dated = ids.map((i) => ev.get(i)).filter((e): e is Evidence => !!e && e.verifiable && !!e.observedAt);
  dated.sort((a, b) => (b.observedAt! > a.observedAt! ? 1 : -1));
  void snap;
  return dated[0] ?? null;
}

function EvidenceCard({ spec, status, snap, ev, compact, selected }: {
  spec: TileSpec; status: TileStatus; snap: RunSnapshot; ev: Map<string, Evidence>; compact: boolean; selected: boolean;
}) {
  const e = cardEvidence(spec, snap, ev);
  const fallen = status === 'hit' || status === 'falling-hit' || status === 'fallen' || status === 'hypothesis';
  // where the tile ends up: one tile-height along its fall direction
  const land: [number, number, number] = fallen && spec.role !== 'baseline'
    ? [spec.pos[0] + spec.dir[0] * TILE.h * 0.55, 0.9, spec.pos[1] + spec.dir[1] * TILE.h * 0.55]
    : [spec.pos[0], TILE.h + 0.5, spec.pos[1]];
  let tone: 'jade' | 'amber' | 'ash' = 'amber';
  let head = '';
  let body = '';
  if (status === 'hit' || status === 'falling-hit') {
    tone = 'jade';
    head = spec.outcome?.outcomeDate ? fmtFull(spec.outcome.outcomeDate) : 'Happened';
    body = e?.claim ?? spec.outcome?.outcome ?? '';
  } else if (status === 'miss') {
    tone = 'ash';
    head = 'Still standing';
    body = spec.outcome?.outcome ?? 'no dated sign yet';
  } else if (spec.role === 'trigger') {
    head = e?.observedAt ? fmtFull(e.observedAt) : 'Trigger';
    body = e?.claim ?? spec.name;
  } else {
    head = e?.observedAt ? fmtFull(e.observedAt) : "I can't verify";
    body = e?.claim ?? 'No dated evidence';
  }
  return (
    <Html position={land} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`dp-card dp-${tone}${compact ? ' dp-compact' : ''}${selected ? ' dp-selected' : ''}`}>
        <div className="dp-card-head">{head}</div>
        {!compact && <div className="dp-card-body">{body}</div>}
        {!compact && e && (
          <div className="dp-card-src">
            {e.source.endpoint} <span>{e.source.field}</span> <em className={`dp-mode dp-mode-${e.mode}`}>{e.mode}</em>
          </div>
        )}
      </div>
    </Html>
  );
}

function Cards({ layout, hud, snap }: { layout: TableLayout; hud: Hud; snap: RunSnapshot }) {
  const status = useHud(hud, (s) => s.status);
  const phase = useHud(hud, (s) => s.phase);
  const focus = useHud(hud, (s) => s.focusKey);
  const ev = useMemo(() => new Map(snap.evidence.map((e) => [e.id, e])), [snap]);
  return (
    <>
      {layout.tiles.map((t) => {
        const st = status[t.key] ?? 'standing';
        const show = st === 'hit' || st === 'falling-hit' || st === 'miss' || st === 'hypothesis'
          || (t.role === 'trigger' && phase === 'predict')
          || t.key === focus;
        if (!show) return null;
        if (t.role === 'baseline' && st !== 'hit' && st !== 'falling-hit' && t.key !== focus) return null;
        const compact = t.key !== focus && (phase === 'score' || phase === 'done' || t.role === 'baseline' || (phase === 'replay' && t.role === 'target'));
        return <EvidenceCard key={t.key} spec={t} status={st} snap={snap} ev={ev} compact={compact} selected={false} />;
      })}
    </>
  );
}

function RowLabel({ layout, hud }: { layout: TableLayout; hud: Hud }) {
  const phase = useHud(hud, (s) => s.phase);
  const base = layout.tiles.filter((t) => t.role === 'baseline');
  if (!base.length || (phase !== 'score' && phase !== 'done')) return null;
  const x = Math.max(...base.map((t) => t.pos[0])) + 1.0;
  return (
    <Html position={[x, 0.2, base[0].pos[1]]} center={false} zIndexRange={[10, 0]} style={{ pointerEvents: 'none', transform: 'translate(0, -50%)' }}>
      <div className="dp-row" style={{ textAlign: 'left' }}>Hiring filter's picks<br /><span>no chain, only their own job posts</span></div>
    </Html>
  );
}

function LaneLabels({ layout, hud }: { layout: TableLayout; hud: Hud }) {
  const arrived = useHud(hud, (s) => s.arrived);
  const phase = useHud(hud, (s) => s.phase);
  if (phase !== 'predict') return null;
  return (
    <>
      {layout.lanes.map((l) => arrived[l.edge.id] ? (
        <Html key={l.edge.id} position={[l.mid[0], 0.35, l.mid[1]]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          <div className="dp-lane">{l.edge.label}</div>
        </Html>
      ) : null)}
    </>
  );
}

// ---------------------------------------------------------------- director

function Director({ layout, hud, tiles, spacers, reducedMotion, hiringFilterView, selectedCompany, focusTarget, autoplay }: DirectorOptions & {
  tiles: React.MutableRefObject<Map<string, TileHandle>>;
  spacers: React.MutableRefObject<RapierRigidBody[] | null>;
  focusTarget: THREE.Vector3;
}) {
  const { camera, size } = useThree();
  const t = useRef(0);
  const s = useRef({
    started: false, predictAt: 0, replayAt: 0, endAt: 0, scoreAt: 0,
    spacerFellAt: new Float32Array(layout.spacers.length).fill(-1),
    laneOffsets: [] as number[],
    arrived: new Set<string>(),
    status: {} as Record<string, TileStatus>,
    lastHudDay: -1,
    camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), init: false,
    spacerColorDirty: true,
  });
  // lane index ranges into the flat spacer array
  useMemo(() => {
    let off = 0; s.current.laneOffsets = layout.lanes.map((l) => { const o = off; off += l.spacers.length; return o; });
  }, [layout]);

  const tileList = layout.tiles;
  const targets = tileList.filter((x) => x.role === 'target');
  const baselineTiles = tileList.filter((x) => x.role === 'baseline');
  const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const cz = (layout.bounds.minZ + layout.bounds.maxZ) / 2;

  const setStatus = (key: string, st: TileStatus) => {
    if (s.current.status[key] === st) return;
    s.current.status = { ...s.current.status, [key]: st };
    hud.set({ status: s.current.status });
  };

  // start / pause from the HUD
  const playing = useHud(hud, (x) => x.playing);
  useEffect(() => {
    if (autoplay && !s.current.started) hud.set({ playing: true });
  }, [autoplay, hud]);

  const tmp = useMemo(() => ({ v: new THREE.Vector3(), w: new THREE.Vector3(), c: new THREE.Color() }), []);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 1 / 30);
    const st = s.current;
    const H = hud.get();
    if (playing) t.current += delta;
    const now = t.current;
    const sp = spacers.current;

    // ---- start: tip every trigger tile
    if (playing && !st.started) {
      st.started = true; st.predictAt = now;
      hud.set({ phase: 'predict' });
      for (const tl of tileList) if (tl.role === 'trigger') {
        const h = tiles.current.get(tl.key);
        if (h?.rb) tip(h.rb, tl.dir, TILE.h, 1.8 * tl.width);
        setStatus(tl.key, 'fallen');
      }
    }

    // ---- chain watchdog: physics does the work; a nudge only if a spacer was clearly struck and stalled
    if (st.started && sp) {
      layout.lanes.forEach((lane, li) => {
        const off = st.laneOffsets[li];
        const src = tiles.current.get(lane.from);
        const srcTilt = src?.rb ? tiltOf(src.rb) : 0;
        for (let i = 0; i < lane.spacers.length; i++) {
          const rb = sp[off + i]; if (!rb) continue;
          const tilt = tiltOf(rb);
          if (tilt > 0.35 && st.spacerFellAt[off + i] < 0) { st.spacerFellAt[off + i] = now; st.spacerColorDirty = true; }
          if (st.spacerFellAt[off + i] >= 0) continue;
          const prevFell = i === 0 ? (srcTilt > 0.6 ? st.predictAt + 0.25 : -1) : st.spacerFellAt[off + i - 1];
          if (prevFell >= 0 && now - prevFell > 0.32) {
            tip(rb, lane.spacers[i].dir, SPACER.h, 0.012);
            st.spacerFellAt[off + i] = now; // count it once; physics finishes the fall
          }
        }
        const lastFell = st.spacerFellAt[off + lane.spacers.length - 1];
        if (lastFell >= 0 && now - lastFell > 0.25 && !st.arrived.has(lane.edge.id)) {
          st.arrived.add(lane.edge.id);
          hud.set({ arrived: { ...hud.get().arrived, [lane.edge.id]: true } });
          const tgt = tileList.find((x) => x.key === lane.to);
          if (tgt && (st.status[tgt.key] ?? 'standing') === 'standing') setStatus(tgt.key, 'predicted');
          st.spacerColorDirty = true;
        }
      });
    }

    // baseline picks light up as soon as play starts: the filter "predicts" them too
    if (st.started && H.phase === 'predict') {
      for (const b of baselineTiles) if (!st.status[b.key]) setStatus(b.key, 'predicted');
    }

    // ---- predict -> replay (or, for a live run, everything falls as a hypothesis)
    const allArrived = layout.lanes.every((l) => st.arrived.has(l.edge.id));
    if (H.phase === 'predict' && (allArrived || now - st.predictAt > 7)) {
      if (!st.replayAt) st.replayAt = now + (layout.isReplay ? 1.1 : 0.4);
      if (now >= st.replayAt) {
        if (layout.isReplay) hud.set({ phase: 'replay', day: 0 });
        else {
          for (const tg of targets) release(tg.key, 'hypothesis');
          hud.set({ phase: 'score' }); st.scoreAt = now;
        }
      }
    }

    // ---- replay clock: reality decides which predicted tiles fall
    if (H.phase === 'replay' && playing) {
      const anyFalling = [...tiles.current.values()].some((h) => h.spec.role === 'target' && h.releasedAt != null && now - h.releasedAt < 0.9);
      const baseRate = layout.horizonDays / (reducedMotion ? 3 : 9.5);
      const rate = baseRate * (anyFalling ? 0.3 : 1);
      const day = Math.min(layout.horizonDays, H.day + delta * rate);
      for (const tl of [...targets, ...baselineTiles]) {
        if (tl.outcomeDay != null && tl.outcomeDay <= day && !tiles.current.get(tl.key)?.releasedAt) release(tl.key, 'falling-hit');
      }
      if (Math.floor(day * 4) !== st.lastHudDay || day >= layout.horizonDays) { st.lastHudDay = Math.floor(day * 4); }
      hud.set({ day });
      // focus: the next prediction that will be decided
      const pending = targets.filter((x) => (st.status[x.key] ?? 'predicted') === 'predicted' && x.outcomeDay != null).sort((a, b) => a.outcomeDay! - b.outcomeDay!);
      const justFell = [...targets].filter((x) => { const h = tiles.current.get(x.key); return h?.releasedAt != null && now - h.releasedAt < 1.6; });
      const fk = justFell[0]?.key ?? pending[0]?.key ?? null;
      if (fk !== H.focusKey) hud.set({ focusKey: fk });
      if (day >= layout.horizonDays) {
        if (!st.endAt) st.endAt = now;
        for (const tl of [...targets, ...baselineTiles]) if (tl.outcomeDay == null) setStatus(tl.key, tl.outcome ? 'miss' : 'predicted');
        st.spacerColorDirty = true;
        if (now - st.endAt > 0.9) { hud.set({ phase: 'score', focusKey: null }); st.scoreAt = now; }
      }
    }

    // settle falling -> hit, count score
    for (const h of tiles.current.values()) {
      if (h.releasedAt != null && st.status[h.spec.key] === 'falling-hit' && now - h.releasedAt > 0.9) {
        setStatus(h.spec.key, 'hit'); st.spacerColorDirty = true;
      }
    }
    const dHits = targets.filter((x) => st.status[x.key] === 'hit' || st.status[x.key] === 'falling-hit').length;
    const bHits = baselineTiles.filter((x) => st.status[x.key] === 'hit' || st.status[x.key] === 'falling-hit').length;
    if (dHits !== H.dominoHits || bHits !== H.baselineHits) hud.set({ dominoHits: dHits, baselineHits: bHits });

    // ---- materials follow status (glow pulses while predicted)
    const pulse = 0.75 + 0.25 * Math.sin(now * 3.2);
    for (const h of tiles.current.values()) {
      const stt = st.status[h.spec.key] ?? 'standing';
      const dim = hiringFilterView && (h.spec.alsoBaseline || !h.spec.netNew) && h.spec.role !== 'baseline';
      const sel = selectedCompany === h.spec.companyId;
      let col: THREE.Color = COLORS.amber; let glow = 0; let pool = 0; let tint = 1;
      if (stt === 'predicted') { col = COLORS.amber; glow = 1.6 * pulse; pool = 0.55 * pulse; }
      else if (stt === 'hypothesis') { col = COLORS.amber; glow = 1.2; pool = 0.4; }
      else if (stt === 'falling-hit' || stt === 'hit') { col = COLORS.jade; glow = stt === 'falling-hit' ? 2.6 : 1.5; pool = 0.6; }
      else if (stt === 'miss') { col = COLORS.ash; glow = 0; pool = 0; tint = 0.52; }
      else if (stt === 'fallen' && h.spec.role === 'trigger') { col = COLORS.amber; glow = 0.28; pool = 0.12; }
      if (h.spec.role === 'baseline' && stt === 'predicted') { col = COLORS.ivory; glow = 0.35; pool = 0.12; }
      if (dim) { tint *= 0.35; glow *= 0.2; pool *= 0.2; }
      if (sel) { glow = Math.max(glow, 1.4); pool = Math.max(pool, 0.4); }
      h.face.emissive.copy(col); h.face.emissiveIntensity = THREE.MathUtils.lerp(h.face.emissiveIntensity, glow, 0.12);
      h.side.emissive.copy(col); h.side.emissiveIntensity = THREE.MathUtils.lerp(h.side.emissiveIntensity, glow * 0.12, 0.12);
      tmp.c.setScalar(tint); h.face.color.lerp(tmp.c, 0.1); h.side.color.lerp(tmp.c.multiply(new THREE.Color('#e6dec9')), 0.1);
      h.pool.color.copy(col); h.pool.opacity = THREE.MathUtils.lerp(h.pool.opacity, pool, 0.1);
    }


    // ---- camera
    cameraStep(delta);
  });

  function release(key: string, as: TileStatus) {
    const h = tiles.current.get(key); if (!h?.rb || h.releasedAt != null) return;
    h.rb.setBodyType(DYNAMIC, true);
    h.rb.recomputeMassPropertiesFromColliders();
    h.rb.wakeUp();
    h.releasedAt = t.current;
    // tip it toward its fall direction: angular velocity about (up x dir)
    const [dx, dz] = h.spec.dir;
    const w = h.spec.role === 'baseline' ? 2.6 : 3.0;
    h.rb.setAngvel({ x: dz * w, y: 0, z: -dx * w }, true);
    tip(h.rb, h.spec.dir, TILE.h, 1.1);
    setStatus(key, as);
  }

  function cameraStep(delta: number) {
    const st = s.current; const H = hud.get();
    const aspect = size.width / Math.max(1, size.height);
    const spanX = layout.bounds.maxX - layout.bounds.minX;
    const spanZ = layout.bounds.maxZ - layout.bounds.minZ;
    const wantPos = tmp.v; const wantLook = tmp.w;
    if (H.phase === 'score' || H.phase === 'done' || reducedMotion) {
      // fit the table into the left ~66% of the frame; the score column owns the rest
      const tanH = Math.tan(THREE.MathUtils.degToRad(17));
      const usable = 0.6;
      const dist = Math.max((spanZ * 0.5 * 0.94) / (tanH * 0.8), (spanX * 0.5) / (tanH * aspect * usable)) * 1.05;
      const visW = 2 * dist * tanH * aspect;
      const shift = visW * (0.5 - usable / 2) * 0.92;
      const elev = THREE.MathUtils.degToRad(64);
      const down = 2 * dist * tanH * 0.05; // the clock owns the top of the frame
      wantLook.set(cx + shift, 0, cz - down);
      wantPos.set(cx + shift - 0.8, dist * Math.sin(elev), cz - down + dist * Math.cos(elev));
      focusTarget.lerp(wantLook, 0.05);
    } else if (H.phase === 'idle') {
      const trig = tileList.filter((x) => x.role === 'trigger');
      const tx = trig.reduce((a, b) => a + b.pos[0], 0) / Math.max(1, trig.length);
      const tz = trig.reduce((a, b) => a + b.pos[1], 0) / Math.max(1, trig.length);
      wantLook.set(tx + 4.2, 0.4, tz + 0.5);
      wantPos.set(tx - 6.0, 6.8, tz + 10.5);
      focusTarget.set(tx, 1.1, tz);
    } else if (H.phase === 'predict') {
      // follow the falling front across all lanes
      let fx = 0, fz = 0, n = 0;
      const sp = spacers.current;
      layout.lanes.forEach((lane, li) => {
        const off = st.laneOffsets[li];
        let last = -1;
        for (let i = 0; i < lane.spacers.length; i++) if (st.spacerFellAt[off + i] >= 0) last = i;
        const p = lane.spacers[Math.max(0, last)].pos;
        fx += p[0]; fz += p[1]; n++;
      });
      void sp;
      if (n) { fx /= n; fz /= n; } else { fx = cx; fz = cz; }
      wantLook.set(fx + 1.5, 0.4, fz * 0.6);
      wantPos.set(fx - 5.5, 7.5, fz * 0.6 + 11.5);
      focusTarget.lerp(tmp.v.clone().set(fx, 0.5, fz * 0.6), 0.08);
    } else {
      const fk = H.focusKey ? tileList.find((x) => x.key === H.focusKey) : null;
      const fx = fk ? fk.pos[0] : cx; const fz = fk ? fk.pos[1] : cz;
      wantLook.set(fx - 1.2, 0.6, fz * 0.75 + 0.6);
      wantPos.set(fx - 9.5, 8.2, fz * 0.75 + 11.5);
      focusTarget.lerp(new THREE.Vector3(fx, 1.0, fz), 0.06);
    }
    if (!st.init) { st.camPos.copy(wantPos); st.camLook.copy(wantLook); st.init = true; }
    const k = 1 - Math.exp(-delta * (H.phase === 'score' ? 1.1 : 1.8));
    st.camPos.lerp(wantPos, k); st.camLook.lerp(wantLook, k);
    camera.position.copy(st.camPos);
    camera.lookAt(st.camLook);
  }

  // spacer colouring: done in a dedicated effect frame (needs the instanced mesh)
  return <SpacerTint layout={layout} hud={hud} />;
}

function SpacerTint({ layout, hud }: { layout: TableLayout; hud: Hud }) {
  const { scene } = useThree();
  const status = useHud(hud, (s) => s.status);
  const arrived = useHud(hud, (s) => s.arrived);
  useEffect(() => {
    let mesh: THREE.InstancedMesh | null = null;
    scene.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && !mesh) mesh = o as THREE.InstancedMesh; });
    const m = mesh as THREE.InstancedMesh | null;
    if (!m) return;
    let idx = 0;
    for (const lane of layout.lanes) {
      const st = status[lane.to];
      const col = st === 'hit' || st === 'falling-hit' ? COLORS.spacerJade : st === 'miss' ? COLORS.spacerAsh
        : arrived[lane.edge.id] ? COLORS.spacerAmber : COLORS.spacerIdle;
      for (let i = 0; i < lane.spacers.length; i++) m.setColorAt(idx++, col);
    }
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [status, arrived, layout, scene]);
  return null;
}

// ---------------------------------------------------------------- root scene

export function TableScene({ layout, hud, snap, reducedMotion, hiringFilterView, selectedCompany, onSelect, autoplay, paused }: {
  layout: TableLayout; hud: Hud; snap: RunSnapshot; reducedMotion: boolean; hiringFilterView: boolean;
  selectedCompany: string | null; onSelect: (s: Selection | null) => void; autoplay: boolean; paused: boolean;
}) {
  const tiles = useRef(new Map<string, TileHandle>());
  const spacers = useRef<RapierRigidBody[] | null>(null);
  const focusTarget = useMemo(() => new THREE.Vector3(-6, 1, 0), []);
  const register = useMemo(() => (h: TileHandle) => { tiles.current.set(h.spec.key, h); (window as unknown as { __dpTiles?: unknown }).__dpTiles = tiles.current; }, []);
  const onPick = (t: TileSpec) => onSelect({ kind: 'node', id: t.companyId });
  const onPickEdge = (id: string) => onSelect({ kind: 'edge', id });
  const cx = (layout.bounds.minX + layout.bounds.maxX) / 2;
  const cz = (layout.bounds.minZ + layout.bounds.maxZ) / 2;
  const dofRange = 14;
  const shadowSpan = Math.max(layout.bounds.maxX - layout.bounds.minX, layout.bounds.maxZ - layout.bounds.minZ) * 0.75;

  return (
    <>
      <color attach="background" args={['#12181d']} />
      <fog attach="fog" args={['#12181d', 26, 64]} />
      <ambientLight intensity={0.12} />
      <hemisphereLight args={['#b9c7d4', '#1a1410', 0.35]} />
      <directionalLight
        position={[cx - 9, 16, cz + 7]} intensity={2.4} color="#ffe6c4" castShadow
        shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.03}
        shadow-camera-left={-shadowSpan} shadow-camera-right={shadowSpan} shadow-camera-top={shadowSpan} shadow-camera-bottom={-shadowSpan}
        shadow-camera-near={1} shadow-camera-far={60}
        target-position={[cx, 0, cz]}
      />
      <directionalLight position={[cx + 12, 6, cz - 14]} intensity={0.9} color="#8fb4d6" />
      <spotLight position={[cx, 18, cz]} angle={0.75} penumbra={1} intensity={60} distance={45} color="#fff1dc" />
      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={2.2} color="#fff1dc" position={[0, 6, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 6, 1]} />
        <Lightformer form="rect" intensity={1.1} color="#9fc4e6" position={[10, 2, -6]} rotation={[0, -Math.PI / 3, 0]} scale={[8, 3, 1]} />
        <Lightformer form="ring" intensity={0.8} color="#f3a43b" position={[-8, 2, 6]} scale={4} />
      </Environment>

      <Physics gravity={[0, -19.6, 0]} timeStep={1 / 60} paused={paused}>
        <Table layout={layout} />
        {layout.tiles.map((t) => <CompanyTile key={t.key} spec={t} register={register} onPick={onPick} hud={hud} />)}
        {layout.spacers.length > 0 && <Spacers layout={layout} bodies={spacers} onPickEdge={onPickEdge} />}
        <Director
          layout={layout} hud={hud} tiles={tiles} spacers={spacers} reducedMotion={reducedMotion}
          hiringFilterView={hiringFilterView} selectedCompany={selectedCompany} focusTarget={focusTarget} autoplay={autoplay}
        />
      </Physics>

      <Cards layout={layout} hud={hud} snap={snap} />
      <LaneLabels layout={layout} hud={hud} />
      <RowLabel layout={layout} hud={hud} />

      <EffectComposer multisampling={4}>
        <DepthOfField target={focusTarget} worldFocusRange={dofRange} bokehScale={reducedMotion ? 0 : 2.6} />
        <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.82} luminanceSmoothing={0.2} />
        <Vignette eskil={false} offset={0.22} darkness={0.78} />
      </EffectComposer>
    </>
  );
}

export function clockLabel(layout: TableLayout, day: number): string {
  return fmtFull(addDays(layout.asOf, day));
}
