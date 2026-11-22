# pledge — Calibration Model

**Version:** 2.0
**Status:** Design
**Supersedes:** v1.0 (duration-only). §2, §4, §5 and §13 survive largely intact; everything
else is new or materially changed.
**Implementation:** `apps/calibration` (Python, nightly), serving in `apps/web` (TypeScript)
**Ships in:** v2 ([`roadmap.md`](./roadmap.md))

Calibration is the differentiator. It is also the part most likely to be quietly wrong —
statistical bugs don't throw exceptions, they produce plausible numbers. This document
specifies both estimands, the four places naive implementations fail, and the tests that catch
each one.

---

## 0. What changed in v2, and what that costs

Read this section before editing anything downstream of it.

| # | Change | Where |
|---|---|---|
| **0.1** | **A second estimand.** v1.0 modelled duration only. The product now also claims to measure whether a stated confidence matches outcomes. Two objects, different failure modes; they must not share a word. | §1 |
| **0.2** | **A live bug in v1.0 §6 is fixed.** The serving snippet read `z = (log(estDays) - mu - xb) / sigma`. That is correct only for a `y = log(actual_days)` parameterisation, which is *not* the one §2 specifies. `y` is already a log **ratio**, so on-time is `y ≤ 0` and `z = −(mu + xb)/sigma`. The `calibrated80` line on the following row was already consistent with the log-ratio form, so the two lines contradicted each other. | §9 |
| **0.3** | **Vocabulary is fixed.** *Self-calibration* = the builder's stated `p` against their outcomes. *Forecast calibration* = **our** model's predictions against outcomes. v1.0 and the product brief called both "calibration". Variable names, copy and this document use the qualified terms without exception. | throughout |
| **0.4** | **v1.0 display rule 7 — "never render calibration as a rank" — is reversed in part.** Calibration Rank as a *gated absolute ladder* is permitted; a percentile against other users is not. That narrowing is what makes it survivable. The *seasonal leaderboard* is a separate claim and is **not** resolved here. | §8.4, §8.5, §11 |
| **0.5** | **Self-reported outcomes are excluded from the fit entirely** — not merely from the rank and the north-star metric. The reason is mathematical, not editorial. | §5.1 |
| **0.6** | **A new requirement on `apps/worker`:** a mandatory probe at the deadline boundary. Without it the binary outcome carries an ambiguity window the width of the probe interval, and no statistical treatment recovers it. | §6.1 |
| **0.7** | **A new anti-gaming threat: deadline blackout.** It follows directly from invariant I-7 and has no row in [`security.md`](./security.md) yet. | §6.4 |

---

## 1. Two estimands, and how they compose

They are not siblings bolted together. They are linked by an identity the duration model
already implies.

| Axis | Object | Estimand | Answers |
|---|---|---|---|
| **Duration** | `y_ij = log(actual/estimated)` | `mu_i`, `sigma_i`, `beta` | *How late are you, typically, on work like this?* |
| **Self-calibration** | `K_ij ∈ {0,1}` | `a_i`, `b_i` | *When you say 85%, do you ship 85% of the time?* |

`K_ij = 1` iff the done-condition was **observed TRUE at or before the original deadline**.
Original, not amended — an amendment moves the deadline and therefore asks a different
question (§7.3).

### 1.1 The link

The duration model already predicts the binary event:

```
q̂_ij = P(y_ij ≤ 0 | x_ij) = Φ( −(mu_i + βᵀx_ij) / sigma_i )
```

So the system holds three probabilities per pledge, and the entire calibration identity is the
relations between them:

| Quantity | Meaning | Source |
|---|---|---|
| `p_ij` | what the builder believes | elicited at pledge time, §7 |
| `q̂_ij` | what the builder's own history implies | duration fit, personal parameters |
| `q̂^pop_ij` | what a *typical* builder's history implies for this spec | duration fit at population parameters, AST features only |
| `K_ij` | what was observed | the probe |

Three readings, all free once both fits exist:

| Reading | What it is | Where it surfaces |
|---|---|---|
| `p` vs `K` | **self-calibration.** Brier, reliability curve, `a_i`/`b_i` | the profile; Calibration Rank |
| `p` vs `q̂` | **the overconfidence gap** — *"you said 90%; on release-sized pledges with a third-party API you land 61%"* | the Scope Negotiator's coaching line |
| `q̂^pop` vs `p` | difficulty-adjusted skill, and the weight that makes the rank ungameable | §8 |

The overconfidence gap requires **no new statistics** — it is a difference of two numbers
already computed — and it is available at `n = 0` using `q̂^pop`. It is the highest-value,
lowest-cost thing in this document.

### 1.2 Which axis drives Calibration Rank

**The self-calibration axis. Never slip.** In descending order of strength:

1. **Slip is not scope-invariant; calibration is.** Ranking on `mu_i` ranks builders on
   *speed*, which is a function of what they chose to attempt. A builder who says "60%" and
   means it is honest whether they slip 3 days or 30.
2. **Slip is already the coaching output.** It feeds the suggested deadline. Promoting a
   diagnostic to a rank target Goodharts it immediately, and the optimal play becomes *pad
   every deadline* — which destroys the value of the deadline field, the product's other
   load-bearing input.
3. **Proper scoring rules make honest reporting individually optimal** — but only
   *conditional on the question set*. That conditioning clause is where the whole anti-gaming
   argument lives (§8), and the slip model has no analogue of it.
4. Slip is heavily censored (§5). The binary axis is far less so (§6), which makes it the more
   defensible thing to hang a public tier on.

Slip keeps its existing jobs — the forecast and the coach — and gains one: it supplies the
difficulty reference `q̂^pop` that makes the rank ungameable. That shared role is why the two
axes must be fitted in one pipeline rather than side by side.

---

## 2. The duration model (unchanged from v1.0)

For user *i*, commitment *j*:

```
estimated_days_ij = deadline_original - committed_at
actual_days_ij    = resolved_at - committed_at
y_ij              = log(actual_days_ij / estimated_days_ij)
```

`y = 0` means dead-on. `y > 0` means slipped. Log space because slip ratios are multiplicative
and right-skewed: 2x late and 0.5x early should be symmetric, and in raw ratio space they are
not.

Hierarchical, partially pooled:

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

**Two honest caveats that bound what any of this means:**

1. **`estimated_days` is a self-set deadline, not an estimate elicited under neutral
   conditions.** A user who learns to pad reaches 95% on-time and learns nothing. What is
   measured is *deadline-setting accuracy*, correlated with but not identical to velocity. The
   forecast UI says "your deadlines", not "your speed."
   The self-calibration axis is **not** subject to this caveat: padding a deadline and then
   stating an honest `p` against it is fine, and padding while stating 95% is caught by §8's
   difficulty reference.
2. **`actual_days` is observation time, not completion time.** Bounded below by true
   completion and above by probe frequency ([`architecture.md`](./architecture.md) §6.2). Copy
   says *observed*, never *shipped at*.

### 2.1 Why hierarchical, concretely

A user with 3 pledges, all of which slipped 3x, has an unpooled estimate of `mu = 1.1`. That is
almost certainly noise. Partial pooling shrinks toward `mu_pop` with weight proportional to n:

```
mu_i_hat = ( n_i/sigma^2 · ybar_i  +  1/tau^2 · mu_pop )
           / ( n_i/sigma^2  +  1/tau^2 )
```

At n=0 the forecast is the population prior. At n=3 it is mostly population, slightly
personal. At n=30 it is nearly all personal. **This is the whole reason the forecast is usable
from pledge #1**, and it is precisely what a weekend clone computing `mean(slip_ratios)` gets
wrong — such a clone shows a new user either a divide-by-zero or a wildly overconfident number
from n=1.

The same argument transfers to the self-calibration axis without modification, which is why §3
is a hierarchical model and not a per-user Brier average.

### 2.2 Implementation order

**Start with the closed-form conjugate fit.** With `sigma_i` fixed to a pooled estimate and
`beta = 0`, the normal-normal model has an exact solution — pure numpy, milliseconds, no
sampling, no convergence diagnostics. Graduate to NumPyro only when the feature vector
genuinely earns it. Adding MCMC before there is data to fit spends the hardest week of the
project on a model you cannot yet validate.

---

## 3. The self-calibration estimator

### 3.1 Do not shrink the Brier score

The Brier score is a non-linear functional of the reliability curve. Shrinking the summary is
the wrong level of the hierarchy — it produces a number that is neither the user's nor the
population's and that decomposes into nothing. **Shrink the curve; derive the score from the
shrunken curve.**

### 3.2 Hierarchical logistic recalibration (primary estimator)

Cox's recalibration intercept and slope, made hierarchical. With `ℓ_ij = logit(p_ij)` and `ℓ̄`
the population mean stated logit:

```
K_ij       ~ Bernoulli(π_ij)
logit π_ij = a_i + b_i · (ℓ_ij − ℓ̄)

a_i        ~ Normal(a_pop, τ_a²)
log b_i    ~ Normal(log b_pop, τ_b²)
```

| Parameter | Reads as |
|---|---|
| `a_i = 0`, `b_i = 1` | perfectly self-calibrated |
| `a_i < 0` | overconfident **in the large** — every stated `p` is too high by a constant on the logit scale |
| `b_i < 1` | the classic overconfidence **shape** — the extremes are not earned; 95% behaves like 80% |
| `b_i > 1` | hedging — real outcomes are more separated than the stated confidences |

**Centre at `ℓ̄`, not at 0.** Uncentred, `a_i` and `b_i` are strongly posterior-correlated and
neither is identified at `n_i = 5`. Centring decorrelates them. This is not cosmetic — it is
the difference between a usable and an unusable fit at the sample sizes that will dominate the
platform for its first year. There is a CI test for it (§12).

Priors, defensible and stated as guesses:

```
a_pop     ~ Normal(0, 1)
log b_pop ~ Normal(0, 0.5)
τ_a       ~ HalfNormal(0.75)
τ_b       ~ HalfNormal(0.40)
```

Seed `a_pop < 0` and `b_pop < 1` from the planning-fallacy and overconfidence literature until
roughly 200 real non-self-reported resolutions exist, and **label it synthetic in the UI** —
the same rule §9.3 applies to the duration prior, for the same reason.

### 3.3 Why not a per-bucket Beta-Binomial

The obvious alternative is a reliability histogram with a Beta prior per confidence bucket. It
fails at the sample sizes that matter: at `n_i = 5` a user occupies at most five buckets, most
of them empty, and the empty buckets are filled entirely by the prior — producing a
"reliability curve" that is a picture of the prior with five dots on it. The two-parameter
logistic form borrows strength *across* the confidence range rather than within buckets, which
is the only way to say anything at n=5. Keep the histogram as a **display** object (§11),
drawn from the fitted curve, never as the estimator.

### 3.4 The reported score

Derive the expected Brier from the shrunken curve rather than computing it on raw pairs:

```
BS_i = (1/n_i) Σ_j [ π̂_ij (1 − π̂_ij)  +  (p_ij − π̂_ij)² ]
                     └── irreducible ──┘   └─ miscalibration ─┘
```

where `π̂_ij = logit⁻¹( â_i + b̂_i (ℓ_ij − ℓ̄) )` is the posterior-mean fitted probability of
`K = 1` given the stated `p`. The two terms are the uncertainty and reliability components of
the Murphy decomposition evaluated under the fitted model; the resolution component is handled
by §8's reference, not by this formula. A user with `n_i = 1` gets `π̂` almost entirely from the
population, so `BS_i` is almost entirely a population statement — which is correct, and which
a raw `(p − K)²` would not have been.

---

## 4. Features (unchanged from v1.0)

Derived from the done-spec AST, never from user-supplied tags
([ADR-0007](./adr/0007-ast-derived-features.md)). A user who could label their own work would
label every slip "hard" and every hit "easy."

| Feature | Type | Source |
|---|---|---|
| `probe_class` | categorical | [DSL](./spec/done-spec-dsl.md) §7 — trivial/weak/standard/strong |
| `n_distinct_sources` | int | count of unique sources in the AST |
| `has_third_party_api` | bool | any non-github, non-registry `http()` source |
| `has_foreign_repo` | bool | a `github.*` source on a repo the account doesn't own |
| `has_registry_publish` | bool | npm/crates/pypi source present |
| `has_temporal_clause` | bool | any `.since(commit_time)` |
| `est_days_bucket` | categorical | log-bucketed: <2, 2–7, 7–21, 21–60, >60 days |
| `class_difficulty` | float | population mean `y` for this probe class, lagged one fit cycle |
| `is_cohort` | bool | committed inside a cohort/covenant with a shared deadline |

`est_days_bucket` matters more than it looks: slip behaviour on a 2-day pledge and a 2-month
one are different processes, and pooling them produces a `mu` describing neither.

The same feature vector serves both axes. `q̂^pop` in §1.1 is this vector evaluated at
population parameters — no separate difficulty model, no new feature source, and therefore no
new surface on which [ADR-0007](./adr/0007-ast-derived-features.md) can be violated.

**The reportable output** — *"you're optimistic by ~3x on anything requiring someone else's
API"* — is `beta[has_third_party_api]` combined with the user's own residuals on those pledges.
This is the sentence users screenshot, so it must be defensible: only surface a category claim
at ≥3 pledges in that category, and state the n.

---

## 5. Censoring and exclusion — duration axis

**This section and §6 are the highest-risk parts of the document.**

A pledge that was `missed` and never subsequently completed has no `actual_days`. It is
**right-censored**: the true duration is *greater than* the observation window, not missing and
not zero.

| Status | Duration treatment |
|---|---|
| `kept` | exact observation of `y` |
| `missed`, later observed passing | exact observation at the later probe |
| `missed`, never passed | **right-censored** at `now − committed_at` |
| `abandoned` (the product's "dropped") | **right-censored** at `resolved_at − committed_at` |
| `disputed` | excluded until resolved |
| `open` | **right-censored** at `now − committed_at`, and it grows every night |

### 5.1 Self-reported resolutions are excluded from both axes

The new direction proposes a verification ladder — machine-verified > peer-attested >
self-reported — and proposes excluding self-reported outcomes from the north-star metric and
from Calibration Rank. **That is not enough. They must be excluded from the fit itself.**

The argument is mathematical and falsifiable, and it belongs in the ADR that records the C-1
reversal:

> A self-reported outcome is chosen by the same person who chose `p`. `(p, K)` is then not a
> forecast–outcome pair; it is a single self-consistent statement. A self-reporter attains
> `BS = 0` **by construction**, with no observation having occurred. Its information content
> about self-calibration is definitionally zero — and including such rows does not merely add
> noise, it drags `a_i` and `b_i` toward apparent perfection in proportion to how many the
> user files.

The same reasoning applies to the duration axis: a self-reported `resolved_at` is a chosen
number, not an observation, and it enters `y` directly.

Peer attestation is different in kind and stays in the fit: the attester is not the committer
([ADR-0006](./adr/0006-accountless-witnesses.md)), and collusion is a bounded, detectable
threat ([`security.md`](./security.md) T-02) rather than a definitional collapse. Whether
peer-attested rows should be **down-weighted** relative to machine-verified ones is genuinely
open — K-1 in §12.2.

### 5.2 The failure mode

Dropping censored rows keeps only pledges that eventually completed — which systematically
excludes the slowest work. The fitted `mu` comes out optimistic. **The product would then be
biased in exactly the direction it exists to correct**, and biased *flatteringly*, which means
nobody would report it as a bug.

### 5.3 The fix

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

Note the `open` row treatment: including still-open pledges as censored observations is what
stops a user from improving their score by simply never resolving anything.

---

## 6. Censoring and ambiguity — self-calibration axis

The binary axis has a *different* problem, and importing §5's reasoning wholesale gets it wrong
in both directions.

### 6.1 With a boundary probe, `K` is not censored at all

`K` asks: was the done-condition observed TRUE at or before the original deadline? If a probe
runs *at* the deadline boundary, that question is answered for every pledge, including ones
that stay open forever. **A pledge still open ten months later has `K = 0`, fully observed, not
censored.** The duration is censored; the binary outcome is not.

This only holds if the probe actually runs there. The backoff curve in `apps/worker` is tuned
for resolution latency, not for estimand integrity, and it can leave the last pre-deadline
probe hours short of the boundary.

> **Requirement (new, on `apps/worker`):** every commitment schedules a **mandatory probe at
> the deadline boundary**, exempt from backoff and from the novelty check, in addition to
> whatever the curve would otherwise schedule. Without it, `K` carries an ambiguity window the
> width of the probe interval, and no statistical treatment recovers it — the information was
> never collected. See [`technical-spec.md`](./technical-spec.md) §5.

Deadline arithmetic for that probe is subject to invariant I-9: the boundary is the committer's
local deadline, and an IST deadline at 23:30 sits on the far side of a UTC date boundary. A
boundary probe scheduled in UTC-naive code fires on the wrong day for exactly the users the
timezone tests exist to protect.

### 6.2 What is excluded, and why it biases optimistic

| Status | `K` |
|---|---|
| `kept` on or before the original deadline | `1` |
| `kept` after the original deadline (a slip) | `0` — the slip magnitude goes to the duration axis |
| `missed` | `0` |
| `abandoned` / dropped | `0` |
| `open`, deadline passed, boundary probe observed FALSE | `0` |
| `open`, deadline not yet passed | not yet a datum — excluded, no bias, it will arrive |
| `disputed` | excluded until resolved |
| boundary probe returned `error` | **ambiguous** — §6.3 |

The row that matters is **dropped**. The tempting implementation scores only pledges that
reached a resolution, and a dropped pledge feels like "no data". It is not: it is a `K = 0`
that was almost always stated at high `p`, because people do not publicly pledge things they
expect to abandon. Excluding dropped rows removes the worst-performing, highest-confidence
observations from the sample and **biases every self-calibration statistic optimistic** — the
same failure as §5.2, in a place where it is easier to commit and harder to notice, because
there is no missing field to trip over. An `abandoned` row has a `resolved_at`; nothing about
it looks incomplete.

### 6.3 Ambiguous rows are missing-not-at-random

Invariant I-7 is absolute for the ledger: a probe that could not observe the target is `error`,
never `fail`. That invariant is about what pledge *asserts*. It has a consequence for the
estimator: a boundary probe that errored leaves `K` genuinely unknown, and the errors are not
random — they correlate with dead domains, abandoned infrastructure and expired certificates,
all of which correlate with `K = 0`.

Treatment, in increasing order of effort:

| | Approach | Verdict |
|---|---|---|
| v2 | Exclude ambiguous rows, **report `n_ambiguous` on every surface**, and **suppress Calibration Rank entirely** when `n_ambiguous / n_total > 0.10` | ship this |
| later | Multiple imputation of `K` from the duration model's `q̂` | upgrade when `n_ambiguous` is large enough to fit against |

Excluding is itself optimistic-biased, which is exactly why the suppression threshold exists
rather than a silent drop. The v2 treatment is a bounded, disclosed bias with a hard cap, not
an unbiased one, and the copy should not imply otherwise.

### 6.4 New threat: deadline blackout

§6.3 creates an incentive. A builder heading for `K = 0` can convert it into an *ambiguous* row
by making the target unobservable at the boundary — take the site down for an hour, block our
egress IP, rate-limit the probe, flip the repo private. I-7 guarantees the result is `error`
and never `fail`, so blackout is a reliable eraser.

**This has no row in [`security.md`](./security.md). It needs one, and this document is not the
place to specify the mitigation.** What belongs here is the boundary between the two systems,
because it is easy to get backwards:

- **The ledger must not punish it.** I-7 stands; an unobservable target is `error`, full stop.
  Nothing in this section licenses writing `missed`.
- **The estimator may treat it conservatively.** Whether a row enters a statistical fit is not
  a claim about what happened. The two decisions are permitted to differ.
- **v2 does neither.** It detects and suppresses: when a user's ambiguous rate materially
  exceeds the population's, the tier is withheld and the profile says so. Withholding a tier is
  not an accusation and needs no evidence standard the ledger would have to meet. Punishing
  would.

The baseline snapshot the worker already takes at commit time is the input a real mitigation
would use — a target reachable at commit time and unreachable at exactly the boundary is a
different object from one that was never reachable. Building that comparison is deferred.

### 6.5 Required test (v2 exit criterion) — both axes

Simulate a population with known `mu`, `sigma`, `a_pop`, `b_pop`, `τ`. Censor 30% at random
windows and drop 15%. Fit each axis twice — once with the correct treatment, once with the
naive one:

| Axis | Naive fit | Must show |
|---|---|---|
| Duration | drop censored rows | `mu` recovered **biased optimistic** |
| Self-calibration | drop dropped/abandoned rows | `a_i` recovered **biased high** (apparently better calibrated), `BS_i` biased low |

**Both correct fits must recover truth within tolerance, and both naive fits must visibly fail
in the stated direction. If a naive fit passes, the test is not exercising the thing it claims
to and the test is wrong.** This is the only test in the file whose success condition includes
another fit failing, and that is deliberate.

---

## 7. Eliciting the confidence

`p` is a new user-supplied input on the write path and it is the entire self-calibration axis.
Free-text probabilities produce garbage data — round-number clumping at 50/75/90/100,
percentage-versus-odds confusion, and a non-trivial rate of people typing `100`, which is
unscoreable under a log rule and pathological under any other.

### 7.1 The input

| Rule | Reason |
|---|---|
| **Discrete anchors only:** 50, 60, 70, 80, 90, 95 | A slider invites false precision. Nobody distinguishes 73% from 77%, and the reliability curve cannot resolve the difference at any n this platform will reach. |
| **Frequency framing, not percentage:** *"Of 10 pledges like this one, how many do you ship by the deadline?"* — rendered as `8 in 10 · 80%` | Frequency framing measurably reduces overconfidence relative to a bare percentage, and it is the framing the coaching line reads back in. |
| **No 100%, no 99%** | 100% is unscoreable; 99% is almost never meant. The ceiling at 95 is a deliberate, visible constraint, not a rounding artefact. |
| **Floor at 50% in v2** | A pledge you believe you will miss is not a pledge; the composer should push the user to move the deadline instead. The cost is real and stated below. |
| **`p` is required.** No default, no pre-selected anchor | A pre-selected value becomes the modal answer within a week, and is then a UI artefact in the ledger rather than a belief. |

**The stated cost of the 50% floor:** truncation means the reliability curve has no data below
`p = 0.5`, so `b_i` is identified only on the upper half of the confidence range and anything
below it is model, not observation. Never draw a reliability diagram below the floor. If
"stretch pledges" below 50% are added later they are a new question type wanting their own
anchors, not a widened slider.

### 7.2 `p` is part of the commitment, not metadata

`commitment.confidence` is `NOT NULL`, immutable after publication, and **covered by the ledger
append that records the commitment**. If `p` is editable after the fact it is not a forecast
and the entire axis is worthless — the same argument that makes `done_spec` content-addressed
and immutable (I-4), applied to the other half of the claim.

### 7.3 Amendments

An amendment that moves a deadline creates a **new question**, and the scored pair is always
`(p, original deadline)`. The amended pledge may carry its own `p` for its own deadline; both
are scored, both appear in the record, and the profile shows the amendment. This falls out of
"deadlines are immutable once published; slips are recorded, not erased" and needs no
special-casing in the fit beyond joining on the *original* deadline rather than the current one
— which is exactly the join a careless implementation gets wrong, silently, in the flattering
direction.

---

## 8. Brier decomposition, and whether Calibration Rank survives it

### 8.1 The problem, stated plainly

Under the Murphy decomposition, `BS = REL − RES + UNC`. A builder who pledges everything at 70%
and ships exactly 70% of the time has `REL = 0` — **perfect reliability, and zero
information**. They have made no discriminating claim about any individual pledge. A rank built
on reliability alone hands its top tier to the least informative possible forecaster, and the
winning strategy is to find your own base rate and state it every time.

Cheaper strategies exist:

| Strategy | What it does | Beats a naive Brier rank? |
|---|---|---|
| **Base-rating** | state your own long-run rate on everything | yes — `REL → 0` |
| **Trivial padding** | pledge things already true or nearly so, at 95% | yes — `BS → 0` ([`security.md`](./security.md) T-05b) |
| **Sandbagging** | state 50–60% on things you are certain of | partially |
| **Volume** | many small pledges | yes, through variance reduction alone |

**So a rank on the raw Brier score does not survive, and the new direction's claim that
Calibration Rank is "un-cheeseable" is false as written.** It becomes true only with a
difficulty reference, which the product brief does not currently describe.

### 8.2 The fix: score against what a typical builder would have forecast

Rank on a Brier **skill score** whose reference forecaster is the population duration model
evaluated on this pledge's AST features — `q̂^pop` from §1.1:

```
BS_ref_i = (1/n_i) Σ_j [ π̂_ij (1 − π̂_ij)  +  (q̂^pop_ij − π̂_ij)² ]

BSS_i    = 1 − BS_i / BS_ref_i
```

Both scores use the same fitted `π̂` (§3.4), so the irreducible term is common to both and the
comparison reduces to *"does your stated `p` beat the population model at predicting your own
outcomes?"*

What this fixes, mechanically:

| Strategy | Under `BSS` |
|---|---|
| **Trivial padding** | `q̂^pop` for a trivial spec is already ≈0.97. The reference is as good as you are. `BSS → 0`. No gain. |
| **Base-rating** | the reference varies with pledge difficulty and you do not, so it beats you on both tails. `BSS < 0`. |
| **Sandbagging** | stating 55% where `q̂^pop = 0.9` is worse than the reference. `BSS < 0`. |
| **Overpromising** | 95% everywhere against a reference that discriminates. `BSS` strongly negative. |
| **Volume** | `BSS` is a per-pledge mean; more pledges tighten the posterior, they do not raise the score. |

This is also why the two axes cannot be fitted as separate projects: `BSS` on the binary axis
is computed from the duration fit's population parameters. Split the pipeline and the rank
loses the only thing that makes it defensible.

### 8.3 Stated weaknesses of `BSS`, because they are real

1. **A skill score is not strictly proper.** `BSS` is a ratio of means, and ranking on it admits
   a second-order incentive distortion that a raw Brier does not. The distortion shrinks with
   `n`, and its direction is toward *hedging* — understating `p` — which is the safer of the two
   directions to be wrong in. Stated, accepted, not fixed.
2. **`π̂` is a recalibration of `p`, so it is not an independent truth model.** Using it to score
   `q̂^pop` is mildly circular: `BSS` measures whether `p`, once recalibrated, adds information
   over `q̂^pop`. The clean version is a joint model carrying both `logit p` and `logit q̂^pop` as
   predictors, ranking on the coefficient of the former. That is the upgrade when `n` supports
   it. It is not v2.
3. **`q̂^pop` inherits every weakness of the duration fit**, including the synthetic prior during
   bootstrap. Until ~200 real resolutions exist, `BSS` is being computed against literature, and
   **the rank must not be shown at all** during that window. Not greyed out, not marked
   provisional — absent.

### 8.4 The ladder

Absolute, gated, published thresholds — **not a percentile against other users**. That
distinction is the whole of §0.4, and it is what makes a tier compatible with the product's
refusal to rank people by volume.

| Tier | Gate |
|---|---|
| **Drafter** | default; fewer than 5 resolved machine-verified or peer-attested pledges (`n_effective < 5`) |
| **Shipper** | `n_effective ≥ 5` and `BSS ≥ 0` |
| **Calibrated** | `n_effective ≥ 15`, `BSS ≥ 0.15`, `abs(â_i) ≤ 0.40` |
| **Oracle** | `n_effective ≥ 40`, `BSS ≥ 0.30`, `abs(â_i) ≤ 0.25`, `b̂_i` between 0.80 and 1.25 |

Every threshold in that table is a **guess**, labelled as one, to be re-set against the real
distribution once one exists — and re-set to absolute values again, never to quantiles. All
tiers additionally require `n_ambiguous / n_total ≤ 0.10` (§6.3), and are computed on
non-self-reported rows only (§5.1).

### 8.5 What is not resolved here

**The seasonal leaderboard is a separate claim and this document does not endorse it.** A gated
absolute ladder is a statement about one builder measured against a fixed bar. A quarterly
leaderboard ranks builders against each other, and every objection in v1.0's display rule 7
applies to it unchanged: it rewards being *measured* over being right, it makes `n` a
competitive resource, and it gives base-rating a reason to exist again at the top of the table.
It needs the C-2 reversal ADR to argue it on its own terms. Do not implement it on the strength
of §8.4.

---

## 9. Serving and cold start

The nightly fit writes one row per user:

```sql
calibration_fit(account_id uuid pk,
                -- duration axis
                mu numeric, sigma numeric,
                beta jsonb,            -- shared, denormalised per row for lookup-free serving
                -- self-calibration axis
                a numeric, b numeric,
                brier numeric, brier_ref numeric, bss numeric,
                tier text,             -- NULL while suppressed; never defaulted to 'Drafter'
                -- volume and honesty
                n_effective numeric,
                n_total int, n_censored int, n_ambiguous int, n_self_reported int,
                fitted_at timestamptz,
                model_version text)
```

Serving is arithmetic in TypeScript, so the forecast renders inline in the composer with the
date picker still open:

```ts
// on-time probability. y is a LOG RATIO, so the on-time event is y <= 0.
const xb      = dot(fit.beta, features);
const z       = -(fit.mu + xb) / fit.sigma;
const pOnTime = normalCdf(z);                          // = q̂

// the same expression at population parameters, AST features only
const zPop       = -(pop.mu + dot(pop.beta, features)) / pop.sigma;
const pOnTimePop = normalCdf(zPop);                    // = q̂^pop

// the deadline that would make this user 80% likely to be on time
const calibrated80 = estDays * Math.exp(fit.mu + xb + fit.sigma * probit(0.8));
```

**The `z` line is the v1.0 bug (§0.2). If a `Math.log(estDays)` term reappears in it, the
parameterisation has been mixed up again.** One unit test pinning `pOnTime` for a known
`(mu, sigma, estDays)` triple against a hand-computed value keeps it fixed.

`p95 < 100ms` with no sidecar in the request path (v2 exit criterion). The Python container is
never on a user-facing code path ([ADR-0004](./adr/0004-python-sidecar-for-calibration.md)) —
if it dies, the app serves yesterday's row.

### 9.1 The coaching line and the Scope Negotiator

The Scope Negotiator's coaching sentence — *"historically you slip ~5 days on release-sized
pledges; pledge Sept 20, or keep Sept 15 at 65%"* — is `q̂`, `q̂^pop` and `calibrated80` in prose.
Two constraints follow, and both land on the LLM integration rather than on this model:

1. **Every number in that sentence is computed in TypeScript from the `calibration_fit` row and
   injected into the prompt.** The model never derives, rounds or recomputes one. A hallucinated
   slip figure is a fabricated statistic about a named user, published on their profile, and it
   is the worst failure mode the LLM path has.
2. **The sidecar is still not on the request path.** Serving from the nightly row satisfies
   [ADR-0004](./adr/0004-python-sidecar-for-calibration.md) unchanged. Whether an LLM call
   belongs at pledge creation is a separate question, argued in the C-3 ADR, and nothing in this
   document depends on its outcome — every number above is available with or without it.

### 9.2 Cold start

| n | What is shown |
|---|---|
| `n = 0` | population only: *"Based on **other builders' data** (you have no resolved pledges yet), an 11-day estimate for this kind of work lands on time about **45%** of the time. Ask again after a few pledges and this becomes about you."* |
| `n = 1…4` | the overconfidence gap (`p` vs `q̂^pop`) — available with no personal history at all, and the entire value on offer at this stage. No `a_i`, no `b_i`, no reliability diagram, no tier. |
| `n ≥ 5` | personal `a_i`, `b_i`, shrunk hard toward population; tier gated per §8.4 |

Never show a personal-sounding number at `n = 0`. The credibility cost of one confidently wrong
first forecast exceeds the value of every correct one after it.

### 9.3 Bootstrapping the population prior

Before real data exists, seed both axes from published literature — software estimation for
`mu_pop`/`sigma_pop` (median slip ~1.5–2x, heavy right tail), the overconfidence literature for
`a_pop`/`b_pop`. **Label it synthetic in the UI**, and replace it as soon as ~200 real resolved,
non-self-reported pledges exist. Presenting a synthetic prior as empirical would be, precisely,
an unfalsifiable claim about shipping.

---

## 10. Recency weighting

People get better at estimating. Weight observations by exponential decay, ~9-month half-life,
on **both** axes:

```
w_ij = 0.5 ** (age_days / 274)
```

Applied to the likelihood contribution. `n_effective = sum(w)`, and it is `n_effective` — not
the raw count — that drives pooling weight, tier gates and confidence display. A user with 40
pledges all from two years ago is closer to a new user than the raw count suggests.

Half-life is a tunable knob, not a constant of nature. Validate it against held-out predictive
accuracy once there is a year of data; until then 9 months is a defensible guess and is
labelled as one in the code.

---

## 11. Display rules

Non-negotiable, because presentation is where a correct model becomes a dishonest product.
Rules 1–6 are unchanged from v1.0. Rule 7 is narrowed. Rules 8–13 are new.

1. **Never a single context-free number.** On-time rate always with `n`. Slip ratios always with
   the distribution shape. Brier never on its own.
2. **Always show volume and raw claims adjacent.** A reader must be able to judge scope
   ([`security.md`](./security.md) T-05b).
3. **Show `n_public / n_total`** — *conditional on
   [ADR-0008](./adr/0008-calibration-over-all-visibilities.md), which is Proposed, not
   accepted.* This rule only has meaning under the all-visibilities denominator; if ADR-0008 is
   rejected it is vacuous and rule 4 carries the honesty burden alone. A profile showing 12 of
   35 is honest; showing 12 of 12 when 23 are hidden is the laundering attack
   ([Q-01](./open-questions.md)).
4. **Show `n_censored`.** "26 kept, 9 missed, 3 still open" is the real shape.
5. **Category claims require n ≥ 3 in that category**, and state the n.
6. **Confidence tiering:** `n_effective < 1` → population only; `< 5` → "low confidence, mostly
   population"; `< 15` → "moderate"; else "your data."
7. **Narrowed (was: never render calibration as a rank or a percentile).** Never render
   calibration as a **percentile against other users**, and never as any tier whose value can
   change when *other people's* pledges resolve. A gated absolute ladder with published
   thresholds (§8.4) is permitted. The seasonal leaderboard is unresolved (§8.5) and is not
   licensed by this rule.
8. **Show `n_ambiguous` wherever a tier is shown**, and when a tier is suppressed (§6.3) say
   which threshold suppressed it, in words. A missing badge with no explanation reads as a bug
   and generates support tickets; a missing badge with a reason reads as rigour.
9. **Self-reported outcomes are marked at the row level and stated in the denominator** —
   *"41 resolved · 34 machine-verified · 5 peer-attested · 2 self-reported (excluded from
   calibration)"*. The exclusion is a **displayed fact**, never a silent filter, or the numbers
   fail to add up on screen and the reader assumes the worse explanation.
10. **Never render a reliability diagram below the elicitation floor** (§7.1), or with fewer
    than 3 populated anchors. A two-dot curve is a Rorschach test.
11. **Brier appears in plain language, never as a bare score.** *"When you say 80%, you ship
    about 6 times in 10"* is the sentence. `BS = 0.19` is not a sentence.
12. **Never show a tier while the population prior is synthetic** (§8.3, point 3).
13. **Never render a tier or a keep rate without the underlying pledges one click away** — the
    same rule as a kept badge and its spec source. A tier whose inputs are not inspectable is
    the thing pledge exists to replace, one level of abstraction up.

---

## 12. Validation

| Check | Method | Cadence |
|---|---|---|
| Duration parameter recovery | Simulate known `mu`, `sigma`, `beta`; fit; compare | CI, every build |
| **Self-calibration parameter recovery** | Simulate known `a_i`, `b_i`, `τ`; fit; compare. Must include an `n_i = 5` cohort — recovery at n=30 proves nothing about the population we will actually have | CI, every build |
| Duration censoring bias | §6.5, duration row | CI, every build |
| **Binary exclusion bias** | §6.5, self-calibration row. Dropping dropped/abandoned rows **must** produce a visibly optimistic `a_i` | CI, every build |
| Beats naive baseline at low n | Simulated users with n<5; hierarchical vs. per-user mean, on held-out log loss | CI — **this is the moat test** |
| **Centring identifiability** | Fit §3.2 uncentred and centred at `n_i = 5`; the uncentred `a`/`b` posterior correlation must exceed 0.9 and the centred must not | CI, every build |
| **Rank gameability** | Simulate four adversaries — base-rater, trivial-padder, sandbagger, volume-farmer (§8.1) — against an honest builder of equal true skill. **No adversary may reach a higher tier than the honest builder.** If one does, `BSS` or the gates are wrong, not the test | CI, every build |
| **Blackout resistance** | Simulate a builder who blacks out the target on every pledge heading for `K = 0`. Their tier must be **suppressed**, not improved (§6.3, §6.4) | CI, every build |
| **Serving arithmetic** | Pin `pOnTime` for a known `(mu, sigma, estDays)` triple against a hand-computed value — the §0.2 regression guard | CI, every build |
| **Boundary-probe scheduling** | A pledge with a 23:30 IST deadline must have a probe scheduled inside the boundary window, in both UTC-date directions (I-9) | CI, every build |
| **Forecast calibration** *(§12.1)* | Of pledges the model forecast at 40%, ~40% land. Reliability diagram, decile buckets, with intervals | Monthly once n>500; **published** |
| Self-calibration population drift | `a_pop`, `b_pop` over time | Weekly |
| Duration drift | Population `mu` over time; alert on step changes (usually a probe-scheduling bug, not human behaviour) | Weekly |

### 12.1 Forecast calibration is now a public claim

In v1.0 this was an internal check. The new direction sells the calibration coach as a product
surface, which promotes it to a claim a user can test — *"of pledges made at 40%, about 40%
should land"* is a falsifiable statement pledge is now making in its own copy.

That changes what the check has to be:

- **Published, not logged.** A monthly reliability diagram for our own forecasts, on a public
  page, with intervals and `n`. The same standard rule 1 applies to a user's profile.
- **Pre-registered failure threshold.** Decide *now*, before there is data, what deviation
  counts as our forecasts being miscalibrated, and commit to saying so on that page when it
  happens. A threshold chosen after seeing the diagram is not a threshold.
- **Both curves, separately.** Forecast calibration of `q̂` (do our on-time probabilities hold
  up?) and of `π̂` (does our recalibration of users' stated `p` hold up?) are different curves
  and can fail independently. One passing does not cover the other.

**A product about calibration whose own forecasts are uncalibrated is the worst available
headline.** It is a worse headline in v2 than it was in v1.0, because now we advertised it.

### 12.2 Known-open

| # | Question |
|---|---|
| **K-1** | Should peer-attested rows be down-weighted relative to machine-verified in the likelihood? They are not definitionally broken (§5.1) but they are collusion-exposed ([`security.md`](./security.md) T-02). A weight is a free parameter with no principled value, and inventing one is worse than leaving it at 1.0 until there is data to fit it against. |
| **K-2** | The seasonal leaderboard (§8.5). Needs the C-2 ADR before any of it is built. |
| **K-3** | The visibility denominator ([ADR-0008](./adr/0008-calibration-over-all-visibilities.md), Proposed) governs both axes identically, and display rule 3 is vacuous without it. |
| **K-4** | Whether `p` should be elicited again at amendment time, and whether the second `p` is a separate forecast or a revision of the first. §7.3 chooses "separate"; that is a decision, not a finding. |
| **K-5** | The §8.4 thresholds are guesses with no empirical basis. They must be re-set once the real `BSS` distribution exists, and re-set to absolute values — the temptation at that moment will be to fit them to quantiles, which is display rule 7 being violated by the back door. |

---

## 13. Aggregate data (the flywheel)

Anonymised cross-user statistics — *"hackathon participants slip 2.4x on 'integrate payments'"*,
*"builders state 85% and land 61% on pledges with a third-party API"* — are a genuine asset and
a content engine ([`product-overview.md`](./product-overview.md) §4). The self-calibration axis
makes them better: a population overconfidence curve is a more interesting artefact than a slip
distribution, and it is the one nobody else can publish, because nobody else has verified
outcomes attached to stated probabilities.

Rules before publishing any aggregate:

- k-anonymity ≥ 20 accounts per reported cell; suppress smaller cells rather than rounding.
- Never publish a cell that could be a single identifiable cohort (a named hackathon with 22
  participants is not anonymous).
- Cohort/covenant-level reports go to the organizer with participant identity; public write-ups
  get the aggregate only.
- **Machine-verified rows only**, and say so. An aggregate that silently includes peer-attested
  rows inherits their collusion exposure at population scale.
- Publish the methodology, including the censoring and exclusion treatment. The credibility of
  the aggregate claim rests on the same footing as the individual one.
