// Tests for diagnostics 4a/4b — bare-TVar value annotations on uppercase
// names.  An uppercase value binding annotated as `Tag :: a` makes `Tag`
// usable as ANY type (an unconstrained type variable), which is unsound
// for a name that is also used as a type constructor.  These tests cover:
//
//   4a — warning on the `Tag :: a` annotation itself
//   4b — warning on every `Tag#method` annotation that presupposes Tag
//        is a real type constructor
//   suppression — both warnings disappear when a constructor branch
//        (`Tag :: a -> Tag a`) is also declared

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

describe('Bare-TVar value annotation diagnostics', () => {
  test('4a: `Tag :: a` produces a warning suggesting a constructor form', () => {
    const r = engine.infer(`
// Tag :: a
const Tag = {};
    `);
    const msg = r.diagnostics.find(d => d.message.includes("'Tag' is annotated as an unconstrained type variable"));
    expect(msg).toBeDefined();
    expect(msg!.message).toContain("Did you mean a constructor signature like 'a -> Tag a'?");
  });

  test('4a: warning text never uses the word "forall"', () => {
    const r = engine.infer(`
// Tag :: a
const Tag = {};
    `);
    for (const d of r.diagnostics) {
      expect(d.message.toLowerCase()).not.toContain('forall');
    }
  });

  test('4b: `Tag#foo` triggers a warning when `Tag :: a` is also declared', () => {
    const r = engine.infer(`
// Tag :: a
// Tag#foo :: Tag a ~> () -> a
const Tag = {};
    `);
    const msg = r.diagnostics.find(d =>
      d.message.includes("Method 'Tag#foo'") &&
      d.message.includes("annotates 'Tag' as a plain type variable rather than a type constructor")
    );
    expect(msg).toBeDefined();
  });

  test('4a + 4b are suppressed when a constructor branch is also declared', () => {
    const r = engine.infer(`
// Tag :: a -> Tag a
// Tag#foo :: Tag a ~> () -> a
const Tag = (x) => ({ value: x });
    `);
    expect(r.diagnostics.find(d => d.message.includes('annotated as an unconstrained type variable'))).toBeUndefined();
    expect(r.diagnostics.find(d => d.message.includes('as a plain type variable rather than a type constructor'))).toBeUndefined();
  });

  test('lowercase `tag :: a` is NOT flagged (only uppercase value bindings)', () => {
    const r = engine.infer(`
// tag :: a
const tag = {};
    `);
    expect(r.diagnostics.find(d => d.message.includes('annotated as an unconstrained type variable'))).toBeUndefined();
  });
});
