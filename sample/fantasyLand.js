import "./Extensions"

// map :: Functor f => (a -> b, f a) -> f b
const map = (fn, functor) => functor.map(fn)

// chain :: Chain m => (a -> m b, m a) -> m b
const chain = (fn, chain) => chain.chain(fn)

// equals :: Setoid a => (a, a) -> Boolean
const equals = (a, b) => a.equals(b)

const fl = {
  ["fantasy-land/map"]: map,
  ["fantasy-land/chain"]: chain,
  ["fantasy-land/equals"]: equals
};


const StringEq = equals("a", "b")