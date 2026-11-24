// ============================================
// Full Workflow — combining all features
// ============================================

// Maybe :: Just a | Nothing

class Just {
  // Just :: a -> Maybe a
  constructor(value) { this.value = value; }
  // Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
  map(fn) { return new Just(fn(this.value)); }
}

// Nothing :: Maybe a
class Nothing {
  map(_fn) { return new Nothing(); }
}

// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }

// fmap :: Functor f => ((a -> b), f a) -> f b
const fmap = (fn, f) => f.map(fn);

// findDiscount :: Number -> Maybe Number
const findDiscount = (total) =>
  total < 500 ? new Nothing() : new Just(total * 0.05);

// discounts :: [Number] -> [Maybe Number]
const discounts = (totals) => totals.map(findDiscount);

// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = (x) => typeof x === 'number';

// formatReference :: (Number | String) -> String
const formatReference = (x) => {
  if (isNumber(x)) {
    return x.toFixed(0);  // x: Number (narrowed)
  }
  return x;               // x: String (narrowed)
};
