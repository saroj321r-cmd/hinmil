// ============================================================================
// Type Signature Parser — parses HM type notation from comments
//
// WHAT THIS FILE DOES (in plain language)
// ---------------------------------------------------------------------------
// Users write type notes as text, e.g. `Number -> String`.  This file reads
// that text and turns it into the in-memory building blocks from types.ts.
// It works like reading a sentence in two steps:
//   1. The *tokenizer* chops the text into words and symbols (tokens):
//      "Array", "->", "(", "a", ...
//   2. The *parser* fits those tokens together according to the grammar of
//      the type language (arrows are right-associative, `|` binds tighter
//      than `->`, brackets mean arrays, braces mean records, ...).
// The result is a Type tree — or a TypeParseError pointing at the exact spot
// where the text stopped making sense.
//
// Supported syntax examples:
//   // :: Number -> String -> Boolean
//   // :: a -> b -> a
//   // :: [Number] -> Number
//   // :: (Number -> String) -> [String]
//   // :: Array<Number> -> Number   (also supported)
//   /* :: Number -> Number */
// ============================================================================

import { Type, TVar, TRow, TLabel, TRecord, Scheme, Constraint, tVar, tCon, tFun, tForall, containsForall, tUnion, tRecord, tOpenRecord, tLabelVar, tLabelLit, tNumLit, tNumber, tBool, tNull, tUndefined, tAny, tSpread, freshTypeVarId, kvName, T_UNION, T_MERGE, T_TUPLE, typeToString } from './types';

/** Matches uppercase-leading identifiers (type constructors). */
const UPPERCASE_RE = /^[A-Z]/;
/** Matches lowercase-leading identifiers (type variables). */
const LOWERCASE_RE = /^[a-z]/;

/** Single-character token lookup — hoisted to module scope. */
const SINGLE_CHARS: Record<string, TokenKind> = {
  '(': 'LPAREN', ')': 'RPAREN',
  '<': 'LANGLE', '>': 'RANGLE',
  '[': 'LBRACKET', ']': 'RBRACKET',
  '{': 'LBRACE', '}': 'RBRACE',
  ',': 'COMMA',  '.': 'DOT',
  '|': 'PIPE',   ':': 'COLON',
  '*': 'STAR',
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'IDENT'    // Number, a, Array, ...
  | 'ARROW'    // ->
  | 'FAT_ARROW' // =>
  | 'SQUIGGLY' // ~>
  | 'LPAREN'   // (
  | 'RPAREN'   // )
  | 'LANGLE'   // <
  | 'RANGLE'   // >
  | 'LBRACKET' // [
  | 'RBRACKET' // ]
  | 'LBRACE'   // {
  | 'RBRACE'   // }
  | 'COLON'    // :
  | 'COMMA'    // ,
  | 'DOT'      // .
  | 'PIPE'     // |
  | 'STAR'     // *
  | 'ELLIPSIS' // ...
  | 'NUMBER'   // 123, 3.14
  | 'STRING'   // "hello", 'hello'
  | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i])) { i++; continue; }



    // Arrow ->
    if (input[i] === '-' && input[i + 1] === '>') {
      tokens.push({ kind: 'ARROW', value: '->' });
      i += 2;
      continue;
    }

    // Fat arrow =>
    if (input[i] === '=' && input[i + 1] === '>') {
      tokens.push({ kind: 'FAT_ARROW', value: '=>' });
      i += 2;
      continue;
    }

    // Squiggly arrow ~>
    if (input[i] === '~' && input[i + 1] === '>') {
      tokens.push({ kind: 'SQUIGGLY', value: '~>' });
      i += 2;
      continue;
    }

    // Ellipsis ...
    if (input[i] === '.' && i + 2 < input.length && input[i + 1] === '.' && input[i + 2] === '.') {
      tokens.push({ kind: 'ELLIPSIS', value: '...' });
      i += 3;
      continue;
    }

    // Single chars
    if (SINGLE_CHARS[input[i]]) {
      tokens.push({ kind: SINGLE_CHARS[input[i]], value: input[i] });
      i++;
      continue;
    }

    // Identifier: optional `@@` or `@` prefix (Fantasy-Land / Symbol-style
    // keys, e.g. `@@type`, `@iterator`), then [A-Za-z_][A-Za-z0-9_]*.
    {
      let p = i;
      if (input[p] === '@') {
        p++;
        if (input[p] === '@') p++;
      }
      if (p > i && /[A-Za-z_]/.test(input[p])) {
        const start = i;
        i = p;
        while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i++;
        tokens.push({ kind: 'IDENT', value: input.slice(start, i) });
        continue;
      }
    }
    if (/[A-Za-z_]/.test(input[i])) {
      let start = i;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) i++;
      tokens.push({ kind: 'IDENT', value: input.slice(start, i) });
      continue;
    }

    // Number literal: digits with optional decimal point
    if (/[0-9]/.test(input[i]) || (input[i] === '-' && i + 1 < input.length && /[0-9]/.test(input[i + 1]))) {
      let start = i;
      if (input[i] === '-') i++;
      while (i < input.length && /[0-9]/.test(input[i])) i++;
      if (i < input.length && input[i] === '.' && i + 1 < input.length && /[0-9]/.test(input[i + 1])) {
        i++; // consume .
        while (i < input.length && /[0-9]/.test(input[i])) i++;
      }
      tokens.push({ kind: 'NUMBER', value: input.slice(start, i) });
      continue;
    }

    // String literal: "..." or '...'
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      let start = i;
      i++; // consume opening quote
      while (i < input.length && input[i] !== quote) i++;
      i++; // consume closing quote
      tokens.push({ kind: 'STRING', value: input.slice(start, i) });
      continue;
    }

    // Unknown char — skip
    i++;
  }

  tokens.push({ kind: 'EOF', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export class TypeParseError extends Error {
  constructor(message: string) {
    // Thrown and caught routinely while probing annotation shapes; skip the
    // stack trace unless debugging hinmil itself (`HM_DEBUG=1`).
    const limit = Error.stackTraceLimit;
    if (!(typeof process !== 'undefined' && process.env?.HM_DEBUG)) Error.stackTraceLimit = 0;
    super(message);
    Error.stackTraceLimit = limit;
    this.name = 'TypeParseError';
  }
}

class TypeParser {
  private tokens: Token[];
  private pos: number;
  /** Maps type-variable names to their ids (within one signature). */
  private varMap: Map<string, number>;
  /** Maps label-variable names to their (TLabel) ids.  Kept separate from
   *  {@link varMap} so a name like `k` never confuses type-var and
   *  label-var sorts within one signature. */
  private labelVarMap: Map<string, TLabel>;
  /** Names of type variables that come from constraints (higher-kinded). */
  private constraintVarNames: Set<string>;
  /** Known type constructor arities (e.g. Pair → 2, Array → 1). */
  private typeArities: Map<string, number>;
  /** When true, lowercase identifiers are never resolved to record label
   *  variables — used while parsing a constraint head (`Array k =>`) where a
   *  lowercase ident is always a constraint type variable, even if the same
   *  name also appears as a `[k]` record label elsewhere in the signature. */
  private suppressLabelVars = false;
  /** Set when at least one nested `forall` quantifier was parsed — cached on
   *  the resulting Scheme as `hasForall` so hot inference paths can gate all
   *  rank-N handling behind one boolean. */
  private sawForall = false;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
    this.varMap = new Map();
    this.labelVarMap = new Map();
    this.constraintVarNames = new Set();
    this.typeArities = new Map();
    // Pre-scan tokens for `[name] :: …` bracketed-key patterns inside
    // record types so that any appearance of `name` as a top-level
    // identifier elsewhere in the signature (e.g.
    // `k -> { [k] :: a, ...r } -> { ...r }`) parses as a label
    // variable rather than a type variable.  We require the trailing
    // `::` to avoid catching ordinary array shorthand `[a]`.
    for (let i = 0; i < tokens.length - 4; i++) {
      if (tokens[i].kind === 'LBRACKET' &&
          tokens[i + 1].kind === 'IDENT' &&
          LOWERCASE_RE.test(tokens[i + 1].value) &&
          tokens[i + 2].kind === 'RBRACKET' &&
          tokens[i + 3].kind === 'COLON' &&
          tokens[i + 4].kind === 'COLON') {
        const name = tokens[i + 1].value;
        if (!this.labelVarMap.has(name)) {
          this.labelVarMap.set(name, tLabelVar(name));
        }
      }
    }
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new TypeParseError(`Expected ${kind} but got ${tok.kind} ("${tok.value}")`);
    }
    return this.advance();
  }

  // -----------------------------------------------------------------------
  // Top-level: parse constraints + type, auto-quantify free vars
  // Also handles constraints: "Functor f => ..." or "(Functor f, Monad m) => ..."
  // -----------------------------------------------------------------------

  parseScheme(): Scheme {
    // Try parsing constraints: Functor f => ... or (Functor f, Monad m) => ...
    const constraints = this.tryParseConstraints();

    // Parse the type (free vars will be auto-quantified)
    let type = this.normalizeObjectKeys(this.parseType());
    // Collect all variable ids that appeared.  Label-vars share the same
    // id-space as ordinary type variables and must also be quantified so
    // that each instantiation produces a fresh label var.
    const vars = Array.from(this.varMap.values());
    for (const lbl of this.labelVarMap.values()) {
      if (lbl.kind === 'var' && !vars.includes(lbl.id)) vars.push(lbl.id);
    }
    if (this.sawForall) {
      // Prenex normalization: quantifiers at the top level and in RESULT
      // positions are semantically identical to scheme-level quantification
      // (the CALLER still chooses the instantiation), so absorb them into
      // the scheme.  Only contravariant (parameter / record-field) foralls
      // remain as nested TForall nodes — those are the genuine rank-N spots.
      const allConstraints = constraints.slice();
      type = this.hoistCovariantForalls(type, vars, allConstraints);
      this.validateForallPositions(type, false);
      const out: Scheme = {
        vars, type,
        constraints: allConstraints.length > 0 ? allConstraints : undefined,
      };
      // The hoist may have absorbed every quantifier — only flag schemes
      // that still carry a nested TForall.
      if (containsForall(type)) out.hasForall = true;
      return out;
    }
    return { vars, type, constraints: constraints.length > 0 ? constraints : undefined };
  }

  /** Absorb `forall`s at the top level and in (nested) result positions into
   *  the enclosing scheme: their vars join `intoVars` and their constraints
   *  join `intoConstraints`.  Returns the stripped type. */
  private hoistCovariantForalls(t: Type, intoVars: number[], intoConstraints: Constraint[]): Type {
    while (t.tag === 'TForall') {
      for (const v of t.vars) if (!intoVars.includes(v)) intoVars.push(v);
      if (t.constraints) intoConstraints.push(...t.constraints);
      t = t.body;
    }
    if (t.tag === 'TFun') {
      const result = this.hoistCovariantForalls(t.result, intoVars, intoConstraints);
      if (result !== t.result) return tFun(t.param, result);
    }
    return t;
  }

  /** Predicativity check: a nested `forall` may appear as a function
   *  parameter (directly, or as a tuple-slot of a multi-param function) or as
   *  a record field value — never inside type-constructor arguments
   *  (`[forall a. …]`, `Either (forall a. …) b`, union members, …). */
  private validateForallPositions(t: Type, allowHere: boolean): void {
    switch (t.tag) {
      case 'TForall':
        if (!allowHere) {
          throw new TypeParseError(
            `'forall' is only allowed as a function parameter or record field type — not inside type-constructor arguments`,
          );
        }
        this.validateForallPositions(t.body, false);
        return;
      case 'TFun': {
        const p = t.param;
        if (p.tag === 'TCon' && p.name === T_TUPLE) {
          for (const a of p.args) this.validateForallPositions(a, true);
        } else {
          this.validateForallPositions(p, true);
        }
        this.validateForallPositions(t.result, false);
        return;
      }
      case 'TCon':
        for (const a of t.args) this.validateForallPositions(a, false);
        return;
      case 'TRecord':
        for (const k in t.fields) this.validateForallPositions(t.fields[k], true);
        if (t.labelFields) for (const lf of t.labelFields) this.validateForallPositions(lf.type, true);
        return;
      default:
        return;
    }
  }

  /**
   * Post-parse rewrite: the first child of an applied `Object k a` is the
   * record *key* and must be a label variable, but juxtaposition parses a
   * bare lowercase `k` as an ordinary type variable.  Convert any such key
   * to a label variable (reusing the existing id so quantification stays
   * consistent, or the shared label from {@link labelVarMap} when the same
   * name also appears as a `[k] ::` field elsewhere — so `Object k a` and
   * `{ [k] :: a }` reference the same key).
   */
  private normalizeObjectKeys(t: Type): Type {
    switch (t.tag) {
      case 'TCon': {
        const args = t.args.map(a => this.normalizeObjectKeys(a));
        if (t.name === 'Object' && args.length === 2 && args[0].tag === 'TVar') {
          const v = args[0];
          let label = this.labelVarMap.get(v.name);
          if (!label || label.kind !== 'var') {
            label = { tag: 'TLabel', kind: 'var', id: v.id, name: v.name };
            this.labelVarMap.set(v.name, label);
            // The id (kept in varMap) now denotes a label var; instantiation
            // detects label-ness from the type structure, so leaving the id in
            // varMap simply keeps it quantified — correct for a standalone
            // `Object k a` whose key appears nowhere else.
          }
          return { ...t, args: [label, args[1]] };
        }
        return { ...t, args };
      }
      case 'TFun':
        return tFun(this.normalizeObjectKeys(t.param), this.normalizeObjectKeys(t.result));
      case 'TRecord': {
        const fields: Record<string, Type> = {};
        for (const k in t.fields) fields[k] = this.normalizeObjectKeys(t.fields[k]);
        const rec: TRecord = { ...t, fields };
        if (t.labelFields) {
          rec.labelFields = t.labelFields.map(lf => ({ label: lf.label, type: this.normalizeObjectKeys(lf.type) }));
        }
        return rec;
      }
      case 'TForall':
        return { ...t, body: this.normalizeObjectKeys(t.body) };
      default:
        return t;
    }
  }

  // -----------------------------------------------------------------------
  // Constraint parsing: "Functor f =>" or "(Functor f, Monad m) =>"
  // -----------------------------------------------------------------------

  private tryParseConstraints(): Constraint[] {
    // We need to look ahead to see if there's a `=>` pattern.
    // Three forms:
    //   1. ClassName varName =>
    //   2. (ClassName varName, ClassName varName, ...) =>
    //   3. (T1 | T2 | ...) varName =>     (structural-union constraint)

    const savedPos = this.pos;
    const savedVarMap = new Map(this.varMap);
    const savedConstraintVarNames = new Set(this.constraintVarNames);

    // Constraint-head atoms are parsed with label-variable resolution
    // suppressed: a lowercase ident in a constraint head (`Array k =>`) is
    // always a constraint type variable, never a `[k]` record label — even
    // when the same name also appears as `[k]` later in the signature.
    const savedSuppress = this.suppressLabelVars;
    this.suppressLabelVars = true;
    try {

    // Try form 3 first: (T1 | T2 | ...) v =>
    // We attempt to parse a parenthesised type containing at least one
    // top-level `|`, followed by a lowercase ident, followed by `=>`.
    if (this.peek().kind === 'LPAREN') {
      try {
        this.advance(); // consume (
        const parsedType = this.parseType();
        if (
          parsedType.tag === 'TCon' &&
          parsedType.name === T_UNION &&
          this.peek().kind === 'RPAREN'
        ) {
          this.advance(); // consume )
          if (this.peek().kind === 'IDENT' && LOWERCASE_RE.test(this.peek().value)) {
            const varName = this.advance().value;
            if (this.peek().kind === 'FAT_ARROW') {
              this.advance(); // consume =>
              if (!this.varMap.has(varName)) {
                const id = freshTypeVarId();
                this.varMap.set(varName, id);
              }
              this.constraintVarNames.add(varName);
              const display = `(${parsedType.args.map(a => {
                const s = typeToString(a);
                return a.tag === 'TFun' ? `(${s})` : s;
              }).join(' | ')})`;
              return [{
                className: display,
                typeVarName: varName,
                unionAlternatives: parsedType.args,
              }];
            }
          }
        }
        // Pattern didn't match — restore.
        this.pos = savedPos;
        this.varMap = new Map(savedVarMap);
        this.constraintVarNames = new Set(savedConstraintVarNames);
      } catch {
        this.pos = savedPos;
        this.varMap = new Map(savedVarMap);
        this.constraintVarNames = new Set(savedConstraintVarNames);
      }
    }

    try {
      // Try form 2: (Constraint, Constraint, ...) =>
      if (this.peek().kind === 'LPAREN') {
        const constraints = this.parseConstraintList();
        if (this.peek().kind === 'FAT_ARROW') {
          this.advance(); // consume =>
          return constraints;
        }
      }

      // Try form 1: ClassName varName => or ClassName (varName args...) =>
      if (this.peek().kind === 'IDENT' && UPPERCASE_RE.test(this.peek().value)) {
        const className = this.advance().value;

        // Applied constraint: ClassName (varName args...) =>
        if (this.peek().kind === 'LPAREN') {
          this.advance(); // consume (
          if (this.peek().kind === 'IDENT' && LOWERCASE_RE.test(this.peek().value)) {
            const varName = this.advance().value;
            if (!this.varMap.has(varName)) {
              const id = freshTypeVarId();
              this.varMap.set(varName, id);
            }
            this.constraintVarNames.add(varName);
            // Consume inner type args (plain vars or nested applications)
            const { names: innerArgNames, types: innerArgTypes } = this.parseAppliedConstraintArgs();
            this.expect('RPAREN');

            if (innerArgNames.length === 0) {
              throw new TypeParseError(`Applied constraint '${className} (${varName})' requires inner type arguments. Use '${className} ${varName}' or '${className} (${varName} a)'.`);
            }

            const constraints: Constraint[] = [{ className, typeVarName: varName, isApplied: true, appliedArgNames: innerArgNames, appliedArgs: innerArgTypes }];

            // Check for comma-separated additional constraints (no parens)
            while (this.peek().kind === 'COMMA') {
              this.advance(); // consume ,
              constraints.push(this.parseSingleConstraint());
            }

            if (this.peek().kind === 'FAT_ARROW') {
              this.advance(); // consume =>
              return constraints;
            }
          }
        }

        // Unified collector for the remaining single-constraint forms:
        //   - simple:    `ClassName v =>`
        //   - mixed:     `ClassName T1 T2 ... v =>`  (positional + bound var)
        //   - concrete:  `ClassName T =>`            (single concrete arg)
        //   - all-extra: `ClassName T1 T2 ... T =>`  (all positional concrete)
        // Atoms are parsed via `parseSimpleAtom` so uppercase identifiers do
        // NOT consume juxtaposition arguments — each token is one positional
        // arg. Result is stored as `positionalArgs: Type[]`. `typeVarName`
        // mirrors the LAST atom when it is a bare lowercase ident; otherwise
        // it is the synthetic placeholder '_concrete'.
        {
          const collectSavedPos = this.pos;
          const collectSavedVarMap = new Map(this.varMap);
          try {
            const atoms: Type[] = [];
            while (
              this.peek().kind === 'IDENT' ||
              this.peek().kind === 'LPAREN' ||
              this.peek().kind === 'LBRACKET' ||
              this.peek().kind === 'LBRACE'
            ) {
              atoms.push(this.parseSimpleAtom());
            }
            if (atoms.length >= 1) {
              const last = atoms[atoms.length - 1];
              const lastIsBareVar = last.tag === 'TVar' && !!last.name;

              // Allow comma-separated additional constraints only for the
              // pure simple case (single bare TVar); mixed/concrete forms
              // are stand-alone.
              if (atoms.length === 1 && lastIsBareVar) {
                const tv = last as Extract<Type, { tag: 'TVar' }>;
                this.constraintVarNames.add(tv.name);
                const constraints: Constraint[] = [{ className, typeVarName: tv.name }];
                while (this.peek().kind === 'COMMA') {
                  this.advance(); // consume ,
                  constraints.push(this.parseSingleConstraint());
                }
                if (this.peek().kind === 'FAT_ARROW') {
                  this.advance(); // consume =>
                  return constraints;
                }
              } else if (this.peek().kind === 'FAT_ARROW') {
                this.advance(); // consume =>
                if (lastIsBareVar) {
                  const tv = last as Extract<Type, { tag: 'TVar' }>;
                  this.constraintVarNames.add(tv.name);
                  return [{
                    className,
                    typeVarName: tv.name,
                    positionalArgs: atoms,
                  }];
                }
                return [{
                  className,
                  typeVarName: '_concrete',
                  positionalArgs: atoms,
                }];
              }
            }
            // No match \u2014 restore.
            this.pos = collectSavedPos;
            this.varMap = collectSavedVarMap;
          } catch {
            this.pos = collectSavedPos;
            this.varMap = collectSavedVarMap;
          }
        }
      }

      // No constraints found — restore position
      this.pos = savedPos;
      this.varMap = savedVarMap;
      this.constraintVarNames = savedConstraintVarNames;
      return [];
    } catch (e) {
      // Re-throw explicit applied-constraint validation errors so they surface
      // as proper diagnostics rather than being silently swallowed.
      if (e instanceof TypeParseError && (e as TypeParseError).message.includes('requires inner type arguments')) {
        throw e;
      }
      this.pos = savedPos;
      this.varMap = savedVarMap;
      this.constraintVarNames = savedConstraintVarNames;
      return [];
    }
    } finally {
      this.suppressLabelVars = savedSuppress;
    }
  }

  private parseConstraintList(): Constraint[] {
    this.expect('LPAREN');
    const constraints: Constraint[] = [];

    // Parse first constraint
    constraints.push(this.parseSingleConstraint());

    // Parse remaining constraints
    while (this.peek().kind === 'COMMA') {
      this.advance(); // consume ,
      constraints.push(this.parseSingleConstraint());
    }

    this.expect('RPAREN');
    return constraints;
  }

  /** Parse the inner argument list of an applied constraint (after the head
   *  var of `Setoid (f b)`).  Accepts plain lowercase type vars and nested
   *  parenthesized applications (`Setoid (f (t a))`), encoding the latter
   *  exactly like the signature body encodes `t a` (a kv-named TCon) so
   *  signatures compare consistently. */
  private parseAppliedConstraintArgs(): { names: string[]; types: Type[] } {
    const names: string[] = [];
    const types: Type[] = [];
    for (;;) {
      const tok = this.peek();
      if (tok.kind === 'IDENT' && LOWERCASE_RE.test(tok.value)) {
        this.advance();
        if (!this.varMap.has(tok.value)) {
          this.varMap.set(tok.value, freshTypeVarId());
        }
        names.push(tok.value);
        types.push({ tag: 'TVar', id: this.varMap.get(tok.value)!, name: tok.value });
        continue;
      }
      if (tok.kind === 'LPAREN') {
        this.advance(); // consume (
        const headTok = this.expect('IDENT');
        if (!LOWERCASE_RE.test(headTok.value)) {
          throw new TypeParseError(`Expected type variable (lowercase) in nested applied-constraint argument, got '${headTok.value}'`);
        }
        if (!this.varMap.has(headTok.value)) {
          this.varMap.set(headTok.value, freshTypeVarId());
        }
        const inner = this.parseAppliedConstraintArgs();
        this.expect('RPAREN');
        if (inner.types.length === 0) {
          throw new TypeParseError(`Nested applied-constraint argument '(${headTok.value})' requires inner type arguments`);
        }
        names.push(`(${headTok.value} ${inner.names.join(' ')})`);
        types.push(tCon(kvName(headTok.value, this.varMap.get(headTok.value)!), inner.types));
        continue;
      }
      break;
    }
    return { names, types };
  }

  private parseSingleConstraint(): Constraint {
    // Structural-union head inside a constraint list: `(T1 | T2 | …) v`.
    // Mirrors form 3 in `tryParseConstraints`, but here the surrounding
    // parens belong to the list (e.g. `(String p, (Number | Undefined) x)`).
    if (this.peek().kind === 'LPAREN') {
      this.advance(); // consume (
      const parsedType = this.parseType();
      if (parsedType.tag !== 'TCon' || parsedType.name !== T_UNION) {
        throw new TypeParseError('Expected a union type `(T1 | T2 | …)` in a parenthesised constraint head');
      }
      this.expect('RPAREN');
      const varTok = this.expect('IDENT');
      if (!LOWERCASE_RE.test(varTok.value)) {
        throw new TypeParseError(`Expected type variable (lowercase) after union constraint head, got '${varTok.value}'`);
      }
      if (!this.varMap.has(varTok.value)) {
        const id = freshTypeVarId();
        this.varMap.set(varTok.value, id);
      }
      this.constraintVarNames.add(varTok.value);
      const display = `(${parsedType.args.map(a => {
        const s = typeToString(a);
        return a.tag === 'TFun' ? `(${s})` : s;
      }).join(' | ')})`;
      return {
        className: display,
        typeVarName: varTok.value,
        unionAlternatives: parsedType.args,
      };
    }

    const classNameTok = this.expect('IDENT');
    if (!UPPERCASE_RE.test(classNameTok.value)) {
      throw new TypeParseError(`Expected constraint name (uppercase), got '${classNameTok.value}'`);
    }

    // Support applied constraints: Monoid (f a)
    if (this.peek().kind === 'LPAREN') {
      this.advance(); // consume (
      const outerTok = this.expect('IDENT');
      if (!LOWERCASE_RE.test(outerTok.value)) {
        throw new TypeParseError(`Expected type variable (lowercase) in applied constraint, got '${outerTok.value}'`);
      }
      // Register the outer kind variable
      if (!this.varMap.has(outerTok.value)) {
        const id = freshTypeVarId();
        this.varMap.set(outerTok.value, id);
      }
      this.constraintVarNames.add(outerTok.value);
      // Consume any inner type args (e.g. the `a` in `f a`, or a nested
      // application like `(t a)` in `Setoid (f (t a))`)
      const { names: innerArgNames, types: innerArgTypes } = this.parseAppliedConstraintArgs();
      this.expect('RPAREN');
      if (innerArgNames.length === 0) {
        throw new TypeParseError(`Applied constraint '${classNameTok.value} (${outerTok.value})' requires inner type arguments. Use '${classNameTok.value} ${outerTok.value}' or '${classNameTok.value} (${outerTok.value} a)'.`);
      }
      return { className: classNameTok.value, typeVarName: outerTok.value, isApplied: true, appliedArgNames: innerArgNames, appliedArgs: innerArgTypes };
    }

    const varNameTok = this.expect('IDENT');
    if (!LOWERCASE_RE.test(varNameTok.value)) {
      throw new TypeParseError(`Expected type variable (lowercase) after constraint name, got '${varNameTok.value}'`);
    }
    // Ensure the type var is registered
    if (!this.varMap.has(varNameTok.value)) {
      const id = freshTypeVarId();
      this.varMap.set(varNameTok.value, id);
    }
    this.constraintVarNames.add(varNameTok.value);
    return { className: classNameTok.value, typeVarName: varNameTok.value };
  }

  // -----------------------------------------------------------------------
  // Type   = Union ( -> Type )?       (`->` is right-associative)
  // Union  = Atom ( | Atom )*         (`|` binds TIGHTER than `->`)
  //
  // So `A | B -> C` parses as `(A | B) -> C` — the most natural reading.
  // To make a function a union member, write `A | (B -> C)` explicitly.
  // -----------------------------------------------------------------------

  parseType(): Type {
    // Nested quantifier: `forall a b. [Constraints =>] Type`.  `forall` is a
    // CONTEXTUAL keyword — only recognised when followed by one or more
    // lowercase identifiers and a dot, so `forall` stays usable as an
    // ordinary type-variable name (backward compatibility).
    if (this.isForallAhead()) return this.parseForall();

    let left = this.parseAtom();

    // Union: collect all `| Atom` members first (no arrows inside members).
    if (this.peek().kind === 'PIPE') {
      const members = [left];
      while (this.peek().kind === 'PIPE') {
        this.advance(); // consume |
        members.push(this.parseAtom());
      }
      left = tUnion(members);
    }

    // Then optionally a single `->` makes everything-so-far the param.
    if (this.peek().kind === 'ARROW') {
      this.advance(); // consume ->
      const right = this.parseType(); // right-associative
      return tFun(left, right);
    }

    return left;
  }

  /** Lookahead: IDENT `forall`, then ≥1 lowercase IDENT, then `.` */
  private isForallAhead(): boolean {
    const t0 = this.peek();
    if (t0.kind !== 'IDENT' || t0.value !== 'forall') return false;
    let i = this.pos + 1;
    let count = 0;
    while (this.tokens[i] && this.tokens[i].kind === 'IDENT' && LOWERCASE_RE.test(this.tokens[i].value)) {
      i++;
      count++;
    }
    return count > 0 && this.tokens[i] !== undefined && this.tokens[i].kind === 'DOT';
  }

  /** Parse `forall a b. [Constraints =>] Type` into a TForall node.
   *  The bound names shadow same-named outer variables while the body is
   *  parsed, and are removed from `varMap` afterwards so the enclosing
   *  scheme never auto-quantifies them. */
  private parseForall(): Type {
    this.advance(); // 'forall'
    const names: string[] = [];
    while (this.peek().kind === 'IDENT' && LOWERCASE_RE.test(this.peek().value)) {
      names.push(this.advance().value);
    }
    this.expect('DOT');

    // Scope: shadow outer vars of the same name with fresh bound ids.
    const savedVarIds: Array<[string, number | undefined]> = names.map(n => [n, this.varMap.get(n)]);
    const savedConstraintHas: Array<[string, boolean]> = names.map(n => [n, this.constraintVarNames.has(n)]);
    const vars: number[] = [];
    for (const n of names) {
      const id = freshTypeVarId();
      this.varMap.set(n, id);
      vars.push(id);
    }

    // Optional scoped constraints: `forall f. Functor f => …`.  These parse
    // via the regular constraint machinery (which also registers `f` in
    // `constraintVarNames`, so `f a` in the body parses as a kv application).
    const constraints = this.tryParseConstraints();
    for (const c of constraints) {
      const idx = names.indexOf(c.typeVarName);
      if (idx >= 0 && c.varId === undefined) c.varId = vars[idx];
    }

    const body = this.parseType();

    // Restore the enclosing scope.
    for (const [n, old] of savedVarIds) {
      if (old === undefined) this.varMap.delete(n);
      else this.varMap.set(n, old);
    }
    for (const [n, had] of savedConstraintHas) {
      if (!had) this.constraintVarNames.delete(n);
    }

    this.sawForall = true;
    return tForall(vars, names, body, constraints.length > 0 ? constraints : undefined);
  }

  // -----------------------------------------------------------------------
  // Atom = '(' Type ')'  |  '[' Type ']'  |  Ident  |  Ident '<' Type (',' Type)* '>'
  // -----------------------------------------------------------------------

  parseAtom(): Type {
    return this.parseAtomCore(true);
  }

  /**
   * Parse a simple atom without juxtaposition — uppercase identifiers are
   * returned as bare TCon (no args consumed).  Parenthesized groups and
   * array shorthand still allow full types inside them.
   */
  private parseSimpleAtom(): Type {
    return this.parseAtomCore(false);
  }

  /**
   * Core atom parser.
   * When `withJuxtaposition` is true, an uppercase identifier consumes following
   * simple atoms as type arguments (e.g. `Box a`, `Either a b`).
   * When false, uppercase identifiers are returned bare as `tCon(name, [])`.
   */
  private parseAtomCore(withJuxtaposition: boolean): Type {
    const tok = this.peek();

    // Record type: { field :: Type, field2 :: Type, ... }
    if (tok.kind === 'LBRACE') {
      return this.parseRecordType();
    }

    // Parenthesized type or tuple: (A) or (A, B, ...) or (..., Y, Z) or () for unit/void
    if (tok.kind === 'LPAREN') {
      this.advance();
      // () — empty parens represent the Unit/Void type
      if (this.peek().kind === 'RPAREN') {
        this.advance();
        return tCon('Void');
      }
      // Leading spread: (..., y, z)
      if (this.peek().kind === 'ELLIPSIS') {
        this.advance(); // consume ...
        const types: Type[] = [tSpread];
        while (this.peek().kind === 'COMMA') {
          this.advance(); // consume ,
          if (this.peek().kind === 'ELLIPSIS') {
            this.advance(); // consume ...
            types.push(tSpread);
            continue;
          }
          types.push(this.parseType());
        }
        this.expect('RPAREN');
        return tCon(T_TUPLE, types);
      }
      const first = this.parseType();
      if (this.peek().kind === 'COMMA') {
        // Tuple: (A, B, ...) — used for multi-param function types
        const types = [first];
        while (this.peek().kind === 'COMMA') {
          this.advance(); // consume ,
          // Spread marker: (a, ..., z) — variadic tuple
          if (this.peek().kind === 'ELLIPSIS') {
            this.advance(); // consume ...
            types.push(tSpread);
            continue;
          }
          types.push(this.parseType());
        }
        this.expect('RPAREN');
        return tCon(T_TUPLE, types);
      }
      // Parenthesized higher-kinded application: (f m), (f a b), etc.
      // When the inner type is a bare TVar and there are remaining atom
      // tokens before the closing paren, treat as kind-variable application.
      // Reject legacy predicate syntax: (a is Type).
      if (first.tag === 'TVar' && this.peek().kind !== 'RPAREN') {
        if (this.peek().kind === 'IDENT' && this.peek().value === 'is') {
          throw new TypeParseError(
            `Legacy inline type predicate syntax (${first.name} is ...) is not supported. Use ::narrow instead.`,
          );
        }
        const args: Type[] = [];
        while (
          this.peek().kind !== 'RPAREN' &&
          this.peek().kind !== 'EOF' &&
          (this.peek().kind === 'IDENT' ||
           this.peek().kind === 'LPAREN' ||
           this.peek().kind === 'LBRACKET' ||
           this.peek().kind === 'LBRACE' ||
           this.peek().kind === 'NUMBER' ||
           this.peek().kind === 'STRING')
        ) {
          args.push(this.parseAtomCore(false));
        }
        if (args.length > 0) {
          this.expect('RPAREN');
          return tCon(kvName(first.name, first.id), args);
        }
      }
      this.expect('RPAREN');
      return first;
    }

    // Array shorthand: [Type] or spread array: [a, ..., b] or [..., a, b]
    if (tok.kind === 'LBRACKET') {
      this.advance();
      // Strict empty array: `[]` — analogous to strict empty record `{}`.
      // Encoded as a 1-arg `Array` (fresh element var) carrying the
      // `strictEmpty` flag so the `Array` arity invariant holds while
      // unification still treats it as "accepts only an empty array".
      if (this.peek().kind === 'RBRACKET') {
        this.advance(); // consume ]
        return { tag: 'TCon', name: 'Array', args: [tVar()], strictEmpty: true };
      }
      // Leading spread: [..., a, b]
      if (this.peek().kind === 'ELLIPSIS') {
        this.advance(); // consume ...
        const types: Type[] = [tSpread];
        while (this.peek().kind === 'COMMA') {
          this.advance(); // consume ,
          if (this.peek().kind === 'ELLIPSIS') {
            this.advance(); // consume ...
            types.push(tSpread);
            continue;
          }
          types.push(this.parseType());
        }
        this.expect('RBRACKET');
        return tCon('SpreadArray', types);
      }
      const first = this.parseType();
      if (this.peek().kind === 'COMMA') {
        // Spread array: [a, ..., b] or [a -> b, b -> c, ..., y -> z]
        // Also: trailing comma `[a,]` → a FIXED 1-slot SpreadArray (exactly
        // one element of type `a`), distinct from `[a]` (= `Array a`, any length).
        const types = [first];
        while (this.peek().kind === 'COMMA') {
          this.advance(); // consume ,
          if (this.peek().kind === 'RBRACKET') break; // trailing comma
          if (this.peek().kind === 'ELLIPSIS') {
            this.advance(); // consume ...
            types.push(tSpread);
            continue;
          }
          types.push(this.parseType());
        }
        this.expect('RBRACKET');
        return tCon('SpreadArray', types);
      }
      this.expect('RBRACKET');
      return tCon('Array', [first]);
    }

    // Must be an identifier
    if (tok.kind === 'IDENT') {
      const name = this.advance().value;

      // Boolean literal values: true, false → infer Boolean type
      if (name === 'true' || name === 'false') {
        return tBool;
      }

      // Lowercase type keywords: null → Null, undefined → Undefined
      if (name === 'null') {
        return tNull;
      }
      if (name === 'undefined') {
        return tUndefined;
      }

      // Check for generic args: Ident '<' ... '>'
      if (this.peek().kind === 'LANGLE') {
        this.advance(); // consume <
        const args: Type[] = [this.parseType()];
        while (this.peek().kind === 'COMMA') {
          this.advance(); // consume ,
          args.push(this.parseType());
        }
        this.expect('RANGLE');
        return tCon(name, args);
      }

      // Is it a known concrete type (starts uppercase) or a type variable (lowercase)?
      if (name[0] === name[0].toUpperCase() && UPPERCASE_RE.test(name)) {
        if (!withJuxtaposition) {
          // Simple mode: return bare TCon without consuming any arguments
          return tCon(name, []);
        }
        // Juxtaposition type application: Box a, Box Number, Either a b, etc.
        // Consume following *simple* atoms as type arguments (lowercase vars,
        // uppercase concrete types WITHOUT their own juxtaposition args,
        // parenthesized types, and array shorthand).
        //
        // When the arity of this constructor is known, parse the last
        // positional argument with full juxtaposition (parseAtomCore(true))
        // so that constraint variables like `f` in `Pair Boolean f m` can
        // consume their own arguments (`f m` → $kv:f(m)).
        const knownArity = (name === 'Function' || name === 'Object')
          ? 2
          : this.typeArities.get(name);
        const args: Type[] = [];
        while (
          (this.peek().kind === 'IDENT' ||
           this.peek().kind === 'LPAREN' ||
           this.peek().kind === 'LBRACKET' ||
           this.peek().kind === 'LBRACE' ||
           this.peek().kind === 'NUMBER' ||
           this.peek().kind === 'STRING')
        ) {
          const isLastPosition = knownArity !== undefined && args.length === knownArity - 1;
          args.push(this.parseAtomCore(isLastPosition));
        }
        return tCon(name, args);
      }

      // Lowercase type variable — may be a higher-kinded constructor
      // via juxtaposition: f a, m b, m (Maybe a).
      // Constraint variables (from `Functor f =>`) get full juxtaposition
      // (consuming any following atoms).  Non-constraint variables only get
      // HK treatment when followed by a parenthesized group — this covers
      // the common m (Maybe a) pattern without breaking trailing-token checks.

      // Label variables (any name appearing as `[name]` somewhere in the
      // signature, picked up during pre-scan) are returned as TLabel
      // wherever they appear bare in type position — e.g. the first `k`
      // in `k -> { [k] :: a, ...r } -> { ...r }`.
      //
      // EXCEPTION: when the same name is ALSO a constraint variable
      // (`Array String k => k -> { [k] :: a }`), the constraint binding wins
      // for bare/applied `k` in type position so it can be baked to the
      // constrained type (`k := Array String`).  The `[k]` record key itself
      // is still resolved to the shared label by `parseRecordField`.
      if (this.labelVarMap.has(name) &&
          !this.suppressLabelVars &&
          !this.constraintVarNames.has(name)) {
        return this.labelVarMap.get(name)!;
      }
      if (!this.varMap.has(name)) {
        const id = freshTypeVarId();
        this.varMap.set(name, id);
      }
      const varId = this.varMap.get(name)!;

      if (withJuxtaposition &&
          (this.constraintVarNames.has(name) || this.peek().kind === 'LPAREN')) {
        // Parse juxtaposition args (like uppercase constructors)
        const args: Type[] = [];
        while (
          (this.peek().kind === 'IDENT' ||
           this.peek().kind === 'LPAREN' ||
           this.peek().kind === 'LBRACKET' ||
           this.peek().kind === 'LBRACE' ||
           this.peek().kind === 'NUMBER' ||
           this.peek().kind === 'STRING')
        ) {
          args.push(this.parseAtomCore(false));
        }
        if (args.length > 0) {
          // Higher-kinded application: encode as $kv:name:id TCon
          return tCon(kvName(name, varId), args);
        }
      }

      // No args or simple mode: just a bare type variable
      return { tag: 'TVar', id: varId, name };
    }

    // Number literal in type position → numeric literal (singleton) type,
    // e.g. `_Tuple :: 2 -> …` (see `tNumLit`).
    if (tok.kind === 'NUMBER') {
      this.advance();
      return tNumLit(Number(tok.value));
    }

    // String literal in type position → label-literal (singleton) type.
    // E.g. `'id'` parses as tLabelLit('id'), and `'id' | 'name'` becomes a
    // union of label-lits — usable for per-key string-literal validation
    // (see query-builder per-table selector unions).  TLabelLit is silently
    // unify-compatible with the wide `String` type, so existing code that
    // wrote a single string-literal where a String was expected still works.
    if (tok.kind === 'STRING') {
      this.advance();
      // Strip surrounding quotes (the tokenizer keeps them in `value`).
      const raw = tok.value;
      const inner = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'")
        ? raw.slice(1, -1)
        : raw;
      return tLabelLit(inner);
    }

    // Star (*) — wildcard / any type
    if (tok.kind === 'STAR') {
      this.advance();
      return tAny;
    }

    // Bare spread marker: ... (used in curry result types like a -> b -> ... -> z)
    if (tok.kind === 'ELLIPSIS') {
      this.advance();
      return tSpread;
    }

    throw new TypeParseError(
      `Unexpected token ${tok.kind} ("${tok.value}") — expected a type`,
    );
  }

  // -----------------------------------------------------------------------
  // Record type: { key :: Type, key2 :: Type, ... }
  // Values can be types OR literal values (numbers, strings, booleans)
  // -----------------------------------------------------------------------

  private parseRecordType(): Type {
    this.expect('LBRACE');

    // Reject the alternate row-rest syntax `{ a :: T | r }` — only
    // the spread form `{ a :: T, ...r }` is supported.  We scan ahead
    // for a top-level PIPE within the matching braces; a union value
    // type like `{ a :: Integer | String }` is still allowed because
    // the trailing `}` is preceded by an IDENT that is *not* the last
    // token before `}` in a row-rest position — distinguish by
    // checking whether the PIPE is followed by exactly `IDENT }` or
    // `IDENT ,`.
    {
      let depth = 1;
      let i = this.pos;
      while (i < this.tokens.length && depth > 0) {
        const tk = this.tokens[i];
        if (tk.kind === 'LBRACE' || tk.kind === 'LPAREN' || tk.kind === 'LBRACKET') depth++;
        else if (tk.kind === 'RBRACE' || tk.kind === 'RPAREN' || tk.kind === 'RBRACKET') depth--;
        else if (depth === 1 && tk.kind === 'PIPE') {
          const a = this.tokens[i + 1];
          const b = this.tokens[i + 2];
          if (a && b && a.kind === 'IDENT' && LOWERCASE_RE.test(a.value)
              && (b.kind === 'RBRACE' || b.kind === 'COMMA')) {
            throw new TypeParseError(
              `Use '...${a.value}' for record row-rest, not '| ${a.value}'`,
            );
          }
        }
        i++;
      }
    }

    const fields: Record<string, Type> = {};
    const labelFields: Array<{ label: TLabel; type: Type }> = [];
    // Collect ALL spread (`...x`) row variables; if more than one we lower
    // to `Merge` (see Plan v6.3 Phase A).
    const rests: (TVar | TRow)[] = [];

    const buildSingleRecord = (rest?: TVar | TRow): Type => {
      const out = rest ? tOpenRecord(fields, rest) : tRecord(fields);
      if (labelFields.length > 0) (out as { labelFields?: typeof labelFields }).labelFields = labelFields;
      return out;
    };

    const finish = (): Type => {
      if (rests.length <= 1) {
        // A literal `{}` in an annotation is a strict, closed, exactly-empty
        // object: tag it so unification refuses to absorb surplus fields.
        if (rests.length === 0
            && Object.keys(fields).length === 0
            && labelFields.length === 0) {
          return { tag: 'TRecord', fields: {}, strictEmpty: true };
        }
        return buildSingleRecord(rests[0]);
      }
      // Multi-spread → lower to Merge.  When concrete fields/labelFields
      // are present, the first Merge arg is a closed TRecord holding them.
      const hasConcrete = Object.keys(fields).length > 0 || labelFields.length > 0;
      const args: Type[] = [];
      if (hasConcrete) args.push(buildSingleRecord(undefined));
      for (const r of rests) args.push(r);
      return tCon(T_MERGE, args);
    };

    // Empty record: {}
    if (this.peek().kind === 'RBRACE') {
      this.advance();
      return finish();
    }

    // Parse comma-separated entries: each entry is a field, a bracket-form
    // field, or a `...rowvar` spread.  Multiple spreads are allowed.
    const parseEntry = (): void => {
      if (this.peek().kind === 'ELLIPSIS') {
        rests.push(this.parseRowVar());
        return;
      }
      // Shorthand row variable: a lone lowercase identifier (`{a}` or the `a`
      // in `{a, b}`) is sugar for the spread form `{...a}` — an open record
      // whose unknown fields range over the row variable `a`.
      const cur = this.peek();
      const next = this.tokens[this.pos + 1];
      if (cur.kind === 'IDENT' && LOWERCASE_RE.test(cur.value)
          && next && (next.kind === 'RBRACE' || next.kind === 'COMMA')) {
        this.advance(); // consume the identifier
        rests.push(this.rowVarFromName(cur.value));
        return;
      }
      this.parseRecordField(fields, labelFields);
    };

    parseEntry();
    while (this.peek().kind === 'COMMA') {
      this.advance(); // consume ,
      parseEntry();
    }

    this.expect('RBRACE');
    return finish();
  }

  private parseRowVar(): TRow {
    this.advance(); // consume ...
    const tok = this.expect('IDENT');
    if (!LOWERCASE_RE.test(tok.value)) {
      throw new TypeParseError(
        `Row variable must be a lowercase identifier (got '${tok.value}')`,
      );
    }
    return this.rowVarFromName(tok.value);
  }

  /**
   * Build a row variable (`TRow`) for a given name.  Row variables share the
   * type-var id space (the disjointness is enforced by `tag`, not by id
   * allocation).  The name is registered in `varMap` so quantification picks
   * it up at scheme-creation time, and the emitted `TRow`'s `id` matches the
   * shared name's id.  Used for both the `...a` spread form and the `{a}`
   * shorthand.
   */
  private rowVarFromName(name: string): TRow {
    if (!this.varMap.has(name)) {
      this.varMap.set(name, freshTypeVarId());
    }
    const id = this.varMap.get(name)!;
    return { tag: 'TRow', id, name };
  }

  private parseRecordField(
    fields: Record<string, Type>,
    labelFields: Array<{ label: TLabel; type: Type }>,
  ): void {
    // Bracket-form field key: `[k] :: type` or `['x'] :: type`
    if (this.peek().kind === 'LBRACKET') {
      this.advance(); // [
      const tok = this.advance();
      if (tok.kind !== 'IDENT' || !LOWERCASE_RE.test(tok.value)) {
        throw new TypeParseError(
          `Bracketed record key must be a label variable (lowercase ident), got '${tok.value}'`,
        );
      }
      if (!this.labelVarMap.has(tok.value)) {
        this.labelVarMap.set(tok.value, tLabelVar(tok.value));
      }
      const label: TLabel = this.labelVarMap.get(tok.value)!;
      this.expect('RBRACKET');
      this.expect('COLON');
      if (this.peek().kind !== 'COLON') {
        throw new TypeParseError(
          `Use '::' for record field separator after bracketed key`,
        );
      }
      this.advance(); // second :
      const valueType = this.parseType();
      labelFields.push({ label, type: valueType });
      return;
    }

    const keyTok = this.expect('IDENT');
    this.expect('COLON');
    if (this.peek().kind !== 'COLON') {
      throw new TypeParseError(
        `Use '::' for record field separator (found single ':' after '${keyTok.value}')`,
      );
    }
    this.advance(); // consume second ':'
    const valueType = this.parseType();
    fields[keyTok.value] = valueType;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the error for input left over after a complete type was parsed.
 * Two leftovers have a known cause and get an actionable message instead of
 * the bare "Unexpected trailing token":
 *  - `f a` where `f` is a lowercase variable without a constraint: only
 *    constraint variables absorb juxtaposed arguments (see README, "Generics
 *    & Higher-Kinded Types"), so the parse stops after `f`.
 *  - a `=>` that the constraint list could not claim, e.g.
 *    `(TypeRep M, Monad m) => …`: a constraint must be `Class var` with a
 *    lowercase variable, so the parenthesised list was parsed as a tuple.
 */
function trailingTokenError(parser: TypeParser): TypeParseError {
  const tok: Token = parser['peek']();
  const prev: Token | undefined = parser['tokens'][parser['pos'] - 1];
  if (tok.kind === 'FAT_ARROW') {
    return new TypeParseError(
      `Unexpected '=>': each constraint must be a class applied to a lowercase type variable (e.g. 'Monad m =>'); a concrete type such as 'TypeRep M' cannot appear in the constraint list`,
    );
  }
  if (
    prev && prev.kind === 'IDENT' && /^[a-z]/.test(prev.value)
    && (tok.kind === 'IDENT' || tok.kind === 'LBRACKET' || tok.kind === 'LBRACE')
  ) {
    return new TypeParseError(
      `Type variable '${prev.value}' is applied to '${tok.value}' but has no constraint. Add a constraint like 'Functor ${prev.value} =>' to use it as a type constructor`,
    );
  }
  return new TypeParseError(`Unexpected trailing token: ${tok.value}`);
}

/**
 * Parse a Hindley-Milner type signature string into a `Scheme`.
 *
 * Examples:
 *   "Number -> String"
 *   "a -> a"
 *   "[Number] -> Number"
 *   "(Number -> String) -> Boolean"
 *   "Box a"  (juxtaposition type application)
 */
export function parseTypeSignature(input: string, constraintVarNames?: Iterable<string>, typeArities?: Map<string, number>): Scheme {
  const tokens = tokenize(input);

  const parser = new TypeParser(tokens);

  if (constraintVarNames) {
    for (const name of constraintVarNames) {
      parser['constraintVarNames'].add(name);
    }
  }

  if (typeArities) {
    parser['typeArities'] = typeArities;
  }

  const scheme = parser.parseScheme();

  // Verify we consumed everything (allow ~> to stop here for method sigs)
  if (parser['peek']().kind !== 'EOF' && parser['peek']().kind !== 'SQUIGGLY') {
    throw trailingTokenError(parser);
  }
  return scheme;
}

/**
 * Parse a type signature, returning only the `Type` (discarding quantifiers).
 */
export function parseType(input: string): Type {
  return parseTypeSignature(input).type;
}

// ---------------------------------------------------------------------------
// Method type signature: ReceiverType ~> MethodType
// ---------------------------------------------------------------------------

export interface MethodTypeSignature {
  /** The receiver type, e.g. `Box a` */
  receiver: Type;
  /** The method's type, e.g. `(a -> b) -> Box b` */
  methodType: Type;
  /** Full scheme (vars shared between receiver and method) */
  scheme: Scheme;
}

/**
 * Parse a method type signature with `~>` syntax.
 *
 * Example: "Box a ~> (a -> b) -> Box b"
 * Returns: { receiver: Box<a>, methodType: (a -> b) -> Box<b> }
 *
 * @param constraintVarNames Optional set of type variable names that should
 *   be treated as higher-kinded (constraint) variables. This allows parsing
 *   `f a ~> ...` where `f` is a constraint type variable.
 */
export function parseMethodTypeSignature(
  input: string,
  constraintVarNames?: Iterable<string>,
  typeArities?: Map<string, number>,
): MethodTypeSignature {
  const tokens = tokenize(input);
  const parser = new TypeParser(tokens);

  // Populate constraint variable names so the parser can handle
  // higher-kinded type application like `f a`
  if (constraintVarNames) {
    for (const name of constraintVarNames) {
      parser['constraintVarNames'].add(name);
    }
  }

  if (typeArities) {
    parser['typeArities'] = typeArities;
  }

  // Parse optional constraints: `Monad m =>` or `(Functor f, Monad m) =>`
  const constraints = parser['tryParseConstraints']();

  // Parse receiver type (left of ~>)
  const receiver = parser['normalizeObjectKeys'](parser['parseType']());
  parser['expect']('SQUIGGLY');

  // Parse method type (right of ~>)
  const methodType = parser['normalizeObjectKeys'](parser['parseType']());

  if (parser['peek']().kind !== 'EOF') {
    throw trailingTokenError(parser);
  }

  const vars = Array.from(parser['varMap'].values());
  return {
    receiver,
    methodType,
    scheme: { vars, type: methodType, constraints: constraints.length > 0 ? constraints : undefined },
  };
}
