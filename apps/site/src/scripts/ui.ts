// Page chrome: theme toggle, scroll reveals, marquee loop, card arrows.

type Theme = 'light' | 'dark';

function currentTheme(root: HTMLElement): Theme {
  if (root.dataset.theme === 'light' || root.dataset.theme === 'dark') return root.dataset.theme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

document.getElementById('theme')?.addEventListener('click', () => {
  const root = document.documentElement;
  const next: Theme = currentTheme(root) === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('pledge-theme', next); } catch { /* storage blocked: theme still applies for this visit */ }
});

const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('in');
    io.unobserve(e.target);
  }
}, { threshold: 0.25 });
document.querySelectorAll('.reveal, .fade').forEach((el) => io.observe(el));

// duplicate marquee content so the -50% translate loops seamlessly
document.querySelectorAll<HTMLElement>('[data-dup]').forEach((t) => { t.innerHTML += t.innerHTML; });

// "Join" links lower on the page jump to the hero form and put the cursor in it
document.querySelectorAll<HTMLAnchorElement>('[data-focus-join]').forEach((a) =>
  a.addEventListener('click', () => {
    setTimeout(() => document.querySelector<HTMLInputElement>('#waitlist input[type="email"], #waitlist input')?.focus({ preventScroll: true }), 500);
  }));

const cards = document.getElementById('cards');
document.querySelectorAll<HTMLButtonElement>('.arrows button').forEach((b) =>
  b.addEventListener('click', () => cards?.scrollBy({ left: 286 * Number(b.dataset.dir), behavior: 'smooth' })));
