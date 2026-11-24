import { Just, Nothing, maybe } from "./Maybe";
import { Left, Right } from "./Either2"
import Pair from "./Pair";
import { curry } from './common';

// ::types ./demo2
// ::narrow Array
// isArray :: a -> Boolean
const isArray = x => Array.isArray(x);

// reduce :: Foldable f => ((b, a) -> b, b, f a) -> b
const reduce = (fn, acc, foldable) => foldable.reduce(fn, acc);

// concat :: Semigroup s => (s, s) -> s
const concat = (xs, ys) => xs.concat(ys);

// append :: (Applicative f, Semigroup (f a)) => (a, f a) -> f a
const append = (item, container) =>
  concat (container.constructor.of (item), container);


// empty :: Monoid m => TypeRep m -> m
const empty = M => {
  return M.empty()
}

// tail :: (Applicative f, Foldable f, Monoid (f a)) => f a -> Maybe (f a)
const tail = foldable => {
  if (isArray (foldable)) return foldable.length < 2 ? Nothing () : Just (foldable.slice (1));

  const M = foldable.constructor;

  const reducer = (acc, x) => {
    return Just (maybe (empty (M), fa => append (x, fa), acc));
  };

  return reduce (reducer, Nothing(), foldable);
};

// mconcat :: Monoid (m a), Foldable f => (TypeRep m, f a) -> m a
const mconcat = (M, foldable) => {
  const reduced = foldable.reduce((acc, x) => acc.concat(x), M.empty());
  return reduced;
};


const last3 = tail([1, 2, 3])
  .map(a => a[0])

const emptyArray = empty(Array);


// firstEl :: Array a -> a
const firstEl = arr => arr[0]

// testNewFeatures :: NonZeroValidNumber -> Any
const testNewFeatures = str => {
  return str
};

const parsed = testNewFeatures(1);

// prop :: (String, a) -> b
const prop = (key, obj) => obj[key];

// getName :: { name :: String } -> String
const getName = obj => prop('name', obj);

// name :: String
const name = getName({ name: 'Alice', age: 30 });

const person = { name: 'Bob', age: 25 };
const personName = person["name"]


// intercalate :: (Monoid m, Foldable f) => (m, f m) -> m
const intercalate = (seperator, foldable) => {

  // reducer :: (Monoid m) => (Pair Boolean m, m) -> Pair Boolean m
  const reducer = (acc, x) => {
    const empty = acc.fst;
    const value = acc.snd

    return Pair(false, concat(empty ? x : concat(x, seperator), value))

  }

  const p = reduce(reducer, Pair(true, empty(seperator.constructor)), foldable)

  return p.snd
};

const intercalated = intercalate(",", ["foo"]);

const emptyArray2 = empty(Array);

// rights :: (Filterable f, Functor f) => f (Either2 a b) -> f b
const rights = f => {
  return f.filter(e => e.isRight).map(e => e.value)
}

// eithArr :: [Either2 String Any]
const eithArr = [Left("Foo"), Right(10), Right("2")]

const eith = intercalated === "Foemp" ? Right(10) : Right("2")

const rs = rights (eithArr);

// takeWhile :: (a -> Boolean) -> Array a -> Array a
const takeWhile = curry((pred, arr) => {
  return arr
})
