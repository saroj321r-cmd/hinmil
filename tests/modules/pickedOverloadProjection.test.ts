// Regression: a call through an OVERLOADED-constructor union (the sqlkit
// codegen shape — a Tables-record field typed
//   `({ props :: … } | Table R | ([RSelector p] -> QueryTag p (Picked R RSelector)))`)
// returns via `tryInferOverloadedCall`, which used to skip the main call
// path's `applyPickedProjection` post-processing hook.  The raw
// `Picked R Sel` marker then leaked into the binding's type:
//
//   • direct property access only "worked" through the permissive
//     unknown-TCon fallback (silently yielding a fresh TVar), and
//   • `QueryTag#concat`-style combinators typed with `Merge r1 r2`
//     produced a union of two unprojected `Picked R Sel` markers, on
//     which property access errored with
//     "Property 'id' does not exist on types 'Picked …', 'Picked …' in union".
//
// The fix applies `applyPickedProjection` + `applyMergeReduction` to the
// overload result as well, so bound tags carry the projected record and
// Merge collapses structurally.
import { TempProject } from '../helpers/project';
import { typeToString } from '../../src/hm/types';

describe('Picked projection through overloaded-constructor calls', () => {
  const project = new TempProject('picked-overload-projection');

  beforeAll(() => {
    project.setup();
    project.write('node_modules/sqlkit/package.json', JSON.stringify({
      name: 'sqlkit', main: 'index.js',
      'hinmil': { sidecars: ['./sqlkit.hm'] },
    }));
    project.write('node_modules/sqlkit/index.js', [
      'exports.mkTables = () => ({ public: { User: (xs) => null } });',
    ].join('\n'));
    project.write('node_modules/sqlkit/sqlkit.hm', [
      'UserRow :: {',
      '  id :: Number,',
      '  name :: String',
      '}',
      'UserTag :: "user"',
      'Prop :: (String, a) -> Prop t a p',
      'Limit :: ((p -> Number) | Number) -> Limit p',
      'Offset :: ((p -> Number) | Number) -> Offset p',
      'GenericSelector :: (Limit p | Offset p | Prop tag a p | SQLTag p o)',
      'UserSelector :: GenericSelector p UserTag',
      "::extend UserSelector 'id' | 'name'",
      'Tables :: { public :: {',
      '  User :: ({ props :: { id :: Prop UserTag Number p, name :: Prop UserTag String p } } | Table UserRow | ([UserSelector p] -> QueryTag p (Picked UserRow UserSelector)))',
      '} }',
      'mkTables :: () -> Tables',
      'QueryTag :: (a, b) -> QueryTag a b',
      'QueryTag() :: p -> Promise e [o]',
      'QueryTag#concat :: QueryTag p1 r1 ~> QueryTag p2 r2 -> QueryTag (Merge p1 p2) (Merge r1 r2)',
    ].join('\n'));
    // Local module boundary mirroring the real-world chain: the consumer
    // gets `tables` from a project file that itself imports the package.
    project.write('db.js', [
      '// ::types sqlkit',
      'import { mkTables } from "sqlkit";',
      'export const tables = mkTables ();',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('bound tag through the overload path carries the projected record', () => {
    project.write('c0.js', [
      '// ::types sqlkit',
      'import { tables } from "./db.js";',
      'const { User } = tables.public;',
      'const a = User(["id"]);',
      'const out = a;',
    ].join('\n'));
    const r = project.inferFile('c0.js');
    expect(r.diagnostics).toEqual([]);
    const ts = typeToString(r.type);
    expect(ts).toContain('id :: Number');
    expect(ts).not.toContain('Picked');
  });

  test('direct call + property access resolves the real column type', () => {
    project.write('c1.js', [
      '// ::types sqlkit',
      'import { tables } from "./db.js";',
      'const { User } = tables.public;',
      'const a = User(["id"]);',
      'const out = a({}).then(rows => rows[0].id);',
    ].join('\n'));
    const r = project.inferFile('c1.js');
    expect(r.diagnostics).toEqual([]);
    // Not the permissive-TVar fallback: the column type must be concrete.
    expect(typeToString(r.type)).toContain('Number');
  });

  test('concat of two bound tags merges the projected records', () => {
    project.write('c2.js', [
      '// ::types sqlkit',
      'import { tables } from "./db.js";',
      'const { User } = tables.public;',
      'const a = User(["id"]);',
      'const b = User(["name"]);',
      'const q = a.concat(b);',
      'const out = q({}).then(rows => rows[0].id);',
    ].join('\n'));
    const r = project.inferFile('c2.js');
    expect(r.diagnostics).toEqual([]);
    expect(typeToString(r.type)).toContain('Number');
  });
});
