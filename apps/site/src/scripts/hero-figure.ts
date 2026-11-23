// Mounts the Forks figure in the hero: the part of Hairline's bench a page needs, and nothing else.
import { forks } from './forks.js';

interface Kernel {
  inject(root: Document): void;
  mk(tag: string, attrs: Record<string, string>, parent: Element): SVGElement;
  tour(stage: HTMLElement, stops: (number[] | null)[], onStop: (i: number) => void): { stop(): void };
  reducedMotion(): boolean;
}

const HL = (globalThis as unknown as { HL?: Kernel }).HL;
const stage = document.getElementById('forks');
const readout = document.getElementById('forks-read');

if (HL && stage && readout) {
  HL.inject(document);
  stage.setAttribute('data-hairline', forks.name);
  stage.setAttribute('role', 'img');
  stage.setAttribute('aria-label', forks.means);
  const svg = HL.mk('svg', { viewBox: '0 0 400 320', 'aria-hidden': 'true' }, stage);

  // the figure writes its caption here; it lands in the corner read-out
  const read = {
    set textContent(v: string) { readout.textContent = v; },
    get textContent() { return readout.textContent ?? ''; },
  };
  const [, mid] = forks.range;
  forks.mount({ stage, svg, read }, mid);
  if (!readout.textContent) readout.textContent = 'rest';

  // like the package's `play`: an unseen pointer walks the tour until a real one arrives
  if (!HL.reducedMotion()) HL.tour(stage, forks.tour, () => {});
}
