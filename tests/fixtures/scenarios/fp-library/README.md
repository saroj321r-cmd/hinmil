# Fixture: fp-library (`fpkit`)

A small, self-written curried functional library with inline `::`
annotations (no `.hm` sidecar), in the style of Fantasy Land libraries:
`curry`, dispatchers that pick an implementation per runtime type (`fl/*`,
`more/findAlg`), Maybe, Either, Result (accumulating errors), Pair, Tuple1–5,
List, Id, Future, the transformers `IdT`, `FutureT` and `StateT`, Free with
an interpreter, record lenses (`object/*`), list helpers (`lst/*`), the
response types of a web wrapper (`express/*`) and law helpers (`test/laws/*`).
Used by `fpLibraryLintsClean`, the `monadTransformers*` scenarios, `objectsAndTuples` and
`strictAnnotations` scenarios and by
`tests/overloading/curriedOverloadParams.test.ts`.

The whole tree must lint clean (`fpLibraryLintsClean.test.ts`). It holds
only what those suites use; to cover a new pattern, add a module here (or
write a new scenario) rather than pointing tests at an external checkout.
