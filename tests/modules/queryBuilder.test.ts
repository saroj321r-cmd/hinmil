// sqlkit library integration — consolidated suite.
//
//   1. QueryTag p inference — selector helpers (`Limit(p => p.limit)`) bind or
//      hint the host constructor's parameter-record slot.
//   2. Source constraint — `::constraint Source s { s :: String | SQLTag a b }`
//      restricts `Prop`'s second argument to String | SQLTag.
//   3. Prop phantom tagging — per-table `<Table>Tag` markers prevent a Prop
//      from one table being used as a selector of another.
//   4. Per-table Selector + Row aliases — column-literal unions accept valid
//      names, reject typos, and per-occurrence freshening keeps repeated
//      alias vars independent.
//   5. Relation diagnostic — `validateSelectorRelations` flags a Child
//      constructor with no declared `<ParentRow>#x` relation.
//   6. Relation projection — a bare identifier typed as the parent
//      `*Selector` union must not be classified as a child relation.
//   7. `Merge a b` reduction — structural union of both operands for
//      `QueryTag#concat`-style combinators.
//   8. Repo row extraction — `Repo :: Table row -> { insert :: row -> ... }`
//      pins CRUD methods to the concrete `<Table>Row` alias.
//   9. Selector-union dedup — nominal-alias rows with identical record
//      shapes stay distinct union members.

import * as fs from 'fs';
import { typeToString, prettyTypeToString } from '../../src/hm/types';
import {
  HM_INVALID_TABLE_RELATION,
  classifyDiagnosticCode,
} from '../../src/services/diagnosticCodes';
import { freshEngine, inferSource, typeOf } from '../helpers/infer';
import { TempProject } from '../helpers/project';

// ---------------------------------------------------------------------------
// Tests for parameter-record inference on `QueryTag p row` constructors.
//
// When a selector array passed to a sqlkit-style table constructor
// contains helpers like `Limit(p => p.limit)` or `Offset(p => p.offset)`
// — generally any helper whose argument is a function
// `({...record...}) -> _` — the gathered parameter record should bind
// the host TCon's parameter slot.  This makes the second overload of
// `QueryTag()` display the user's actual params record instead of a bare
// type variable.
// ---------------------------------------------------------------------------

describe('QueryTag p inference from selector helpers', () => {
  test('Limit callback contributes its record to the host parameter slot', () => {
    const src = `
// R :: { id :: Number }
// S :: "id"
// Limit  :: ({ limit :: Number } -> Number) -> Limit
// T :: [S | Limit] -> QueryTag p (Picked R S)
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit)])
    `;
    const ts = typeOf(src);
    // Picked row is inlined under the row slot…
    expect(ts).toContain('id :: Number');
    // …and the param slot now carries `{ limit :: Number }`.
    expect(ts).toContain('limit :: Number');
  });

  test('Limit + Offset merge into a single parameter record', () => {
    const src = `
// R :: { id :: Number }
// S :: "id"
// Limit  :: ({ limit  :: Number } -> Number) -> Limit
// Offset :: ({ offset :: Number } -> Number) -> Offset
// T :: [S | Limit | Offset] -> QueryTag p (Picked R S)
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit), Offset(p => p.offset)])
    `;
    const ts = typeOf(src);
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('offset :: Number');
  });

  test('parameters from a nested sub-query propagate to the outer host', () => {
    const src = `
// LocationRow :: { id :: Number }
// LocationSelector :: "id"
// OrganisationRow :: { id :: Number, name :: String }
// OrganisationRow#locations :: [LocationRow]
// OrganisationSelector :: "id" | "name" | QueryTag p LocationRow | Limit
// LocationOnlySelector :: LocationSelector | LocLimit
// LocLimit :: ({ locLimit :: Number } -> Number) -> LocLimit
// Limit    :: ({ orgLimit :: Number } -> Number) -> Limit
// Location :: [LocationOnlySelector] -> QueryTag p (Picked LocationRow LocationSelector)
// Organisation :: [OrganisationSelector] -> QueryTag p (Picked OrganisationRow OrganisationSelector)
function LocLimit(fn) { return null; }
function Limit(fn) { return null; }
function Location(xs) { return null; }
function Organisation(xs) { return null; }
const q = Organisation([
  "id",
  Location(["id", LocLimit(p => p.locLimit)]),
  Limit(p => p.orgLimit),
])
    `;
    const ts = typeOf(src);
    // Both the inner sub-query's helper and the outer helper contribute
    // to the host's parameter record.
    expect(ts).toContain('orgLimit :: Number');
    expect(ts).toContain('locLimit :: Number');
  });

  test('no helpers → param slot remains an unbound TVar (no binding)', () => {
    const src = `
// R :: { id :: Number }
// S :: "id"
// T :: [S] -> QueryTag p (Picked R S)
function T(xs) { return null; }
const q = T(["id"])
    `;
    const ts = typeOf(src);
    // Picked row still inlines.
    expect(ts).toContain('id :: Number');
    // No record binding for `p` — should still display as a bare lowercase
    // TVar (single letter, after pretty-printing).
    expect(ts).toMatch(/QueryTag\s+[a-z]\b/);
  });

  test('1-arg host (QueryTag o, no param slot) records the param via paramHint and surfaces it via instance-callable overload', () => {
    // Mirrors the post-edit sqlkit sidecar: `QueryTag` carries only the
    // output row, and the params record is reconstructed structurally
    // from the helpers used in the selector list.  The hover/sig-help
    // paths read the `paramHint` attached during call-site projection
    // and substitute it into the parameter slot of the second overload.
    const src = `
// R :: { id :: Number }
// S :: "id"
// Limit  :: ({ limit :: Number } -> Number) -> Limit r
// T :: [S | Limit r] -> QueryTag (Picked R S)
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit)])
    `;
    const r = inferSource(src);
    const ts = typeToString(r.type);
    // The host TCon prints just the projected row arg (1-arg arity).
    expect(ts).toContain('id :: Number');
    expect(ts).not.toMatch(/QueryTag\s+[a-z]\s+\{/);
    // paramHint is attached on the result TCon.
    const t = r.type as { tag: string; name?: string; paramHint?: { tag: string; fields?: Record<string, unknown> } };
    expect(t.tag).toBe('TCon');
    expect(t.name).toBe('QueryTag');
    expect(t.paramHint).toBeDefined();
    expect(t.paramHint!.tag).toBe('TRecord');
    expect(t.paramHint!.fields).toHaveProperty('limit');
  });

  // Re-targeted onto the supported instance-callable carrier path: the
  // selector list inlines `Limit(p => p.limit)` / `Offset(p => p.offset)`
  // helpers whose callback param records are projected and *merged* into the
  // host's `paramHint`.  (The earlier `Limit :: r -> Limit r` minimal-harness
  // form was skipped because that bare-carrier annotation never binds through
  // to the call-result TVar; the instance-callable form below is the shape the
  // real-world sqlkit sidecar actually uses.)
  test('1-arg host: param record merged from multiple inline helper carriers (Limit + Offset)', () => {
    // Two helper carriers contribute distinct fields; Phase D walks each
    // carrier callback record and merges them into a single host paramHint.
    //   const q = Table(["id", Limit(p => p.limit), Offset(p => p.offset)])
    const src = `
// R :: { id :: Number }
// S :: "id"
// Limit  :: ({ limit :: Number } -> Number) -> Limit r
// Offset :: ({ offset :: Number } -> Number) -> Offset r
// T :: [S | Limit r | Offset r] -> QueryTag (Picked R S)
function T(xs) { return null; }
const q = T(["id", Limit(p => p.limit), Offset(p => p.offset)])
    `;
    const r = inferSource(src);
    const t = r.type as { tag: string; name?: string; paramHint?: { tag: string; fields?: Record<string, unknown> } };
    expect(t.tag).toBe('TCon');
    expect(t.name).toBe('QueryTag');
    expect(t.paramHint).toBeDefined();
    expect(t.paramHint!.tag).toBe('TRecord');
    expect(t.paramHint!.fields).toHaveProperty('limit');
    expect(t.paramHint!.fields).toHaveProperty('offset');
  });
});

// ---------------------------------------------------------------------------
// Shared-`p` params threading (sidecar form).
//
// New-style generator signatures thread ONE parameter variable `p` from the
// selector union into the host's param slot:
//
//   Limit :: ((p -> Number) | Number) -> Limit p
//   User  :: [UserSelector | Limit p | Offset p] -> QueryTag p (Picked ...)
//
// The engine pins `p` (it appears in the call's result type) so per-element
// freshening of the selector union keeps `p` SHARED across elements, and the
// structural harvest of callback bodies (`p => p.limit`) supplies the record
// fields.  Together: `QueryTag { limit :: Number, ... } { ...projected row }`.
// ---------------------------------------------------------------------------

describe('shared-p params threading from sidecar helpers', () => {
  const project = new TempProject('sqlkit-shared-p');

  beforeAll(() => {
    project.setup();
    project.write('node_modules/dbkit/package.json', JSON.stringify({
      name: 'dbkit', main: 'index.js', 'hinmil': { sidecars: './dbkit.hm' },
    }));
    project.write('node_modules/dbkit/index.js', [
      'exports.User = (xs) => null;',
      'exports.Limit = (fn) => null;',
      'exports.Offset = (fn) => null;',
      'exports.Like = (fn) => null;',
      'exports.Page = (fn) => null;',
      'exports.sql = (strings) => null;',
      'exports.Perm = (xs) => null;',
    ].join('\n'));
    project.write('node_modules/dbkit/dbkit.hm', [
      'UserRow :: { id :: Number, name :: String }',
      'UserSelector :: "id" | "name"',
      'PermRow :: { pid :: Number }',
      'PermSelector :: "pid"',
      'Limit :: ((p -> Number) | Number) -> Limit p',
      'Offset :: ((p -> Number) | Number) -> Offset p',
      'Like :: ((p -> String) | String) -> Like p',
      'Page :: ((p -> Number) | Number) -> Page p',
      'sql :: ([String], ...) -> SQLTag p o',
      'perms :: QueryTag ({ locationId :: Number }) { pid :: Number }',
      'Perm :: [PermSelector | Limit p] -> QueryTag p (Picked PermRow PermSelector)',
      'User :: [UserSelector | Limit p | Offset p | Like p | SQLTag p o2 | QueryTag p (Picked PermRow a2)] -> QueryTag p (Picked UserRow UserSelector)',
      'QueryTag() :: p -> Promise [o]',
      'SQLTag() :: p -> Promise [o]',
      'QueryTag#concat :: QueryTag p1 r1 ~> QueryTag p2 r2 -> QueryTag (Merge p1 p2) (Merge r1 r2)',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('Limit + Offset callbacks bind the shared p to one merged record', () => {
    project.write('consumer.js', [
      'const { User, Limit, Offset } = require("dbkit");',
      'const q = User(["id", Limit(p => p.limit), Offset(p => p.offset)]);',
    ].join('\n'));
    const r = project.inferFile('consumer.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('offset :: Number');
    expect(ts).toContain('id :: Number');
    // The record binds the param SLOT (not just a display hint).
    expect(ts).toMatch(/QueryTag \{/);
  });

  test('helper payload type flows into the params field (Like → String)', () => {
    project.write('consumer-like.js', [
      'const { User, Like } = require("dbkit");',
      'const q = User(["name", Like(p => p.q)]);',
    ].join('\n'));
    const r = project.inferFile('consumer-like.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('q :: String');
    expect(ts).toContain('name :: String');
  });

  test('direct-value helper (Limit(10)) contributes no param field', () => {
    project.write('consumer-direct.js', [
      'const { User, Limit } = require("dbkit");',
      'const q = User(["id", Limit(10)]);',
    ].join('\n'));
    const r = project.inferFile('consumer-direct.js');
    expect(r.diagnostics).toEqual([]);
    const ts = prettyTypeToString(r.type);
    // No callback → nothing to harvest; p stays a bare TVar.
    expect(ts).toMatch(/QueryTag [a-z]\b/);
  });

  test('no helpers → p stays unbound', () => {
    project.write('consumer-none.js', [
      'const { User } = require("dbkit");',
      'const q = User(["id", "name"]);',
    ].join('\n'));
    const r = project.inferFile('consumer-none.js');
    expect(r.diagnostics).toEqual([]);
    const ts = prettyTypeToString(r.type);
    expect(ts).toMatch(/QueryTag [a-z]\b/);
  });

  test('parameterized selector alias element ([UserSelectorP p]) expands and threads p', () => {
    project.write('node_modules/dbkit2/package.json', JSON.stringify({
      name: 'dbkit2', main: 'index.js', 'hinmil': { sidecars: './dbkit2.hm' },
    }));
    project.write('node_modules/dbkit2/index.js', [
      'exports.User = (xs) => null;',
      'exports.Limit = (fn) => null;',
    ].join('\n'));
    project.write('node_modules/dbkit2/dbkit2.hm', [
      'UserRow :: { id :: Number, name :: String }',
      'UserCols :: "id" | "name"',
      'Limit :: ((p -> Number) | Number) -> Limit p',
      'UserSelectorP :: "id" | "name" | Limit p',
      'User :: [UserSelectorP p] -> QueryTag p (Picked UserRow UserCols)',
      'QueryTag() :: p -> Promise [o]',
    ].join('\n'));
    project.write('consumer-alias.js', [
      'const { User, Limit } = require("dbkit2");',
      'const q = User(["id", Limit(p => p.limit)]);',
    ].join('\n'));
    const r = project.inferFile('consumer-alias.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('id :: Number');
  });

  test('::extend on the selector alias keeps shared-p threading intact', () => {
    project.write('consumer-extend.js', [
      '// ::extend UserSelector Page p',
      'const { User, Limit, Page } = require("dbkit");',
      'const q = User(["id", Limit(p => p.limit), Page(p => p.page)]);',
    ].join('\n'));
    const r = project.inferFile('consumer-extend.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('page :: Number');
    expect(ts).toContain('id :: Number');
  });

  test('tagged-template interpolation callbacks bind the SQLTag param slot', () => {
    project.write('consumer-sql.js', [
      'const { sql } = require("dbkit");',
      'const frag = sql`where riziv like ${p => p.riziv}`;',
    ].join('\n'));
    const r = project.inferFile('consumer-sql.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toMatch(/SQLTag \{ riziv ::/);
  });

  test('sql fragment inside a selector array threads its params to the host', () => {
    project.write('consumer-sql-sel.js', [
      'const { User, sql, Limit } = require("dbkit");',
      'const q = User(["id", sql`and x = ${p => p.x}`, Limit(p => p.limit)]);',
    ].join('\n'));
    const r = project.inferFile('consumer-sql-sel.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('x ::');
    expect(ts).toContain('limit :: Number');
  });

  test('inline concat argument keeps harvested fields merged into a bound slot', () => {
    // The sub-tag element (`perms`) hard-binds the shared p to a closed
    // record at HM time; the later harvest of `Limit(p => p.limit)` must
    // merge into it AND the merge must be visible through the outer
    // combinator's slot var (`concat`'s p2) — regression for the subst
    // sweep in bindParamSlot's record merge-back.
    project.write('consumer-concat.js', [
      'const { User, Perm, Limit } = require("dbkit");',
      'const perms = Perm(["pid", Limit(p => p.locationId)]);',
      'const q = User(["id"]).concat(User([perms, Limit(p => p.limit)]));',
    ].join('\n'));
    const r = project.inferFile('consumer-concat.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('locationId :: Number');
    expect(ts).toContain('limit :: Number');
  });

  test('generator shape: GenericSelector p tag + Prop t a p methods + ::extend columns', () => {
    // Mirrors the sqlkit introspect generator output under the new
    // params-threading scheme:
    //   - `GenericSelector` carries the shared `p` FIRST (DFS var order
    //     [p, tag, a, o]) so per-table aliases partially apply it:
    //     `UserSelector :: GenericSelector p UserTag`.
    //   - `Prop t a p` gains a params var; chain methods thread it from
    //     `((p -> a) | a)` operands.
    //   - Column literals arrive via `::extend` (name-based var capture
    //     unifies the extension's `p` with the alias body's `p`).
    project.write('node_modules/dbkit3/package.json', JSON.stringify({
      name: 'dbkit3', main: 'index.js', 'hinmil': { sidecars: './dbkit3.hm' },
    }));
    project.write('node_modules/dbkit3/index.js', [
      'exports.User = (xs) => null;',
      'exports.Limit = (fn) => null;',
      'exports.firstname = { col: "firstname" };',
    ].join('\n'));
    project.write('node_modules/dbkit3/dbkit3.hm', [
      'UserTag :: () -> UserTag',
      'UserRow :: { id :: Number, firstname :: String }',
      'Limit :: ((p -> Number) | Number) -> Limit p',
      'Offset :: ((p -> Number) | Number) -> Offset p',
      'GenericSelector :: (Limit p | Offset p | Prop tag a p | SQLTag p o)',
      'UserSelector :: GenericSelector p UserTag',
      "::extend UserSelector 'id' | 'firstname'",
      'User :: Table UserRow',
      'User :: [UserSelector p] -> QueryTag p (Picked UserRow UserSelector)',
      'firstname :: Prop UserTag String p',
      'Prop#eq :: Prop t a p ~> ((p -> a) | a) -> Prop t a p',
      'Prop#iLike :: Prop t a p ~> ((p -> String) | String) -> Prop t a p',
      'QueryTag() :: p -> Promise [o]',
    ].join('\n'));
    project.write('consumer-gen.js', [
      'const { User, Limit, firstname } = require("dbkit3");',
      'const q = User(["id", firstname.iLike(p => p.q), Limit(p => p.limit)]);',
    ].join('\n'));
    const r = project.inferFile('consumer-gen.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('q :: String');
    expect(ts).toContain('limit :: Number');
    expect(ts).toContain('id :: Number');
  });
});

// ---------------------------------------------------------------------------
// Phase C: `Source` constraint on Prop's second argument.
//
// `::constraint Source s { s :: String | SQLTag a b }` restricts the
// second argument of `Prop` (and its typed variants) to either a
// column-name `String` or a `SQLTag`.  Passing a Number/Boolean/etc.
// must produce a constraint diagnostic.
// ---------------------------------------------------------------------------

describe('Phase C — Source constraint on Prop second-arg', () => {
  const project = new TempProject('sqlkit-prop-source');

  beforeAll(() => {
    project.setup();

    project.write('node_modules/sqlkit/package.json', JSON.stringify({
      name: 'sqlkit',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit/index.js', [
      'exports.Prop = (col, src) => ({ kind: "Prop", col, src });',
      'exports.NumberProp = (col, src) => ({ kind: "NumberProp", col, src });',
      'exports.sql = (parts, ...vals) => ({ kind: "SQLTag", parts, vals });',
    ].join('\n'));

    // Mini-sidecar carrying the Source constraint and a Prop factory.
    project.write('node_modules/sqlkit/sqlkit.hm', [
      "// Phantom table tag (Phase B shape).",
      "MeetingTag :: () -> MeetingTag",
      "",
      "// SQLTag (parameter, output).",
      "sql :: ([String], [a]) -> SQLTag b c",
      "",
      "// Source constraint: only String or SQLTag are legal column sources.",
      "::constraint Source s { s :: String | SQLTag a b }",
      "",
      "// Prop factories require Source for their second argument.",
      "Prop :: Source s => (String, s) -> Prop t b",
      "NumberProp :: Source s => (String, s) -> Prop t Number",
      "",
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  const isError = (d: { severity?: number }) =>
    d.severity === undefined || d.severity === 1;

  test('Prop("id", "id") is accepted (String source)', () => {
    project.write('ok-string.js', [
      'const { Prop } = require("sqlkit");',
      'const p = Prop("id", "id");',
      '',
    ].join('\n'));
    const r = project.inferFile('ok-string.js');
    expect(r.diagnostics.filter(isError)).toEqual([]);
  });

  test('Prop("id", sql`...`) is accepted (SQLTag source)', () => {
    project.write('ok-sql.js', [
      'const { Prop, sql } = require("sqlkit");',
      'const p = Prop("id", sql`select 1`);',
      '',
    ].join('\n'));
    const r = project.inferFile('ok-sql.js');
    expect(r.diagnostics.filter(isError)).toEqual([]);
  });

  test('Prop("id", 42) is rejected (Number is not a Source)', () => {
    project.write('bad-number.js', [
      'const { Prop } = require("sqlkit");',
      'const p = Prop("id", 42);',
      '',
    ].join('\n'));
    const r = project.inferFile('bad-number.js');
    const errors = r.diagnostics.filter(isError);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => /Source/.test(e.message))).toBe(true);
  });

  test('NumberProp("id", true) is rejected (Boolean is not a Source)', () => {
    project.write('bad-bool.js', [
      'const { NumberProp } = require("sqlkit");',
      'const p = NumberProp("id", true);',
      '',
    ].join('\n'));
    const r = project.inferFile('bad-bool.js');
    const errors = r.diagnostics.filter(isError);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => /Source/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase B end-to-end test: a per-table phantom tag on `Prop` prevents
// a Prop value from one table from being used as a selector of another.
//
// The sidecar emits `<Table>Tag :: a` markers and ties them into both
// the per-table Props record and the Selector union.  When a `.props`
// destructuring binds a value of type `Prop MeetingTag Number`, passing it
// to `Song([...])` (selectors `Prop SongTag a`) must fail to unify.
// ---------------------------------------------------------------------------

describe('Phase B — per-table Prop phantom tag', () => {
  const project = new TempProject('sqlkit-prop-tagging');

  beforeAll(() => {
    project.setup();

    project.write('node_modules/sqlkit/package.json', JSON.stringify({
      name: 'sqlkit',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit/index.js', [
      'exports.Meeting = (sel) => ({ kind: "Meeting", sel });',
      'exports.Song = (sel) => ({ kind: "Song", sel });',
      'exports.meetingProps = { id: { kind: "Prop", tag: "MeetingTag" } };',
      'exports.songProps = { id: { kind: "Prop", tag: "SongTag" } };',
    ].join('\n'));

    // Mini-sidecar with the Phase B shape: phantom `<Table>Tag` markers
    // tie Props records and Selector unions together so cross-table use
    // fails to unify.
    project.write('node_modules/sqlkit/sqlkit.hm', [
      "// Phantom table tags — distinct nominal types (constructor-style so",
      "// they don't degrade into type aliases of a free var).",
      "MeetingTag :: () -> MeetingTag",
      "SongTag :: () -> SongTag",
      "",
      "// Prop carries the table tag in its first parameter.",
      "Prop :: (String, a) -> Prop t b",
      "",
      "// Chain method preserves the table tag.",
      "Prop#eq :: Prop t a ~> b -> Prop t a",
      "",
      "// Per-table Props records inlined directly on the value (so cross-",
      "// package alias expansion isn't required for destructuring).",
      "meetingProps :: { id :: Prop MeetingTag Number }",
      "songProps :: { id :: Prop SongTag Number }",
      "",
      "// Per-table Selector unions also bind the tag in the Prop branch.",
      "MeetingSelector :: (String | Prop MeetingTag a)",
      "SongSelector :: (String | Prop SongTag a)",
      "",
      "Meeting :: [MeetingSelector] -> Number",
      "Song :: [SongSelector] -> Number",
      "",
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  // Default severity is Error when undefined.
  const isError = (d: { severity?: number }) =>
    d.severity === undefined || d.severity === 1;

  test('a prop from meetingProps is accepted by Meeting([...])', () => {
    project.write('ok.js', [
      'const { Meeting, meetingProps } = require("sqlkit");',
      'const { id } = meetingProps;',
      'Meeting([id]);',
      '',
    ].join('\n'));
    const r = project.inferFile('ok.js');
    expect(r.diagnostics.filter(isError)).toEqual([]);
  });

  test('a prop from meetingProps is rejected by Song([...])', () => {
    project.write('cross.js', [
      'const { Song, meetingProps } = require("sqlkit");',
      'const { id } = meetingProps;',
      'Song([id]);',
      '',
    ].join('\n'));
    const r = project.inferFile('cross.js');
    const errors = r.diagnostics.filter(isError);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => /MeetingTag.*SongTag|SongTag.*MeetingTag/.test(e.message))).toBe(true);
  });

  test('chained Prop methods preserve the table tag', () => {
    project.write('chain.js', [
      'const { Meeting, Song, meetingProps } = require("sqlkit");',
      'const { id } = meetingProps;',
      '// Prop#eq preserves the receiver tag, so .eq(1) is still a MeetingSelector.',
      'Meeting([id.eq(1)]);',
      'Song([id.eq(1)]);',
      '',
    ].join('\n'));
    const r = project.inferFile('chain.js');
    const errors = r.diagnostics.filter(isError);
    expect(errors.length).toBeGreaterThan(0);
    const source = fs.readFileSync(project.pathOf('chain.js'), 'utf8');
    const songLineStart = source.indexOf('Song([');
    const meetingLineStart = source.indexOf('Meeting([');
    const meetingLineEnd = source.indexOf('\n', meetingLineStart);
    expect(errors.every(e => e.start < meetingLineStart || e.start > meetingLineEnd)).toBe(true);
    expect(errors.some(e => e.start >= songLineStart)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end test for the Phase 2 sqlkit codegen pattern: per-table
// `<Table>Row` and `<Table>Selector` aliases, where `<Table>Selector` is
// a union of column-name string literals plus the generic Selector
// branches.  Validates that hinmil:
//   • accepts `Meeting(["id", "date"])` (matching column literals)
//   • rejects `Meeting(["naame"])` (typo — no matching label literal)
//   • accepts mixed selector lists `Meeting(["id", Limit(5)])`
//   • surfaces `<Table>Row` as the row type returned by the call.
// ---------------------------------------------------------------------------

describe('sqlkit Phase 2 — per-table Selector + Row aliases', () => {
  const project = new TempProject('sqlkit-selector-alias');

  beforeAll(() => {
    project.setup();

    // Mock the sqlkit package exporting `Meeting` and `Limit`.
    project.write('node_modules/sqlkit/package.json', JSON.stringify({
      name: 'sqlkit',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit/index.js', [
      'exports.Meeting  = (sel) => ({ kind: "QueryTag", sel });',
      'exports.Limit = (n)   => ({ kind: "Limit", n });',
    ].join('\n'));

    // Sidecar mirrors what sqlkit introspect now emits per Phase 2.
    project.write('node_modules/sqlkit/sqlkit.hm', [
      "// Generic selector union (catch-all for non-typed tables).",
      "Selector :: (String | Prop a | QueryTag a | Table | Limit | Offset | SQLTag a)",
      "",
      "// Per-table Row alias: raw column shape, no relations.",
      "MeetingRow :: {",
      "  id :: Number,",
      "  date :: Date,",
      "  result :: String",
      "}",
      "",
      "// Per-table Selector union: column-name literals + generic branches.",
      "MeetingSelector :: ('id' | 'date' | 'result' | Prop a | QueryTag a | Table | Limit | Offset | SQLTag a)",
      "",
      "Meeting  :: [MeetingSelector] -> QueryTag MeetingRow",
      "Limit :: Number -> Limit",
      "",
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('accepts query with all valid column-name literals', () => {
    project.write('ok.js', [
      'const { Meeting } = require("sqlkit");',
      'const t = Meeting(["id", "date", "result"]);',
    ].join('\n'));
    const r = project.inferFile('ok.js');
    expect(r.diagnostics).toHaveLength(0);
  });

  test('rejects query with a misspelled column-name literal', () => {
    project.write('typo.js', [
      'const { Meeting } = require("sqlkit");',
      'const t = Meeting(["naame"]);',
    ].join('\n'));
    const r = project.inferFile('typo.js');
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.some(d => d.message.includes("'naame'"))).toBe(true);
  });

  test('accepts mixed selectors: literal + Limit', () => {
    project.write('mixed.js', [
      'const { Meeting, Limit } = require("sqlkit");',
      'const t = Meeting(["id", Limit(5)]);',
    ].join('\n'));
    const r = project.inferFile('mixed.js');
    expect(r.diagnostics).toHaveLength(0);
  });

  test('different elements binding the same alias var stay independent', () => {
    // The Selector union has `Prop a | QueryTag a | SQLTag a` — three uses
    // of the SAME `a`.  Without per-occurrence freshening, the first
    // element pinning `a := X` would corrupt the expected type for all
    // later elements.  Here `OtherTable(...)` returns `QueryTag OtherRow`
    // and must NOT be diagnosed as a mismatch just because the
    // preceding `Meeting([...])` already bound `a := MeetingRow` in its slot.
    project.write('node_modules/sqlkit-multi/package.json', JSON.stringify({
      name: 'sqlkit-multi',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit-multi/index.js', [
      'exports.Meeting  = (sel) => ({ kind: "QueryTag", sel });',
      'exports.Other = (sel) => ({ kind: "QueryTag", sel });',
    ].join('\n'));
    project.write('node_modules/sqlkit-multi/sqlkit.hm', [
      "MeetingRow  :: { id :: Number }",
      "OtherRow :: { name :: String }",
      "MultiSelector :: ('id' | Prop a | QueryTag a | SQLTag a)",
      "Meeting  :: [MultiSelector] -> QueryTag MeetingRow",
      "Other :: [MultiSelector] -> QueryTag OtherRow",
      "",
    ].join('\n'));
    project.write('multi.js', [
      'const { Meeting, Other } = require("sqlkit-multi");',
      'const t = Meeting(["id", Other(["id"])]);',
    ].join('\n'));
    const r = project.inferFile('multi.js');
    expect(r.diagnostics).toHaveLength(0);
  });

  test('readOrganisation-shaped: Prop element followed by QueryTag element', () => {
    // Reproduce the exact API-server failure: an annotated `Prop X`
    // value comes first, binding `a := X` in the per-element freshened
    // union, then a sub-query call (`Loc(["id"])`) returns `QueryTag
    // LocRow` and must NOT see `a` already pinned to `X`.
    project.write('node_modules/sqlkit-org/package.json', JSON.stringify({
      name: 'sqlkit-org',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit-org/index.js', [
      'exports.Org = (sel) => ({ kind: "QueryTag", sel });',
      'exports.Loc = (sel) => ({ kind: "QueryTag", sel });',
      'exports.updatedAtF = { kind: "Prop" };',
    ].join('\n'));
    project.write('node_modules/sqlkit-org/sqlkit.hm', [
      "OrgRow :: { id :: Number, name :: String }",
      "LocRow :: { id :: Number }",
      "OrgSelector :: ('id' | 'name' | Prop a | QueryTag a | Table b | Limit | Offset | SQLTag a)",
      "LocSelector :: ('id' | Prop a | QueryTag a | Table b | Limit | Offset | SQLTag a)",
      "Org :: [OrgSelector] -> QueryTag OrgRow",
      "Loc :: [LocSelector] -> QueryTag LocRow",
      "updatedAtF :: Prop String",
      "",
    ].join('\n'));
    project.write('org.js', [
      'const { Org, Loc, updatedAtF } = require("sqlkit-org");',
      'const t = Org([',
      '  updatedAtF,',
      '  Loc(["id"])',
      ']);',
    ].join('\n'));
    const r = project.inferFile('org.js');
    expect(r.diagnostics).toHaveLength(0);
  });

  test('return type carries the concrete <Table>Row alias', () => {
    project.write('row.js', [
      'const { Meeting } = require("sqlkit");',
      'const t = Meeting(["id"]);',
    ].join('\n'));
    const r = project.inferFile('row.js');
    expect(r.diagnostics).toHaveLength(0);
    // The top-level inferred type for the whole module isn't `t`'s type
    // directly, but `r` carries a `nodeTypes` map keyed by AST node.
    // Easiest end-to-end check: serialise the result and confirm the
    // `MeetingRow` alias appears somewhere in the inferred types.
    const summary = JSON.stringify(r);
    expect(summary).toContain('MeetingRow');
  });
});

// ---------------------------------------------------------------------------
// Tests for the constructor-aware "no relation" diagnostic emitted by
// `validateSelectorRelations` in src/infer/calls.ts.  The diagnostic
// fires when a call site `Parent([Child(...), ...])` (or bare
// `Parent([Child, ...])`) names a Child constructor whose row is not
// declared as a relation of Parent's row via a `<ParentRow>#x ::
// <ChildRow>` (or `[<ChildRow>]`) method-shadow.
// ---------------------------------------------------------------------------

describe('relation diagnostic — Child has no relation with Parent', () => {
  const SCHEMA = [
    '// Q       :: a -> Q a',
    '// Picked  :: r -> a -> Picked r a',
    '// PostRow    :: { id :: Number, title :: String }',
    '// AuthorRow  :: { id :: Number, name :: String }',
    '// CommentRow :: { id :: Number, text :: String }',
    '// PostSelector    :: "id" | "title" | Q a',
    '// AuthorSelector  :: "id" | "name"',
    '// CommentSelector :: "id" | "text"',
    '// PostRow#author :: AuthorRow',
    '// Post    :: [PostSelector]    -> Q (Picked PostRow    a)',
    '// Author  :: PostSelector',
    '// Author  :: [AuthorSelector]  -> Q (Picked AuthorRow  a)',
    '// Comment :: PostSelector',
    '// Comment :: [CommentSelector] -> Q (Picked CommentRow a)',
    '// unsafe :: a',
    'const unsafe = null;',
    'const Post    = unsafe;',
    'const Author  = unsafe;',
    'const Comment = unsafe;',
    '',
  ].join('\n');

  test('A: nested call with missing shadow emits exactly one diagnostic', () => {
    const r = inferSource(SCHEMA + 'const q = Post(["id", Comment(["text"])]);\n');
    const matches = r.diagnostics.filter(d =>
      /'Comment' has no relation with 'Post'/.test(d.message),
    );
    expect(matches).toHaveLength(1);
    // Must be located on the inner call's identifier, not the whole call.
    const m = matches[0];
    expect(r.diagnostics.filter(d => d.start === m.start && d.end === m.end)).toHaveLength(1);
  });

  test('B: bare-identifier form also emits the diagnostic', () => {
    const r = inferSource(SCHEMA + 'const q = Post(["id", Comment]);\n');
    const matches = r.diagnostics.filter(d =>
      /'Comment' has no relation with 'Post'/.test(d.message),
    );
    expect(matches).toHaveLength(1);
  });

  test('C: declared relation produces no diagnostic', () => {
    // Author IS declared as a relation of PostRow via PostRow#author.
    const r = inferSource(SCHEMA + 'const q = Post(["id", Author(["name"])]);\n');
    expect(r.diagnostics).toHaveLength(0);
  });

  test('D: parent row with NO shadows declared — no false positive', () => {
    const noShadows = SCHEMA.replace('// PostRow#author :: AuthorRow\n', '');
    const r = inferSource(noShadows + 'const q = Post(["id", Comment(["text"])]);\n');
    const matches = r.diagnostics.filter(d =>
      / has no relation with /.test(d.message),
    );
    expect(matches).toHaveLength(0);
  });

  test('E: classifier maps the new message to HM_INVALID_TABLE_RELATION (7001)', () => {
    expect(classifyDiagnosticCode("'Comment' has no relation with 'Post'"))
      .toBe(HM_INVALID_TABLE_RELATION);
  });
});

// ---------------------------------------------------------------------------
// Regression: row projection (sqlkit-style `Row([...])`) must not
// classify an array element as a child relation when its inferred type
// is the parent's `*Selector` union — that union legitimately mentions
// many `Picked R _` rows from sibling tables and must NOT be treated as
// "this element is a relation to one of those rows".
//
// Repro:
//   - Two top-level bindings using the same parent constructor.
//   - The second binding lists a bare identifier (e.g. an `sql\`...\``
//     fragment) inside the selector array.
//   - Before the fix the bare identifier's elemType was unified to
//     `OrganisationSelector`, and `findPickedRowInType` returned the
//     first `Picked` row it found in the union (e.g. `CaregiverTodoRow`),
//     causing the projection to inject a bogus `caregiverTodos` field.
// ---------------------------------------------------------------------------

describe('relation projection — ambiguous *Selector identifier', () => {
  it('drops a bare identifier whose type is the parent Selector union (no spurious relation field)', () => {
    const source = `
// ::sumtype Maybe a = Just a | Nothing
// random :: Sql
const random = ({});

// LocationRow :: { id :: Number, name :: String }
// CaregiverTodoRow :: { id :: Number, label :: String }

// OrganisationRow :: { id :: Number, name :: String }
// OrganisationRow#locations :: [LocationRow]
// OrganisationRow#caregiverTodos :: [CaregiverTodoRow]

// OrganisationSelector :: ('id' | 'name' | Table LocationRow | QueryTag p (Picked LocationRow a) | Table CaregiverTodoRow | QueryTag p (Picked CaregiverTodoRow a) | Sql)

// Location :: Table LocationRow | ([OrganisationSelector] -> QueryTag p (Picked LocationRow a))
const Location = (xs) => xs;

// Organisation :: Table OrganisationRow | ([OrganisationSelector] -> QueryTag p (Picked OrganisationRow a))
const Organisation = (xs) => xs;

export const q1 = Organisation(["id", Location(["id"])]);
export const q2 = Organisation(["id", "name", Location(["id"]), random]);
`;
    const eng = freshEngine();
    const result = eng.infer(source);
    const q1 = result.exports.get('q1');
    const q2 = result.exports.get('q2');
    expect(q1).toBeDefined();
    expect(q2).toBeDefined();
    const q1Str = prettyTypeToString(eng.subst.apply(q1!.type));
    const q2Str = prettyTypeToString(eng.subst.apply(q2!.type));
    // The legitimate relation `Location([...])` must be projected as
    // `locations` for both bindings.
    expect(q1Str).toMatch(/locations/);
    expect(q2Str).toMatch(/locations/);
    // The bare `random` identifier (typed as the OrganisationSelector
    // union) must NOT pull in `caregiverTodos` — that field belongs to a
    // sibling Picked branch of the selector union, not to this query.
    expect(q2Str).not.toMatch(/caregiverTodos/);
  });
});

// ---------------------------------------------------------------------------
// Tests for the `Merge a b` reserved-TCon reduction used to type
// combinators like `QueryTag#concat` whose result row + parameter records
// are the structural union of both operands.
// ---------------------------------------------------------------------------

describe('Merge reduction (QueryTag#concat-style)', () => {
  test('two TRecord operands collapse to a single structural-union record', () => {
    const src = `
// A :: { id :: Number }
// B :: { name :: String }
// merge :: (A, B) -> Merge A B
function merge(a, b) { return null; }
const r = merge(0, 0)
    `;
    const ts = typeOf(src);
    // Both fields appear in one structural record.
    expect(ts).toContain('id :: Number');
    expect(ts).toContain('name :: String');
    // Marker is gone.
    expect(ts).not.toContain('Merge');
  });

  test('Merge inside a wrapper TCon collapses in place', () => {
    const src = `
// A :: { x :: Number }
// B :: { y :: String }
// QueryTag :: a -> QueryTag a
// concat :: (A, B) -> QueryTag (Merge A B)
function concat(a, b) { return null; }
const r = concat(0, 0)
    `;
    const ts = typeOf(src);
    expect(ts).toContain('QueryTag');
    expect(ts).toContain('x :: Number');
    expect(ts).toContain('y :: String');
    expect(ts).not.toContain('Merge');
  });

  test('Merge with an unbound operand renders without the noisy row tail', () => {
    const src = `
// A :: { id :: Number }
// merge :: A -> Merge A b
function merge(a) { return null; }
const r = merge(0)
    `;
    const ts = typeOf(src);
    // `b` never resolves to a record.  The pretty-printer now hides
    // bare row-var siblings (`...b`) when at least one Merge operand
    // contributed concrete fields — that extra `...b` adds no info and
    // just clutters the type the user sees (the structural marker is
    // still preserved internally in the Type AST).
    expect(ts).not.toContain('...b');
    expect(ts).toContain('id :: Number');
  });
});

// ---------------------------------------------------------------------------
// End-to-end test for the Phase 3 API-server pattern: a generic
// `Repo` factory that takes a `Table row` (where `row` is the per-table
// `<Table>Row` alias emitted by sqlkit Phase 2 codegen) and returns a
// record of CRUD methods keyed by the concrete row type.
//
// Validates that hinmil:
//   • destructures `Repo(Meeting)` into `{ insert, insertBatch, ... }`
//     with each method's input/output pinned to `MeetingRow`
//   • accepts `insert(rawRow)` where rawRow matches the row shape
//   • rejects `insert({ wrong: 1 })` with a "Type mismatch" diagnostic
//
// The `Table row` annotation only works if sqlkit codegen emits each
// table as `Meeting :: Table MeetingRow` (Phase 3 codegen update) — without
// that, `row` would bind to the props-record type instead of the row.
// ---------------------------------------------------------------------------

describe('Repo :: Table row -> { insert :: row -> ... }', () => {
  const project = new TempProject('repo-row-extraction');

  beforeAll(() => {
    project.setup();

    // sqlkit package: Phase 2/3 codegen output — `Meeting :: Table MeetingRow`.
    project.write('node_modules/sqlkit/package.json', JSON.stringify({
      name: 'sqlkit',
      main: 'index.js',
      'hinmil': { sidecars: './sqlkit.hm' },
    }));
    project.write('node_modules/sqlkit/index.js', [
      'exports.Meeting = (sel) => ({ kind: "QueryTag", sel });',
    ].join('\n'));
    project.write('node_modules/sqlkit/sqlkit.hm', [
      "MeetingRow :: {",
      "  id :: Number,",
      "  name :: String",
      "}",
      "MeetingSelector :: ('id' | 'name' | Prop a)",
      "Meeting :: Table MeetingRow",
      "Meeting :: [MeetingSelector] -> QueryTag MeetingRow",
      "",
    ].join('\n'));

    // App-local Repo module — generic over the table's row type.
    project.write('node_modules/repo-lib/package.json', JSON.stringify({
      name: 'repo-lib',
      main: 'index.js',
      'hinmil': { sidecars: './repo.hm' },
    }));
    project.write('node_modules/repo-lib/index.js', [
      'exports.Repo = (model) => ({',
      '  insert:      (p) => p,',
      '  insertBatch: (p) => p,',
      '  updateById:  (p) => p,',
      '  deleteById:  (p) => p,',
      '});',
    ].join('\n'));
    project.write('node_modules/repo-lib/repo.hm', [
      "Repo :: Table row -> {",
      "  insert      :: row -> RTask r e row,",
      "  insertBatch :: [row] -> RTask r e [row],",
      "  updateById  :: row -> RTask r e row,",
      "  deleteById  :: { id :: a } -> RTask r e row",
      "}",
      "",
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('accepts insert with raw row matching the table row shape', () => {
    project.write('ok.js', [
      'const { Meeting } = require("sqlkit");',
      'const { Repo } = require("repo-lib");',
      'const { insert } = Repo(Meeting);',
      'const t = insert({ id: 1, name: "foo" });',
    ].join('\n'));
    const r = project.inferFile('ok.js');
    expect(r.diagnostics).toHaveLength(0);
  });

  test('rejects insert with a row whose field types do not match', () => {
    project.write('bad.js', [
      'const { Meeting } = require("sqlkit");',
      'const { Repo } = require("repo-lib");',
      'const { insert } = Repo(Meeting);',
      // `id` is annotated as Number on MeetingRow — passing a string here
      // should fail on the common-key unification path.
      'const t = insert({ id: "not a number", name: "ok" });',
    ].join('\n'));
    const r = project.inferFile('bad.js');
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('insertBatch takes a list of rows', () => {
    project.write('batch.js', [
      'const { Meeting } = require("sqlkit");',
      'const { Repo } = require("repo-lib");',
      'const { insertBatch } = Repo(Meeting);',
      'const t = insertBatch([{ id: 1, name: "a" }, { id: 2, name: "b" }]);',
    ].join('\n'));
    const r = project.inferFile('batch.js');
    expect(r.diagnostics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: sqlkit-style selector unions where multiple Picked-row
// branches share the same structural record shape (e.g. both
// `CaregiverRow` and `EmployeeRow` declared as `{ id :: Number }`
// before any extra fields are added).  Before the fix, `tUnion`'s
// structural dedup collapsed `Picked CaregiverRow a` and
// `Picked EmployeeRow a` to a single member because TRecord
// equality ignored the nominal `alias` tag — so calls like
// `User([..., Employee([Department])])` produced a spurious
// "'EmployeeRow' is not a valid relation here" diagnostic.
// ---------------------------------------------------------------------------

describe('selector union: nominal-alias rows with same record shape', () => {
  const SCHEMA = [
    '// QueryTag :: p -> a -> QueryTag p a',
    '// Picked :: r -> a -> Picked r a',
    '// Table  :: a -> Table a',
    '// Prop   :: t -> a -> Prop t a',

    '// CaregiverTag        :: () -> CaregiverTag',
    '// CaregiverLocationTag :: () -> CaregiverLocationTag',
    '// EmployeeTag         :: () -> EmployeeTag',
    '// DepartmentTag       :: () -> DepartmentTag',
    '// UserTag             :: () -> UserTag',

    '// CaregiverRow         :: { id :: Number }',
    '// CaregiverLocationRow :: { id :: Number }',
    '// EmployeeRow          :: { id :: Number }',
    '// DepartmentRow        :: { id :: Number }',
    '// UserRow              :: { id :: Number }',

    // Selector unions — modelled like sqlkit with Table+QueryTag branches per relation.
    '// CaregiverSelector :: ("id" | Prop CaregiverTag a | Table CaregiverLocationRow | QueryTag p (Picked CaregiverLocationRow a) | Table UserRow | QueryTag p (Picked UserRow a))',
    '// EmployeeSelector  :: ("id" | Prop EmployeeTag a | Table DepartmentRow | QueryTag p (Picked DepartmentRow a) | Table UserRow | QueryTag p (Picked UserRow a))',
    '// DepartmentSelector :: ("id" | Prop DepartmentTag a)',
    '// UserSelector :: ("id" | Prop UserTag a | Table CaregiverRow | QueryTag p (Picked CaregiverRow a) | Table EmployeeRow | QueryTag p (Picked EmployeeRow a))',

    // Method shadows: User has both Caregiver and Employee as relations.
    '// UserRow#caregiver :: CaregiverRow',
    '// UserRow#employee :: EmployeeRow',
    '// EmployeeRow#department :: DepartmentRow',

    // Constructor-callable overloads (Table T + callable form), mirroring sqlkit.
    '// User       :: Table UserRow',
    '// User       :: [UserSelector] -> QueryTag p (Picked UserRow UserSelector)',
    '// Caregiver  :: Table CaregiverRow',
    '// Caregiver  :: [CaregiverSelector] -> QueryTag p (Picked CaregiverRow CaregiverSelector)',
    '// Employee   :: Table EmployeeRow',
    '// Employee   :: [EmployeeSelector] -> QueryTag p (Picked EmployeeRow EmployeeSelector)',
    '// Department :: Table DepartmentRow',
    '// Department :: [DepartmentSelector] -> QueryTag p (Picked DepartmentRow DepartmentSelector)',

    '// unsafe :: a',
    'const unsafe = null;',
    'const User       = unsafe;',
    'const Caregiver  = unsafe;',
    'const Employee   = unsafe;',
    'const Department = unsafe;',
    '',
  ].join('\n');

  test('User(["id", Caregiver, Employee([Department])]) — both ARE relations', () => {
    const r = inferSource(SCHEMA + 'const q = User(["id", Caregiver, Employee([Department])]);\n');
    const errs = r.diagnostics.filter(d =>
      / is not a valid relation here\b/.test(d.message) ||
      / has no relation with /.test(d.message) ||
      /Cannot unify/.test(d.message),
    );
    if (errs.length > 0) {
      // eslint-disable-next-line no-console
      console.log('relation diagnostics:', errs.map(e => `${e.start}-${e.end}: ${e.message}`));
    }
    expect(errs).toEqual([]);
  });
});
