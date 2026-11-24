// Mounts the three Hairline figures in "How it works": the part of Hairline's bench a page needs, and nothing else.
import { forks } from './forks.js';
import { rules, proof } from './figures.js';

interface Kernel {
  inject(root: Document): void;
  mk(tag: string, attrs: Record<string, string>, parent: Element): SVGElement;
  tour(stage: HTMLElement, stops: (number[] | null)[], onStop: (i: number) => void): { stop(): void };
  reducedMotion(): boolean;
}
interface Figure {
  name: string;
  means: string;
  tour: (number[] | null)[];
  mount(host: { stage: HTMLElement; svg: SVGElement; read: { textContent: string } }, value: unknown): unknown;
}

const BROKEN = new Set([3, 9, 14, 21, 26, 33, 38]); // the same seven runs break everywhere on the page
const HL = (globalThis as unknown as { HL?: Kernel }).HL;

function mountFigure(kernel: Kernel, fig: Figure, stageId: string, readId: string, value: unknown): void {
  const stage = document.getElementById(stageId);
  const readout = document.getElementById(readId);
  if (!stage || !readout) return;
  stage.setAttribute('data-hairline', fig.name);
  stage.setAttribute('role', 'img');
  stage.setAttribute('aria-label', fig.means);
  const svg = kernel.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, stage);
  // the figure writes its caption here; it lands in the card's corner read-out
  const read = {
    set textContent(v: string) { readout.textContent = v; },
    get textContent() { return readout.textContent ?? ''; },
  };
  fig.mount({ stage, svg, read }, value);
  if (!readout.textContent) readout.textContent = 'point at a run';
  // like the package's `play`: an unseen pointer walks the tour until a real one arrives
  if (!kernel.reducedMotion()) kernel.tour(stage, fig.tour, () => {});
}

if (HL) {
  HL.inject(document);
  mountFigure(HL, rules as Figure, 'fig-rules', 'fig-rules-read', undefined);
  mountFigure(HL, forks as Figure, 'forks', 'forks-read', forks.range[1]);
  mountFigure(HL, proof as Figure, 'fig-proof', 'fig-proof-read', BROKEN);
}
