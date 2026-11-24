import { Just, Nothing } from './Maybe'
import { Left, Right } from './Either'
// ============================================
// Monad Transformers — class, prototype & object literal styles
// ============================================



// ============================================
// 1. MaybeT — class style
// ============================================

// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT#map :: Monad m => MaybeT m a ~> (a -> b) -> MaybeT m b
  map(fn) {
    return new MaybeT(
      this.run.chain(maybe =>
        maybe.isNothing()
          ? this.run.constructor.of(new Nothing())
          : this.run.constructor.of(new Just(fn(maybe.value)))
      )
    );
  }

  // MaybeT#chain :: Monad m => MaybeT m a ~> (a -> MaybeT m b) -> MaybeT m b
  chain(fn) {
    return new MaybeT(
      this.run.chain(maybe =>
        maybe.isNothing()
          ? this.run.constructor.of(new Nothing())
          : fn(maybe.value).run
      )
    );
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(new Just(value)));
  }

  // MaybeT.none :: Monad m => TypeRep m -> MaybeT m a
  static none(M) {
    return new MaybeT(M.of(new Nothing()));
  }

  // MaybeT.lift :: Monad m => m a -> MaybeT m a
  static lift(monad) {
    return new MaybeT(monad.chain(value =>
      monad.constructor.of(new Just(value))
    ));
  }
}

// ============================================
// 2. EitherT — prototype style
// ============================================

// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT#map :: Monad m => EitherT e m a ~> (a -> b) -> EitherT e m b
EitherT.prototype.map = function(fn) {
  return new EitherT(
    this.run.chain(either =>
      either.isLeft
        ? this.run.constructor.of(Left(either.value))
        : this.run.constructor.of(Right(fn(either.value)))
    )
  );
};

// EitherT#chain :: Monad m => EitherT e m a ~> (a -> EitherT e m b) -> EitherT e m b
EitherT.prototype.chain = function(fn) {
  return new EitherT(
    this.run.chain(either =>
      either.isLeft
        ? this.run.constructor.of(Left(either.value))
        : fn(either.value).run
    )
  );
};

// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

// EitherT.left :: Monad m => (TypeRep m, e) -> EitherT e m a
EitherT.left = function(M, err) {
  return new EitherT(M.of(Left(err)));
};

// EitherT.lift :: Monad m => m a -> EitherT e m a
EitherT.lift = function(monad) {
  return new EitherT(monad.chain(value =>
    monad.constructor.of(Right(value))
  ));
};

// ============================================
// 3. ReaderT — object literal / factory style
// ============================================

// ReaderT :: Monad m => (r -> m a) -> ReaderT r m a
const ReaderT = (run) => ({
  run,

  // ReaderT#map :: Monad m => ReaderT r m a ~> (a -> b) -> ReaderT r m b
  map: (fn) => ReaderT(r =>
    run(r).chain(a => run(r).constructor.of(fn(a)))
  ),

  // ReaderT#chain :: Monad m => ReaderT r m a ~> (a -> ReaderT r m b) -> ReaderT r m b
  chain: (fn) => ReaderT(r =>
    run(r).chain(a => fn(a).run(r))
  ),
});

// ReaderT.of :: Monad m => (TypeRep m, a) -> ReaderT r m a
ReaderT.of = (M, value) => ReaderT(_r => M.of(value));

// ReaderT.ask :: Monad m => TypeRep m -> ReaderT r m r
ReaderT.ask = (M) => ReaderT(r => M.of(r));

// ReaderT.lift :: Monad m => m a -> ReaderT r m a
ReaderT.lift = (monad) => ReaderT(_r => monad);

// ============================================
// Identity monad (base monad for testing stacks)
// ============================================

// Identity :: a -> Identity a
const Identity = (value) => ({
  // Identity#value :: Identity a ~> a
  value,

  // Identity#map :: Identity a ~> (a -> b) -> Identity b
  map: (fn) => Identity(fn(value)),

  // Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b
  chain: (fn) => fn(value),
});

// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);


// ============================================
// Usage examples
// ============================================

// --- MaybeT (class) with Identity ---
const mt1 = MaybeT.of(Identity, 42);
const mt2 = mt1.map(x => x + 1);
const mt3 = mt1.chain(x => MaybeT.of(Identity, x * 2));
const mtNone = MaybeT.none(Identity);
const mt4 = mtNone.map(x => x + 1);

// --- EitherT (prototype) with Identity ---
const et1 = EitherT.of(Identity, "hello");
const et2 = et1.map(s => s.length);
const et3 = et1.chain(s => EitherT.of(Identity, s.toUpperCase()));
const etLeft = EitherT.left(Identity, "error");
const et4 = etLeft.map(s => s.length);

// --- ReaderT (object literal) with Identity ---
const rt1 = ReaderT.of(Identity, 10);
const rt2 = rt1.map(x => x * 2);
const rt3 = rt1.chain(x => ReaderT.of(Identity, x + 5));
const rtAsk = ReaderT.ask(Identity);
const rt4 = rtAsk.chain(env => ReaderT.of(Identity, env + "!"));

module.exports = { MaybeT, EitherT, ReaderT, Identity };

