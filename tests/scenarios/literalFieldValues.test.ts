// A string literal in an object field meets the field's literal union.
//
// `paint ("succes")` against `Intent :: "none" | "primary" | …` was already
// a typo; the same literal as a field value (`{ intent: "succes" }`, and so
// every JSX attribute `intent="succes"`) was typed as a plain `String` and
// accepted.  A string literal field value now gets the expected field type
// (aliases expanded, also inside `Intent | Undefined`), like a literal
// argument.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function errors(src: string): string[] {
  return new InferenceEngine().infer(src).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

const KIT = `
// Intent :: "none" | "primary" | "success" | "warning" | "danger"
// TagProps :: { intent :: Intent | Undefined, minimal :: Boolean | Undefined, children :: String }

// Tag :: TagProps -> ReactElement
const Tag = ({ intent, children }) => <span className={intent}>{children}</span>;

// toastOf :: { message :: String, intent :: Intent } -> String
const toastOf = t => t.message;
`;

describe('string literals in object fields', () => {
  test('a listed literal is accepted, in a record and as a JSX attribute', () => {
    expect(errors(KIT + `
// saved :: String
const saved = toastOf ({ message: "Opgeslagen", intent: "success" });

// Status :: { done :: Boolean } -> ReactElement
const Status = ({ done }) => <Tag intent="success" minimal>{done ? "klaar" : "bezig"}</Tag>;
`)).toEqual([]);
  });

  test('an optional literal field may be left out', () => {
    expect(errors(KIT + `
// Plain :: { label :: String } -> ReactElement
const Plain = ({ label }) => <Tag>{label}</Tag>;
`)).toEqual([]);
  });

  test('a typo in a record field is rejected', () => {
    expect(errors(KIT + `
// failed :: String
const failed = toastOf ({ message: "Mislukt", intent: "dangr" });
`).some(m => m.includes("'dangr'"))).toBe(true);
  });

  test('a typo in a JSX attribute is rejected', () => {
    expect(errors(KIT + `
// Status :: { done :: Boolean } -> ReactElement
const Status = ({ done }) => <Tag intent="succes">{done ? "klaar" : "bezig"}</Tag>;
`).some(m => m.includes("'succes'"))).toBe(true);
  });
});
