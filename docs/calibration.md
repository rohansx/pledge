# pledge — Calibration Model

**Version:** 1.0
**Status:** Design
**Implementation:** `apps/calibration` (Python), serving in `apps/web` (TypeScript)
**Ships in:** v2 ([`roadmap.md`](./roadmap.md))

Calibration is the differentiator. It is also the part most likely to be quietly wrong —
statistical bugs don't throw exceptions, they produce plausible numbers. This document
specifies the model, the two places naive implementations fail, and the tests that catch it.

---

## 1. What we are estimating

For user *i*, commitment *j*:

```
estimated_days_ij = deadline_original - committed_at
actual_days_ij    = resolved_at - committed_at
y_ij              = log(actual_days_ij / estimated_days_ij)
```

`y = 0` means dead-on. `y > 0` means slipped. Log space because slip ratios are multiplicative
and right-skewed: 2x late and 0.5x early should be symmetric, and in raw ratio space they are
not.

**Two honest caveats stated before the model, because they bound what any of this means:**

1. **`estimated_days` is a self-set deadline, not an estimate elicited under neutral
   conditions.** A user who learns to pad reaches 95% on-time and learns nothing. What is
   measured is *deadline-setting accuracy*, which is correlated with but not identical to
   velocity. The forecast UI should say "your deadlines" not "your speed."
2. **`actual_days` is observation time, not completion time.** It is bounded below by the
   true completion and above by probe frequency
   ([`architecture.md` §6.2](./architecture.md)). Copy says *observed*, never *shipped at*.

Neither invalidates the product. Both must be said out loud, or the first person to notice
says it for you.

---

## 2. The model

Hierarchical, partially pooled, in log space.

```
y_ij  ~ Normal(mu_i + beta · x_ij,  sigma_i^2)

mu_i    ~ Normal(mu_pop, tau^2)          # per-user bias, pooled toward the population
sigma_i ~ HalfNormal(sigma_pop)          # per-user consistency
beta    ~ Normal(0, 1)                   # shared feature effects
```

| Parameter | Meaning |
|---|---|
| `mu_i` | user *i*'s systematic optimism. `exp(mu_i)` is their typical slip multiplier |
| `sigma_i` | user *i*'s variability. Two users can share a median and differ entirely in predictability |
| `beta` | how much each work-type feature shifts slip, **shared across all users** |
| `mu_pop`, `tau` | population mean bias and between-user spread |

### 2.1 Why hierarchical, concretely

A user with 3 commitments, all of which slipped 3x, has an unpooled estimate of `mu = 1.1`.
That is almost certainly noise. Partial pooling shrinks toward `mu_pop` with weight
proportional to n:

```
mu_i_hat = ( n_i/sigma^2 · ybar_i  +  1/tau^2 · mu_pop )
           / ( n_i/sigma^2  +  1/tau^2 )
```

At n=0 the forecast is the population prior. At n=3 it is mostly population, slightly
personal. At n=30 it is nearly all personal. **This is the whole reason the forecast is usable
from commitment #1**, and it is precisely what a weekend clone computing `mean(slip_ratios)`
gets wrong — such a clone shows a new user either a divide-by-zero or a wildly overconfident
number from n=1.

### 2.2 Implementation order

**Start with the closed-form conjugate fit.** With `sigma_i` fixed to a pooled estimate and
`beta = 0`, the normal-normal model above has an exact solution — pure numpy, milliseconds,
no sampling, no convergence diagnostics.

Graduate to NumPyro only when the feature vector genuinely earns it. Adding MCMC before there
is data to fit is spending the hardest week of the project on a model you cannot yet validate.

---

## 3. Features

Derived from the done-spec AST, never from user-supplied tags
([ADR-0007](./adr/0007-ast-derived-features.md)). A user who could label their own work would
label every slip "hard" and every hit "easy."

| Feature | Type | Source |
|---|---|---|
| `probe_class` | categorical | DSL §7 — trivial/weak/standard/strong |
| `n_distinct_sources` | int | count of unique sources in the AST |
| `has_third_party_api` | bool | any non-github, non-registry `http()` source |
| `has_foreign_repo` | bool | a `github.*` source on a repo the account doesn't own |
| `has_registry_publish` | bool | npm/crates/pypi source present |
| `has_temporal_clause` | bool | any `.since(commit_time)` |
| `est_days_bucket` | categorical | log-bucketed: <2, 2–7, 7–21, 21–60, >60 days |
| `class_difficulty` | float | population mean `y` for this probe class, lagged one fit cycle |
| `is_cohort` | bool | committed inside a cohort with a shared deadline |

`est_days_bucket` matters more than it looks: slip behaviour on a 2-day commitment and a
2-month one are different processes, and pooling them produces a `mu` describing neither.

**The reportable output** — "you're optimistic by ~3x on anything requiring someone else's
API" — is `beta[has_third_party_api]` combined with the user's own residuals on those
commitments. This is the sentence users screenshot, so it must be defensible: only surface a
category claim when the user has ≥3 commitments in that category, and say the n.

---

## 4. Censoring — the part naive implementations get wrong

**This is the highest-risk section in the document.**

A commitment that was `missed` and never subsequently completed has no `actual_days`. It is
**right-censored**: the true duration is *greater than* the observation window, not missing
and not zero.

| Outcome | Treatment |
|---|---|
| `kept` | exact observation of `y` |
| `missed`, later observed passing | exact observation at the later probe |
| `missed`, never passed | **right-censored** at `now - committed_at` |
| `abandoned` | **right-censored** at `resolved_at - committed_at` |
| `disputed` | excluded until resolved |
| `open` | **right-censored** at `now - committed_at`, and it grows every night |

### The failure mode

Dropping censored rows keeps only commitments that eventually completed — which
systematically excludes the slowest work. The fitted `mu` comes out optimistic. **The product
would then be biased in exactly the direction it exists to correct**, and it would be biased
flatteringly, which means nobody would report it as a bug.

### The fix

Censored likelihood. Exact rows contribute the normal log-pdf; censored rows contribute the
log survival function:

```python
from scipy.stats import norm

def log_likelihood(y, censored, mu, sigma):
    z = (y - mu) / sigma
    exact = norm.logpdf(z[~censored]).sum() - np.log(sigma) * (~censored).sum()
    cens  = norm.logsf(z[censored]).sum()      # log P(Y > y) — "at least this long"
    return exact + cens
```

Note the `open` row treatment: including still-open commitments as censored observations is
what stops a user from improving their score by simply never resolving anything.

### Required test (v2 exit criterion)

Simulate a population with known `mu`, `sigma`. Censor 30% at random windows. Fit twice —
once with the censored likelihood, once dropping censored rows. **The drop-rows fit must
visibly recover a biased-optimistic `mu`, and the censored fit must recover truth within
tolerance.** If both pass, the test is not exercising censoring and is wrong.

---

## 5. Recency weighting

People get better at estimating. Weight observations by exponential decay, ~9-month half-life:

```
w_ij = 0.5 ** (age_days / 274)
```

Applied to the likelihood contribution. `n_effective = sum(w)`, and it is `n_effective` — not
raw count — that drives pooling weight and confidence display. A user with 40 commitments all
from two years ago should be treated closer to a new user than the raw count suggests.

Half-life is a tunable knob, not a constant of nature. Validate it against held-out predictive
accuracy once there is a year of data; until then 9 months is a defensible guess and should be
labelled as one in the code.

---

## 6. Serving

The nightly fit writes one row per user:

```sql
calibration_fit(account_id uuid pk,
                mu numeric, sigma numeric,
                beta jsonb,            -- shared, denormalised per row for lookup-free serving
                n_effective numeric,
                n_total int, n_censored int,
                fitted_at timestamptz,
                model_version text)
```

Serving is arithmetic in TypeScript, so the forecast renders inline in the composer with the
date picker still open:

```ts
const xb = dot(fit.beta, features);
const z  = (Math.log(estDays) - fit.mu - xb) / fit.sigma;
const pOnTime = normalCdf(z);

const calibrated80 = estDays * Math.exp(fit.mu + xb + fit.sigma * probit(0.8));
```

`p95 < 100ms` with no sidecar in the request path (v2 exit criterion). The Python container
is never on a user-facing code path — if it dies, the app serves yesterday's row.

### Cold start

No `calibration_fit` row → population prior with `n_effective = 0`, displayed as:

> Based on **other builders' data** (you have no resolved commitments yet), an 11-day
> estimate for this kind of work lands on time about **45%** of the time. Ask again after
> a few commitments and this becomes about you.

Never show a personal-sounding number at n=0. The credibility cost of one confidently wrong
first forecast exceeds the value of every correct one after it.

### Bootstrapping the population prior

Before real data exists, seed from a synthetic corpus reflecting published software-estimation
literature (median slip ~1.5–2x, heavy right tail). **Label it synthetic in the UI**, and
replace it as soon as ~200 real resolved commitments exist. Presenting a synthetic prior as
empirical would be, precisely, an unfalsifiable claim about shipping.

---

## 7. Display rules

Non-negotiable, because presentation is where a correct model becomes a dishonest product.

1. **Never a single context-free number.** On-time rate always with `n`. Slip ratios always
   with the distribution shape.
2. **Always show volume and raw claims adjacent.** A reader must be able to judge scope
   ([`security.md`](./security.md) T-05b).
3. **Show `n_public / n_total`** — *conditional on [ADR-0008](./adr/0008-calibration-over-all-visibilities.md),
   which is Proposed, not accepted.* This rule only has meaning under the all-visibilities
   denominator; if ADR-0008 is rejected it is vacuous and rule 4 carries the honesty burden
   alone. A profile showing 12 of 35 is honest; showing 12 of 12 when 23 are hidden is the
   laundering attack ([Q-01](./open-questions.md)).
4. **Show `n_censored`.** "26 kept, 9 missed, 3 still open" is the real shape.
5. **Category claims require n ≥ 3 in that category**, and state the n.
6. **Confidence tiering:** `n_effective < 1` → population only; `< 5` → "low confidence,
   mostly population"; `< 15` → "moderate"; else "your data."
7. **Never render calibration as a rank or a percentile against other users.** That converts
   an instrument into a leaderboard, which the product explicitly refuses
   ([`product-overview.md` §8](./product-overview.md)).

---

## 8. Validation

| Check | Method | Cadence |
|---|---|---|
| Parameter recovery | Simulate known params, fit, compare | CI, every build |
| Censoring bias | §4 two-way test | CI, every build |
| Beats naive baseline at low n | Simulated users with n<5; hierarchical vs. per-user mean, on held-out log loss | CI — **this is the moat test** |
| Forecast calibration | Of commitments forecast at 40%, ~40% should land on time. Reliability diagram, decile buckets | Monthly once n>500 |
| Drift | Population `mu` over time; alert on step changes (usually a probe-scheduling bug, not human behaviour) | Weekly |

The forecast-calibration check is the one that matters long-term and the one that cannot run
until there is real data. **A product about calibration whose own forecasts are uncalibrated
is the worst available headline.** Schedule the first reliability diagram as a hard task, not
an aspiration.

---

## 9. Aggregate data (the flywheel)

Anonymised cross-user statistics — *"hackathon participants slip 2.4x on 'integrate
payments'"* — are a genuine asset and a content engine
([`product-overview.md` §4](./product-overview.md)).

Rules before publishing any aggregate:

- k-anonymity ≥ 20 accounts per reported cell; suppress smaller cells rather than rounding.
- Never publish a cell that could be a single identifiable cohort (a named hackathon with 22
  participants is not anonymous).
- Cohort-level reports go to the organizer with participant identity; public write-ups get
  the aggregate only.
- Publish the methodology, including censoring treatment. The credibility of the aggregate
  claim rests on the same footing as the individual one.
