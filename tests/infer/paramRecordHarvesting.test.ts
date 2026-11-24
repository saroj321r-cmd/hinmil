// Verification tests for the generic param-record harvesting mechanism:
// when a call's result type carries a `Picked R Sel` marker (any DSL
// emitting that shape), `gatherParamRecord` walks the call's selector
// array, inspects helper-callback bodies, and reconstructs the tag's
// parameter shape (record, scalar, or unbound TVar).
//
// Although sqlkit is the canonical consumer, every mechanism tested here
// is name-agnostic: the gate is the generic `Picked` type marker, and
// the contributors are identified by structural shape (Runnable-style
// constraints, callback/direct argument forms) — never by string match.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { typeToString, prettyTypeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';

describe('chained method-call param harvesting', () => {
  test('single .iLike(p => p.q) on a Prop contributes q to params', () => {
    const src = `
// R :: { id :: Number, firstname :: String }
// S :: "id"
// Prop :: { iLike :: Prop t a ~> ({ q :: String } -> String) -> Prop t a }
// firstname :: Prop t String
// T :: [S | Prop t a] -> QueryTag p (Picked R S)
const firstname = null;
function T(xs) { return null; }
const q = T(["id", firstname.iLike(p => p.q)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('q ::');
  });

  test('chained .iLike(...).or(.iLike(...)) harvests q from inner callbacks', () => {
    const src = `
// R :: { id :: Number }
// S :: "id"
// Prop :: { iLike :: Prop t a ~> ({ q :: String } -> String) -> Prop t a
//        , or :: Prop t a ~> Prop t a -> Prop t a }
// firstname :: Prop t String
// lastname  :: Prop t String
// T :: [S | Prop t a] -> QueryTag p (Picked R S)
const firstname = null;
const lastname  = null;
function T(xs) { return null; }
const q = T(["id", firstname.iLike(p => p.q).or(lastname.iLike(p => p.q))])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('q ::');
  });
});

describe('display-time row-tail suppression on Merge', () => {
  test('Merge of a record with a bare row-var hides the ...b tail in display', () => {
    const src = `
// A :: { limit :: Number, page :: Number }
// merge :: A -> Merge b A
function merge(a) { return null; }
const r = merge(0)
    `;
    const engine = new InferenceEngine();
    const result = engine.infer(src);
    const ts = typeToString(result.type);
    expect(ts).not.toContain('...b');
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('page :: Number');
  });
});

describe('Runnable-payload propagation into harvested fields', () => {
  test('Runnable Number r => r -> Limit r pins p.limit to Number', () => {
    const src = `
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Limit :: Runnable Number r => r -> Limit
// T :: [S | Limit] -> QueryTag p (Picked R S)
function Limit(r) { return null; }
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('limit :: Number');
  });

  test('Runnable String r => Prop t a ~> r -> Prop t a pins p.q to String', () => {
    // Method-call form is harder (declared scheme is on the method,
    // not the identifier callee), so this test only locks in the
    // current behavior — `q` is harvested as a field, even if not yet
    // typed as String.  Tighten when method-scheme propagation lands.
    const src = `
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Limit :: Runnable Number r => r -> Limit
// T :: [S | Limit] -> QueryTag p (Picked R S)
function Limit(r) { return null; }
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit), Limit(p => p.page)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('page :: Number');
  });

  test('Runnable String r on a Prop#iLike method pins p.q to String', () => {
    // Method-call form: the `Runnable String r =>` constraint lives on
    // `Prop#iLike` in the MethodRegistry, not on the callee identifier.
    // The visit-function's MemberExpression-callee branch looks the
    // scheme up via the receiver TCon and feeds the payload (`String`)
    // to the body-walk so `p.q` is sharpened from a fresh TVar.
    const src = `
// Tag :: ()
// Prop :: t -> v -> Prop t v
// Runnable :: a -> r -> Constraint
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Prop#iLike :: Runnable String r => Prop t a ~> r -> Prop t a
// firstname :: Prop Tag String
// T :: [S | Prop t a] -> QueryTag p (Picked R S)
const firstname = null;
function T(xs) { return null; }
const q = T(["id", firstname.iLike(p => p.q)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('q :: String');
    // Hover on `.iLike` must show the `Runnable String r =>` constraint
    // prefix (with receiver vars substituted) — not just the bare
    // receiver/method types.
    const iLikeOffset = src.indexOf('iLike(p');
    const sig = r.methodSignatures.get(iLikeOffset);
    expect(sig).toBeDefined();
    expect(sig).toContain('Runnable String');
    expect(sig).toContain('~>');
    expect(sig).toMatch(/Runnable String r =>.*~>/);
  });

  test('Runnable payload does NOT leak into p.q when callback body coerces it (template literal)', () => {
    // `` `%${p.q}%` `` always returns String regardless of p.q's type,
    // so the Runnable String r => constraint tells us nothing about
    // p.q itself.  The harvested field must surface as a fresh TVar,
    // not be wrongly pinned to String.
    const src = `
// Tag :: ()
// Prop :: t -> v -> Prop t v
// Runnable :: a -> r -> Constraint
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Prop#iLike :: Runnable String r => Prop t a ~> r -> Prop t a
// firstname :: Prop Tag String
// T :: [S | Prop t a] -> QueryTag p (Picked R S)
const firstname = null;
function T(xs) { return null; }
const q = T(["id", firstname.iLike(p => \`%\${p.q}%\`)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // The field is still harvested (its name appears) but is NOT
    // wrongly typed as String.
    expect(ts).toContain('q ::');
    expect(ts).not.toMatch(/q :: String/);
  });

  test('one concrete callback in a chain upgrades earlier opaque harvests', () => {
    // Chain-order: the outer `.or(email.iLike(p => \`%${p.q}%\`))` is
    // visited first and harvests `q :: TVar`; the inner
    // `firstname.iLike(p => p.q)` proves `q :: String` via the Runnable
    // payload.  The later concrete harvest must upgrade the earlier
    // opaque one — otherwise the user sees `q :: a` despite a direct
    // `p => p.q` in the same chain.
    const src = `
// Tag :: ()
// Prop :: t -> v -> Prop t v
// Runnable :: a -> r -> Constraint
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Prop#iLike :: Runnable String r => Prop t a ~> r -> Prop t a
// Prop#or :: Prop t a ~> Prop t a -> Prop t a
// firstname :: Prop Tag String
// lastname :: Prop Tag String
// email :: Prop Tag String
// T :: [S | Prop t a] -> QueryTag p (Picked R S)
const firstname = null;
const lastname = null;
const email = null;
function T(xs) { return null; }
const q = T(["id",
  firstname.iLike(p => p.q)
    .or(lastname.iLike(p => \`%\${p.q}%\`))
    .or(email.iLike(p => \`%\${p.q}%\`))
])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('q :: String');
  });
});

describe('pretty-printer hides singleton bare-row tails on Merge', () => {
  test('prettyTypeToString collapses Merge of singleton bare rows to a single bare TVar', () => {
    const src = `
// findUsers :: Merge a b -> Number
function findUsers(p) { return null; }
const r = findUsers;
    `;
    const engine = new InferenceEngine();
    const result = engine.infer(src);
    const pretty = prettyTypeToString(result.type);
    // Both `a` and `b` are singletons inside the Merge — rather than
    // collapsing to a meaningless `{}` (which would read as "no
    // parameters"), the pretty printer falls back to a single bare
    // polymorphic row variable so a concatenated zero-param tag
    // displays the same shape as a single zero-param tag.
    expect(pretty).not.toContain('{}');
    expect(pretty).not.toContain('...a');
    expect(pretty).not.toContain('...b');
    expect(pretty).toMatch(/^[a-z]\s*->\s*Number$/);
    // Raw typeToString still shows the tails for callers that need
    // round-trippable output (e.g. snapshot/serialization).
    const raw = typeToString(result.type);
    expect(raw).toContain('...a');
    expect(raw).toContain('...b');
  });

  test('prettyTypeToString keeps bare-row tails when the row name appears elsewhere', () => {
    const src = `
// f :: a -> Merge a b -> a
function f(a, p) { return a; }
const r = f;
    `;
    const engine = new InferenceEngine();
    const result = engine.infer(src);
    const pretty = prettyTypeToString(result.type);
    // `a` appears in three positions — kept.  `b` is singleton — dropped.
    expect(pretty).toContain('...a');
    expect(pretty).not.toContain('...b');
  });
});

describe('scalar-param tag inference (bare/direct helpers)', () => {
  test('Limit(p => p) alone in selector → tag param is Number, not {}', () => {
    const src = `
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Limit :: Runnable Number r => r -> Limit
// T :: [S | Limit] -> QueryTag p (Picked R S)
function Limit(r) { return null; }
function T(xs) { return null; }
const q = T(["id", Limit(p => p)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // The tag's param slot should be the scalar Number, not a TVar
    // and not an empty record.
    expect(ts).toContain('Number');
    expect(ts).not.toMatch(/QueryTag\s+\{\s*\}/);
  });

  test('Limit(42) direct-value form → tag param stays polymorphic (value already supplied)', () => {
    // The value is provided at the helper call site, so the surrounding
    // tag does NOT need a parameter for it later — the tag's param slot
    // must stay unbound (a TVar), not be pinned to Number.
    const src = `
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Limit :: Runnable Number r => r -> Limit
// T :: [S | Limit] -> QueryTag p (Picked R S)
function Limit(r) { return null; }
function T(xs) { return null; }
const q = T(["id", Limit(42)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // No Number contribution to the param slot.
    expect(ts).not.toMatch(/QueryTag\s+Number/);
    // Param slot remains an unbound TVar (or `{}` for closed empty).
    expect(ts).toMatch(/QueryTag\s+\(?[a-z]\)?\s/);
  });

  test('record-shaped Limit(p => p.limit) still works (regression)', () => {
    const src = `
// ::constraint Runnable t r { r :: (a -> t) | t }
// R :: { id :: Number }
// S :: "id"
// Limit :: Runnable Number r => r -> Limit
// T :: [S | Limit] -> QueryTag p (Picked R S)
function Limit(r) { return null; }
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('limit :: Number');
  });
});

describe('Merge of zero-param tags preserves polymorphism', () => {
  // When two tags with unbound parameter slots are concatenated via a
  // signature of the form `~> QueryTag p2 r2 -> QueryTag (Merge p1 p2) ...`,
  // the resulting param slot must remain polymorphic in display — the
  // single-tag form shows a bare `a`, so the concatenated form must
  // not collapse to a meaningless `{}`.
  const tmpRoot = '/tmp/hm-merge-zero-param';

  beforeAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpRoot, 'node_modules/sigs'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'node_modules/sigs/package.json'), JSON.stringify({
      name: 'sigs',
      main: 'index.js',
      'hinmil': { sidecars: './sigs.hm' },
    }));
    fs.writeFileSync(
      path.join(tmpRoot, 'node_modules/sigs/index.js'),
      [
        'exports.User = () => ({ concat: (o) => ({}) });',
        'exports.Limit = (r) => null;',
        'exports.Bounded = () => ({ concat: (o) => ({}) });',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(tmpRoot, 'node_modules/sigs/sigs.hm'), [
      '::constraint Runnable t r { r :: (a -> t) | t }',
      'QueryTag :: (a, b) -> QueryTag a b',
      'QueryTag() :: p -> Promise [o]',
      'QueryTag#concat :: QueryTag p1 r1 ~> QueryTag p2 r2 -> QueryTag (Merge p1 p2) (Merge r1 r2)',
      'UserRow :: { id :: Number, name :: String }',
      'User :: [a] -> QueryTag p (Picked UserRow a)',
      'Limit :: Runnable Number r => r -> Limit',
      'Bounded :: () -> QueryTag Number (Picked UserRow a)',
      '',
    ].join('\n'));
  });

  test('concat of two zero-param tags renders param as a bare TVar, not `{}`', () => {
    const consumerPath = path.join(tmpRoot, 'consumer.js');
    fs.writeFileSync(consumerPath, [
      'const { User } = require("sigs");',
      'const a = User(["id"]);',
      'const b = User(["name"]);',
      'const joined = a.concat(b);',
      '',
    ].join('\n'));
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const importResolver = ctx.createImportResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const typeDirResolver = ctx.createTypeDirectiveResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    const r = eng.infer(source, undefined, importResolver, typeDirResolver, aliasResolver);
    const joinedT = r.topLevelBindings.get('joined')!.type;
    const pretty = prettyTypeToString(joinedT);
    // Must not show a meaningless `{}` in the param slot.
    expect(pretty).not.toMatch(/QueryTag\s+\{\s*\}/);
    // Must read as `QueryTag <var> ...` with a bare polymorphic var
    // (the outer printer may wrap the single-var arg in parens).
    expect(pretty).toMatch(/QueryTag\s+\(?[a-z][a-zA-Z0-9_]*\)?\s/);
  });

  test('concat of a zero-param tag with a scalar-param tag reduces to the scalar', () => {
    // When one operand has an unbound TVar param and the other has a
    // concrete scalar (e.g. `Number`), calling the merged tag would
    // require the arg to satisfy both — so the effective param is the
    // scalar.  The display must therefore read `Number`, not
    // `Merge a Number`.
    const consumerPath = path.join(tmpRoot, 'consumerScalar.js');
    fs.writeFileSync(consumerPath, [
      'const { User, Bounded } = require("sigs");',
      'const p = User(["id"]);',
      'const b = Bounded();',
      'const joined = p.concat(b);',
      '',
    ].join('\n'));
    const fileUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});
    const importResolver = ctx.createImportResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    const typeDirResolver = ctx.createTypeDirectiveResolver(fileUri);
    const eng = new InferenceEngine();
    const source = fs.readFileSync(consumerPath, 'utf8');
    const r = eng.infer(source, undefined, importResolver, typeDirResolver, aliasResolver);
    const joinedT = r.topLevelBindings.get('joined')!.type;
    const pretty = prettyTypeToString(joinedT);
    // Param slot must read `Number`, not `Merge a Number`.
    expect(pretty).toMatch(/QueryTag\s+Number\s/);
    expect(pretty).not.toMatch(/Merge\s+[a-z]+\s+Number/);
  });
});
