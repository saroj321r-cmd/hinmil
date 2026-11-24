// Block comments mix prose and annotations.  An HM annotation inside a block
// comment must START A PARAGRAPH (first non-empty line of the block, or the
// line after a blank / bare-`*` line), and its continuation ends at the next
// blank line.  Otherwise developer notes that merely quote a type — like the
// question left in the app's `server/src/lib/rtask.js` — were parsed as real
// annotations ("HM2001 Invalid type annotation for 'RTask': Unexpected
// trailing token") and glued the following prose onto the signature.

import { extractAnnotations } from '../../src/commentParser';

const names = (src: string) => extractAnnotations(src).map(a => [a.name, a.raw]);

describe('block comment annotations must start a paragraph', () => {
  test('a quoted type inside a prose paragraph is not an annotation (app rtask.js notes)', () => {
    const src = [
      '/*',
      '  vraag 2:',
      '    - import {RTask} from "fpkit" resulteert in RTask :: Any. je hebt een sidecar gemaakt',
      '      namelijk:',
      '        RTask :: {',
      '          of :: a -> RTask r e a,',
      '          reject :: e2 -> RTask r2 e2 a2',
      '        } al de numerieke ophoging is overbodig,',
      '*/',
      'export const fromPromiseFn = f => f;',
    ].join('\n');
    expect(names(src)).toEqual([]);
  });

  test('JSDoc description paragraph followed by an annotation paragraph still works (fpkit fl/traverse.js)', () => {
    const src = [
      '/**',
      ' * For more info:',
      ' * https://github.com/sanctuary-js/sanctuary-type-classes/pull/19',
      ' *',
      ' * Array#traverse :: Applicative f',
      ' *                   => Array a ~> TypeRep f -> (a -> f b) -> f (Array b)',
      ' */',
      'natives.Array = function (typeRep) { return fn => fn; };',
    ].join('\n');
    expect(names(src)).toEqual([
      ['Array#traverse', 'Applicative f => Array a ~> TypeRep f -> (a -> f b) -> f (Array b)'],
    ]);
  });

  test('annotation on the first line of the block keeps its multi-line continuation', () => {
    const src = [
      '/*',
      '  fromPromise :: (a -> Promise e b)',
      '              -> a -> RTask r e b',
      '*/',
      'const fromPromise = f => f;',
    ].join('\n');
    expect(names(src)).toEqual([
      ['fromPromise', '(a -> Promise e b) -> a -> RTask r e b'],
    ]);
  });

  test('prose after a blank line is not appended to the signature', () => {
    const src = [
      '/**',
      ' * withEnv :: (r -> Promise e a) -> RTask r e a',
      ' *',
      ' * Runs a promise function with the RTask environment as its argument.',
      ' */',
      'const withEnv = fn => fn;',
    ].join('\n');
    expect(names(src)).toEqual([
      ['withEnv', '(r -> Promise e a) -> RTask r e a'],
    ]);
  });
});
