# Rationale template

The page that ships with the sketch. One page. Replace each note with content, and drop a section that has nothing to say.

```markdown
# <What is being designed>

## Problem

<One paragraph: what we are doing, and what about the existing system makes the shape non-obvious. Name the constraints the design must honour: types to interoperate with, callers that cannot break, invariants that cross the boundary.>

## Usage

<Written first. What the caller imports and calls, in two or three realistic call sites, and what comes back. When usage and types disagree, the types change.>

## Shape

<Data structures first. Then how data flows through the signatures. State which invariants the types enforce, where validation lives, and what the module deliberately does not do. Say what the interface hides and why it is no larger than it needs to be.>

## Failure and operation

<What happens when it runs twice, crashes halfway, or meets a concurrent writer. What crosses a trust boundary and how it is checked. Which signals will show it working or failing in production.>

## Trade-offs accepted

- We accept <cost> in exchange for <benefit>.
<Name anything a future reader could mistake for an oversight.>

## Alternatives considered

- <A different whole shape>: lost because <one line>.
<At least one. When constraints forced the answer, say "this was the only viable shape because...".>

## Open questions

<Things the human must decide, phrased as questions.>

## First step

<The first thing to build against the sketch, in one sentence.>
```
