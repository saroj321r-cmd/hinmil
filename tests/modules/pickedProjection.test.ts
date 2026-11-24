// Tests for the inline call-site record projection performed when a call's
// result type contains a `Picked R a` marker.  `Picked` is a generic
// hinmil primitive — libraries (e.g. sqlkit) emit signatures like
//
//     SomeTable :: [SomeSelector] -> QueryTag (Picked SomeRow SomeSelector)
//
// The post-processing hook in `src/infer/calls.ts` inspects the call's
// literal-array argument and replaces the marker with a structural record
// reflecting the columns the caller actually selected.  Relations are
// resolved through the parent row's method-shadows (`Row#child :: [ChildRow]`)
// rather than a name-mangling convention.

import { typeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { clearConstraints } from '../../src/registries/constraintRegistry';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { provideSignatureHelp } from '../../src/services/signatureHelp';

describe('Picked projection', () => {
  beforeEach(() => {
    clearCustomMethods();
    clearConstraints();
    clearDataTypes();
  });

  test('string-literal columns project to row field types', () => {
    const src = `
// OrganisationRow :: { id :: Number, name :: String, slug :: String }
// OrganisationSelector :: "id" | "name" | "slug"
// Organisation :: [OrganisationSelector] -> QueryTag (Picked OrganisationRow OrganisationSelector)
function Organisation(xs) { return null; }
Organisation(["id", "name"])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    expect(ts).toContain('name :: String');
    expect(ts).not.toContain('slug');
    expect(ts).toContain('QueryTag');
  });

  test('unknown column literals are dropped', () => {
    const src = `
// QueryTag :: a -> QueryTag a
// R :: { id :: Number, name :: String }
// S :: "id" | "name"
// T :: [S] -> QueryTag (Picked R S)
function T(xs) { return null; }
T(["id", "bogus"])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    expect(ts).not.toContain('bogus');
  });

  test('projected record is structural (no row alias)', () => {
    const src = `
// QueryTag :: a -> QueryTag a
// R :: { id :: Number, name :: String }
// S :: "id" | "name"
// T :: [S] -> QueryTag (Picked R S)
function T(xs) { return null; }
T(["id"])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const inner = (r.type as any).args?.[0];
    expect(inner?.tag).toBe('TRecord');
    expect(inner?.alias).toBeUndefined();
    expect(Object.keys(inner.fields)).toEqual(['id']);
  });

  test('Identifier of `Prop T` type contributes a field by name', () => {
    const src = `
// QueryTag :: a -> QueryTag a
// R :: { id :: Number, name :: String, computed :: Number }
// S :: "id" | "name" | "computed" | Prop a
// computed :: Prop Number
// T :: [S] -> QueryTag (Picked R S)
const computed = null;
function T(xs) { return null; }
T([computed])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('computed :: Number');
  });

  test('unrelated free-form expressions are silently skipped', () => {
    const src = `
// QueryTag :: a -> QueryTag a
// R :: { id :: Number, name :: String }
// S :: "id" | "name" | Number
// limit :: Number -> Number
// T :: [S] -> QueryTag (Picked R S)
function limit(n) { return n; }
function T(xs) { return null; }
T(["id", limit(10)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
  });

  test('nested call resolves relation through method-shadow', () => {
    // `OrganisationRow#locations :: [LocationRow]` is a method-shadow that
    // tells the projection hook: when an element of an
    // `Organisation([...])` selector array has type `QueryTag LocationRow`,
    // place it under the key `locations`.
    const src = `
// LocationRow :: { id :: Number, label :: String }
// LocationSelector :: "id" | "label"
// OrganisationRow :: { id :: Number, name :: String }
// OrganisationRow#locations :: [LocationRow]
// OrganisationSelector :: "id" | "name" | QueryTag LocationRow
// Location :: [LocationSelector] -> QueryTag (Picked LocationRow LocationSelector)
// Organisation :: [OrganisationSelector] -> QueryTag (Picked OrganisationRow OrganisationSelector)
function Location(xs) { return null; }
function Organisation(xs) { return null; }
Organisation(["id", Location(["id"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    expect(ts).toContain('locations :: [{ id :: Number }]');
  });

  test('bare relation identifier expands all child row columns', () => {
    // sqlkit convention: when a relation is referenced *without* a
    // selector array (e.g. `LocationType` instead of `LocationType([...])`),
    // every column of the child row is selected.
    const src = `
// LocationTypeRow :: { id :: Number, label :: String }
// LocationTypeSelector :: "id" | "label"
// LocationType :: [LocationTypeSelector] -> QueryTag (Picked LocationTypeRow LocationTypeSelector)
// LocationRow :: { id :: Number, name :: String }
// LocationRow#locationType :: LocationTypeRow
// LocationSelector :: "id" | "name" | QueryTag LocationTypeRow
// Location :: [LocationSelector] -> QueryTag (Picked LocationRow LocationSelector)
function LocationType(xs) { return null; }
function Location(xs) { return null; }
Location(["id", LocationType])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('locationType :: { id :: Number, label :: String }');
  });

  test('array with no column selectors implicitly selects all row columns', () => {
    // When the selector array contains only relations / extras and no
    // string-literal columns, sqlkit selects every row column too.
    const src = `
// LocationRow :: { id :: Number, name :: String, address :: String }
// LocationSelector :: "id" | "name" | "address"
// OrganisationRow :: { id :: Number, name :: String }
// OrganisationRow#locations :: [LocationRow]
// OrganisationSelector :: "id" | "name" | QueryTag LocationRow
// Location :: [LocationSelector] -> QueryTag (Picked LocationRow LocationSelector)
// Organisation :: [OrganisationSelector] -> QueryTag (Picked OrganisationRow OrganisationSelector)
function Location(xs) { return null; }
function Organisation(xs) { return null; }
Organisation([Location(["id"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    expect(ts).toContain('name :: String');
    expect(ts).toContain('locations ::');
  });

  test('nested call inlines child row even when QueryTag is multi-arg (p, row)', () => {
    // Mirrors the production sqlkit sidecar which now emits 2-arg
    // signatures: `Table :: [Sel] -> QueryTag p (Picked R Sel)`.  The
    // parent projection must still inline the nested call's projected
    // record under the relation key — not fall back to `[LocationRow]`.
    const src = `
// LocationRow :: { id :: Number, label :: String }
// LocationSelector :: "id" | "label"
// OrganisationRow :: { id :: Number, name :: String }
// OrganisationRow#locations :: [LocationRow]
// OrganisationSelector :: "id" | "name" | QueryTag p LocationRow
// Location :: [LocationSelector] -> QueryTag p (Picked LocationRow LocationSelector)
// Organisation :: [OrganisationSelector] -> QueryTag p (Picked OrganisationRow OrganisationSelector)
function Location(xs) { return null; }
function Organisation(xs) { return null; }
Organisation(["id", Location(["id", "label"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    // Inlined record, NOT bare `[LocationRow]` shortcut.
    expect(ts).toContain('locations :: [{ id :: Number, label :: String }]');
    expect(ts).not.toMatch(/locations :: \[LocationRow\]/);
  });

  test('nested call without a matching method-shadow is skipped', () => {
    const src = `
// LocationRow :: { id :: Number }
// LocationSelector :: "id"
// OrganisationRow :: { id :: Number, name :: String }
// OrganisationSelector :: "id" | "name" | QueryTag LocationRow
// Location :: [LocationSelector] -> QueryTag (Picked LocationRow LocationSelector)
// Organisation :: [OrganisationSelector] -> QueryTag (Picked OrganisationRow OrganisationSelector)
function Location(xs) { return null; }
function Organisation(xs) { return null; }
Organisation(["id", Location(["id"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    // No shadow → no relation key projected.
    expect(ts).not.toContain('locations');
  });

  test('no Picked marker → result is unchanged', () => {
    const src = `
// QueryTag :: a -> QueryTag a
// R :: { id :: Number }
// T :: [String] -> QueryTag R
function T(xs) { return null; }
T(["id"])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('QueryTag');
  });

  test('non-array argument leaves the marker in place', () => {
    const src = `
// QueryTag :: a -> QueryTag a
// R :: { id :: Number }
// S :: "id"
// T :: a -> QueryTag (Picked R S)
function T(x) { return null; }
T(42)
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('Picked');
  });

  test('projection propagates through outer wrapper parameter slot', () => {
    // Regression for a bug where the inner call's `Picked R Sel` result
    // had been unified with an outer wrapper's parameter type variable
    // (e.g. `one :: QueryTag b -> ...` binding `b` to `Picked R Sel`),
    // and the post-projection QueryTag-of-record argument therefore
    // mismatched the slot with a spurious "Cannot unify { ... } with
    // Picked R …" diagnostic.  The Picked rewrite must be propagated
    // into the substitution so every alias of the binding sees the
    // projected record.
    const src = `
// QueryTag :: a -> QueryTag a
// RTask :: a -> b -> c -> RTask a b c
// R :: { id :: Number, name :: String }
// S :: "id" | "name"
// T :: [S] -> QueryTag (Picked R S)
// one :: QueryTag b -> a -> RTask r e b
function T(xs) { return null; }
function one(t) { return null; }
const q = one(T(["id"]))
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const noisy = (r.diagnostics ?? []).filter(d =>
      d.message.includes('Cannot unify') &&
      d.message.includes('Picked'),
    );
    expect(noisy).toEqual([]);
  });

  test('value-as-callable overload specialises carrier TVar with host row', () => {
    // Regression for the LSP-end-to-end bug where a value of type
    // `QueryTag {projected}` (after Picked projection) could be invoked,
    // but inference left the result type as the bare `RTask r e [b]`
    // from the imported overload `QueryTag :: a -> RTask r e [b]` instead
    // of substituting `b` with the host's projected row.  This broke
    // signature help, dot-completion (no `.map`), and callback param
    // types in `.map(x => …)` chains.  The carrier TVar must be
    // specialised with the host TCon's row arg before unification in
    // `tryConstructorCallable`.
    const src = `
// QueryTag :: a -> QueryTag a
// QueryTag() :: a -> RTask r e [b]
// RTask :: a -> b -> c -> RTask a b c
// R :: { id :: Number, name :: String }
// S :: "id" | "name"
// T :: [S] -> QueryTag (Picked R S)
function T(xs) { return null; }
const q = T(["id"]);
const r = q({})
    `;
    const engine = new InferenceEngine();
    const result = engine.infer(src);
    const ts = typeToString(result.type);
    expect(ts).toContain('RTask');
    expect(ts).toContain('id :: Number');
    expect(ts).not.toMatch(/\[\s*[a-z]\s*\]/);
  });

  test('signature help on a value-as-callable substitutes carrier with host row', () => {
    // Regression for the LSP signature-help path: typing
    // `readRandomOrganisations(` after binding it to `Organisation([...])`
    // was showing `(a) -> RTask r e [b]` from the bare imported overload
    // `QueryTag :: a -> RTask r e [b]`, instead of substituting the carrier
    // `[b]` with the projected row from the host TCon `QueryTag {projected}`.
    const src = `
// QueryTag :: a -> QueryTag a
// QueryTag() :: a -> RTask r e [b]
// RTask :: r -> e -> a -> RTask r e a
// R :: { id :: Number, name :: String }
// S :: "id" | "name"
// T :: [S] -> QueryTag (Picked R S)
function T(xs) { return null; }
const q = T(["id"]);
q(`;
    const engine = new InferenceEngine();
    const sig = provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
    expect(sig).not.toBeNull();
    const labels = sig!.signatures.map(s => s.label);
    const carrierLabel = labels.find(l => l.includes('RTask'));
    expect(carrierLabel).toBeDefined();
    expect(carrierLabel!).toContain('id :: Number');
    expect(carrierLabel!).not.toMatch(/\[\s*[a-z]\s*\]/);
  });

  // Regression: an overloaded function invoked with an EMPTY argument list
  // (`f(|)`) must surface ALL overload branches in signature help.  A prior
  // bug narrowed the display to the single branch that inference had
  // provisionally matched against the implicit `undefined` argument, hiding
  // every other overload from the user.
  test('empty-paren call on an overloaded function shows every overload', () => {
    const src = `
// objectOverload :: { nam :: String } -> { nam :: String }
// objectOverload :: Test -> Test
// Test :: { name :: String }
const objectOverload = some => { return some };
objectOverload(`;
    const engine = new InferenceEngine();
    const sig = provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
    expect(sig).not.toBeNull();
    expect(sig!.signatures).toHaveLength(2);
    const labels = sig!.signatures.map(s => s.label);
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('{ nam :: String }'),
      expect.stringContaining('Test'),
    ]));
  });

  // Regression: record-typed overloads must be discriminated by field name,
  // not by lenient record unification (which merges `{ name }` into a `{ nam }`
  // parameter and so makes the first record branch swallow every argument).
  const RECORD_OVERLOAD = `
// objectOverload :: { nam :: String } -> { nam :: String }
// objectOverload :: Test -> Test
// Test :: { name :: String }
const objectOverload = some => { return some };
// testje :: Test
const testje = { name: "test" };
`;

  function recordSigLabels(tail: string): string[] {
    const src = RECORD_OVERLOAD + tail;
    const engine = new InferenceEngine();
    const sig = provideSignatureHelp({
      source: src,
      offset: src.length,
      engine,
      resolver: () => null,
      typeResolver: () => null,
      reinferWithArrayASI: () => null,
    });
    return sig ? sig.signatures.map(s => s.label) : [];
  }

  test('a still-unbound partial argument keeps every record overload visible', () => {
    // `te` is mid-typing (will become `testje`); inference may provisionally
    // bind it to the first branch's parameter, but signature help must not
    // narrow until the identifier resolves.
    const labels = recordSigLabels('objectOverload(te');
    expect(labels).toHaveLength(2);
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('{ nam :: String }'),
      expect.stringContaining('Test'),
    ]));
  });

  test('a resolved record argument selects the field-matching overload', () => {
    // `testje :: Test = { name :: String }` matches ONLY the `Test -> Test`
    // branch — the `{ nam :: String }` branch requires a `nam` field.
    const labels = recordSigLabels('objectOverload(testje');
    expect(labels).toEqual(['objectOverload(Test) -> Test']);
  });

  test('overload SELECTION picks the field-matching branch (not the first)', () => {
    // Inference itself must record the correct overload index for a record
    // argument, so hover and the inferred result type agree with signature
    // help.
    const src = RECORD_OVERLOAD + 'const out = objectOverload(testje);';
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const calleeStart = src.lastIndexOf('objectOverload(testje');
    expect(r.callSiteOverloadIndex?.get(calleeStart)).toBe(1);
  });
  // unification) used to be treated as a projection target.  The same
  // selector array would then be re-projected against unrelated rows,
  // wiping out the legitimate projection and producing the parent's
  // full unprojected row.  `applyPickedProjection` now skips union
  // members when collecting / rewriting Picked markers.
  test('sibling Picked branches in parent selector union do not re-project the array', () => {
    const src = `
// LocationRow :: { id :: Number, label :: String }
// LocationSelector :: ('id' | 'label')
// OrganisationRow :: { id :: Number, name :: String, website :: String }
// OrganisationRow#locations :: [LocationRow]
// OrganisationSelector :: ('id' | 'name' | QueryTag p (Picked LocationRow a))
// Location :: [LocationSelector] -> QueryTag p (Picked LocationRow LocationSelector)
// Organisation :: [OrganisationSelector] -> QueryTag p (Picked OrganisationRow OrganisationSelector)
function Location(xs) { return null; }
function Organisation(xs) { return null; }
Organisation([Location(["id", "label"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // Implicit "all columns" branch: the only element is a relation,
    // so the parent row's columns are inlined alongside the relation key.
    expect(ts).toContain('locations :: [{ id :: Number, label :: String }]');
    expect(ts).toContain('id :: Number');
    expect(ts).toContain('name :: String');
    // Crucially, NOT polluted with the unprojected row alias OR a bogus
    // projection produced by re-applying [Location(...)] against
    // OrganisationRow itself.
    expect(ts).not.toMatch(/Picked OrganisationRow/);
  });

  // Regression: bare-identifier relation reference like
  // `Location([LocationType, ...])` used to project the value-as-callable
  // constructor's `{ props :: {…} }` branch under the relation key
  // instead of the child row's actual columns.  For bare identifiers
  // the projection now always expands the row alias, ignoring the
  // constructor union shape entirely.
  test('bare identifier relation expands row columns even when constructor is a value-as-callable union', () => {
    const src = `
// LocationTypeRow :: { id :: Number, label :: String, code :: String }
// LocationTypeSelector :: ('id' | 'label' | 'code')
// LocationType :: ({ props :: { id :: a, label :: a, code :: a } } | Table LocationTypeRow | ([LocationTypeSelector] -> QueryTag p (Picked LocationTypeRow LocationTypeSelector)))
// LocationRow :: { id :: Number, name :: String }
// LocationRow#locationType :: LocationTypeRow
// LocationSelector :: ('id' | 'name' | QueryTag p (Picked LocationTypeRow a))
// Location :: [LocationSelector] -> QueryTag p (Picked LocationRow LocationSelector)
const LocationType = null;
function Location(xs) { return null; }
Location(["id", LocationType])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // Inlined row columns under the relation key — NOT the
    // constructor's `{ props :: {…} }` surface.
    expect(ts).toContain('locationType :: { id :: Number, label :: String, code :: String }');
    expect(ts).not.toMatch(/locationType :: \{\s*props\s*::/);
  });

  // Bare identifier whose binding type is a plain TFun signature
  // (no value-as-callable union) should keep working: row columns
  // still inlined, no regression on the simpler case.
  test('bare identifier with plain TFun signature still expands row columns', () => {
    const src = `
// LocationTypeRow :: { id :: Number, label :: String }
// LocationTypeSelector :: ('id' | 'label')
// LocationType :: [LocationTypeSelector] -> QueryTag p (Picked LocationTypeRow LocationTypeSelector)
// LocationRow :: { id :: Number, name :: String }
// LocationRow#locationType :: LocationTypeRow
// LocationSelector :: ('id' | 'name' | QueryTag p (Picked LocationTypeRow a))
// Location :: [LocationSelector] -> QueryTag p (Picked LocationRow LocationSelector)
function LocationType(xs) { return null; }
function Location(xs) { return null; }
Location(["id", LocationType])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('locationType :: { id :: Number, label :: String }');
  });

  // Bare identifier whose constructor union has a `Table R` branch
  // (the other arm of the value-as-callable shape) must not be picked
  // up as the inner record either.
  test('bare identifier with Table R branch in union still expands row columns', () => {
    const src = `
// LocationTypeRow :: { id :: Number, label :: String }
// LocationTypeSelector :: ('id' | 'label')
// LocationType :: (Table LocationTypeRow | ([LocationTypeSelector] -> QueryTag p (Picked LocationTypeRow LocationTypeSelector)))
// LocationRow :: { id :: Number, name :: String }
// LocationRow#locationType :: LocationTypeRow
// LocationSelector :: ('id' | 'name' | QueryTag p (Picked LocationTypeRow a))
// Location :: [LocationSelector] -> QueryTag p (Picked LocationRow LocationSelector)
const LocationType = null;
function Location(xs) { return null; }
Location([LocationType])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    expect(ts).toContain('locationType :: { id :: Number, label :: String }');
  });

  // Nested call (NOT bare identifier) — the projected record from the
  // inner call must continue to be inlined via
  // `extractInnerProjectedRecord`, not the row-alias expansion.
  test('nested call uses inner projected record, not row-alias expansion', () => {
    const src = `
// LocationTypeRow :: { id :: Number, label :: String, code :: String }
// LocationTypeSelector :: ('id' | 'label' | 'code')
// LocationType :: [LocationTypeSelector] -> QueryTag p (Picked LocationTypeRow LocationTypeSelector)
// LocationRow :: { id :: Number, name :: String }
// LocationRow#locationType :: LocationTypeRow
// LocationSelector :: ('id' | 'name' | QueryTag p (Picked LocationTypeRow a))
// Location :: [LocationSelector] -> QueryTag p (Picked LocationRow LocationSelector)
function LocationType(xs) { return null; }
function Location(xs) { return null; }
Location([LocationType(["id", "label"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // Only the projected columns from the inner call — NOT every column.
    expect(ts).toContain('locationType :: { id :: Number, label :: String }');
    expect(ts).not.toContain('code ::');
  });

  // ----- Prop value-type lives at the LAST type-argument -----
  // sqlkit models `Prop t Value` where the tag (`t`) carries the owning
  // table and `Value` is the SQL value type.  When projecting a Picked
  // selector that is `Prop t Value`, the projected field type must be
  // `Value` — i.e. the last positional argument — not the tag.
  test('Prop value-type comes from the last type-argument, not the tag', () => {
    const src = `
// Tag :: ()
// Prop :: t -> v -> Prop t v
// updatedAtF :: Prop Tag String
// memberCount :: Prop Tag Number
// R :: { updatedAtF :: String, memberCount :: Number }
// S :: ("updatedAtF" | "memberCount")
// T :: [S] -> QueryTag (Picked R S)
const updatedAtF = null;
const memberCount = null;
function T(xs) { return null; }
T([updatedAtF, memberCount])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const inner = (r.type as any).args?.[0];
    expect(inner?.tag).toBe('TRecord');
    // The value type — String / Number — must surface, NOT the tag (`Tag`).
    expect(typeToString(inner.fields.updatedAtF)).toBe('String');
    expect(typeToString(inner.fields.memberCount)).toBe('Number');
  });

  // ----- Inline arrow-callback contributes its first param to the params record -----
  // Some helpers (sqlkit's `Prop#eq`, `Limit`, etc.) use a Runnable
  // constraint `r :: (a -> v) | v` so the function VALUE is unified
  // wholesale and the arrow's param TVar stays unbound.  We must still
  // recover `{ field :: ? }` from `p => p.field` MemberExpressions in
  // the body so the params slot is populated for hover/completion.
  test('inline arrow callback contributes p.field accesses to the params record', () => {
    const src = `
// LimitT :: a -> b -> LimitT a b
// Runnable :: a -> r -> Constraint
// Limit :: Runnable Number r => r -> LimitT p Number
// R :: { id :: Number }
// S :: "id" | LimitT p Number
// T :: [S] -> QueryTag p (Picked R S)
function Limit(x) { return null; }
function T(xs) { return null; }
T(["id", Limit(p => p.limit)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // The arrow's body harvested the `limit` field name and surfaced it
    // through the wrapper's params slot.
    expect(ts).toContain('limit');
    // The selector record still surfaces `id`.
    expect(ts).toContain('id :: Number');
  });

  // End-to-end: method-call helper at projection-time must merge its
  // arrow's param record into the outer call's params slot alongside
  // any other selectors.
  test('method-call helper inside Picked selectors contributes arrow param fields', () => {
    const src = `
// Tag :: ()
// Prop :: t -> v -> Prop t v
// Runnable :: a -> r -> Constraint
// Prop#eq :: Runnable a r => Prop t a ~> r -> Prop t a
// applicationId :: Prop Tag Number
// R :: { applicationId :: Number, name :: String }
// S :: ("applicationId" | "name" | Prop t v)
// T :: [S] -> QueryTag p (Picked R S)
const applicationId = null;
function T(xs) { return null; }
T([applicationId.eq(p => p.applicationId), "name"])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // The arrow's `p.applicationId` must surface in the params slot.
    expect(ts).toContain('applicationId');
    // The selector record still carries its projected field as well.
    expect(ts).toContain('name :: String');
  });

  // ----- extractInnerProjectedRecord must target the ROW slot, not the
  //       params slot, when the wrapper TCon has both. -----
  // After bindParamSlot fills the param slot of an inner call's wrapper
  // with a record (from arrow harvesting), the OUTER projection looking
  // for the inner's row-record must NOT pick up the params record by
  // accident.  `findHostSlots` separates the two.
  //
  // Regression scenario: `Inner([selectors])` returns
  // `QueryTag p (Picked InnerRow Sel)`.  When projection runs, the
  // wrapper's `p` slot may be substituted with a record harvested from
  // an inline arrow callback.  The OUTER call then asks for the inner
  // call's projected row-record; without slot-targeting the helper
  // would pick the params record (slot 0) instead of the row record
  // (slot 1).
  test('inner projected-record extraction targets the row slot, not the params slot', () => {
    const src = `
// IprChildRow :: { code :: String, label :: String, x :: Number }
// IprChildSel :: ("code" | "label" | "x")
// IprChild :: [IprChildSel] -> QueryTag p (Picked IprChildRow IprChildSel)
// IprParentRow :: { id :: Number, name :: String }
// IprParentRow#child :: [IprChildRow]
// IprParentSel :: ("id" | "name" | QueryTag p IprChildRow)
// IprParent :: [IprParentSel] -> QueryTag p (Picked IprParentRow IprParentSel)
function IprChild(xs) { return null; }
function IprParent(xs) { return null; }
IprParent(["id", IprChild(["code", "label"])])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // Outer must inline ONLY the projected fields from the inner call.
    expect(ts).toMatch(/child :: \[\{ code :: String, label :: String \}\]/);
    expect(ts).not.toMatch(/x ::/);
  });

  // ----- Harvested params field gets its TYPE from the row column when names match -----
  // The arrow `p => p.id` (under a `Runnable` constraint that doesn't
  // bind the param's TVar) produces `{ id :: <fresh TVar> }` from a
  // body-syntactic walk.  When the row being projected has a column of
  // the same name (e.g. `OrganisationRow { id :: Number }`), the
  // params field should pick up `Number` from the row instead of
  // surfacing as a free variable.
  test('arrow-harvested params field is enriched with row column type when names match', () => {
    const src = `
// EnrTag :: ()
// EnrProp :: t -> v -> EnrProp t v
// EnrRunnable :: a -> r -> Constraint
// EnrProp#eq :: EnrRunnable a r => EnrProp t a ~> r -> EnrProp t a
// id :: EnrProp EnrTag Number
// EnrRow :: { id :: Number, name :: String }
// EnrSel :: ("id" | "name" | EnrProp t v)
// Enr :: [EnrSel] -> QueryTag p (Picked EnrRow EnrSel)
const id = null;
function Enr(xs) { return null; }
Enr(["name", id.eq(p => p.id)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    // The params slot must show `id :: Number` (from the row), NOT a TVar.
    const ts = typeToString(r.type);
    expect(ts).toMatch(/QueryTag \{ id :: Number \}/);
  });

  // Negative case: a harvested field with NO matching row column keeps
  // its original (helper-derived or fresh-TVar) type.
  test('row-enrichment leaves unrelated params fields untouched', () => {
    const src = `
// LimitT :: a -> b -> LimitT a b
// EnrRunnable2 :: a -> r -> Constraint
// Limit :: EnrRunnable2 Number r => r -> LimitT p Number
// EnrRow2 :: { id :: Number, name :: String }
// EnrSel2 :: ("id" | "name" | LimitT p Number)
// Enr2 :: [EnrSel2] -> QueryTag p (Picked EnrRow2 EnrSel2)
function Limit(x) { return null; }
function Enr2(xs) { return null; }
Enr2(["id", Limit(p => p.limit)])
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const ts = typeToString(r.type);
    // `limit` is NOT a column of EnrRow2 — it must still show up as a
    // params field, with its own (Number, from the Runnable constraint
    // value) or fresh-TVar type, not be dropped.
    expect(ts).toContain('limit');
  });

  // ----- Constraint validation on instance method calls -----
  // `Prop#eq :: Runnable a r => Prop t a ~> r -> Prop t a` constrains the
  // argument `r` to either `(a -> t)` or `t`.  When the receiver is
  // `Prop Tag Number`, calling `id.eq("een")` should report that String
  // does not satisfy the union constraint — mirroring the behaviour of
  // the static `Limit("een")` form.
  test('constrained instance method validates argument against union constraint', () => {
    const src = `
// ::constraint CnstrRunnable t r { r :: (a -> t) | t }
// Tag :: ()
// Prop :: t -> v -> Prop t v
// Prop#eq :: CnstrRunnable a r => Prop t a ~> r -> Prop t a
// id :: Prop Tag Number
const id = null;
id.eq("een")
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const msgs = (r.diagnostics ?? []).map(d => d.message);
    expect(msgs.some(m => /does not satisfy union constraint 'CnstrRunnable'/.test(m))).toBe(true);
  });

  test('constrained instance method accepts argument that satisfies union constraint', () => {
    const src = `
// ::constraint CnstrRunnable2 t r { r :: (a -> t) | t }
// Tag :: ()
// Prop :: t -> v -> Prop t v
// Prop#eq :: CnstrRunnable2 a r => Prop t a ~> r -> Prop t a
// id :: Prop Tag Number
const id = null;
id.eq(123)
    `;
    const engine = new InferenceEngine();
    const r = engine.infer(src);
    const msgs = (r.diagnostics ?? []).map(d => d.message);
    expect(msgs.some(m => /does not satisfy union constraint/.test(m))).toBe(false);
  });
});
