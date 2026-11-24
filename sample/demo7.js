// ============================================================================
// demo7.js — generic call-site projection in hinmil
//
// hinmil itself contains NO library-specific code (no sqlkit, no ORM
// mention).  Any library can opt into call-site type projection by
// emitting these four generic primitives in its `// ::` annotations:
//
//   1. `Picked R Sel`         — projection marker on a constructor's
//                              return type.  The selector array passed
//                              at the call site replaces it with a
//                              record built from the elements.
//
//   2. `Prop T`               — named calculated field.  When such a
//                              binding appears in a selector array its
//                              identifier name becomes the projected
//                              field key, with value type `T`.
//
//   3. `RowAlias#rel :: Child` / `[Child]`
//                              — a property-shadow on the row alias.
//                              `R#x :: T` is the LSP's existing way to
//                              say "member access `.x` on a value of
//                              type `R` yields `T`" — `T` can be any
//                              type (scalar, function, row, list).
//                              What is *new* is that the projection
//                              algorithm now does a reverse lookup on
//                              these shadows: given a nested selector
//                              whose row is `Child`, it finds the
//                              shadow key `x` and uses it as the
//                              field name in the projected record
//                              (wrapping in `[ ]` for `[Child]`).
//
//   4. (no column selectors)  — sqlkit-style convention: when the
//                              selector array contains only relations
//                              and extras, every column of the row is
//                              implicitly added to the projection.
//
// Hover any of `q1`..`q5` below to see the projected record types.
// ============================================================================

// ---------------------------------------------------------------------------
// `unsafe :: a` — fully polymorphic stub.  Lets us bind every demo
// constructor to a value whose type is whatever the annotation declares,
// without writing real implementations.
// ---------------------------------------------------------------------------
// unsafe :: a
const unsafe = null;

// ---------------------------------------------------------------------------
// Opaque type constructors used by this demo.  In a real codebase these
// come from the library's `.hm` sidecar.
// ---------------------------------------------------------------------------
// Q    :: a -> Q a
// Prop :: a -> Prop a

// ---------------------------------------------------------------------------
// Row aliases — plain data shapes
// ---------------------------------------------------------------------------
// PostRow    :: { id :: Number, title :: String, body :: String, authorId :: Number }
// AuthorRow  :: { id :: Number, name :: String, email :: String }
// CommentRow :: { id :: Number, postId :: Number, text :: String }

// ---------------------------------------------------------------------------
// Selector unions — what each constructor accepts inside its array
// ---------------------------------------------------------------------------
// PostSelector    :: "id" | "title" | "body" | "authorId" | Prop a | Q a
// AuthorSelector  :: "id" | "name" | "email"
// CommentSelector :: "id" | "text" | Q a

// ---------------------------------------------------------------------------
// Property-shadows on the parent row.  `R#x :: T` already meant
// "`.x` on an `R` returns `T`"; here we use that to declare relations
// so the projection algorithm can map a nested `AuthorRow` selector
// to the `author` key, and a nested `[CommentRow]` to `comments`.
// ---------------------------------------------------------------------------
// PostRow#author   :: AuthorRow
// PostRow#comments :: [CommentRow]
// CommentRow#author :: AuthorRow

// ---------------------------------------------------------------------------
// Constructors — overloaded with two annotations.  The first lets the
// bare identifier appear inside another selector array (the "value as
// selector" form, used by q4).  The second is the callable form that
// drives the `Picked` projection.
// ---------------------------------------------------------------------------
// Post    :: [PostSelector]    -> Q (Picked PostRow    PostSelector)
// Author  :: PostSelector
// Author  :: [AuthorSelector]  -> Q (Picked AuthorRow  AuthorSelector)
// Comment :: PostSelector
// Comment :: [CommentSelector] -> Q (Picked CommentRow CommentSelector)
const Post    = unsafe;
const Author  = unsafe;
const Comment = unsafe;

// A calculated field — `Prop T` carries the value type, the binding's
// identifier name becomes the projected key.
// wordCount :: Prop Number
const wordCount = unsafe;


// ===========================================================================
// (1) String-literal column selection.
//     Only the picked columns appear in the projected record.
//     Hover q1  →  Q with fields id and title.
// ===========================================================================
const q1 = Post (["id", "title"]);


// ===========================================================================
// (2) `Prop T` calculated field.
//     Identifier name becomes the field key, `T` becomes the value type.
//     Hover q2  →  Q with fields id and wordCount.
// ===========================================================================
const q2 = Post (["id", wordCount]);


// ===========================================================================
// (3) Nested call resolves through method-shadows AND projects deeply.
//     `Author([...])` returns `Q (Picked AuthorRow ...)`; the parent
//     projection inspects `PostRow#author :: AuthorRow`, places the
//     result under the key `author`, and substitutes the inner
//     *projected* record (not the bare alias name).
//     Hover q3  →  id, author with only its name field, comments with
//                  only their text field.
// ===========================================================================
const q3 = Post ([
  "id",
  Author  (["name"]),
  Comment (["text"])
]);


// ===========================================================================
// (4a) Bare relation identifier — selects ALL child columns.
//      `Author` (no parens) means: include every column of `AuthorRow`.
//      Hover q4  →  id, author with id+name+email.
// ===========================================================================
const q4 = Post (["id", Author]);


// ===========================================================================
// (4b) No column selectors at all — implicit "select all columns".
//      The array contains only a relation + a calculated field, so
//      every `PostRow` column is added implicitly alongside them.
//      Hover q5  →  author with name only, wordCount, plus every
//                   PostRow column (id, title, body, authorId).
// ===========================================================================
const q5 = Post ([Author (["name"]), wordCount]);


// ===========================================================================
// REALISTIC SCENARIOS
// ===========================================================================
// The five micro-examples above isolate one feature each.  The blocks
// below combine them into shapes you would actually write in an app:
// nested loaders, derived dashboards, paginated lists, and a small
// helper built on top of `Q (Picked …)`.
// ===========================================================================


// ---------------------------------------------------------------------------
// (S1) Blog post detail page — three levels deep.
//
// Post → comments → author of each comment.  The selector
// `Comment([..., Author([...])])` flows through the row-shadow
// `CommentRow#author` (declared at the top of this file) so the
// projected `comments` list contains records whose `author` field is
// itself a projected record.
// ---------------------------------------------------------------------------
const postDetail = Post ([
  "id", "title", "body",
  Author ([ "name", "email" ]),
  Comment ([
    "text",
    Author ([ "name" ])
  ])
]);


// ---------------------------------------------------------------------------
// (S2) Dashboard row — only calculated fields.
//
// No string columns, no relations: the array contains only `Prop T`
// bindings.  Each binding contributes a field whose name is the
// binding's identifier and whose type is the `T` it carries.  The
// "no column selectors" implicit-all rule then folds in the parent
// row's columns alongside.
//
// Hover dashboard expects every PostRow column plus wordCount,
// readingMinutes and isPinned.
// ---------------------------------------------------------------------------
// readingMinutes :: Prop Number
const readingMinutes = unsafe;

// isPinned :: Prop Boolean
const isPinned = unsafe;

const dashboard = Post ([ wordCount, readingMinutes, isPinned ]);


// ---------------------------------------------------------------------------
// (S3) Pagination wrapper — preserves the inner projection.
//
// `paginate` is a tiny generic helper.  It takes any `Q a` and a page
// size and returns a `Q (Page a)`.  The row type of the inner query is
// preserved untouched, so the projected record from `q1` lives intact
// inside the returned page.
// ---------------------------------------------------------------------------
// Page     :: a -> Page a
// paginate :: Q a -> Number -> Q (Page a)
const paginate = unsafe;

const firstPage = paginate (q1) (25);


// ---------------------------------------------------------------------------
// (S4) Tiny wrapper around a `Picked`-returning constructor.
//
// `pickPostIds` always asks for the id column of a Post.  Inference
// figures out the return type — hover it to see the projected
// `{ id :: Number }` record inside the returned `Q`.
// ---------------------------------------------------------------------------
const pickPostIds = () => Post (["id"]);

const postIds = pickPostIds ();

