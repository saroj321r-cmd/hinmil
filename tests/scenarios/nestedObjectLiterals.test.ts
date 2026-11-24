// A nested object literal gets the expected field type.
//
// An object literal argument is inferred against the parameter type, so its
// callbacks get their parameter types (and may ignore trailing ones) and
// its string literals meet a literal union.  An object literal one level
// deeper, as the value of a field (`drawerProps={{ … }}`), was inferred
// without that type: `onClose: () => close ()` became `() -> ()` against
// `MouseEvent -> ()`, and `position: "left"` a plain `String`.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function errors(src: string): string[] {
  return new InferenceEngine().infer(src).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

const KIT = `
// MouseEvent :: { preventDefault :: () -> () }
// DrawerProps :: { isOpen :: Boolean | Undefined, position :: "top" | "bottom" | "left" | "right" | Undefined, onClose :: (MouseEvent -> ()) | Undefined }
// SideBarProps :: { title :: String, drawerProps :: DrawerProps }

// SideBar :: SideBarProps -> ReactElement
const SideBar = ({ title }) => <nav>{title}</nav>;

// close :: () -> ()
const close = () => {};
`;

describe('object literals inside object literals', () => {
  test('a nested callback may ignore its event, a nested literal is listed', () => {
    expect(errors(KIT + `
// Menu :: { open :: Boolean } -> ReactElement
const Menu = ({ open }) => <SideBar drawerProps={{ isOpen: open, position: "left", onClose: () => close () }} title="Planner" />;
`)).toEqual([]);
  });

  test('also in a plain call', () => {
    expect(errors(KIT + `
// settings :: Boolean -> SideBarProps
const settings = open => ({ title: "Planner", drawerProps: { isOpen: open, position: "right", onClose: () => close () } });
`)).toEqual([]);
  });

  test('a typo in a nested literal is rejected', () => {
    expect(errors(KIT + `
// Menu :: { open :: Boolean } -> ReactElement
const Menu = ({ open }) => <SideBar drawerProps={{ isOpen: open, position: "lefft" }} title="Planner" />;
`).some(m => m.includes("'lefft'"))).toBe(true);
  });
});
