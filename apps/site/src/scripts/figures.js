/**
 * Two more Hairline figures for "How it works", drawn with the same kernel and camera as Forks
 * so the three steps read as one set.
 *
 * Rules: a repo plinth with five code lines and a rule tablet standing at its edge. The pointer
 * reads the code: lines lift around it and the tablet rises a little, as if being written.
 *
 * Proof: forty run tiles, one per seed. Kept runs lie flat; the seven broken runs stand up in
 * seal red. The pointer lifts the tile under it and the read-out names that run.
 */
// HL is the Hairline kernel (MIT, © Lucas Marques), loaded as a classic script from /vendor/hairline-kernel.js.
const { Cam, facing, fit, prism, proj, rings, unproj, spring, stepS, pointer, put, register, disposer, solid, mk } = globalThis.HL;

const PB = 6, PAD = 7;

/** Shared scene: camera fitted to a plinth of ex × ey with room for `top` of height. */
function scene(svg, ex, ey, top) {
  const C = Cam(45, 0.5, 2.45);
  fit(C, [[-PAD, -PAD, -PB], [ex + PAD, ey + PAD, -PB], [ex + PAD, -PAD, -PB], [-PAD, ey + PAD, -PB], [0, 0, top]], 200, 166);
  const P = proj(C), front = facing(C);
  const g = mk("g", {}, svg);
  const [pr, pi] = rings(-PAD, -PAD, ex + PAD, ey + PAD, 8, 2);
  put(solid(g), prism(P, front, pr, pi, -PB, 0));
  return { C, P, front, g };
}

/** A box on the plinth that springs to a target height. */
function box(g, x0, y0, x1, y1, h, r = 2.4) {
  const [ring, inner] = rings(x0, y0, x1, y1, r, 0.9);
  return { x0, y0, x1, y1, h0: h, ring, inner, el: solid(g), sp: spring(h, { eps: 0.04 }), drawn: NaN };
}
function draw(P, front, b) {
  const h = Math.max(0.6, b.sp.x);
  if (h === b.drawn) return;
  b.drawn = h;
  put(b.el, prism(P, front, b.ring, b.inner, 0, h));
}

function mountRules({ stage, svg, read }) {
  const bag = disposer();
  const EX = 120, EY = 75;
  const { C, P, front, g } = scene(svg, EX, EY, 46);
  const LENS = [62, 44, 70, 36, 54];
  // far rows first so appending paints back to front; the tablet sits nearest, so it goes last
  const lines = LENS.map((len, j) => box(g, 6, 7 + j * 13, 6 + len, 7 + j * 13 + 6, 2.2, 1.6));
  const tablet = box(g, 92, 10, 110, 66, 26);
  const parts = [...lines, tablet];

  const B = register(stage, (dt) => {
    let moving = false;
    for (const b of parts) { if (stepS(b.sp, dt)) moving = true; draw(P, front, b); }
    return moving;
  });
  bag.add(B.unregister);

  const rest = () => { for (const b of parts) b.sp.t = b.h0; read.textContent = "reads 5 lines"; B.wake(); };
  rest();
  bag.add(pointer(stage, {
    move: (p) => {
      const [x, y] = unproj(C, p[0], p[1], 0);
      let near = -1, best = Infinity;
      lines.forEach((b, j) => {
        const d = Math.abs(y - (b.y0 + b.y1) / 2) + Math.max(0, x - b.x1, b.x0 - x) * 0.3;
        b.sp.t = b.h0 + Math.max(0, 9 - d) * 0.9;
        if (d < best) { best = d; near = j; }
      });
      const onTablet = x > tablet.x0 - 4 && y > tablet.y0 - 4 && y < tablet.y1 + 4;
      tablet.sp.t = tablet.h0 + (onTablet || best < 8 ? 8 : 0);
      read.textContent = onTablet ? "rule · one charge per payment" : best < 8 ? `reading line ${near + 1}` : "reads 5 lines";
      B.wake();
    },
    leave: rest,
  }));
  bag.add(() => svg.replaceChildren());
  return { set: () => {}, destroy: bag.dispose };
}

function mountProof({ stage, svg, read }, broken) {
  const bag = disposer();
  const NX = 10, NY = 4, CELL = 12, FOOT = 9.5, TALL = 12;
  const EX = NX * CELL, EY = NY * CELL;
  const { C, P, front, g } = scene(svg, EX, EY, TALL + 8);
  const tiles = [];
  for (let s = 0; s <= NX + NY - 2; s++) for (let i = 0; i < NX; i++) {
    const j = s - i;
    if (j < 0 || j >= NY) continue;
    const run = j * NX + i + 1, bad = broken.has(run);
    const x0 = i * CELL + (CELL - FOOT) / 2, y0 = j * CELL + (CELL - FOOT) / 2;
    const t = box(g, x0, y0, x0 + FOOT, y0 + FOOT, bad ? TALL : 1.2, 1.8);
    t.run = run; t.bad = bad; t.i = i; t.j = j;
    if (bad) t.el.sil.classList.add("hi");
    tiles.push(t);
  }
  const B = register(stage, (dt) => {
    let moving = false;
    for (const t of tiles) { if (stepS(t.sp, dt)) moving = true; draw(P, front, t); }
    return moving;
  });
  bag.add(B.unregister);

  const summary = `broke on ${broken.size} of ${NX * NY} runs`;
  const rest = () => { for (const t of tiles) t.sp.t = t.h0; read.textContent = summary; B.wake(); };
  rest();
  bag.add(pointer(stage, {
    move: (p) => {
      const [x, y] = unproj(C, p[0], p[1], 0);
      const i = Math.floor(x / CELL), j = Math.floor(y / CELL);
      for (const t of tiles) t.sp.t = t.h0 + (t.i === i && t.j === j ? 7 : 0);
      const hit = tiles.find((t) => t.i === i && t.j === j);
      read.textContent = hit ? `run ${hit.run} · ${hit.bad ? "broke" : "kept"}` : summary;
      B.wake();
    },
    leave: rest,
  }));
  bag.add(() => svg.replaceChildren());
  return { set: () => {}, destroy: bag.dispose };
}

export const rules = {
  name: "rules",
  means: "Claude reads five lines of code and writes one rule from them.",
  tour: [[130, 150], [175, 175], [250, 150], null],
  mount: (host) => mountRules(host),
};

export const proof = {
  name: "proof",
  means: "Forty runs of one rule: kept runs lie flat, the seven broken runs stand up in red.",
  tour: [[150, 160], [205, 175], [250, 150], null],
  mount: (host, broken) => mountProof(host, broken),
};
