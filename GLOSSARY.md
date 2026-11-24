# Glossary — Plain-Language Guide to the Words Used in This Codebase

This project is a *type checker* for JavaScript. Reading its code means running
into a lot of specialist jargon. This glossary explains every important term in
everyday language, so you can read the source code even if you have never
programmed before. Terms are ordered so that later entries build on earlier ones.

---

## The absolute basics

### Type
A *type* is the "kind of thing" a value is. `5` is a **Number**, `"hello"` is a
**String**, `true` is a **Boolean**. Think of types as labels on boxes: the label
tells you what is inside without opening the box.

### Type checker
A program that reads your code and checks that the labels match up. If a
function expects a Number and you hand it a String, the type checker warns you
*before* you run the program — like a spell checker, but for logic mistakes.

### Type inference
JavaScript code usually doesn't say what type anything is. *Inference* means
the checker figures the types out on its own by looking at how values are used.
If it sees `x + 1`, it can *infer* that `x` is probably a Number. This whole
project is one big inference machine.

### Hindley–Milner (HM)
The name of the classic recipe (algorithm) for type inference, invented by
Roger Hindley and Robin Milner. It is the "engine design" this project follows,
hence the project name **hinmil**. Its famous property: it can find the most
general correct type for a piece of code without any help.

### Annotation
A note the programmer writes in a comment to *tell* the checker a type instead
of letting it guess. In this project annotations look like:

```js
// add :: Number -> Number -> Number
const add = (a) => (b) => a + b;
```

The `::` reads as "has the type". Everything after it describes the type.

### Signature
The full type description of a function — its "job description". In
`Number -> Number -> Number` the arrows mean "takes a … and gives back a …".
So this reads: "takes a Number, then takes another Number, and gives back a
Number."

---

## How types are represented inside the program

The checker needs to store types in memory as data. Each flavour of type has
its own building block. Their names all start with a lowercase `t`:

### TVar — type variable (`tVar`)
A *placeholder* for a type we don't know yet, written as a letter like `a` or
`b`. Compare it to the `x` in school algebra: "some value, to be determined."
`Array a` means "an array of *something* — we don't know what yet, but every
element is the same something."

### TCon — type constructor (`tCon`)
A *named*, concrete type, possibly with sub-parts: `Number`, `String`,
`Array Number` ("array of numbers"), `Promise Error String` ("a promise that
will deliver a string, or fail with an Error"). The name "constructor" means it *constructs* a full type
out of the pieces you give it.

### TFun — function type (`tFun`)
The type of a function: "takes X, returns Y", stored as an arrow `X -> Y`.
A function with several parameters takes them as one *tuple*
(`(X, Y) -> Z`, see *Tuple* and *Tuple-applied*); a curried function is a
chain of single-parameter arrows (`X -> Y -> Z`, see *currying* below).

### TRecord — record type (`tRecord`)
The type of an object with named fields, e.g. `{ name :: String, age :: Number }`.
Think of a form with labelled boxes: the record type says which labels exist
and what may go in each box.

### Tuple
A fixed-length list where each position has its own type, used internally to
describe multi-parameter functions: `(Number, String) -> Boolean` means "takes
a Number *and* a String, gives back a Boolean."

### Union type
A type that says "one of these": `Number | String` means the value is *either*
a Number *or* a String. Like a train ticket that is valid on two different routes.

### TRow — row type (`tRow`)
An "open-ended" record: "it has *at least* these fields, and maybe more we
don't care about." Useful for functions that only need an object to have, say,
a `name` field, whatever else it carries. The "row" is the list of known fields
plus a placeholder for "the rest".

### Wildcard (`*`)
A type that matches absolutely anything, no questions asked. Used when the
author explicitly doesn't care.

---

## The core machinery

### Unification
The heart of the whole engine. *Unify* means: take two type descriptions and
try to make them identical by filling in placeholders. It is like solving a
small puzzle:

- Unify `Array a` with `Array Number` → success, and we learn `a = Number`.
- Unify `Number` with `String` → failure → the checker reports a type error.

Nearly every check in this project eventually becomes a unification question.
The code lives in `src/hm/unify.ts`.

### Substitution (`subst`)
The growing "answer sheet" of the puzzle: a table that records what each
placeholder turned out to be (`a = Number`, `b = String -> Boolean`, …).
*Applying* a substitution means going through a type and replacing every
placeholder with its answer. Code: `src/hm/substitution.ts`.

### Environment (`env`)
The checker's memory of "which names are currently in scope and what type does
each have" — like a phone book mapping names to types. Every `{ … }` block in
your code gets its own page that can override the previous one. Code:
`src/hm/env.ts`.

### Occurs check
A safety test during unification that prevents nonsense like `a = Array a`
("a box that contains itself"). Without it the checker could loop forever
describing an infinitely nested type.

### Fresh variable
A brand-new placeholder that has never been used before. The engine hands
these out with a counter (like a ticket machine at the bakery) so no two
placeholders ever collide by accident.

### Generalization / Scheme
When a definition is finished, its leftover placeholders get "sealed" into a
reusable template called a *type scheme*. `identity :: a -> a` is a template:
*each* place that uses `identity` gets its own fresh copy of `a`, so using it
with a Number in one place and a String elsewhere is fine.

### Instantiation
The opposite of generalization: taking the sealed template and stamping out a
fresh copy with new placeholders, ready to be filled in for one particular use.

### Rank-1 polymorphism / Let-generalization
"Rank-1" says *where* the "works for any type" promise may sit: only at the
very front of a signature, never inside a parameter. The sealing described
under *Generalization* happens the moment a `let`/`const` definition is
finished — hence "let-generalization". The practical limit: an *inferred*
function argument can never itself be polymorphic; it gets pinned to one type
the first time it is used. Higher-rank types give up automatic inference,
which is why they are opt-in here: see *Rank-N / forall* below and
TYPE-SYSTEM.md for the full story.

### Rank-N / `forall`
Writing `forall a.` explicitly in an annotation puts the "works for any type"
promise *inside* a parameter or record field:
`applyBoth :: (forall a. a -> a) -> ...` demands an argument that genuinely
works for every type. The engine never infers such a type — it only checks
against the ones you write. The check is *subsumption*: the annotation's
bound variables are skolemized (made untouchable) and the argument must
typecheck against them, failing with "Argument is not polymorphic enough".
A `forall`-bound type may also not leak into the call's result (*skolem
escape*, "Polymorphic value escapes its scope") — this is what makes the
`runST`/brand pattern safe.

### Skolem / Rigid type variable
When *checking* an annotation like `f :: a -> a`, the letter `a` is a promise:
"this works for **any** type the caller picks." To verify the promise, the
checker temporarily turns `a` into an untouchable, made-up type (a *skolem*)
that refuses to unify with anything concrete. If the function body secretly
treats `a` as, say, Number, unification against the skolem fails and the lie is
exposed. "Rigid" = not allowed to bend. Code: `src/infer/annotation-rigid.ts`.

### Parametricity
The guarantee that a "works for any type" promise is kept honestly: a function
typed `a -> a` may not peek at the value and do something special when it
happens to be a Number. In this project the rule also protects constraint
variables — a body checked against `Functor f => ...` may not secretly decide
that `f` is `Array`, even though Array *is* a Functor. Enforced with skolems
(see above).

### Currying
Splitting a multi-argument function into a chain of one-argument functions:
instead of `add(2, 3)` you can write `add(2)(3)` — `add(2)` returns a new
function still waiting for the second number. Classic HM systems represent
every function this way. HinMil does not: a function with several parameters
gets a tuple type (`(Number, Number) -> Number`, see *Tuple-applied*), and
only a function that really returns a function — `a => b => a * b` — gets a
chain of arrows: `Number -> Number -> Number`.

### Spread arrow chain (`...`)
A signature like `a -> b -> ... -> z`: a curried chain of *unknown length*,
where the `...` reads "zero or more parameters following this pattern". Used
to type variadic combinators (`pipe`, `compose`, `liftN`) that plain HM
cannot express. Special unification rules apply — see TYPE-SYSTEM.md.

### Narrowing
Getting more precise inside an `if`. If `x` is `Number | String` and the code
says `if (typeof x === "string")`, then *inside* that branch the checker
"narrows" x to just String. Like customs splitting one queue into two.
Code: `src/infer/narrowing.ts`.

### Constraint (type class)
A requirement attached to a placeholder: `Functor f => f a -> f b` reads "for
any container type `f` — *as long as `f` supports mapping* — …". The part
before `=>` is the constraint. Think of it as a membership card: any type may
apply, but it must prove it has the required abilities (methods).

### Higher-kinded type (HKT) / Kind variable (`$kv`)
A placeholder for a *container shape* rather than a plain type. In `f a`,
`f` might become Array, Promise, Maybe… — anything that wraps values. Because
that is unusual, the code encodes these as special names starting with `$kv:`.
"Kind" is the type-of-a-type: Number is a finished type; Array is a
type-*builder* that still needs one ingredient.

### Sum type / Variant
A type declared as a fixed menu of alternatives, e.g.
`Maybe a = Just a | Nothing` ("a Maybe is *either* a wrapped value *or*
nothing"). Each alternative is a *variant*. Declared here via the comment
shorthand `// Maybe :: Just a | Nothing` — no directive needed.

### Overload
One function name with several alternative signatures. The checker tries each
signature against the actual arguments and picks the one that fits.

### Row polymorphism
The formal name of the "open record" idea from TRow above: functions can
accept any object that has *at least* the required fields.

---

## Words for HinMil's own type features

These go beyond textbook Hindley–Milner. TYPE-SYSTEM.md explains the
reasoning behind each one.

### `Any`
The type of a value the checker cannot know anything about: an import from a
package without types, `globalThis`. `Any` fits everywhere and
everything fits it — a deliberate hole, like a blank on a form that the
reader is allowed to fill in any way. It never appears for code the checker
can actually see.

### Gradual typing
Letting typed and untyped code live side by side: unannotated code is checked
leniently (types are inferred, but the checker avoids reporting things nobody
promised), annotated code is checked strictly. Annotations can be added one
function at a time.

### Auto-union
What happens when unannotated code uses one placeholder at two types (a
helper called once with a Number and once with a String): instead of
reporting an error, the checker widens the placeholder to `Number | String`.
Annotated code does not get this leniency.

### Literal type (singleton)
A type with exactly one value: `'paid'` is the type of the text "paid" and
nothing else. A union of them (`'draft' | 'sent' | 'paid'`) lists the allowed
values, like the options of a drop-down list. Numbers can be literal types too
(`2`).

### Label variable
A placeholder for a *field name* instead of a type: in
`(k, { [k] :: a, ...r }) -> a`, `k` stands for whichever field the caller
names. A second sort of variable next to type variables.

### Type alias
A name for a type, written as an annotation without a declaration below it:
`// LineItem :: { description :: String, price :: Number }`. Aliases are
*nominal*: two aliases with the same fields are still different types.

### Nominal vs. structural
Two ways to decide whether types are the same. *Structural*: by their shape
(two records with the same fields match). *Nominal*: by their name (a
`Customer` is not a `Supplier`, even with the same fields). Records and
constraints are structural here; sum types, classes and aliases are nominal.

### Opaque type
A type whose inside the checker does not know, only its name and the
operations declared on it — for example `Observable a` from a library
without types, declared in a `.hm` file.

### Receiver (`~>`) / method / static
In `Box#map :: Box a ~> (a -> b) -> Box b`, the part before `~>` is the
*receiver*: the value before the dot in `box.map (f)`. `Type#name` declares a
*method* (on values of the type); `Type.name` declares a *static* (on the
type itself, like `Box.of`).

### Instance-callable
A value that can be called like a function, written `Type() :: …` — for
example a query object that runs when you call it. Declared separately from
the constructor (`Type :: …`), which *makes* such values.

### TypeRep
A value that stands for a type at runtime — passing `Array` or `Maybe` as an
argument so a function knows which container to build (`of (Array) (1)`).
`TypeRep f` connects that runtime argument to the higher-kinded placeholder
`f`.

### Constraint representative (`::rep`)
A directive saying "this method is how type T meets constraint C", e.g. that
`Array` is a `Monoid` through `Array.empty`. Lets built-in or library types
take part in constraints without changing them.

### Overload set
The alternatives of an overloaded function, kept in the order they were
written. A call tries them in that order; when an argument does not decide
yet (a curried function), the remaining alternatives stay together until the
next argument does.

### Type-level function (`Picked`, `Merge`, `Awaited`)
A type that is *computed* once the arguments of a call are known, like a
formula in a spreadsheet cell. `Picked` keeps only the selected fields of a
row, `Merge` combines the fields of two records (`{ ...a, ...b }`), `Awaited`
unwraps a promise returned from a promise callback.

### Lookup that can miss
A function that may find nothing, such as `Map#get`: its result type is
`v | Undefined`. A `has` check on the same map and key, or an annotation on
the variable that receives the result, tells the checker the key is there.

### Excess field
A field in an object literal that its named record type does not declare —
usually a typo (`emial`). Reported as HM1010, with a "did you mean" hint.

### Hoisting
JavaScript lets a top-level function use a `const` that is declared further
down the file. The checker gives such a forward reference a placeholder and
fills it in once the declaration has been checked.

---

## Words about this codebase specifically

### Directive
A special comment command such as `::constraint`, `::narrow`,
`::types` that configures the checker rather than annotating one value.

### Diagnostic (`diag`)
One warning or error message shown to the user, with a location and an
explanation. "Diagnostics" is standard editor terminology for the squiggly
underlines.

### LSP — Language Server Protocol
The standard "walkie-talkie language" between an editor (VS Code) and a
language brain (this project). The editor asks "what's the type under the
cursor?" and the *language server* answers. Everything in `src/services/`
answers a specific kind of editor question:

- **Hover** — the info popup when the mouse rests on code.
- **Completion** — the suggestion list while typing.
- **Signature help** — the parameter hints inside a function call.
- **References / Rename / Code actions** — find-usages, safe renaming,
  quick fixes.

### Project scope
A folder with its own hinmil configuration (`hinmil.config.json`,
`hinmil.config.js` or `"hinmil"` in `package.json`) and therefore its own
globals, types directory and settings. A file belongs to the nearest scope
above it; in a monorepo, `server/` and `client/` are two scopes. The
language server keeps an import context and engine per scope; the CLI a
`ProjectChecker` per scope.

### AST — Abstract Syntax Tree
The tree-shaped outline of source code that parsers produce: a sentence
diagram for programs. This project turns JavaScript text into an AST (the
*acorn* parser by default, behind a swappable façade in `src/parsing.ts`),
then walks the tree to infer types.

### Registry
A global lookup table filled at startup and consulted everywhere, e.g. the
*method registry* ("which methods does each type have?") or the *data type
registry* ("which sum types exist?"). Code: `src/registries/`.

### Engine
Short for the `InferenceEngine` in `src/infer/index.ts` — the coordinator
object that owns the environment, substitution, diagnostics list and all
registries while one file is being analysed.

### Arity
Simply "how many arguments something takes". A function of arity 2 takes two
arguments; `Array` has arity 1 because it needs one ingredient (the element
type).

### Sidecar file
A separate `.hm` file that carries the type annotations of JavaScript code
outside its source — like subtitles shipped next to a film. A package can
publish its own (`"hinmil": { "sidecars": … }` in `package.json`), and a
project can write one for a package that has none (`hm-types/<pkg>.hm`).

### Tuple-applied
How JavaScript calls are modelled internally: `f(a, b)` bundles its
arguments into a `Tuple[A, B]` and unifies that against the function's
parameter. This is why a multi-argument function is annotated
`(A, B) -> C` while a curried one is `A -> B -> C`.

### Module / export map
Each file is a *module*: it is checked on its own, and what it exports is
recorded as an *export map* (name → type scheme) that importing files use.
Both module styles are understood: ES modules (`import`/`export`) and
CommonJS (`require`/`module.exports`).

### Inline-annotated package
An npm package whose JavaScript carries `::` annotations itself, without a
sidecar. The checker reads those files as if they were part of your project.

### Companion package / project stub
Two ways to supply types for a package that has none: a separate
`@hm/<package>` package with sidecars (like `@types/*` for TypeScript), or a
project's own `hm-types/<package>.hm` file. A project stub wins over
everything else.

### Speculation / trial
Trying something "in pencil": the checker attempts a unification (for
example one alternative of an overload), and if it fails it rubs the
attempt out — the substitution and any messages are rolled back — and tries
the next. Code: `speculate` and `tryCommit` in `src/infer/helpers.ts`.

### Error sentinel (`$error`)
After a real type error, the placeholders involved are filled with a special
"already wrong" type. Anything that touches it is silently accepted, so one
mistake produces one message instead of a cascade.

### Globals file
A project-level `.hm` (or `.js`) file — `globals.hm` by default, or
whatever the `globals` config entry points at — whose declarations are
merged into every file of its *project scope* (the folder whose
configuration names it, and everything below it). Typically holds `::global`
directives, ambient type aliases and shared constraints.

### `::global` directive
Registers a method or static on a type (`Array#ap`, `String.empty`), e.g.
for prototype extensions the checker cannot see. It does **not** declare a
global variable — the "global" refers to the declaration applying to every
file in its project scope.
