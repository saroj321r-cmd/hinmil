import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

// =========================================================================
// Monad Transformer — class style (MaybeT)
// =========================================================================

describe('MaybeT (class style)', () => {
  const preamble = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = (v) => v;
// Nothing :: Maybe a
const Nothing = Nothing;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);

// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b
`;

  test('class constructor and static of', () => {
    const src = preamble + `
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(Just(value)));
  }
}

const mt = MaybeT.of(Identity, 42);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    // m should resolve to Identity (constructor name), not (a -> Identity a)
    const mtType = typeToString(r.substitution.apply(r.topLevelBindings.get('mt')!.type));
    expect(mtType).toContain('Identity');
    expect(mtType).not.toContain('->');
  });

  test('class map method', () => {
    const src = preamble + `
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
        maybe.tag === 'Nothing'
          ? this.run.constructor.of(Nothing)
          : this.run.constructor.of(Just(fn(maybe.value)))
      )
    );
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(Just(value)));
  }
}

const mt = MaybeT.of(Identity, 42);
const mt2 = mt.map(x => x + 1);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('class chain method', () => {
    const src = preamble + `
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT#chain :: Monad m => MaybeT m a ~> (a -> MaybeT m b) -> MaybeT m b
  chain(fn) {
    return new MaybeT(
      this.run.chain(maybe =>
        maybe.tag === 'Nothing'
          ? this.run.constructor.of(Nothing)
          : fn(maybe.value).run
      )
    );
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(Just(value)));
  }
}

const mt = MaybeT.of(Identity, 42);
const mt2 = mt.chain(x => MaybeT.of(Identity, x * 2));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Monad Transformer — prototype style (EitherT)
// =========================================================================

describe('EitherT (prototype style)', () => {
  const preamble = `
// Either :: Left e | Right a
// Left :: e -> Either e a
const Left = (v) => v;
// Right :: a -> Either e a
const Right = (v) => v;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);

// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b
`;

  test('prototype constructor and static of', () => {
    const src = preamble + `
// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

const et = EitherT.of(Identity, "hello");
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    // m should resolve to Identity (constructor name), not (a -> Identity a)
    const etType = typeToString(r.substitution.apply(r.topLevelBindings.get('et')!.type));
    expect(etType).toContain('Identity');
    expect(etType).not.toContain('->');
  });

  test('prototype map method', () => {
    const src = preamble + `
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
      either.tag === 'Left'
        ? this.run.constructor.of(Left(either.value))
        : this.run.constructor.of(Right(fn(either.value)))
    )
  );
};

// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

const et = EitherT.of(Identity, "hello");
const et2 = et.map(s => s + " world");
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('prototype chain method', () => {
    const src = preamble + `
// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT#chain :: Monad m => EitherT e m a ~> (a -> EitherT e m b) -> EitherT e m b
EitherT.prototype.chain = function(fn) {
  return new EitherT(
    this.run.chain(either =>
      either.tag === 'Left'
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

const et = EitherT.of(Identity, "hello");
const et2 = et.chain(s => EitherT.of(Identity, s + " world"));
const etLeft = EitherT.left(Identity, "error");
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('prototype lift', () => {
    const src = preamble + `
// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT.lift :: Monad m => m (Either e a) -> EitherT e m a
EitherT.lift = function(wrapped) {
  return new EitherT(wrapped);
};

    `;
    const r = engine.infer(src);
    const parseErrors = r.diagnostics.filter(d => d.message.startsWith('Invalid type annotation'));
    expect(parseErrors).toHaveLength(0);
  });
});

// =========================================================================
// Monad Transformer — object literal / factory style (ReaderT)
// =========================================================================

describe('ReaderT (object literal style)', () => {
  const preamble = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);

// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b
`;

  test('factory constructor and static of', () => {
    const src = preamble + `
// ReaderT :: (r -> a) -> ReaderT r a
const ReaderT = (run) => ({
  // ReaderT#run :: ReaderT r a ~> (r -> a)
  run,
  // ReaderT#map :: ReaderT r a ~> (a -> b) -> ReaderT r b
  map: (fn) => ReaderT(r => fn(run(r))),
  // ReaderT#chain :: ReaderT r a ~> (a -> ReaderT r b) -> ReaderT r b
  chain: (fn) => ReaderT(r => fn(run(r)).run(r)),
});

// ReaderT.of :: a -> ReaderT r a
ReaderT.of = (value) => ReaderT(_r => value);

const rt = ReaderT.of(10);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('factory map method', () => {
    const src = preamble + `
// ReaderT :: (r -> a) -> ReaderT r a
const ReaderT = (run) => ({
  // ReaderT#run :: ReaderT r a ~> (r -> a)
  run,
  // ReaderT#map :: ReaderT r a ~> (a -> b) -> ReaderT r b
  map: (fn) => ReaderT(r => fn(run(r))),
  // ReaderT#chain :: ReaderT r a ~> (a -> ReaderT r b) -> ReaderT r b
  chain: (fn) => ReaderT(r => fn(run(r)).run(r)),
});

// ReaderT.of :: a -> ReaderT r a
ReaderT.of = (value) => ReaderT(_r => value);

const rt = ReaderT.of(10);
const rt2 = rt.map(x => x * 2);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('factory chain method', () => {
    const src = preamble + `
// ReaderT :: (r -> a) -> ReaderT r a
const ReaderT = (run) => ({
  // ReaderT#run :: ReaderT r a ~> (r -> a)
  run,
  // ReaderT#map :: ReaderT r a ~> (a -> b) -> ReaderT r b
  map: (fn) => ReaderT(r => fn(run(r))),
  // ReaderT#chain :: ReaderT r a ~> (a -> ReaderT r b) -> ReaderT r b
  chain: (fn) => ReaderT(r => fn(run(r)).run(r)),
});

// ReaderT.of :: a -> ReaderT r a
ReaderT.of = (value) => ReaderT(_r => value);

const rt = ReaderT.of(10);
const rt2 = rt.chain(x => ReaderT.of(x + 5));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('factory ask and lift', () => {
    const src = preamble + `
// ReaderT :: (r -> a) -> ReaderT r a
const ReaderT = (run) => ({
  // ReaderT#run :: ReaderT r a ~> (r -> a)
  run,
  // ReaderT#map :: ReaderT r a ~> (a -> b) -> ReaderT r b
  map: (fn) => ReaderT(r => fn(run(r))),
  // ReaderT#chain :: ReaderT r a ~> (a -> ReaderT r b) -> ReaderT r b
  chain: (fn) => ReaderT(r => fn(run(r)).run(r)),
});

// ReaderT.of :: a -> ReaderT r a
ReaderT.of = (value) => ReaderT(_r => value);

// ReaderT.ask :: () -> ReaderT r r
ReaderT.ask = () => ReaderT(r => r);

const rtAsk = ReaderT.ask();
const rt2 = rtAsk.chain(env => ReaderT.of(env));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Annotation correctness — types are inferred as expected
// =========================================================================

describe('Monad transformer type annotations', () => {
  test('MaybeT constructor annotation is parsed correctly', () => {
    const src = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
// Nothing :: Maybe a
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }
}
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('EitherT multi-param type annotation is parsed correctly', () => {
    const src = `
// Either :: Left e | Right a
// Left :: e -> Either e a
// Right :: a -> Either e a
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('ReaderT factory annotation is parsed correctly', () => {
    const src = `
// ReaderT :: (r -> a) -> ReaderT r a
const ReaderT = (run) => ({
  // ReaderT#run :: ReaderT r a ~> (r -> a)
  run,
});
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('method annotation with receiver type on transformer', () => {
    const src = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
// Nothing :: Maybe a
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }
  // MaybeT#map :: Monad m => MaybeT m a ~> (a -> b) -> MaybeT m b
  map(fn) {
    return new MaybeT(this.run);
  }
}
    `;
    const r = engine.infer(src);
    // Verify no parse errors (annotations parsed correctly)
    const parseErrors = r.diagnostics.filter(d => d.message.includes('Invalid type annotation'));
    expect(parseErrors).toHaveLength(0);
  });

  test('static method annotation on transformer', () => {
    const src = `
// Either :: Left e | Right a
// Left :: e -> Either e a
// Right :: a -> Either e a
// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT.of :: a -> EitherT e m a
EitherT.of = function(value) {
  return new EitherT(value);
};

// EitherT.left :: e -> EitherT e m a
EitherT.left = function(err) {
  return new EitherT(err);
};
    `;
    const r = engine.infer(src);
    // Verify no parse errors (annotations parsed correctly)
    const parseErrors = r.diagnostics.filter(d => d.message.includes('Invalid type annotation'));
    expect(parseErrors).toHaveLength(0);
  });
});

// =========================================================================
// Mixed style — transformer uses all three patterns
// =========================================================================

describe('Monad transformer mixed styles', () => {
  test('Identity monad with object literal, used as base for class transformer', () => {
    const src = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = (v) => v;
// Nothing :: Maybe a
const Nothing = Nothing;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
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

// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(Just(value)));
  }
}

const mt = MaybeT.of(Identity, 42);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const mtType = typeToString(r.substitution.apply(r.topLevelBindings.get('mt')!.type));
    expect(mtType).toContain('Identity');
    expect(mtType).not.toContain('->');
  });

  test('Identity monad with object literal, used as base for prototype transformer', () => {
    const src = `
// Either :: Left e | Right a
// Left :: e -> Either e a
const Left = (v) => v;
// Right :: a -> Either e a
const Right = (v) => v;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
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

// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

const et = EitherT.of(Identity, "hello");
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const etType = typeToString(r.substitution.apply(r.topLevelBindings.get('et')!.type));
    expect(etType).toContain('Identity');
    expect(etType).not.toContain('->');
  });

  test('Identity monad with object literal, used as base for factory transformer', () => {
    const src = `
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

// ReaderT :: (r -> a) -> ReaderT r a
const ReaderT = (run) => ({
  // ReaderT#run :: ReaderT r a ~> (r -> a)
  run,
  // ReaderT#map :: ReaderT r a ~> (a -> b) -> ReaderT r b
  map: (fn) => ReaderT(r => fn(run(r))),
  // ReaderT#chain :: ReaderT r a ~> (a -> ReaderT r b) -> ReaderT r b
  chain: (fn) => ReaderT(r => fn(run(r)).run(r)),
});

// ReaderT.of :: a -> ReaderT r a
ReaderT.of = (value) => ReaderT(_r => value);

const rt = ReaderT.of(10);
const rt2 = rt.map(x => x * 2);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

// =========================================================================
// Constraint prefix on method annotations (=> + ~> combo)
// =========================================================================

describe('Constraint prefix on method annotations', () => {
  const preamble = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = (v) => v;
// Nothing :: Maybe a
const Nothing = Nothing;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);

// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b
`;

  test('method annotation with Monad m => prefix parses without error', () => {
    const src = preamble + `
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }
}
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('method annotation with constraint resolves chain callback type', () => {
    const src = preamble + `
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT#chain :: Monad m => MaybeT m a ~> (a -> MaybeT m b) -> MaybeT m b
  chain(fn) {
    return new MaybeT(
      this.run.chain(maybe =>
        maybe.tag === 'Nothing'
          ? this.run.constructor.of(Nothing)
          : fn(maybe.value).run
      )
    );
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(Just(value)));
  }
}

const mt = MaybeT.of(Identity, 42);
const mt2 = mt.chain(x => MaybeT.of(Identity, x * 2));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('maybe callback parameter gets type Maybe a (not just a)', () => {
    const src = preamble + `
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT#chain :: Monad m => MaybeT m a ~> (a -> MaybeT m b) -> MaybeT m b
  chain(fn) {
    return new MaybeT(
      this.run.chain(maybe => fn(maybe).run)
    );
  }
}
    `;
    const r = engine.infer(src);
    // Find the 'maybe' parameter
    const maybeOffset = src.indexOf('maybe =>');
    const entry = r.nodeTypes.get(maybeOffset);
    expect(entry).toBeDefined();
    const resolved = r.substitution.apply(entry!.type);
    expect(resolved.tag).toBe('TCon');
    expect((resolved as any).name).toBe('Maybe');
    expect((resolved as any).args).toHaveLength(1);
  });

  test('EitherT prototype with Monad m => on method annotations', () => {
    const src = `
// Either :: Left e | Right a
// Left :: e -> Either e a
const Left = (v) => v;
// Right :: a -> Either e a
const Right = (v) => v;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b

// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT#chain :: Monad m => EitherT e m a ~> (a -> EitherT e m b) -> EitherT e m b
EitherT.prototype.chain = function(fn) {
  return new EitherT(
    this.run.chain(either =>
      either.tag === 'Left'
        ? this.run.constructor.of(Left(either.value))
        : fn(either.value).run
    )
  );
};

// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

const et = EitherT.of(Identity, "hello");
const et2 = et.chain(s => EitherT.of(Identity, s + " world"));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('constraint method lookup works on kv type from factory result', () => {
    const src = preamble + `
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  doChain() {
    return this.run.chain(x => x);
  }
}
    `;
    const r = engine.infer(src);
    // x => x unifies m with Maybe, which rightly fails the Monad constraint
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].message).toContain("'Maybe'");
    expect(r.diagnostics[0].message).toContain("Monad");
    // Verify the .chain method on this.run was resolved
    const chainOffset = src.indexOf('.chain(x');
    const dotChain = chainOffset + 1; // the 'chain' property
    const chainEntry = r.nodeTypes.get(dotChain);
    expect(chainEntry).toBeDefined();
    const chainType = r.substitution.apply(chainEntry!.type);
    // Should be a function type from the Monad constraint
    expect(chainType.tag).toBe('TFun');
  });

  test('constrained m resolves to constructor name, not function type', () => {
    const src = `
// Either :: Left e | Right a
// Left :: e -> Either e a
const Left = (v) => v;
// Right :: a -> Either e a
const Right = (v) => v;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b

// EitherT :: Monad m => m (Either e a) -> EitherT e m a
function EitherT(run) {
  if (!(this instanceof EitherT)) return new EitherT(run);
  // EitherT#run :: Monad m => EitherT e m a ~> m (Either e a)
  this.run = run;
}

// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

const et1 = EitherT.of(Identity, "hello");
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    // et1 should be EitherT e Identity String, not EitherT e (a -> Identity a) String
    const et1Type = typeToString(r.substitution.apply(r.topLevelBindings.get('et1')!.type));
    expect(et1Type).toContain('Identity');
    expect(et1Type).not.toContain('->');
  });

  test('MaybeT and EitherT in same file: no kv cross-contamination', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = (v) => v;
// Nothing :: Maybe a
const Nothing = Nothing;
// Either :: Left e | Right a
// Left :: e -> Either e a
const Left = (v) => v;
// Right :: a -> Either e a
const Right = (v) => v;

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b

// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }
  // MaybeT#chain :: Monad m => MaybeT m a ~> (a -> MaybeT m b) -> MaybeT m b
  chain(fn) {
    return new MaybeT(
      this.run.chain(maybe =>
        maybe.tag === 'Nothing'
          ? this.run.constructor.of(Nothing)
          : fn(maybe.value).run
      )
    );
  }
  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    return new MaybeT(M.of(Just(value)));
  }
}

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
      either.tag === 'Left'
        ? this.run.constructor.of(Left(either.value))
        : this.run.constructor.of(Right(fn(either.value)))
    )
  );
};
// EitherT#chain :: Monad m => EitherT e m a ~> (a -> EitherT e m b) -> EitherT e m b
EitherT.prototype.chain = function(fn) {
  return new EitherT(
    this.run.chain(either =>
      either.tag === 'Left'
        ? this.run.constructor.of(Left(either.value))
        : fn(either.value).run
    )
  );
};
// EitherT.of :: Monad m => (TypeRep m, a) -> EitherT e m a
EitherT.of = function(M, value) {
  return new EitherT(M.of(Right(value)));
};

const mt1 = MaybeT.of(Identity, 42);
const mt2 = mt1.chain(x => MaybeT.of(Identity, x * 2));
const et1 = EitherT.of(Identity, "hello");
const et2 = et1.map(s => s.length);
const et3 = et1.chain(s => EitherT.of(Identity, s.toUpperCase()));
    `;
    const r = engine.infer(src);
    // No "Cannot unify m (Maybe b) ..." errors — kv ids must not leak
    expect(r.diagnostics).toHaveLength(0);
    const et1Type = typeToString(r.substitution.apply(r.topLevelBindings.get('et1')!.type));
    expect(et1Type).toContain('EitherT');
    expect(et1Type).toContain('Identity');
    expect(et1Type).not.toContain('Maybe');
  });
});

// =========================================================================
// Diagnostic validation — constraint method return type checking
// =========================================================================

describe('Constraint method return type validation', () => {
  test('MaybeT.of without Maybe wrapping produces diagnostic', () => {
    const src = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = (v) => v;
// Nothing :: Maybe a
const Nothing = Nothing;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b

// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    // MaybeT#run :: Monad m => MaybeT m a ~> m (Maybe a)
    this.run = run;
  }

  // MaybeT.of :: Monad m => (TypeRep m, a) -> MaybeT m a
  static of(M, value) {
    // BUG: passes bare value instead of Just(value)
    return new MaybeT(M.of(value));
  }
}
    `;
    const r = engine.infer(src);
    // The engine should detect that M.of(value) returns m a (where a is not Maybe a)
    // but the constructor expects m (Maybe a)
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  test('ternary branch mismatch diagnostic points at method name, not at inner expression', () => {
    const src = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
const Just = (v) => v;
// Nothing :: Maybe a
const Nothing = Nothing;
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);
// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b

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
          ? this.run.constructor.of()
          : this.run.constructor.of(Just(fn(maybe.value)))
      )
    );
  }
}
    `;
    const r = engine.infer(src);
    const mismatch = r.diagnostics.find(d => d.message.includes('Type mismatch'));
    expect(mismatch).toBeDefined();
    // Diagnostic should point at the method name 'map',
    // NOT at some inner expression like maybe.isNothing()
    const diagText = src.substring(mismatch!.start, mismatch!.end);
    expect(diagText).toBe('map');
  });
});

// =========================================================================
// Arity-aware HK grouping
// =========================================================================

describe('Arity-aware HK grouping', () => {
  test('Pair Boolean f m groups f m as HK when Pair arity is 2 and f is constrained', () => {
    const src = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// Pair :: (a, b) -> Pair a b
const Pair = (a, b) => ({ fst: a, snd: b });

// reducer :: Functor f => (Pair Boolean f m, m) -> Pair Boolean f m
const reducer = (pair, x) => pair;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const reducerType = typeToString(r.substitution.apply(r.topLevelBindings.get('reducer')!.type));
    // f m should be grouped as one HK type, so Pair has 2 args (Boolean, f m)
    expect(reducerType).toContain('Pair');
    expect(reducerType).toContain('Boolean');
  });

  test('Pair Boolean (f m) with parens works the same as arity-based grouping', () => {
    const src = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// Pair :: (a, b) -> Pair a b
const Pair = (a, b) => ({ fst: a, snd: b });

// reducer :: Functor f => (Pair Boolean (f m), m) -> Pair Boolean (f m)
const reducer = (pair, x) => pair;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('MaybeT m a is not affected (arity 2, no HK grouping needed)', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
// Nothing :: Maybe a
// MaybeT :: Monad m => m (Maybe a) -> MaybeT m a
class MaybeT {
  constructor(run) {
    this.run = run;
  }
}
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('Pair a without constraint gives arity mismatch (too few args)', () => {
    const src = `
// Pair :: (a, b) -> Pair a b
const Pair = (a, b) => ({ fst: a, snd: b });

// getValue :: Pair a -> a
const getValue = (p) => p.fst;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => d.message.includes("expects 2 type argument") && d.message.includes("got 1"))).toBe(true);
  });

  test('Pair a b c without constraint gives arity mismatch (too many args)', () => {
    const src = `
// Pair :: (a, b) -> Pair a b
const Pair = (a, b) => ({ fst: a, snd: b });

// getValue :: Pair a b c -> a
const getValue = (p) => p.fst;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => d.message.includes("expects 2 type argument") && d.message.includes("got 3"))).toBe(true);
  });

  test('Array a b gives arity mismatch from method registry', () => {
    const src = `
// merge :: Array a b -> a
const merge = (xs) => xs[0];
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d => d.message.includes("'Array' expects 1 type argument") && d.message.includes("got 2"))).toBe(true);
  });

  test('(f m) without constraint gives unconstrained HK diagnostic', () => {
    const src = `
// Pair :: (a, b) -> Pair a b
const Pair = (a, b) => ({ fst: a, snd: b });

// reducer :: (Pair Boolean (f m), m) -> Pair Boolean (f m)
const reducer = (acc, x) => acc;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d =>
      d.message.includes("'f'") && d.message.includes("no constraint")
    )).toBe(true);
  });

  test('(f m) with constraint in file does not warn', () => {
    const src = `
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// Pair :: (a, b) -> Pair a b
const Pair = (a, b) => ({ fst: a, snd: b });

// reducer :: Functor f => (Pair Boolean (f m), m) -> Pair Boolean (f m)
const reducer = (acc, x) => acc;
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.filter(d => d.message.includes("no constraint"))).toHaveLength(0);
  });

  test('m (Maybe a) without any constraint gives unconstrained HK diagnostic', () => {
    const src = `
// Maybe :: Just a | Nothing
// Just :: a -> Maybe a
// Nothing :: Maybe a
// MaybeT :: m (Maybe a) -> MaybeT m a
class MaybeT { constructor(run) { this.run = run; } }
    `;
    const r = engine.infer(src);
    expect(r.diagnostics.some(d =>
      d.message.includes("'m'") && d.message.includes("no constraint")
    )).toBe(true);
  });
});

// =========================================================================
// ReaderT — constrained (Monad m =>) transformer style
// =========================================================================

describe('ReaderT (constrained transformer style)', () => {
  const preamble = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  map: (fn) => Identity(fn(value)),
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);

// Identity#map :: Identity a ~> (a -> b) -> Identity b
// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b
`;

  test('constrained ReaderT constructor annotation parses without error', () => {
    const src = preamble + `
// ReaderT :: Monad m => (r -> m a) -> ReaderT r m a
const ReaderT = (run) => ({
  // ReaderT#run :: Monad m => ReaderT r m a ~> (r -> m a)
  run,
});
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('constrained ReaderT map method', () => {
    const src = preamble + `
// ReaderT :: Monad m => (r -> m a) -> ReaderT r m a
const ReaderT = (run) => ({
  // ReaderT#run :: Monad m => ReaderT r m a ~> (r -> m a)
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

const rt = ReaderT.of(Identity, 10);
const rt2 = rt.map(x => x * 2);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('constrained ReaderT chain method', () => {
    const src = preamble + `
// ReaderT :: Monad m => (r -> m a) -> ReaderT r m a
const ReaderT = (run) => ({
  // ReaderT#run :: Monad m => ReaderT r m a ~> (r -> m a)
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

const rt = ReaderT.of(Identity, 10);
const rt2 = rt.chain(x => ReaderT.of(Identity, x + 5));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('constrained ReaderT ask and lift', () => {
    const src = preamble + `
// ReaderT :: Monad m => (r -> m a) -> ReaderT r m a
const ReaderT = (run) => ({
  // ReaderT#run :: Monad m => ReaderT r m a ~> (r -> m a)
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

const rtAsk = ReaderT.ask(Identity);
const rt2 = rtAsk.chain(env => ReaderT.of(Identity, env));
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
  });
});

describe('constraint validation — function type resolves to constructor', () => {
  test('constraint var bound to constructor function rewrites to TCon', () => {
    const src = `
// ::constraint Monad m { m :: { chain :: m a ~> (a -> m b) -> m b, of :: a -> m a } }

// Identity :: a -> Identity a
const Identity = (value) => ({
  value,
  chain: (fn) => fn(value),
});
// Identity.of :: a -> Identity a
Identity.of = (value) => Identity(value);

// Identity#chain :: Identity a ~> (a -> Identity b) -> Identity b

// wrap :: Monad m => (TypeRep m, a) -> m a
const wrap = (M, value) => M.of(value);
const result = wrap(Identity, 42);
    `;
    const r = engine.infer(src);
    expect(r.diagnostics).toHaveLength(0);
    const rt = typeToString(r.substitution.apply(r.topLevelBindings.get('result')!.type));
    expect(rt).toContain('Identity');
    expect(rt).not.toContain('->');
  });
});
