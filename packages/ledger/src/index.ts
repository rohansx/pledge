// Public surface of @pledge/ledger — the chain's arithmetic and nothing else.
//
// This package deliberately does NOT import @pledge/db. The append helper lives in
// @pledge/db (it needs a transaction handle), and the verification walk lives there too (it
// needs to read rows). Keeping the hashing here is what lets `npx pledge-verify` recompute a
// receipt with no database, no connection string, and no trust in us
// (docs/architecture.md §6.5).
//
// NOT HERE, DELIBERATELY: Merkle trees, audit paths, checkpoints, Rekor. Those are v2 and
// ADR-0005 is Proposed, not accepted. Building them now is the scope creep the roadmap warns
// kills the phase.
export * from "./canonical-json";
export * from "./chain";
export * from "./payloads";
export * from "./signing";
