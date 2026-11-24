// Regression tests for two related export-boundary properties:
//
//  1. Default-export annotation-authoritative branch (`module.exports = chain`
//     where `chain` has a class-constraint annotation):  the consumer must
//     receive a polymorphic scheme whose `vars`/`constraints` are taken
//     verbatim from the user's annotation, NOT a monomorphic scheme
//     re-derived from `this.subst.apply(scheme.type) + generalize`.  Before
//     the fix, that re-derivation collapsed `vars` to `[]` and re-exposed
//     the producing module's RAW scheme TVar ids inside `$kv:` constructor
//     names.
//
//  2. Poison isolation: when a *non-annotated* exported binding's body has
//     a unification failure, `poisonFreeVars` binds free TVars to the
//     `$error` sentinel.  Without scrubbing, that sentinel survives into
//     the exported scheme (via `applySubstToScheme` -> `generalize`),
//     making consumers see `$error` instead of a polymorphic signature.
//     The scrubber replaces each `$error` with a fresh TVar so consumers
//     keep a usable polymorphic signature.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter, containsErrorType, T_ERROR, Type, Scheme } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-export-scheme-isolation-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(source: string): {
  diagnostics: string[];
  result: ReturnType<InferenceEngine['infer']>;
} {
  const consumerPath = writeFile('consumer.js', source);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  const r = eng.infer(source, undefined, resolver, typeResolver, aliasResolver);
  return { diagnostics: r.diagnostics.map(d => d.message), result: r };
}

/** Recursively collect the embedded ids of every `$kv:` TCon in a Type. */
function collectKvIds(t: Type, acc: number[] = []): number[] {
  if (t.tag === 'TCon') {
    if (t.name.startsWith('$kv:')) {
      const id = Number(t.name.split(':')[2]);
      if (Number.isFinite(id)) acc.push(id);
    }
    (t.args ?? []).forEach(a => collectKvIds(a, acc));
  } else if (t.tag === 'TFun') {
    collectKvIds(t.param, acc);
    collectKvIds(t.result, acc);
  }
  return acc;
}

function inferFile(uri: string, source: string): ReturnType<InferenceEngine['infer']> {
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(uri);
  const typeResolver = ctx.createTypeDirectiveResolver(uri);
  const aliasResolver = ctx.createImportTypeAliasResolver(uri);
  const eng = new InferenceEngine();
  return eng.infer(source, undefined, resolver, typeResolver, aliasResolver);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

beforeEach(() => resetTypeVarCounter());

// ===========================================================================
// 1. Default-export annotation-authoritative
// ===========================================================================

describe('default-export annotation-authoritative: module.exports = constrainedFn', () => {
  beforeAll(() => {
    writeFile('chain.js', [
      '// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }',
      '',
      '// chain :: Chain m => (a -> m b) -> m a -> m b',
      'const chain = fn => chainable => chainable.chain (fn);',
      '',
      'module.exports = chain;',
    ].join('\n'));
  });

  test('exported "default" scheme preserves polymorphic vars + Chain constraint', () => {
    const chainPath = path.join(tmpRoot, 'chain.js');
    const chainUri = pathToFileURL(chainPath).href;
    const src = fs.readFileSync(chainPath, 'utf-8');
    const r = inferFile(chainUri, src);

    const def = r.exports.get('default');
    expect(def).toBeDefined();
    // Polymorphism preserved: vars list non-empty (the three quantified
    // TVars: m, a, b).
    expect((def as Scheme).vars.length).toBeGreaterThanOrEqual(3);
    // Class constraint preserved verbatim.
    expect((def as Scheme).constraints).toBeDefined();
    expect((def as Scheme).constraints!.some(c => c.className === 'Chain')).toBe(true);
  });

  test('consumer sees fresh per-call-site polymorphism (no raw producer ids leak)', () => {
    // Capture chain.js's raw producer TVar ids by inferring it standalone.
    resetTypeVarCounter();
    const chainPath = path.join(tmpRoot, 'chain.js');
    const chainUri = pathToFileURL(chainPath).href;
    const chainSrc = fs.readFileSync(chainPath, 'utf-8');
    const chainResult = inferFile(chainUri, chainSrc);
    const chainScheme = chainResult.exports.get('default') as Scheme;
    // chain's quantified ids are its raw producer ids; none of these exact
    // ids may survive into a consumer's instantiated type.  (Annotation
    // schemes are parsed in a reserved high id range, so the raw producer
    // ids are large while fresh consumer ids are small — an exact-id check
    // is therefore the robust isolation invariant, independent of numeric
    // ordering.)
    const producerIds = new Set<number>(chainScheme.vars);

    // Now run the consumer: it should instantiate `chain` with FRESH ids
    // distinct from every raw producer id.
    resetTypeVarCounter();
    const { diagnostics, result } = inferConsumer([
      'const chain = require("/tmp/hm-export-scheme-isolation-test/chain.js");',
      'const useIt = (fn, m) => chain (fn) (m);',
    ].join('\n'));

    // No diagnostics expected from this snippet (it just uses chain twice).
    const unexpected = diagnostics.filter(d => !/Unknown constraint/.test(d));
    expect(unexpected).toEqual([]);

    // The type of `chain` at its usage site must contain only FRESH kv-tcon
    // ids — never a raw producer id.
    const useItScheme = result.topLevelBindings.get('useIt');
    expect(useItScheme).toBeDefined();
    const leaked = collectKvIds((useItScheme as Scheme).type).filter(id => producerIds.has(id));
    expect(leaked).toEqual([]);
  });

  test('non-trivial body shape does not leak into export signature', () => {
    // Two structurally different bodies with the SAME annotation must
    // produce IDENTICAL exported schemes (modulo TVar id renumbering).
    writeFile('chainA.js', [
      '// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }',
      '// chain :: Chain m => (a -> m b) -> m a -> m b',
      'const chain = fn => chainable => chainable.chain (fn);',
      'module.exports = chain;',
    ].join('\n'));
    writeFile('chainB.js', [
      '// ::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }',
      '// chain :: Chain m => (a -> m b) -> m a -> m b',
      'const chainFn = chainable => fn => chainable.chain (fn);',
      'const chain = fn => chainable => chainFn (chainable) (fn);',
      'module.exports = chain;',
    ].join('\n'));

    function getSchemeShape(file: string): { varsLen: number; constraints: string[] } {
      resetTypeVarCounter();
      const p = path.join(tmpRoot, file);
      const uri = pathToFileURL(p).href;
      const src = fs.readFileSync(p, 'utf-8');
      const r = inferFile(uri, src);
      const s = r.exports.get('default') as Scheme;
      return {
        varsLen: s.vars.length,
        constraints: (s.constraints ?? []).map(c => c.className).sort(),
      };
    }

    const a = getSchemeShape('chainA.js');
    const b = getSchemeShape('chainB.js');
    expect(a).toEqual(b);
  });
});

// ===========================================================================
// 2. Poison isolation at the export boundary
// ===========================================================================

describe('poison isolation: failed body does not corrupt exported signature', () => {
  beforeAll(() => {
    // Non-annotated identity function with a deliberate type error in
    // a sibling top-level binding.  The sibling failure poisons free
    // TVars in the engine's subst.  Without scrubbing, the export of
    // `id` would either become monomorphic (vars=[]) or contain $error.
    writeFile('poison.js', [
      'const id = x => x;',
      '// trigger a unify failure that pollutes the engine subst:',
      'const boom = 1 + "string";',
      'module.exports = { id };',
    ].join('\n'));
  });

  test('exported scheme for `id` remains polymorphic (no $error, vars non-empty)', () => {
    const p = path.join(tmpRoot, 'poison.js');
    const uri = pathToFileURL(p).href;
    const src = fs.readFileSync(p, 'utf-8');
    const r = inferFile(uri, src);
    const idScheme = r.exports.get('id') as Scheme;
    expect(idScheme).toBeDefined();
    // No `$error` sentinel must leak into the exported type.
    expect(containsErrorType(idScheme.type)).toBe(false);
    // Polymorphism is preserved: at least one quantified var.
    expect(idScheme.vars.length).toBeGreaterThanOrEqual(1);
  });

  test('consumer of poisoned-sibling module sees usable signature for `id`', () => {
    writeFile('poison2.js', [
      'const id = x => x;',
      'const boom = 1 + "string";',
      'module.exports = { id };',
    ].join('\n'));
    const { diagnostics } = inferConsumer([
      'const { id } = require("/tmp/hm-export-scheme-isolation-test/poison2.js");',
      'const n = id (42);',
      'const s = id ("hello");',
    ].join('\n'));
    // The consumer must be able to call `id` polymorphically at TWO
    // different types without conflict.  Pre-scrub, $error would have
    // unified `n` and `s` into the same monomorphic type, generating a
    // diagnostic on the second call.
    const typeMismatches = diagnostics.filter(d => /Type mismatch|Cannot unify/.test(d));
    expect(typeMismatches).toEqual([]);
  });
});
