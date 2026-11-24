// ============================================
// Sum types — declared via the annotation shorthand,
// no directive needed
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

// ============================================
// Factory functions instead of classes
// ============================================

// Result :: Ok a | Err e

// Ok :: a -> Result a e
const Ok = (value) => ({
  tag: 'Ok',
  value,
});

// Err :: e -> Result a e
const Err = (error) => ({
  tag: 'Err',
  error,
});

// ============================================
// Multi-line declaration with complex fields
// ============================================

// Response :: Success { status :: Number, body :: String }
//           | Failure (Object String String)

// Success :: { status :: Number, body :: String } -> Response
// Failure :: (Object String String) -> Response

// ============================================
// Phantom variant parameters — new Nothing() stays Maybe a
// ============================================

// findDiscount :: Number -> Maybe Number
const findDiscount = (total) =>
  total > 500 ? new Just(total * 0.05) : new Nothing();

// ============================================
// Narrowing to a variant
// ============================================

// ::narrow Just
// isJust :: a -> Boolean
const isJust = (m) => m.tag === 'Just';

// ============================================
// Sumtype shorthand — Either
// ============================================

// Either :: Left e | Right a

// Left :: e -> Either e a
// Right :: a -> Either e a

// getValue :: Either String Number -> Number
const getValue = (either) => either.value;
