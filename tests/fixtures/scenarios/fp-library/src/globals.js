// ::global Array#ap :: [a] ~> [a -> b] -> [b]

// ::constraint Category c { c :: Semigroupoid, c :: { id :: () -> c a a }}
// ::constraint Extend w { w :: { extend :: w a ~> (w a -> b) -> w b }}
// ::constraint Alt f { f :: Functor, f:: { alt :: f a ~> f a -> f a }}
// ::constraint Ord a { a :: Setoid, a :: { lte :: a ~> a -> Boolean } }
// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Bifunctor f { f :: { bimap :: f a c ~> (a -> b) -> (c -> d) -> f b d } }
// ::constraint Profunctor p { p :: Functor, p:: { promap :: p b c ~> (a -> b) -> (c -> d) -> p a d }}
// ::constraint Filterable f { f :: { filter :: f a ~> (a -> Boolean) -> f a } }
// ::constraint Bichain m { m :: { bichain :: m a b ~> (a -> m c d) -> (b -> m c d) -> m c d } }
// ::constraint Chain m { m :: Apply, m :: { chain :: m a ~> (a -> m b) -> m b } }
// ::constraint Monad m { m :: Applicative, m :: Chain }
// ::constraint Extract w { w :: { extract :: w a ~> () -> a }}
// ::constraint Comonad w  { w :: Extend, w :: Extract }
// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }
// ::constraint Monoid m { m :: Semigroup, m :: { empty :: () -> m } }
// ::constraint Group g { g :: Monoid,  g :: { invert :: g ~> () -> g }}
// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }
// ::constraint Apply f { f :: Functor, f :: { ap :: f a ~> f (a -> b) -> f b } }
// ::constraint Applicative f { f :: Apply, f :: { of :: a -> f a } }
// ::constraint Plus f { f :: Alt, f :: { zero :: () -> f a } }
// ::constraint Alternative f { f :: Applicative, f :: Plus }
// ::constraint ChainRec m { m :: Chain, m :: { chainRec :: (forall c. (a -> c) -> (b -> c) -> a -> m c) -> a -> m b } }
// ::constraint Traversable t { t :: Functor, t :: { traverse :: Applicative f => t a ~> TypeRep f -> (a -> f b) -> f (t b) } }
// ::constraint Semigroupoid c { c :: { compose :: c i j ~> c j k -> c i k  }  }
// ::constraint Contravariant f { f :: { contramap :: f a ~> (b -> a) -> f b }  }


// ::constraint Binary f { f :: { coalesce :: f a b ~> (a -> c) -> (b -> c) -> f a c}  }

// A monoid wrapper (Sum, First, Last) whose wrapped value is read via `.value`.
// The value type differs per wrapper (Sum -> Number, First a -> Maybe a), which
// HM cannot relate to `m` (it would need a type family), hence `Any`.
// ::constraint Unwrappable m { m :: Monoid, m :: { value :: m ~> Any } }

// What the target monad of a Free interpreter needs: `chain` and a static
// `of`.  Free derives `map` and `ap` from them when the monad lacks them, so
// a minimal type such as test/FreeBox is enough.
// ::constraint Chainable m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }