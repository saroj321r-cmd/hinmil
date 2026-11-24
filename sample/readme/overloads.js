import { curry } from '../common';
// ============================================
// Overloads — multiple `Name :: ...` annotations
// ============================================
//
// When the same name is annotated more than once, hinmil treats the
// declarations as call-overloads.  At a call site the engine picks the
// branch whose argument types match; in hover/signature help every
// branch is surfaced so the reader can see all available shapes.

// add :: (Number, Number) -> Number
// add :: (String, String) -> String
const add = (a, b) => a + b;

const sumOfTwo = add (1, 2);
const concat   = add ("foo", "bar");

const curriedAdd = curry(add)

// curriedAddInline :: Number -> Number -> Number
// curriedAddInline :: String -> String -> String
const curriedAddInline = curry((a, b) => a + b)

const sumOfTwoInline = curriedAddInline (1, 2);
const concatInline   = curriedAddInline("two", "two");

// ============================================
// Constructor-as-callable overloads
// ============================================
//
// An uppercase name may be declared BOTH as a bare type
// (Tag :: a — used for the type of values returned by other functions)
// AND as a callable form (Tag :: a -> Wrapped a).  Calling a value
// whose inferred type is Tag a then resolves through the callable
// overload — even with zero arguments.

// Wrapped :: a
// Tag :: a -> Tag a
// Tag() :: a -> Wrapped a

// makeTag :: a -> Tag a
const makeTag = (x) => ({ value: x });

const tagged  = makeTag (42);
const wrapped = tagged ("re-tag");

// Hovering `tagged` shows two lines:  the inferred TCon type
// (Tag Number), followed by the callable overload rendered under the
// binding's own name — `tagged :: a -> Wrapped a` — so the signature
// reads as the value's own contract rather than the constructor's.

// ============================================
// Multiple callable overloads
// ============================================
//
// Box can be invoked with a Number OR with a String.  Both branches
// show up in hover and in signature help.

// Box :: a -> Box a
// Box() :: Number -> String
// Box() :: String -> String

// pack :: a -> Box a
const pack = (x) => ({ inner: x });

const boxed       = pack (1);
const numberLabel = boxed (7);
const stringLabel = boxed ("seven");
