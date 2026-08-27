/**
 * The grammar of done-spec-dsl.md §2, as a Chevrotain CstParser.
 *
 * Two deliberate departures from the EBNF as written, both forced by §9:
 *
 *  1. `comparison = accessor comp_op (literal | instant)`. The EBNF's right-hand side is
 *     `literal`, but every template in §9 carries a `> commit_time` freshness clause, which
 *     the EBNF as printed cannot express. The templates are normative; the omission is a
 *     defect in the grammar block. Flagged in the return note.
 *  2. `accessor = ident [args] { "." ident [args] }` — one generic member chain, rather than
 *     the EBNF's `source { "." field } { call }`. The EBNF puts every call after every field,
 *     which its own §3.2 example (`github.commits(r).since(commit_time).count`) contradicts.
 *     A generic chain accepts both orderings and the visitor rejects the meaningless ones
 *     with a message naming the segment.
 */
import { CstParser, type CstNode, type IToken } from "chevrotain";

import {
  All,
  And,
  Any,
  Comma,
  CommitTime,
  Contains,
  Deadline,
  DecimalLiteral,
  Dot,
  EndsWith,
  Equals,
  False,
  Greater,
  GreaterEq,
  Identifier,
  IntegerLiteral,
  LParen,
  Less,
  LessEq,
  Matches,
  Not,
  NotEquals,
  Or,
  RParen,
  StartsWith,
  StringLiteral,
  True,
  VersionLiteral,
  allTokens,
} from "./lexer";

class SpecParser extends CstParser {
  constructor() {
    super(allTokens, { recoveryEnabled: false });
    this.performSelfAnalysis();
  }

  readonly spec = this.RULE("spec", () => {
    this.SUBRULE(this.orExpr);
  });

  readonly orExpr = this.RULE("orExpr", () => {
    this.SUBRULE(this.andExpr, { LABEL: "lhs" });
    this.MANY(() => {
      this.CONSUME(Or);
      this.SUBRULE2(this.andExpr, { LABEL: "rhs" });
    });
  });

  readonly andExpr = this.RULE("andExpr", () => {
    this.SUBRULE(this.notExpr, { LABEL: "lhs" });
    this.MANY(() => {
      this.CONSUME(And);
      this.SUBRULE2(this.notExpr, { LABEL: "rhs" });
    });
  });

  readonly notExpr = this.RULE("notExpr", () => {
    // §5 step 1 folds `not not x` away, which only makes sense if it parses in the first place.
    this.MANY(() => this.CONSUME(Not));
    this.SUBRULE(this.primary);
  });

  readonly primary = this.RULE("primary", () => {
    this.OR([
      { ALT: () => this.SUBRULE(this.combinator) },
      {
        ALT: () => {
          this.CONSUME(LParen);
          this.SUBRULE(this.orExpr, { LABEL: "grouped" });
          this.CONSUME(RParen);
        },
      },
      { ALT: () => this.SUBRULE(this.comparison) },
    ]);
  });

  readonly combinator = this.RULE("combinator", () => {
    this.OR([{ ALT: () => this.CONSUME(All) }, { ALT: () => this.CONSUME(Any) }]);
    this.CONSUME(LParen);
    this.SUBRULE(this.orExpr, { LABEL: "arg" });
    this.MANY(() => {
      this.CONSUME(Comma);
      // The EBNF allows a dangling comma before `)`; the OPTION is what makes it legal.
      this.OPTION(() => this.SUBRULE2(this.orExpr, { LABEL: "arg" }));
    });
    this.CONSUME(RParen);
  });

  readonly comparison = this.RULE("comparison", () => {
    this.SUBRULE(this.accessor);
    this.OPTION(() => {
      this.SUBRULE(this.compOp);
      this.SUBRULE(this.operand, { LABEL: "rhs" });
    });
  });

  readonly compOp = this.RULE("compOp", () => {
    this.OR([
      { ALT: () => this.CONSUME(Equals) },
      { ALT: () => this.CONSUME(NotEquals) },
      { ALT: () => this.CONSUME(GreaterEq) },
      { ALT: () => this.CONSUME(LessEq) },
      { ALT: () => this.CONSUME(Greater) },
      { ALT: () => this.CONSUME(Less) },
      { ALT: () => this.CONSUME(Contains) },
      { ALT: () => this.CONSUME(Matches) },
      { ALT: () => this.CONSUME(StartsWith) },
      { ALT: () => this.CONSUME(EndsWith) },
    ]);
  });

  readonly accessor = this.RULE("accessor", () => {
    this.SUBRULE(this.segment, { LABEL: "segment" });
    this.MANY(() => {
      this.CONSUME(Dot);
      this.SUBRULE2(this.segment, { LABEL: "segment" });
    });
  });

  readonly segment = this.RULE("segment", () => {
    this.CONSUME(Identifier);
    this.OPTION(() => {
      this.CONSUME(LParen);
      this.OPTION2(() => {
        this.SUBRULE(this.operand, { LABEL: "arg" });
        this.MANY(() => {
          this.CONSUME(Comma);
          this.SUBRULE2(this.operand, { LABEL: "arg" });
        });
      });
      this.CONSUME(RParen);
    });
  });

  readonly operand = this.RULE("operand", () => {
    this.OR([
      { ALT: () => this.CONSUME(StringLiteral) },
      { ALT: () => this.CONSUME(VersionLiteral) },
      { ALT: () => this.CONSUME(DecimalLiteral) },
      { ALT: () => this.CONSUME(IntegerLiteral) },
      { ALT: () => this.CONSUME(True) },
      { ALT: () => this.CONSUME(False) },
      { ALT: () => this.CONSUME(CommitTime) },
      { ALT: () => this.CONSUME(Deadline) },
    ]);
  });
}

/** Chevrotain parsers are expensive to construct and safe to share; one is enough. */
export const specParser = new SpecParser();

export type { CstNode, IToken };
