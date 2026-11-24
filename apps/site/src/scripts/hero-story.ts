// Plays the hero's pull-request story: checks go green, Pledge runs 40 times, a rule breaks,
// the merge is blocked. Loops through three bugs so the page isn't only about payments.
// Mock data: illustrative findings, not a real customer's.
export {}; // a module, so its names don't collide with demo.ts

interface Scenario {
  title: string; num: string; unit: number; integ: number;
  rule: string; broken: readonly number[];
  found: string; cause: string; impact: string; replay: string;
}

const SCENARIOS: readonly Scenario[] = [
  { title: 'Retry failed checkouts', num: '#482', unit: 214, integ: 38,
    rule: 'One charge per payment.', broken: [3, 9, 14, 21, 26, 33, 38],
    found: '2 charges for pay_8812, expected 1', cause: '/checkout ignores the Idempotency-Key header',
    impact: 'A customer is charged $98 for a $49 order', replay: '$ pledge replay r_91c --seed 0x0e' },
  { title: 'Process payment webhooks async', num: '#517', unit: 231, integ: 41,
    rule: 'Each paid order ships once.', broken: [6, 17, 29, 35],
    found: '2 shipments for ord_3310, expected 1', cause: 'the webhook handler never records the event id',
    impact: 'The same order ships to the customer twice', replay: '$ pledge replay r_a04 --seed 0x11' },
  { title: 'Faster checkout for flash sales', num: '#530', unit: 236, integ: 44,
    rule: 'Stock never goes below zero.', broken: [2, 5, 11, 12, 18, 22, 27, 31, 34, 37, 40],
    found: 'stock is −1 for sku kettle, expected ≥ 0', cause: 'read-then-write without a row lock',
    impact: 'The last kettle is sold to two customers', replay: '$ pledge replay r_c7e --seed 0x05' },
];

const RUNS = 40;
const RUN_MS = 65;          // one run filling in
const HOLD_MS = 7000;       // how long the verdict stays up
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

const story = document.getElementById('story');
if (story) {
  const $ = (id: string): HTMLElement => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`hero-story: missing #${id}`);
    return node;
  };
  const timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, fn: () => void): void => { timers.push(setTimeout(fn, ms)); };
  const runs = $('sRuns');
  runs.append(...Array.from({ length: RUNS }, () => document.createElement('i')));
  const cells = Array.from(runs.children) as HTMLElement[];
  const dots = Array.from(story.querySelectorAll<HTMLElement>('.s-dots i'));

  const check = (id: string, state: 'wait' | 'run' | 'ok' | 'bad', text: string): void => {
    $(id).dataset.state = state;
    $(`${id}T`).textContent = text;
  };

  const fill = (s: Scenario): void => {
    $('sTitle').textContent = s.title;
    $('sNum').textContent = s.num;
    $('sRule').textContent = s.rule;
    $('fBroke').textContent = `${s.broken.length} of ${RUNS} runs`;
    $('fFound').textContent = s.found;
    $('fCause').textContent = s.cause;
    $('fImpact').textContent = s.impact;
    $('sReplay').textContent = s.replay;
  };

  const verdict = (s: Scenario): void => {
    check('cPl', 'bad', `1 rule broken on ${s.broken.length} of ${RUNS} runs`);
    $('sMergeT').textContent = 'Merge blocked: your tests passed, Pledge didn’t.';
    story.dataset.phase = 'blocked';
  };

  const play = (index: number): void => {
    const s = SCENARIOS[index];
    timers.splice(0).forEach(clearTimeout);
    dots.forEach((d, i) => d.classList.toggle('on', i === index));
    fill(s);
    cells.forEach((c) => { c.className = ''; });
    story.dataset.phase = 'checking';
    $('sMergeT').textContent = 'Waiting for checks…';
    check('cUnit', 'wait', 'waiting');
    check('cInt', 'wait', 'waiting');
    check('cPl', 'wait', 'waiting');

    at(300, () => check('cUnit', 'run', 'running'));
    at(550, () => check('cInt', 'run', 'running'));
    at(1300, () => check('cUnit', 'ok', `${s.unit} passed`));
    at(1700, () => check('cInt', 'ok', `${s.integ} passed`));
    at(1900, () => { check('cPl', 'run', `running 0 of ${RUNS}`); story.dataset.phase = 'running'; });
    let broke = 0;
    cells.forEach((c, i) => at(2100 + i * RUN_MS, () => {
      const bad = s.broken.includes(i + 1);
      if (bad) broke++;
      c.className = bad ? 'no' : 'ok';
      $('cPlT').textContent = `running ${i + 1} of ${RUNS}${broke ? ` · ${broke} broken` : ''}`;
    }));
    const done = 2100 + RUNS * RUN_MS + 250;
    at(done, () => verdict(s));
    at(done + HOLD_MS, () => { story.dataset.phase = 'out'; });
    at(done + HOLD_MS + 450, () => play((index + 1) % SCENARIOS.length));
  };

  if (reduce) {
    // no motion: show the finished story for the first bug
    const s = SCENARIOS[0];
    fill(s);
    cells.forEach((c, i) => { c.className = s.broken.includes(i + 1) ? 'no' : 'ok'; });
    check('cUnit', 'ok', `${s.unit} passed`);
    check('cInt', 'ok', `${s.integ} passed`);
    verdict(s);
  } else {
    play(0);
  }
}
