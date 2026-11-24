// ============================================================================
// Constraint Registry — type class constraints for HM type annotations
//
// Plain language: a *constraint* is a membership requirement for types.
// "Functor f => …" reads: "this works for any container type f, PROVIDED f
// supports mapping".  This file is the notebook of all declared constraints
// and their required methods, plus the logic that decides whether a concrete
// type earns the membership card ("does Array have a map method? then Array
// satisfies Functor").
//
// A constraint like `Functor` declares a set of method requirements.
// Any type that has those methods registered (via `#` annotations) satisfies
// the constraint structurally — no explicit `instance` declaration needed.
//
// Definition syntax (in JS comments):
//   // ::constraint Functor f { map :: f a ~> (a -> b) -> f b }
//   // ::constraint Monad m { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a }
//
// Usage in type signatures:
//   // map :: Functor f => (a -> b) -> f a -> f b
// ============================================================================

import { lookupMethod, MethodEntry } from './methodRegistry';
import { Type, TCon, parseKvName, typeToString, tCon, T_TUPLE, T_UNION, T_FUNCTION, isAnyType, functionParamList } from '../hm/types';
import { parseMethodTypeSignature, parseType } from '../hm/typeParser';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MethodRequirement {
  /** Method name, e.g. "map" */
  name: string;
  /** Raw signature text, e.g. "f a ~> (a -> b) -> f b" */
  signature: string;
  /** Type variable of the constraint that DECLARES the method (set by
   *  `getEffectiveMethods`).  An inherited method keeps its owner's variable:
   *  `map` reached through `Monad m` is still written `f a ~> …` (Functor f). */
  ownerTypeVar?: string;
}

/** Expected kind of the type parameter in a constraint definition. */
export type ConstraintKind = '*' | '* -> *';

export interface ConstraintDef {
  /** Constraint name, e.g. "Functor" */
  name: string;
  /** Type variable name used in the definition, e.g. "f" */
  typeVar: string;
  /** Required methods */
  methods: MethodRequirement[];
  /** Parent constraint names (inheritance), e.g. ["Functor", "Chain"] */
  extends?: string[];
  /** Expected kind of the type parameter, inferred from method signatures.
   *  `'* -> *'` when the type var is applied (e.g. `f a`), `'*'` when bare.
   *  Computed automatically from method signatures if not provided. */
  expectedKind?: ConstraintKind;
  /** Structural constraint header parameters, in declaration order.
   *  Set when the def was written as `::constraint Name p1 p2 … pN = …`.
   *  Mutually exclusive with `methods`/nominal form. */
  headerParams?: string[];
  /** Structural constraint self-clauses (one or more `<self> is <body>`).
   *  Each `selfParam` MUST be one of `headerParams`. The body's free
   *  variables that are not in `headerParams` are existential: every
   *  use-site instantiation gets fresh ids. The body uses parser-allocated
   *  TVar ids; resolution maps them per instantiation. */
  selfClauses?: { selfParam: string; body: Type }[];
  /** Source location of the originating `// ::constraint` directive.
   *  Populated by the registration call-site (per-file or sidecar) so
   *  hover / go-to-definition can navigate users back to the definition.
   *  All three fields are set together; `uri` may be `undefined` for
   *  in-memory directives without a backing file. */
  uri?: string;
  commentStart?: number;
  commentEnd?: number;
  /** Pretty body text between the outermost `{ … }` of the directive,
   *  trimmed.  Used by hover to show the constraint's body inline. */
  bodyText?: string;
}

/** Parsed constraint reference from a type signature, e.g. `Functor f` */
export interface Constraint {
  /** Constraint name, e.g. "Functor" */
  className: string;
  /** Type variable name it applies to, e.g. "f" */
  typeVarName: string;
}

// ---------------------------------------------------------------------------
// Registry class
// ---------------------------------------------------------------------------

/** Encapsulates constraint registry state and operations. */
export class ConstraintRegistry {
  private registry = new Map<string, ConstraintDef>();

  /** Register a constraint definition. Computes expectedKind if not provided. */
  register(def: ConstraintDef): void {
    if (def.expectedKind === undefined) {
      def.expectedKind = inferExpectedKind(def.typeVar, def.methods);
    }
    this.registry.set(def.name, def);
  }

  /** Look up a constraint definition by name. */
  lookup(name: string): ConstraintDef | null {
    const def = this.registry.get(name) ?? null;
    if (def) this.resolveInheritedKind(def);
    return def;
  }

  /**
   * Extends-only constraints (e.g. `::constraint Alternative f
   * { f :: Applicative, f :: Plus }`) have no method signatures of their own,
   * so parse-time kind inference defaults them to `*`.  Their true kind is the
   * kind of their parents.  Resolved lazily (parents may be registered after
   * the child) and memoized by upgrading `def.expectedKind` in place.
   */
  private resolveInheritedKind(def: ConstraintDef): void {
    if (
      def.expectedKind !== '*' ||
      def.methods.length > 0 ||
      (def.selfClauses && def.selfClauses.length > 0) ||
      !def.extends ||
      def.extends.length === 0
    ) {
      return;
    }
    // Walk all ancestors (cycle-safe); at least one concrete ancestor carries
    // its own kind from method signatures.
    for (const ancestor of this.superclassClosure(def.name)) {
      if (ancestor === def.name) continue;
      const parent = this.registry.get(ancestor);
      if (parent?.expectedKind === '* -> *') {
        def.expectedKind = '* -> *';
        return;
      }
    }
  }

  /** Get all registered constraint names. */
  getNames(): string[] {
    return Array.from(this.registry.keys());
  }

  /** Clear all constraint definitions. */
  clear(): void {
    this.registry.clear();
  }

  /** Save a snapshot of all constraint registrations. */
  snapshot(): ConstraintRegistrySnapshot {
    return new Map(this.registry);
  }

  /** Restore constraint registrations from a snapshot. */
  restore(snap: ConstraintRegistrySnapshot): void {
    this.registry.clear();
    for (const [k, v] of snap) {
      this.registry.set(k, v);
    }
  }

  /** Merge a snapshot's registrations (non-destructive). */
  merge(snap: ConstraintRegistrySnapshot): void {
    for (const [k, v] of snap) {
      if (!this.registry.has(k)) {
        this.registry.set(k, v);
      }
    }
  }

  /**
   * Collect all effective methods for a constraint, including inherited ones.
   * Child methods override parent methods of the same name.
   * Uses a visited set to prevent infinite loops in case of cycles.
   */
  getEffectiveMethods(constraintName: string): MethodRequirement[] {
    const methods = new Map<string, MethodRequirement>();
    const visited = new Set<string>();

    const collect = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);

      const def = this.registry.get(name);
      if (!def) return;

      // Collect parent methods first (so child methods override)
      if (def.extends) {
        for (const parent of def.extends) {
          collect(parent);
        }
      }

      // Own methods override inherited ones
      for (const m of def.methods) {
        methods.set(m.name, { ...m, ownerTypeVar: def.typeVar });
      }
    };

    collect(constraintName);
    return Array.from(methods.values());
  }

  /**
   * Collect the superclass closure of a constraint: the constraint itself
   * plus every ancestor reachable through `extends` (transitively).  Used to
   * decide whether a DECLARED (given) constraint entails a REQUIRED (wanted)
   * one — e.g. a signature declaring `Applicative f` also provides `Apply f`
   * and `Functor f`.
   */
  superclassClosure(constraintName: string): Set<string> {
    const out = new Set<string>();
    const visit = (name: string) => {
      if (out.has(name)) return;
      out.add(name);
      const def = this.registry.get(name);
      if (def?.extends) {
        for (const parent of def.extends) visit(parent);
      }
    };
    visit(constraintName);
    return out;
  }

  /**
   * Check whether a concrete type satisfies a constraint.
   * A type satisfies a constraint if it has all required methods registered
   * in the method registry. Includes inherited methods.
   */
  checkConstraint(constraintName: string, typeName: string): { satisfied: boolean; missing: string[] } {
    const def = this.registry.get(constraintName);
    if (!def) {
      return { satisfied: false, missing: [] };
    }

    const effectiveMethods = this.getEffectiveMethods(constraintName);
    const missing: string[] = [];
    for (const req of effectiveMethods) {
      const entry = lookupMethod(typeName, req.name);
      if (!entry) {
        missing.push(req.name);
      }
    }

    return { satisfied: missing.length === 0, missing };
  }
}

/** Default global registry instance (backward compatibility). */
const defaultConstraintRegistry = new ConstraintRegistry();

// ---------------------------------------------------------------------------
// Backward-compatible free functions (delegate to defaultConstraintRegistry)
// ---------------------------------------------------------------------------

/**
 * Register a constraint definition.
 */
export function registerConstraint(def: ConstraintDef): void {
  defaultConstraintRegistry.register(def);
}

/**
 * Look up a constraint definition by name.
 */
export function lookupConstraint(name: string): ConstraintDef | null {
  return defaultConstraintRegistry.lookup(name);
}

/**
 * Get all registered constraint names.
 */
export function getConstraintNames(): string[] {
  return defaultConstraintRegistry.getNames();
}

/**
 * Get all effective methods for a constraint, including inherited ones.
 */
export function getEffectiveMethods(constraintName: string): MethodRequirement[] {
  return defaultConstraintRegistry.getEffectiveMethods(constraintName);
}

/**
 * Get the superclass closure of a constraint (itself + all `extends`
 * ancestors, transitively).
 */
export function constraintSuperclassClosure(constraintName: string): Set<string> {
  return defaultConstraintRegistry.superclassClosure(constraintName);
}

/**
 * Clear all constraint definitions.
 * Called at the start of each inference run.
 */
export function clearConstraints(): void {
  defaultConstraintRegistry.clear();
}

/** Snapshot type for saving/restoring constraint state. */
export type ConstraintRegistrySnapshot = Map<string, ConstraintDef>;

/** Save a snapshot of all constraint registrations. */
export function snapshotConstraintRegistry(): ConstraintRegistrySnapshot {
  return defaultConstraintRegistry.snapshot();
}

/** Restore constraint registrations from a snapshot. */
export function restoreConstraintRegistry(snap: ConstraintRegistrySnapshot): void {
  defaultConstraintRegistry.restore(snap);
}

/** Merge a snapshot's registrations into the current registry (non-destructive). */
export function mergeConstraintRegistry(snap: ConstraintRegistrySnapshot): void {
  defaultConstraintRegistry.merge(snap);
}

/**
 * Check whether a concrete type (by name) satisfies a constraint.
 */
export function checkConstraint(constraintName: string, typeName: string): { satisfied: boolean; missing: string[] } {
  return defaultConstraintRegistry.checkConstraint(constraintName, typeName);
}

// ---------------------------------------------------------------------------
// ::constraint directive parsing — unified syntax
// ---------------------------------------------------------------------------
//
// Single grammar:
//
//   ::constraint Name p1 p2 … pN { clause, clause, … }
//
//   clause ::= paramName '::' rhs
//   rhs    ::= '{' field, field, … '}'    — record (methods if `~>`-shaped, else fields)
//            | UpperIdent                   — super-constraint reference (extends)
//            | type ('|' type)*             — union (structural alternatives)
//            | type                         — single-type structural equality
//
// Internally desugared to the existing ConstraintDef shape:
//   - record clauses whose every field uses `~>` ⇒ `methods[]` (nominal class)
//   - bare-uppercase clauses naming another constraint ⇒ `extends[]`
//   - everything else ⇒ `selfClauses[]` (structural)
//
// All clause `paramName`s must appear in the header parameter list.
// ---------------------------------------------------------------------------

/**
 * Header pattern:
 *   `::constraint Name p1 p2 … pN { … }`
 *
 * Captures: (1) constraint name, (2) header params (one or more
 * space-separated lowercase idents), (3) body between the outermost braces.
 */
const CONSTRAINT_HEADER_PATTERN =
  /^[\s*]*::constraint\s+([A-Z]\w*)\s+([a-z]\w*(?:\s+[a-z]\w*)*)\s*\{([\s\S]*)\}\s*$/m;

/** Split a string on top-level commas (respecting parens/brackets/braces). */
function splitTopLevelCommas(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

/**
 * Parse a `// ::constraint` comment body into a ConstraintDef using the
 * unified syntax. Returns null if the comment doesn't match.
 */
export function parseConstraintDirective(commentText: string): ConstraintDef | null {
  const m = CONSTRAINT_HEADER_PATTERN.exec(commentText);
  if (!m) return null;

  const name = m[1];
  const headerRaw = m[2];
  const bodyRaw = m[3];

  const headerParams = headerRaw.split(/\s+/).filter(Boolean);
  if (headerParams.length === 0) return null;
  const headerSet = new Set(headerParams);

  const clauseTexts = splitTopLevelCommas(bodyRaw);
  if (clauseTexts.length === 0) return null;

  const methods: MethodRequirement[] = [];
  const selfClauses: { selfParam: string; body: Type }[] = [];
  const extendsNames: string[] = [];

  for (const raw of clauseTexts) {
    const clause = raw.trim();
    if (!clause) continue;

    // `<param> :: <rhs>`
    const cm = /^([a-z]\w*)\s*::\s*([\s\S]+)$/.exec(clause);
    if (!cm) return null;
    const param = cm[1];
    const rhs = cm[2].trim();
    if (!headerSet.has(param)) return null;

    // (1) Record body: `{ field :: sig, ... }` — always treated as a
    //     method record (nominal type-class). Methods may use `~>` for
    //     instance methods or a plain function/value type for statics.
    const recordBody = stripOuterBraces(rhs);
    if (recordBody !== null) {
      const fields = splitTopLevelCommas(recordBody);
      const fieldDecls = fields
        .map(f => /^(\w+)\s*::\s*([\s\S]+)$/.exec(f.trim()))
        .filter((x): x is RegExpExecArray => x !== null);
      if (fieldDecls.length !== fields.length || fieldDecls.length === 0) {
        return null;
      }
      for (const fd of fieldDecls) {
        methods.push({ name: fd[1], signature: fd[2].trim() });
      }
      continue;
    }

    // (2) Bare uppercase identifier: super-constraint reference.
    //     Examples: `m :: Chain`, `m :: Applicative`. We match a bare TCon-name
    //     that does NOT contain a type application or function arrow — those
    //     should still go through structural parsing.
    if (/^[A-Z]\w*$/.test(rhs)) {
      extendsNames.push(rhs);
      continue;
    }

    // (3) Otherwise: structural body (single type or `T1 | T2 | …` union).
    try {
      const body = parseType(rhs);
      selfClauses.push({ selfParam: param, body });
    } catch {
      return null;
    }
  }

  if (methods.length === 0 && selfClauses.length === 0 && extendsNames.length === 0) {
    return null;
  }

  // typeVar = LAST header param (convention: the "main" constrained var).
  const typeVar = headerParams[headerParams.length - 1];

  // Kind: `* -> *` if the typeVar is applied anywhere (in a method record
  // signature or in a structural body); `*` otherwise.
  const expectedKind = inferKindFromDef(typeVar, methods, selfClauses);

  return {
    name,
    typeVar,
    methods,
    headerParams,
    selfClauses: selfClauses.length > 0 ? selfClauses : undefined,
    extends: extendsNames.length > 0 ? extendsNames : undefined,
    expectedKind,
    bodyText: bodyRaw.trim(),
  };
}

/** If `s` is `{ … }` (with balanced outer braces), return the inner content. */
function stripOuterBraces(s: string): string | null {
  if (!s.startsWith('{') || !s.endsWith('}')) return null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0 && i !== s.length - 1) return null;
    }
  }
  return depth === 0 ? s.slice(1, -1).trim() : null;
}

/**
 * Infer the expected kind of a constraint's type variable from its method
 * signatures and structural body types. `* -> *` if applied anywhere
 * (e.g. `f a`); `*` otherwise.
 */
export function inferExpectedKind(typeVar: string, methods: MethodRequirement[]): ConstraintKind {
  const pattern = new RegExp(`\\b${typeVar}\\s+[a-z(]`);
  for (const m of methods) {
    if (pattern.test(m.signature)) return '* -> *';
  }
  return '*';
}

function inferKindFromDef(
  typeVar: string,
  methods: MethodRequirement[],
  selfClauses: { selfParam: string; body: Type }[],
): ConstraintKind {
  if (inferExpectedKind(typeVar, methods) === '* -> *') return '* -> *';
  // Structural bodies don't currently carry kind information here; the
  // body Types are first-order. We still return '*' for them — kind issues
  // surface at unification time.
  void selfClauses;
  return '*';
}

/**
 * Validate a constraint definition for kind consistency and completeness.
 * Returns an array of human-readable warning/error messages (empty if valid).
 */
export function validateConstraintDef(def: ConstraintDef): string[] {
  const errors: string[] = [];
  const { typeVar, methods, name } = def;

  // For pure-structural / pure-extends defs there's nothing to validate
  // beyond what the parser already guarantees (clause params ∈ header).
  if (methods.length === 0) {
    return errors;
  }

  // 1. Check that the type variable appears in at least one method signature
  const barePattern = new RegExp(`\\b${typeVar}\\b`);
  const usedInAny = methods.some(m => barePattern.test(m.signature));
  if (!usedInAny) {
    errors.push(
      `Type variable '${typeVar}' is not used in any method signature of constraint '${name}'.`,
    );
  }

  // 2. Check for inconsistent kind usage:
  //    typeVar used both bare (kind *) and applied (kind * -> *) across methods
  const appliedPattern = new RegExp(`\\b${typeVar}\\s+[a-z(]`);
  const bareOnlyPattern = new RegExp(`\\b${typeVar}(?:\\s*(?:~>|->|,|\\)|$))`);
  const hasApplied = methods.some(m => appliedPattern.test(m.signature));
  const hasBare = methods.some(m => bareOnlyPattern.test(m.signature));

  if (hasApplied && hasBare) {
    errors.push(
      `Inconsistent kind for '${typeVar}' in constraint '${name}': used as both kind * (concrete type) and kind * -> * (type constructor). ` +
      `If '${typeVar}' is a type constructor, all occurrences should use '${typeVar} a'. ` +
      `If '${typeVar}' is a concrete type, it should not be applied.`,
    );
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Constraint shape matching
// ---------------------------------------------------------------------------

/**
 * Check that a registered method's signature shape matches the constraint's
 * required shape.  Wherever the constraint's type variable (`f`, `m`, etc.)
 * appears in the constraint signature, the registered method must use the
 * concrete type constructor.
 *
 * Returns a human-readable mismatch description, or null if the shape is OK.
 */
export function checkConstraintMethodShape(
  constraintTypeVar: string,
  constraintMethodSig: string,
  concreteName: string,
  registeredEntry: MethodEntry,
): string | null {
  try {
    const constraintParsed = parseMethodTypeSignature(constraintMethodSig, [constraintTypeVar]);
    const regSig = registeredEntry.signature;

    if (!regSig.includes('~>')) {
      // A method whose registered signature carries no `~>` receiver is a
      // built-in / plain method (e.g. Array's native `reduce`).  Validate its
      // shape against the constraint exactly as for `~>`-bearing methods: the
      // registered type must match the constraint method's required form
      // position-for-position.  This is a purely structural check — a
      // constraint method such as `(b -> a -> b) -> b -> b` is rejected by a
      // built-in like `((b, a, …) -> b, b) -> b` not because of currying, but
      // because the two shapes simply do not unify.
      let regType: Type;
      try {
        regType = parseType(regSig);
      } catch {
        return null;
      }
      if (!matchesConstraintShapeAnySlot(
        constraintParsed.methodType,
        regType,
        constraintTypeVar,
        concreteName,
      )) {
        return `has signature '${regSig}' which cannot be unified with the required '${typeToString(constraintParsed.methodType)}'`;
      }
      return null;
    }
    const regParsed = parseMethodTypeSignature(regSig);
    if (!matchesConstraintShapeAnySlot(
      constraintParsed.methodType,
      regParsed.methodType,
      constraintTypeVar,
      concreteName,
    )) {
      return `signature does not match constraint shape`;
    }
    return null;
  } catch { /* parse/validation error — constraint shape invalid */
    return null;
  }
}

/**
 * Shape-check a *static* constraint method (one whose constraint signature
 * carries no `~>` receiver, e.g. Foldable's `off :: a -> f a`) against a
 * representing local annotation (also receiver-less, e.g. `off :: a -> Array a`).
 *
 * Both sides are plain types.  We parse the constraint requirement with the
 * constraint variable known so applied positions like `f a` become kind-var
 * constructors, parse the local signature normally, then run the same
 * structural / linkage check used for instance methods.  Returns a
 * human-readable mismatch description, or null if the shape is OK.
 */
export function checkStaticConstraintMethodShape(
  constraintTypeVar: string,
  constraintMethodSig: string,
  concreteName: string,
  registeredSig: string,
): string | null {
  try {
    // Reuse the method-signature parser (which knows how to treat a bare
    // constraint variable applied to args as a kind-variable constructor) by
    // prefixing a synthetic receiver; only `.methodType` is consulted.
    const constraintParsed = parseMethodTypeSignature(
      `${constraintTypeVar} ~> ${constraintMethodSig}`,
      [constraintTypeVar],
    );
    const regType = parseType(registeredSig);
    if (!matchesConstraintShapeAnySlot(
      constraintParsed.methodType,
      regType,
      constraintTypeVar,
      concreteName,
    )) {
      return `signature does not match constraint shape`;
    }
    return null;
  } catch { /* parse/validation error — constraint shape invalid */
    return null;
  }
}

/**
 * Optional context threaded through {@link matchesConstraintShape} to enforce
 * *type-variable linkage*.  Each distinct constraint-signature type variable
 * (the inner `a`, `b`, … — not the constraint's own kind-variable) is recorded
 * the first time it is matched against a registered sub-type; on every later
 * occurrence the registered side must agree (structurally) with that first
 * binding.  This turns the previously unconditional wildcard match for type
 * variables into a consistent one, so e.g. a `Functor` method required as
 * `f a ~> (a -> b) -> f b` is no longer satisfied by a registered
 * `Array a ~> (a -> b) -> Array a` (which conflates `b` with `a` in its
 * return position).
 */
export interface ConstraintShapeContext {
  /** constraint TVar id → the registered sub-type it first matched. */
  varMap: Map<number, Type>;
  /**
   * When set, forces the constraint's kind-variable application (`f a`) to
   * align with the registered constructor's argument starting at THIS slot
   * index (0 = leftmost) instead of the default rightmost alignment.  This lets
   * a constraint that operates on a non-rightmost type parameter — e.g.
   * Contravariant's `contramap` on `Arrow a b` transforms the LEFT parameter,
   * whereas Functor's `map` transforms the rightmost — be matched.  A given
   * offset that cannot be honoured at some occurrence fails the whole attempt,
   * so the caller can enumerate offsets and rely on the type-variable linkage
   * check to accept at most the single consistent alignment.
   */
  slotOffset?: number;
  /**
   * Inner constructor-variable linkage: constraint-side kv var id (e.g. the
   * `f` of a method-local `Applicative f =>` prefix) → the registered-side
   * kv head name it first matched.  Both signatures parse their OWN prefix
   * vars to kv-TCons with unrelated ids, so they can never be equal by name;
   * they are instead paired by consistent co-occurrence (every `f …` on the
   * constraint side must meet the SAME registered constructor var).
   */
  kvHeadMap?: Map<number, string>;
}

/**
 * Structural equality between two registered sub-types, comparing type
 * variables by identity (id).  Used by the linkage check to decide whether a
 * repeated constraint variable maps to the *same* registered type as before.
 */
function sameRegisteredType(a: Type, b: Type): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case 'TVar':
      return a.id === (b as Type & { tag: 'TVar' }).id;
    case 'TCon': {
      const bc = b as Type & { tag: 'TCon' };
      if (a.name !== bc.name || a.args.length !== bc.args.length) return false;
      return a.args.every((x, i) => sameRegisteredType(x, bc.args[i]));
    }
    case 'TFun': {
      const bf = b as Type & { tag: 'TFun' };
      return sameRegisteredType(a.param, bf.param) && sameRegisteredType(a.result, bf.result);
    }
    default:
      // Records / rows / labels: be conservative and treat them as equal so we
      // never *introduce* a false mismatch for shapes the linkage check does
      // not model precisely.
      return true;
  }
}

/**
 * Normalise an optional registered parameter `X | Undefined` down to `X` for
 * constraint-shape matching.
 *
 * Built-in methods model an omittable argument as a union with `Undefined`
 * (e.g. Array#reduce's optional initial value `b | Undefined`, produced by
 * `opt()` in the method registry).  In a constraint requirement the same slot
 * is written as the bare type (`b`), so without this normalisation the linkage
 * check compares a plain `TVar b` against a `Union[b, Undefined]` and reports a
 * spurious shape mismatch.  An optional parameter is a supertype of its
 * mandatory form in contravariant position, so treating `X | Undefined` as `X`
 * here is sound.  Only strips when `Undefined` is actually a member, leaving
 * genuine value unions such as `[a | b]` untouched.
 */
function stripOptional(t: Type): Type {
  if (t.tag === 'TCon' && t.name === T_UNION) {
    const members = t.args.filter(
      m => !(m.tag === 'TCon' && m.name === 'Undefined'),
    );
    if (members.length !== t.args.length) {
      return members.length === 1 ? members[0] : tCon(T_UNION, members);
    }
  }
  return t;
}

/** `Undefined` itself, or a union that admits `Undefined` — i.e. an
 *  omittable parameter slot as produced by `opt()` in the method registry. */
function isOptionalSlot(t: Type): boolean {
  if (t.tag !== 'TCon') return false;
  if (t.name === 'Undefined') return true;
  return t.name === T_UNION && t.args.some(
    m => m.tag === 'TCon' && m.name === 'Undefined',
  );
}

/** A registered parameter position that may be omitted ENTIRELY when
 *  calling: a single optional slot, or a parameter-group tuple consisting
 *  solely of optional slots. */
function isFullyOptionalParam(t: Type): boolean {
  if (isOptionalSlot(t)) return true;
  return t.tag === 'TCon' && t.name === T_TUPLE
    && t.args.length > 0 && t.args.every(isOptionalSlot);
}

/**
 * Match a constraint method type against a registered method type, trying the
 * historical rightmost kind-variable alignment first (backward compatible) and
 * then alternative left-anchored slot alignments for wider, multi-parameter
 * registered constructors.
 *
 * Motivation: a constraint's kind variable `f` is unary, but a concrete type
 * may be k-ary (`Arrow a b`).  Different constraints operate on different
 * parameters of the same ADT — Functor's `map` on the rightmost (`b`),
 * Contravariant's `contramap` on the leftmost (`a`).  The type-variable linkage
 * check inside {@link matchesConstraintShape} rejects every inconsistent
 * alignment, so at most one slot produces a match and there is no ambiguity.
 */
function matchesConstraintShapeAnySlot(
  constraintType: Type,
  registeredType: Type,
  constraintVar: string,
  concreteName: string,
): boolean {
  // Rightmost (default) alignment — preserves prior behaviour exactly.
  if (matchesConstraintShape(
    constraintType, registeredType, constraintVar, concreteName, { varMap: new Map() },
  )) {
    return true;
  }
  // Alternative left-anchored slots (0 = leftmost).  Capped generously; real
  // constraint-operated constructors are low arity.
  const MAX_CONSTRAINT_SLOT = 8;
  for (let slot = 0; slot <= MAX_CONSTRAINT_SLOT; slot++) {
    if (matchesConstraintShape(
      constraintType, registeredType, constraintVar, concreteName,
      { varMap: new Map(), slotOffset: slot },
    )) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively check that wherever the constraint's type variable appears as a
 * type constructor in `constraintType`, the corresponding position in
 * `registeredType` uses `concreteName`.
 *
 * When a {@link ConstraintShapeContext} is supplied, inner type variables are
 * additionally checked for *linkage* consistency (see the interface docs).
 */
export function matchesConstraintShape(
  constraintType: Type,
  registeredType: Type,
  constraintVar: string,
  concreteName: string,
  ctx?: ConstraintShapeContext,
  inFunctionParam = false,
): boolean {
  // An optional registered parameter (`X | Undefined`) satisfies a constraint
  // requirement of `X`; normalise it away before any structural / linkage
  // comparison.  Applied on every (recursive) entry so nested optional slots —
  // e.g. Array#reduce's `b | Undefined` initial value inside a parameter tuple
  // — are handled too.
  registeredType = stripOptional(registeredType);
  // `Any` in a constraint's required shape accepts every registered type
  // (a deliberately unconstrained slot, e.g. `value :: m ~> Any`).
  if (isAnyType(constraintType)) return true;
  if (constraintType.tag === 'TCon') {
    const kv = parseKvName(constraintType.name);
    if (kv && kv.varName === constraintVar) {
      if (registeredType.tag !== 'TCon' || registeredType.name !== concreteName) return false;
      const cArgs = constraintType.args;
      let rArgs = registeredType.args;
      // Functions as a binary constructor (Profunctor): `p b c` reads
      // `Function [b] c` — the single-parameter list `[b]` IS the slot `b`.
      if (concreteName === T_FUNCTION && cArgs.length === 2 && rArgs.length === 2) {
        const params = functionParamList(rArgs[0]);
        if (params && params.length === 1) rArgs = [params[0], rArgs[1]];
      }
      if (rArgs.length < cArgs.length) return false;
      const extra = rArgs.length - cArgs.length;
      // The constraint applies its kind variable to `cArgs.length` argument(s);
      // the registered constructor may carry MORE parameters (a multi-param
      // ADT viewed through a unary constraint).  By default the constraint's
      // argument aligns with the RIGHTMOST slots (the Functor convention).  A
      // caller may instead pin a specific left-anchored slot via
      // `ctx.slotOffset` — used to match constraints (e.g. Contravariant) whose
      // operated parameter is not the rightmost.  An out-of-range pin fails the
      // attempt so slot enumeration stays consistent across occurrences.
      let offset = extra;
      if (ctx && ctx.slotOffset !== undefined) {
        if (ctx.slotOffset > extra) return false;
        offset = ctx.slotOffset;
      }
      for (let i = 0; i < cArgs.length; i++) {
        if (!matchesConstraintShape(cArgs[i], rArgs[offset + i], constraintVar, concreteName, ctx)) return false;
      }
      return true;
    }
    // Any other kind-variable constructor — an INNER constructor var of the
    // constraint method signature (e.g. `f` from `traverse`'s own
    // `Applicative f =>` prefix).  The registered signature declares its own
    // `f` with an unrelated kv id, so name equality can never hold; match a
    // registered kv application structurally, linking the pair of heads for
    // consistency across occurrences (`f b` and `f (t b)` must meet the SAME
    // registered constructor var).
    if (kv) {
      if (registeredType.tag !== 'TCon') return false;
      const rkv = parseKvName(registeredType.name);
      if (!rkv) return false;
      if (constraintType.args.length !== registeredType.args.length) return false;
      if (ctx) {
        const prev = ctx.kvHeadMap?.get(kv.varId);
        if (prev === undefined) {
          (ctx.kvHeadMap ??= new Map()).set(kv.varId, registeredType.name);
        } else if (prev !== registeredType.name) {
          return false;
        }
      }
      return constraintType.args.every((a, i) =>
        matchesConstraintShape(a, registeredType.args[i], constraintVar, concreteName, ctx));
    }
    // Any other concrete constructor (including `Tuple`, which represents a
    // multi-parameter parameter group `(a, b) -> r`): the registered side must
    // use the SAME constructor with the SAME arity at this position.  This is
    // what makes the check form-exact, e.g. a tuple parameter group
    // `(b, a) -> b` (TFun(Tuple[b,a], b)) does NOT match a curried
    // `b -> a -> b` (TFun(b, TFun(a, b))), and vice versa.
    if (registeredType.tag !== 'TCon') return false;
    if (constraintType.name !== registeredType.name) return false;
    // Function parameter-group tuples tolerate surplus trailing parameters on
    // either side — a JS callback may ignore the extra arguments it is passed
    // (e.g. a native `Array#reduce` 4-arg callback satisfying a 2-arg
    // `reduce`).  Only the leading (shared) positions need to match; the
    // tupled-vs-curried distinction is still enforced by the constructor-form
    // check above, so this stays sound.
    if (inFunctionParam && constraintType.name === T_TUPLE) {
      const n = Math.min(constraintType.args.length, registeredType.args.length);
      for (let i = 0; i < n; i++) {
        if (!matchesConstraintShape(constraintType.args[i], registeredType.args[i], constraintVar, concreteName, ctx)) return false;
      }
      return true;
    }
    if (constraintType.args.length !== registeredType.args.length) return false;
    return constraintType.args.every((a, i) =>
      matchesConstraintShape(a, registeredType.args[i], constraintVar, concreteName, ctx));
  }

  if (constraintType.tag === 'TFun') {
    if (registeredType.tag !== 'TFun') return false;
    // A NULLARY constraint method (`() -> r`, parameter `Void`) is satisfied
    // by a registered method whose parameters are ALL optional
    // (`X | Undefined`, the method registry's `opt()` encoding): such a
    // method is callable with zero arguments, exactly what the constraint
    // promises.  E.g. `Number#toString :: (Number | Undefined) -> String`
    // satisfies Showable's `toString :: () -> String`.  Decided BEFORE the
    // stripOptional normalisation below, which erases precisely the
    // optionality that makes this sound (leaving `Void` vs `Number`).
    if (
      constraintType.param.tag === 'TCon' && constraintType.param.name === 'Void'
      && isFullyOptionalParam(registeredType.param)
    ) {
      return matchesConstraintShape(constraintType.result, registeredType.result, constraintVar, concreteName, ctx);
    }
    let cParam = constraintType.param;
    let rParam = stripOptional(registeredType.param);
    // Surplus-trailing-parameter tolerance for the BARE (1-arity) parameter
    // form: a constraint callback written as a single parameter (`a -> Boolean`)
    // is satisfied by a registered multi-parameter group
    // (`(a, Number, [a]) -> Boolean`, e.g. native `Array#filter`) — the extra
    // arguments are simply ignored by a 1-arg JS callback.  A single parameter
    // is not represented as a `Tuple`, so the Tuple-vs-Tuple tolerance below
    // (in the TCon branch) never sees this case; align the bare side with the
    // FIRST element of the wider group instead.  Mirrored for the reverse
    // direction (constraint group vs bare registered parameter).
    const isParamGroup = (t: Type): boolean => t.tag === 'TCon' && t.name === T_TUPLE;
    if (!isParamGroup(cParam) && isParamGroup(rParam) && (rParam as TCon).args.length >= 1) {
      rParam = (rParam as TCon).args[0];
    } else if (isParamGroup(cParam) && !isParamGroup(rParam) && (cParam as TCon).args.length >= 1) {
      cParam = (cParam as TCon).args[0];
    }
    return matchesConstraintShape(cParam, rParam, constraintVar, concreteName, ctx, true) &&
           matchesConstraintShape(constraintType.result, registeredType.result, constraintVar, concreteName, ctx);
  }

  // A polymorphic variable in the constraint signature (other than the
  // constraint's own type-constructor var) is a wildcard — but, when a linkage
  // context is supplied, each distinct *inner* constraint variable must map to
  // a consistent registered sub-type across all of its occurrences.  This is
  // what catches return-position variable swaps such as `f b` vs `f a`.
  //
  // The constraint's *own* variable (e.g. `s` in `Semigroup s`) is deliberately
  // excluded: when it has kind `*` it is parsed as a bare `TVar` here, and it
  // legitimately matches *different* concrete shapes across positions — e.g.
  // `Semigroup`'s `concat :: s ~> s -> s` is satisfied by Array's widening
  // `[a] ~> [b] -> [a | b]`, where the input `s` is `[b]` but the output `s`
  // is `[a | b]`.  Treating it as a wildcard preserves that.
  if (constraintType.tag === 'TVar') {
    if (ctx && constraintType.name !== constraintVar) {
      const prev = ctx.varMap.get(constraintType.id);
      if (prev === undefined) {
        ctx.varMap.set(constraintType.id, registeredType);
      } else if (!sameRegisteredType(prev, registeredType)) {
        return false;
      }
    }
    return true;
  }

  return true;
}
