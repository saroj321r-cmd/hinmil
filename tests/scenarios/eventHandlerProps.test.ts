// Event handlers and DOM attributes on components, as TypeScript treats
// them:
//
//  - a callback in a `… -> ()` slot may return a value: the result is
//    ignored (`onClick={() => dispatch (saved ())}`).  Before, the returned
//    action was a mismatch with `()`.  A function with its OWN annotation
//    `-> ()` that returns a value is still an error;
//  - an attribute with a hyphen (`aria-label`, `data-testid`) is not checked
//    against the component's props (a props type cannot name it; the
//    component passes it on to its DOM element).  Before, a closed props
//    type gave HM1010 "Unknown field 'aria-label'".  Its value is still
//    typed, and a misspelled ordinary prop is still reported.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function errors(src: string): string[] {
  return new InferenceEngine().infer(src).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

const KIT = `
// MouseEvent :: { preventDefault :: () -> (), stopPropagation :: () -> () }
// ButtonProps :: { text :: String, onClick :: (MouseEvent -> ()) | Undefined, disabled :: Boolean | Undefined }

// Button :: ButtonProps -> ReactElement
const Button = ({ text, onClick }) => <button onClick={onClick}>{text}</button>;

// Action :: { type :: String }

// dispatch :: Action -> Action
const dispatch = action => action;
`;

describe('a callback in a `-> ()` slot', () => {
  test('may return a value (a dispatched action)', () => {
    expect(errors(KIT + `
// Save :: () -> ReactElement
const Save = () => <Button onClick={() => dispatch ({ type: "save" })} text="Opslaan" />;
`)).toEqual([]);
  });

  test('also as a plain callback argument', () => {
    expect(errors(KIT + `
// each :: ((Number -> ()), [Number]) -> ()
const each = (f, xs) => { xs.forEach (f); };

// logAll :: [Number] -> ()
const logAll = xs => each (x => dispatch ({ type: String (x) }), xs);
`)).toEqual([]);
  });

  test('an annotated function returning a value is still an error', () => {
    expect(errors(KIT + `
// clear :: () -> ()
const clear = () => dispatch ({ type: "clear" });
`).length).toBeGreaterThan(0);
  });
});

describe('attributes with a hyphen on a component', () => {
  test('aria-label and data-testid are accepted', () => {
    expect(errors(KIT + `
// Close :: () -> ReactElement
const Close = () => <Button aria-label="sluiten" data-testid="close" text="×" />;
`)).toEqual([]);
  });

  test('their value is still typed', () => {
    expect(errors(KIT + `
// Close :: () -> ReactElement
const Close = () => <Button aria-label={labelOf ("x")} text="×" />;
`).some(m => m.includes('labelOf'))).toBe(true);
  });

  test('a misspelled ordinary prop is still reported', () => {
    expect(errors(KIT + `
// Close :: () -> ReactElement
const Close = () => <Button disabeld text="×" />;
`).some(m => m.includes("'disabeld'"))).toBe(true);
  });
});
