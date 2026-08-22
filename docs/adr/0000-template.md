# ADR-NNNN: <Title in sentence case>

**Status:** Accepted | Proposed | Superseded by ADR-XXXX
**Date:** YYYY-MM
**Deciders:** rohansx
**Context docs:** <relative links to the docs this decision affects, e.g. [`architecture.md`](../architecture.md), [`security.md`](../security.md)>

## Context
<The forces at play. What problem, what constraints, what was actually true when deciding.
2-5 paragraphs.

Name the constraint that dominates. On this project it is almost always one of two:
nights-and-weekends build time, or the credibility of the record. Say which one, and say what
it rules out.

If the decision was previously made differently, say so, and say why the first answer was
wrong. If a bias drove the first answer — habit, taste, wanting to use a particular tool —
name the bias explicitly. Naming it is what stops it recurring.

Include real numbers where they exist: current volume, expected volume, the threshold at
which the choice stops holding. A context section with no numbers usually means the decision
was made on feel.>

## Decision
<One paragraph, declarative, unambiguous. What we are doing — present tense, not "we should".
If part of the decision is deferred, say exactly which part and what the trigger is. Never
write a paragraph that reads as settled when it is open.>

## Alternatives considered
| Option | Why not |
|---|---|
| <Option A> | <The honest reason. State what the option is genuinely better at *before* saying why it lost. A strawman here is worthless in six months — it makes the ADR useless to the person deciding whether to reverse it.> |
| <Option B> | <...> |

## Consequences
**Good:**
- <What this buys, concretely.>

**Bad:**
- <Real costs. Not advantages in disguise. If this section is hard to write, the decision has
  not been thought through — every choice forecloses something.>

**Neutral:**
- <Optional. Things that change but are neither better nor worse: a different failure mode, a
  different operational shape, work deferred that arrives either way.>

## Revisit when
<Concrete, checkable triggers. A threshold, a metric, or an event — not "if it becomes a
problem". Each trigger names the response, not just the alarm:

- \<metric\> exceeds \<number\> → \<what we do\>
- \<event\> happens → \<what we do\>>
