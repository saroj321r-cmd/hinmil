// LSP rename handlers (src/services/rename.ts): provideReferences,
// providePrepareRename and provideRename, exercised end-to-end on real
// inference results — a realistic annotated module where a binding has an
// HM annotation comment that must be renamed along with the identifiers.

import { ReferenceParams, PrepareRenameParams, RenameParams } from 'vscode-languageserver/node';
import {
  provideReferences,
  providePrepareRename,
  provideRename,
} from '../../src/services/rename';
import { inferSource } from '../helpers/infer';
import { makeDoc, TEST_URI } from '../helpers/lsp';

// A small realistic module: annotated function + several usages.
const SOURCE = [
  '// double :: Number -> Number',
  'const double = x => x * 2;',
  'const a = double(2);',
  'const b = double(a);',
  'const shadow = () => { const double = 1; return double; };',
].join('\n');

const doc = makeDoc(SOURCE);
const result = inferSource(SOURCE);

/** Position of the nth occurrence of `needle` (0-based), as an LSP Position. */
function positionOf(needle: string, nth = 0): { line: number; character: number } {
  let idx = -1;
  for (let i = 0; i <= nth; i++) idx = SOURCE.indexOf(needle, idx + 1);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  return doc.positionAt(idx);
}

function refParams(pos: { line: number; character: number }, includeDeclaration: boolean): ReferenceParams {
  return {
    textDocument: { uri: TEST_URI },
    position: pos,
    context: { includeDeclaration },
  };
}

describe('provideReferences', () => {
  test('finds declaration + all usages of a top-level binding', () => {
    // `const double` declaration is on line 1 (0-based), after the annotation.
    const locs = provideReferences(doc, refParams(positionOf('double', 1), true), result);
    // declaration + 2 call sites (the shadowed inner binding is separate)
    expect(locs).toHaveLength(3);
    expect(locs.every(l => l.uri === TEST_URI)).toBe(true);
  });

  test('excludes the declaration when includeDeclaration is false', () => {
    const locs = provideReferences(doc, refParams(positionOf('double', 1), false), result);
    expect(locs).toHaveLength(2);
    // Both remaining references are call sites on lines 2 and 3.
    expect(locs.map(l => l.range.start.line).sort()).toEqual([2, 3]);
  });

  test('a shadowing inner binding forms its own reference group', () => {
    // Position on the inner `double` declared inside the arrow body.
    const locs = provideReferences(doc, refParams(positionOf('double = 1'), true), result);
    expect(locs).toHaveLength(2); // inner declaration + inner return usage
    expect(locs.every(l => l.range.start.line === 4)).toBe(true);
  });

  test('returns [] when the cursor is not on an identifier', () => {
    const locs = provideReferences(doc, refParams(positionOf('=>'), true), result);
    expect(locs).toEqual([]);
  });
});

describe('providePrepareRename', () => {
  test('returns range + placeholder on a renameable identifier', () => {
    const prep = providePrepareRename(
      doc,
      { textDocument: { uri: TEST_URI }, position: positionOf('double', 2) } as PrepareRenameParams,
      result,
    );
    expect(prep).not.toBeNull();
    expect(prep!.placeholder).toBe('double');
    const { start, end } = prep!.range;
    expect(SOURCE.slice(doc.offsetAt(start), doc.offsetAt(end))).toBe('double');
  });

  test('returns null when the cursor is not on an identifier', () => {
    const prep = providePrepareRename(
      doc,
      { textDocument: { uri: TEST_URI }, position: positionOf('=>') } as PrepareRenameParams,
      result,
    );
    expect(prep).toBeNull();
  });
});

describe('provideRename', () => {
  function rename(pos: { line: number; character: number }, newName: string) {
    return provideRename(
      doc,
      { textDocument: { uri: TEST_URI }, position: pos, newName } as RenameParams,
      result,
    );
  }

  test('renames every occurrence plus the HM annotation name', () => {
    const edit = rename(positionOf('double', 1), 'twice');
    expect(edit).not.toBeNull();
    const edits = edit!.changes![TEST_URI];
    // 3 identifier occurrences + 1 annotation-comment name
    expect(edits).toHaveLength(4);
    expect(edits.every(e => e.newText === 'twice')).toBe(true);
    // One edit must target the annotation comment on line 0.
    expect(edits.some(e => e.range.start.line === 0)).toBe(true);
  });

  test('renaming the shadowed inner binding keeps identifier edits on the inner scope', () => {
    const edit = rename(positionOf('double = 1'), 'inner');
    const edits = edit!.changes![TEST_URI];
    // Two identifier occurrences inside the arrow body…
    const identifierEdits = edits.filter(e => e.range.start.line === 4);
    expect(identifierEdits).toHaveLength(2);
    // …plus the annotation-comment edit: annotation lookup is name-based,
    // so the `// double :: …` header is (currently) retargeted as well.
    expect(edits).toHaveLength(3);
  });

  test('returns null when the cursor is not on an identifier', () => {
    expect(rename(positionOf('=>'), 'x')).toBeNull();
  });
});
