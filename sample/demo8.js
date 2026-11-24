// ============================================================================
// demo8.js — Three ways to express multi-shaped constructor arguments
// ============================================================================
//
//   • Option A: inline structural-union constraint in a single annotation
//   • Option B: multiple `Name :: ...` overloads merged into a Union scheme
//   • Option C: nominal `::constraint Name p1 ... pN = self is body` directive
//
// Hover any binding below to see the inferred type. All three substitute
// inner type variables precisely.

// ============================================================================
// OPTION A — inline structural-union constraint
// ============================================================================
//
// One annotation, one type variable (`run`), constrained to one of two
// alternative shapes. The lowercase `a` inside the function alternative
// is a fresh per-instantiation variable, so passing a function with
// known argument type substitutes it precisely.

// LimitA :: ((a -> Number) | Number) run => run -> LimitA run
const LimitA = (x) => x;

// getLimit :: { limit :: Number } -> Number
const getLimit = p => p.limit;

const a1 = LimitA(5);
//    ^ a1 :: LimitA Number

const a2 = LimitA(getLimit);
//    ^ a2 :: LimitA ({ limit :: Number } -> Number)
//      Note how `a` was substituted by the actual record shape.

// const a3 = LimitA("nope");
// Removing the comment above triggers:
//   Type 'String' does not satisfy union constraint '((a -> Number) | Number)'

// ----------------------------------------------------------------------------
// Option A combined with a nominal `::constraint` definition.
// ----------------------------------------------------------------------------
// `::constraint` is the existing nominal type-class mechanism. It works
// orthogonally to the union-constraint syntax — both can appear in the
// same file (and, if needed, in the same scheme as comma-separated
// constraints).

// ::constraint Showable s { s :: { toString :: s ~> () -> String } }

// renderLimit :: Showable s => LimitA s -> String
const renderLimit = (l) => "[Limit] " + l.toString();

// LimitA registers `toString` to satisfy `Showable`:
// LimitA#toString :: LimitA r ~> () -> String
LimitA.prototype.toString = function () { return "limit"; };

const text = renderLimit(a1);
//    ^ text :: String  (Showable LimitA satisfied via toString registration)

// ============================================================================
// OPTION B — multiple overloads (Union scheme)
// ============================================================================
//
// Each `Name :: ...` line registers an overload. The engine merges them
// into a Union scheme. At each call site the first matching branch wins
// and its substitution propagates correctly to the result type.

// LimitB :: (a -> Number) -> LimitB (a -> Number)
// LimitB :: Number -> LimitB Number
const LimitB = (x) => x;

const b1 = LimitB(5);
//    ^ b1 :: LimitB Number   (second branch matched)

const b2 = LimitB(getLimit);
//    ^ b2 :: LimitB ({ limit :: Number } -> Number)
//      First branch matched; `a` substituted from getLimit's parameter type.

// ============================================================================
// OPTION C — nominal structural constraint
//             (`::constraint Name p1 ... pN = self is body [, ...]`)
// ============================================================================
//
// A reusable, named version of Option A. Each `::constraint` definition
// declares its header parameters explicitly. The body is one or more
// `<self> is <type-expression>` clauses; `<self>` MUST be one of the
// header parameters. Free body variables that are NOT in the header are
// existential — every use-site instantiation gets fresh ids.
//
//   ::constraint Runnable r { r :: (a -> r) | r }
//                ^^^^^^^^ ^   ^      ^
//                name     |   |      existential `a`
//                         |   self type
//                         header param (also the self-type here)

// ::constraint Runnable r { r :: (a -> r) | r }

// LimitC :: Runnable r => r -> r
const LimitC = (x) => x;

const c1 = LimitC(5);
//    ^ c1 :: Number

const c2 = LimitC(getLimit);
//    ^ c2 :: { limit :: Number } -> Number
//      Existential `a` was instantiated with the actual record shape.

// A second use site shows that `a` is freshly instantiated each time.
// pickShape :: Runnable r => r -> r
const pickShape = x => x;

const c3 = pickShape(42);
//    ^ c3 :: Number

// ----------------------------------------------------------------------------
// Concrete-type self-arg: `Runnable Number =>`
// ----------------------------------------------------------------------------
// The use site may supply a concrete type for the self-position instead
// of a bound variable. The body is then checked eagerly at the annotation
// site — no use-site polymorphism, immediate diagnostic on mismatch.

// runNumber :: Runnable Number => Number -> Number
const runNumber = (x) => x;

const c4 = runNumber(7);
//    ^ c4 :: Number  (Runnable Number satisfied by the bare-`r` alternative)

// Note: with `Runnable r = r is (a -> r) | r` the bare `r` alternative
// makes every type satisfy the constraint. To see a constraint failure,
// define a stricter structural body — see `NumLike` below.

// ::constraint NumLike a r { r :: (a -> Number) | Number }

// runNum :: NumLike a Number => Number -> Number
const runNum = (x) => x;
//    ^ NumLike a Number satisfied (Number matches the second alternative;
//      `a` is bound at the use site as a fresh existential).

// const runStr = x => x;
// // runStr :: NumLike a String => String -> String
// Removing the comments above triggers:
//   Type 'String' does not satisfy constraint 'NumLike'

// ----------------------------------------------------------------------------
// Multi-param header (positional concrete + bound var): `NumLike String r =>`
// ----------------------------------------------------------------------------
// `NumLike a r` declares two header parameters, so use sites supply two
// positional arguments. Either may be a concrete type or a use-site var.
//
//   ::constraint NumLike a r { r :: (a -> Number) | Number }
//                        ^ ^      ^
//                        | self   self-clause body
//                        extra header param
//
//   firstNum has annotation `NumLike String r => r -> r`,
//   meaning a := String, r still bound at use site.

// firstNum :: NumLike String r => r -> r
const firstNum = (x) => x;

const c5 = firstNum(7);
//    ^ c5 :: Number  (matches the second alternative)

// strLen :: String -> Number
const strLen = (s) => s.length;

const c6 = firstNum(strLen);
//    ^ c6 :: String -> Number  (matches the first alternative; a := String)

// const c7 = firstNum((b) => b ? 1 : 0);
// Removing the comment above triggers:
//   Type 'Boolean -> Number' does not satisfy union constraint 'NumLike'
//   (Boolean → String mismatch in the first alternative; the second
//    alternative `Number` doesn't match a function either.)

// ----------------------------------------------------------------------------
// Multiple self-clauses: `r is ... , s is ...`
// ----------------------------------------------------------------------------
// The body may contain MORE than one `<self> is <body>` clause, separated
// by `,`. Each clause is checked independently. Multi-line layout uses
// leading commas, mirroring Haskell record/where conventions.

// ::constraint Pair a b { a :: String | Number, b :: Boolean | Number }

// pairCheck :: Pair String Number => String -> Number
const pairCheck = (s) => s.length;

const c8 = pairCheck("hello");
//    ^ c8 :: Number
//      Clause 1: a := String matches `String | Number` ✓
//      Clause 2: b := Number matches `Boolean | Number` ✓

// const c9 = pairCheck;  // with annotation `Pair Boolean Number => ...`
// would trigger:
//   Type 'Boolean' does not satisfy constraint 'Pair'
//   (Boolean is in neither alternative of the first clause.)

// ============================================================================
// When to pick which?
// ============================================================================
//
//   Option A      ── one line, shared TVar in the result skeleton,
//                    single use, no external name needed.
//
//   Option B      ── different result shapes per branch,
//                    different arity per branch,
//                    or when you want to document each branch independently.
//
//   Option C      ── reusable structural constraint, multiple annotations
//                    referring to the same `Name`. Header parameters are
//                    explicit; free body vars are existential. One or more
//                    `<self> is <body>` clauses per definition.
