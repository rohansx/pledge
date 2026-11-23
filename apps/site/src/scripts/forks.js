/**
 * Forks: one snapshot (the plinth) holding forty forks, one per seed, in an
 * 8 × 5 field. The pointer is the fault proxy: forks rise around it as the
 * fault reaches them, falling off with distance. Seven forks are the seeds
 * where the pledge breaks; each carries a 2 × 2 dot mark on its lid, rises
 * further, and the nearest one in reach takes the bright stroke. At rest the
 * field is a low dune and the bright mark sits on seed 0x0e, the one a finding
 * would replay. The slider is the fault's reach, in cells.
 */
// HL is the Hairline kernel (MIT, © Lucas Marques), loaded as a classic script from /vendor/hairline-kernel.js.
const {
  Cam, clamp, facing, fit, prism, proj, rings, unproj, spring, stepS,
  mk, place, pointer, put, register, disposer, solid,
} = globalThis.HL;

const NX = 8, NY = 5, CELL = 15, FOOT = 11.5, HMAX = 40, LIFT = 12, PB = 6, PAD = 7;
const EX = NX * CELL, EY = NY * CELL;
const BROKEN = new Set([3, 9, 14, 21, 26, 33, 38]); // seeds, 1-based, read row by row
const REST_SEED = 14;

/** Share of full height at u radii from the pointer: 1 → .31 at 42% → .09 beyond (Terrain's falloff). */
const falloff = (u) =>
  u <= 0 ? 1 : u <= 0.417 ? 1 - (u / 0.417) * 0.6875 : u <= 1 ? 0.3125 - ((u - 0.417) / 0.583) * 0.2185 : 0.094;
const hex = (s) => "0x" + s.toString(16).padStart(2, "0");

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  const C = Cam(45, 0.5, 2.45);
  fit(C, [[-PAD, -PAD, -PB], [EX + PAD, EY + PAD, -PB], [EX + PAD, -PAD, -PB], [-PAD, EY + PAD, -PB], [0, 0, HMAX + LIFT]], 200, 166);
  const P = proj(C), front = facing(C);
  let R = value * CELL, over = null;

  const g = mk("g", {}, svg), forks = [];
  const [pr, pi] = rings(-PAD, -PAD, EX + PAD, EY + PAD, 8, 2);
  put(solid(g), prism(P, front, pr, pi, -PB, 0));

  // Diagonal by diagonal from the far corner, so appending paints back to front.
  for (let s = 0; s <= NX + NY - 2; s++) for (let i = 0; i < NX; i++) {
    const j = s - i;
    if (j < 0 || j >= NY) continue;
    const seed = j * NX + i + 1, u = i / (NX - 1), v = j / (NY - 1);
    const h0 = 3 + 13 * Math.exp(-((u - 0.22) ** 2 + (v - 0.75) ** 2) / 0.09) + 8 * Math.exp(-((u - 0.82) ** 2 + (v - 0.2) ** 2) / 0.05);
    const x0 = i * CELL + (CELL - FOOT) / 2, y0 = j * CELL + (CELL - FOOT) / 2;
    const [ring, inner] = rings(x0, y0, x0 + FOOT, y0 + FOOT, 2.4, 0.9);
    const el = solid(g), bad = BROKEN.has(seed);
    // broken forks carry a 2 × 2 dot mark on the lid, painted with their own group
    const dots = bad ? [0, 1, 2, 3].map(() => mk("circle", { r: 0.95, class: "dot m" }, el.g)) : [];
    forks.push({ i, j, seed, bad, h0, ring, inner, el, dots, sp: spring(h0, { eps: 0.04 }), drawn: NaN });
  }
  const bySeed = new Map(forks.map((f) => [f.seed, f]));
  let lit = bySeed.get(REST_SEED);

  function draw(f) {
    const h = Math.max(0.6, f.sp.x);
    if (h === f.drawn) return;
    f.drawn = h;
    put(f.el, prism(P, front, f.ring, f.inner, 0, h));
    const cx = (f.i + 0.5) * CELL, cy = (f.j + 0.5) * CELL;
    f.dots.forEach((d, k) => place(d, P(cx + ((k % 2) - 0.5) * 3.4, cy + (Math.floor(k / 2) - 0.5) * 3.4, h)));
  }
  function light(f) {
    if (f === lit) return;
    for (const x of [lit, f]) if (x) {
      const on = x === f;
      x.el.sil.classList.toggle("hi", on);
      x.dots.forEach((d) => d.classList.toggle("m", !on));
    }
    lit = f;
  }
  light(null); light(bySeed.get(REST_SEED));

  const B = register(stage, (dt) => {
    let m = false;
    for (const f of forks) { if (stepS(f.sp, dt)) m = true; draw(f); }
    return m;
  });
  bag.add(B.unregister);

  function retarget() {
    if (!over) {
      for (const f of forks) f.sp.t = f.h0;
      light(bySeed.get(REST_SEED));
      read.textContent = "rest";
      B.wake();
      return;
    }
    let near = null, nd = Infinity;
    for (const f of forks) {
      const d = Math.hypot((f.i + 0.5) * CELL - over[0], (f.j + 0.5) * CELL - over[1]);
      const k = falloff(d / R);
      f.sp.t = Math.max(f.h0, HMAX * k + (f.bad && d < R ? LIFT : 0));
      if (f.bad && d < R && d < nd) { near = f; nd = d; }
    }
    light(near);
    const i = clamp(Math.floor(over[0] / CELL), 0, NX - 1), j = clamp(Math.floor(over[1] / CELL), 0, NY - 1);
    const f = bySeed.get(j * NX + i + 1);
    read.textContent = `seed ${hex(f.seed)} · ${f.bad ? "broke" : "kept"}`;
    B.wake();
  }

  bag.add(pointer(stage, {
    move: (p) => { over = unproj(C, p[0], p[1], 0); retarget(); },
    leave: () => { over = null; retarget(); },
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => { R = v * CELL; if (over) retarget(); },
    destroy: bag.dispose,
  };
}

// Built and validated on the hairline-create bench; exported here for the site's own host (hero-figure.ts).
export const forks = {
  name: "forks",
  means: "Forty forks of one snapshot: a fault sweeps across them, and the seeds where the pledge breaks stand up.",
  rules: [1, 3, 4, 5],
  range: [1.5, 2.5, 4],
  tour: [[150, 190], [215, 150], [270, 175], null],
  mount,
};
