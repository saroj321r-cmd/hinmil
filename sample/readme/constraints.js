// ============================================
// @ constraint — Type Classes
// ============================================

// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// fmap :: Functor f => ((a -> b), f a) -> f b
const fmap = (fn, functor) => functor.map(fn);
