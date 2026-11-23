// Hero demo: a sequence diagram that walks through one bug, then the verdict.
// Lanes: 0 Customer · 1 Your app · 2 Database · 3 Payments (fake).

type Lane = 0 | 1 | 2 | 3;

interface Arrow {
  from: Lane;
  to: Lane;
  label: string;
  fault?: string;      // what Pledge's proxy did to this message
  dropped?: boolean;   // the message never arrives
}

interface Step {
  caption: string;
  arrows?: Arrow[];
  ledger?: { text: string; bad?: boolean };
}

interface Scenario {
  pledge: string;
  check: string;
  ledgerTitle: string;
  steps: Step[];
  verdict: string;
  cause: string;
  broken: readonly number[];   // which of the 40 seeds broke
  replay: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    pledge: 'One charge per payment.',
    check: 'count(charges WHERE payment_id = pay_8812) = 1',
    ledgerTitle: 'payments fake · charges',
    steps: [
      { caption: 'A customer pays $49.', arrows: [{ from: 0, to: 1, label: 'POST /checkout · pay_8812' }] },
      { caption: 'Your app charges the card.', arrows: [{ from: 1, to: 3, label: 'charge $49' }], ledger: { text: 'ch_1 · pay_8812 · $49' } },
      { caption: 'Pledge drops the reply.', arrows: [{ from: 1, to: 0, label: '200 OK', fault: 'reply dropped', dropped: true }] },
      { caption: 'The customer retries.', arrows: [{ from: 0, to: 1, label: 'POST /checkout · retry' }] },
      { caption: 'The card is charged again.', arrows: [{ from: 1, to: 3, label: 'charge $49' }], ledger: { text: 'ch_2 · pay_8812 · $49', bad: true } },
    ],
    verdict: 'expected 1 charge · found 2',
    cause: '/checkout ignores the Idempotency-Key header',
    broken: [3, 9, 14, 21, 26, 33, 38],
    replay: 'pledge replay r_91c --seed 0x0e',
  },
  {
    pledge: 'Each paid order ships once.',
    check: 'count(shipments WHERE order_id = ord_3310) = 1',
    ledgerTitle: 'database · shipments',
    steps: [
      { caption: 'The payment provider confirms the order.', arrows: [{ from: 3, to: 1, label: 'webhook payment.paid · ord_3310' }] },
      { caption: 'Your app books a shipment.', arrows: [{ from: 1, to: 2, label: 'INSERT shipment' }], ledger: { text: 'shp_1 · ord_3310' } },
      { caption: 'Pledge sends the same webhook again.', arrows: [{ from: 3, to: 1, label: 'webhook payment.paid · ord_3310', fault: 'duplicate delivery' }] },
      { caption: 'The order ships twice.', arrows: [{ from: 1, to: 2, label: 'INSERT shipment' }], ledger: { text: 'shp_2 · ord_3310', bad: true } },
    ],
    verdict: 'expected 1 shipment · found 2',
    cause: 'webhook handler never records evt_id',
    broken: [6, 17, 29, 35],
    replay: 'pledge replay r_a04 --seed 0x11',
  },
  {
    pledge: 'Stock never goes below zero.',
    check: 'min(products.stock WHERE sku = kettle) >= 0',
    ledgerTitle: 'database · products.stock',
    steps: [
      { caption: 'One kettle left in stock.', ledger: { text: 'kettle · stock 1' } },
      { caption: 'Pledge sends two checkouts at once.', arrows: [{ from: 0, to: 1, label: 'POST /checkout · kettle ×2', fault: 'same-instant' }] },
      { caption: 'Both see one in stock.', arrows: [{ from: 1, to: 2, label: 'SELECT stock → 1 ×2' }] },
      { caption: 'The last kettle sells twice.', arrows: [{ from: 1, to: 2, label: 'UPDATE stock = stock − 1 ×2' }], ledger: { text: 'kettle · stock −1', bad: true } },
    ],
    verdict: 'expected stock ≥ 0 · found −1',
    cause: 'read-then-write without a row lock',
    broken: [2, 5, 11, 12, 18, 22, 27, 31, 34, 37, 40],
    replay: 'pledge replay r_c7e --seed 0x05',
  },
];

const TOTAL_SEEDS = 40;
const STEP_MS = 1900;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const timers: ReturnType<typeof setTimeout>[] = [];

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`demo: missing #${id}`);
  return node;
};
const later = (fn: () => void, ms: number): void => { timers.push(setTimeout(fn, reduce ? 0 : ms)); };
const clearTimers = (): void => { timers.splice(0).forEach(clearTimeout); };
const center = (lane: Lane): number => 12.5 + lane * 25;

function arrowEl(a: Arrow): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const left = Math.min(center(a.from), center(a.to));
  const width = Math.abs(center(a.to) - center(a.from));
  const arrow = document.createElement('div');
  arrow.className = `arrow ${a.to > a.from ? 'to-r' : 'to-l'}${a.dropped ? ' dropped' : ''}${a.fault ? ' faulted' : ''}`;
  arrow.style.left = `${left}%`;
  arrow.style.width = `${width}%`;
  const label = document.createElement('span');
  label.className = 'lbl';
  label.textContent = a.label;
  arrow.append(label, Object.assign(document.createElement('i'), { className: 'line' }));
  if (a.fault) {
    const f = document.createElement('span');
    f.className = 'fault';
    f.textContent = `Pledge · ${a.fault}`;
    arrow.append(f);
  }
  row.append(arrow);
  requestAnimationFrame(() => requestAnimationFrame(() => arrow.classList.add('drawn')));
  return row;
}

function ledgerRow(text: string, bad = false): void {
  const r = document.createElement('div');
  r.className = `lrow${bad ? ' bad' : ''}`;
  r.textContent = text;
  $('ledger').append(r);
}

function setBadge(state: 'watching' | 'broken'): void {
  const b = $('badge');
  b.className = `badge ${state}`;
  b.textContent = state === 'broken' ? 'BROKEN' : 'watching';
}

function fillSeeds(s: Scenario): void {
  const cells = Array.from($('seeds').children) as HTMLElement[];
  cells.forEach((c, i) => later(() => { c.className = s.broken.includes(i + 1) ? 'no' : 'ok'; }, i * 30));
  later(() => {
    $('seedMeta').textContent = `broke on ${s.broken.length} of ${TOTAL_SEEDS} seeds`;
  }, TOTAL_SEEDS * 30);
}

function verdict(s: Scenario, index: number): void {
  setBadge('broken');
  $('caption').textContent = `The pledge breaks: ${s.verdict}.`;
  $('finding').innerHTML = '';
  const lines: [string, string][] = [['likely cause', s.cause], ['replay', s.replay]];
  for (const [k, v] of lines) {
    const row = document.createElement('div');
    row.innerHTML = `<span>${k}</span>`;
    row.append(Object.assign(document.createElement('code'), { textContent: v }));
    $('finding').append(row);
  }
  $('finding').classList.add('show');
  fillSeeds(s);
  later(() => play((index + 1) % SCENARIOS.length), 7000);
}

function play(index: number): void {
  clearTimers();
  const s = SCENARIOS[index];
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.setAttribute('aria-selected', String(Number(t.dataset.s) === index)));
  $('pTitle').textContent = s.pledge;
  $('pCheck').textContent = s.check;
  $('ledgerH').textContent = s.ledgerTitle;
  $('ledger').innerHTML = '';
  $('rows').innerHTML = '';
  $('finding').classList.remove('show');
  $('finding').innerHTML = '';
  $('seedMeta').textContent = '';
  Array.from($('seeds').children).forEach((c) => { c.className = ''; });
  setBadge('watching');

  s.steps.forEach((step, i) => later(() => {
    $('caption').textContent = step.caption;
    $('stepNo').textContent = `${i + 1} / ${s.steps.length + 1}`;
    step.arrows?.forEach((a) => $('rows').append(arrowEl(a)));
    if (step.ledger) ledgerRow(step.ledger.text, step.ledger.bad);
  }, i * STEP_MS));
  later(() => {
    $('stepNo').textContent = `${s.steps.length + 1} / ${s.steps.length + 1}`;
    verdict(s, index);
  }, s.steps.length * STEP_MS);
}

if (document.getElementById('demo')) {
  $('seeds').append(...Array.from({ length: TOTAL_SEEDS }, () => document.createElement('i')));
  document.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.addEventListener('click', () => play(Number(t.dataset.s))));
  play(0);
}
