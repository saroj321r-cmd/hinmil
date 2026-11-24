// ::types ./demo2.js
// Either :: Left e | Right a
// Either#$value :: Either e a ~> (e | a)
// Either#map :: Either e a ~> (a -> b) -> Either e b
// Either#ap :: Either e a ~> Either e (a -> b) -> Either e b
// Either#chain :: Either e a ~> (a -> Either e b) -> Either e b
// Either#traverse :: Applicative f => Either e a ~> (TypeRep f, a -> f b) -> f (Either e b)
// Either#match :: Either e a ~> ({ Left :: (e -> r), Right :: (a -> r) }) -> r
// Either.of :: a -> Either e a

class Either {
  constructor(x) {
    this.$value = x;
  }

  // ----- Pointed (Either a)
  static of(x) {
    return new Right(x);
  }
}

// Left :: e -> Either e a
class Left extends Either {

  // ::narrow Left
  // Either#isLeft :: Either e a ~> Boolean
  get isLeft() {
    return true;
  }

  // ::narrow Right
  // Either#isRight :: Either e a ~> Boolean
  get isRight() {
    return false;
  }

  static of(x) {
    throw new Error('`of` called on class Left (value) instead of Either (type)');
  }

  [util.inspect.custom]() {
    return `Left(${inspect(this.$value)})`;
  }

  map(_fn) {
    return this
  }

  ap(_f) {
    return this
  }

  chain(_fn) {
    return this
  }

  join() {
    return this;
  }

  sequence(of) {
    return of(this);
  }

  traverse(of, _fn) {
    return of.of(this)
  }
}

// Right :: a -> Either e a
class Right extends Either {
  get isLeft() {
    return false;
  }

  get isRight() {
    return true;
  }

  static of(x) {
    throw new Error('`of` called on class Right (value) instead of Either (type)');
  }

  [util.inspect.custom]() {
    return `Right(${inspect(this.$value)})`;
  }

  map(fn) {
    return Either.of(fn(this.$value));
  }

  ap(f) {
    // return f.match({
    //   Left: e => new Left(e),
    //   Right: g => this.map(g)
    // });

    if (f.isLeft) {
      return f;
    } 
    return new Right(f.$value(this.$value));
  }

  chain(fn) {
    return fn(this.$value);
  }

  join() {
    return this.$value;
  }

  sequence(of) {
    return this.traverse(of, x => x);
  }

  traverse(of, fn) {
    return fn(this.$value).map(Either.of);
  }
}
