/**
 * Regression: `expandAliases` with a per-pass `AliasExpansionMemo`
 * must (a) produce results structurally equal to an unmemoised
 * expansion and (b) keep per-use-site TVar freshening — so that
 * different call sites receive disjoint TVar IDs even when both go
 * through the cache.  Without (b), `Location([sel1, sel2])` would
 * unify the two elements' free `a`s and corrupt downstream
 * inference.
 */

import { expandAliases, AliasExpansionMemo } from '../../src/infer/annotations';
import { Type, tCon, tVar, T_UNION, collectVarNames } from '../../src/hm/types';

function freeVarIds(t: Type): Set<number> {
  const ids = new Map<number, string>();
  collectVarNames(t, ids);
  return new Set(ids.keys());
}

describe('expandAliases memoisation', () => {
  test('memoised result is structurally equal to unmemoised', () => {
    // Sel :: (String | Prop a | QueryTag a)
    const aliases = new Map<string, Type>();
    aliases.set('Sel', tCon(T_UNION, [
      tCon('String', []),
      tCon('Prop', [tVar('a')]),
      tCon('QueryTag', [tVar('a')]),
    ]));
    const aliasVars = new Map<string, string[]>();

    const t = tCon('List', [tCon('Sel', [])]);

    const baseline = expandAliases(aliases, t, undefined, aliasVars);
    const memo: AliasExpansionMemo = new Map();
    const memoised1 = expandAliases(aliases, t, undefined, aliasVars, memo);
    const memoised2 = expandAliases(aliases, t, undefined, aliasVars, memo);

    // Compare structure ignoring per-call fresh TVar ids/names.
    const norm = (x: Type) => JSON.stringify(x, (k, v) => {
      if (k === 'id') return '_';
      if (v && typeof v === 'object' && v.tag === 'TVar') {
        return { tag: 'TVar', id: '_', name: '_' };
      }
      return v;
    });

    expect(norm(memoised1)).toBe(norm(baseline));
    expect(norm(memoised2)).toBe(norm(baseline));
  });

  test('per-use-site TVar freshening is preserved across memo hits', () => {
    const aliases = new Map<string, Type>();
    aliases.set('Sel', tCon(T_UNION, [
      tCon('String', []),
      tCon('Prop', [tVar('a')]),
    ]));
    const aliasVars = new Map<string, string[]>();

    const memo: AliasExpansionMemo = new Map();
    const call1 = expandAliases(aliases, tCon('Sel', []), undefined, aliasVars, memo);
    const call2 = expandAliases(aliases, tCon('Sel', []), undefined, aliasVars, memo);

    const ids1 = freeVarIds(call1);
    const ids2 = freeVarIds(call2);

    expect(ids1.size).toBeGreaterThan(0);
    expect(ids2.size).toBeGreaterThan(0);
    // No shared IDs — both calls must produce independent fresh TVars.
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
  });

  test('per-use-site freshening also holds for bare alias with declared vars', () => {
    // GenericSel :: (Prop tag | QueryTag tag), declared vars [tag]
    const aliases = new Map<string, Type>();
    aliases.set('GenericSel', tCon(T_UNION, [
      tCon('Prop', [tVar('tag')]),
      tCon('QueryTag', [tVar('tag')]),
    ]));
    const aliasVars = new Map<string, string[]>([['GenericSel', ['tag']]]);

    const memo: AliasExpansionMemo = new Map();
    const call1 = expandAliases(aliases, tCon('GenericSel', []), undefined, aliasVars, memo);
    const call2 = expandAliases(aliases, tCon('GenericSel', []), undefined, aliasVars, memo);

    const ids1 = freeVarIds(call1);
    const ids2 = freeVarIds(call2);

    expect(ids1.size).toBeGreaterThan(0);
    expect(ids2.size).toBeGreaterThan(0);
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
  });
});
