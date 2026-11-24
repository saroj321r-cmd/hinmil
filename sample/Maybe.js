// Maybe :: Just a | Nothing
function Maybe() {
  throw new TypeError ("Maybe is abstract: use Just or Nothing");

}

// Just :: a -> Maybe a
class Just {
  constructor(value) {
    // Maybe#value :: Maybe a ~> a
    this.value = value;

    // ::private
    // Maybe#privateMember :: Maybe a ~> String
    this.privateMember = "private"
  }

  isNothing() {
    return false;
  }

  // Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
  map(fn) {
    return new Just(fn(this.value));
  }

  // Maybe#chain :: Maybe a ~> (a -> Maybe b) -> Maybe b
  chain(fn) {
    return fn(this.value);
  }

  // Maybe#getOrElse :: Maybe a ~> a -> a
  getOrElse(_defaultValue) {
    return this.value;
  }

  // Maybe#match :: Maybe a ~> { Nothing :: () -> b, Just :: a -> b } -> b
  match(p) {
    return p.Just(this.value)
  }

  // ::private
  // Maybe#privateFunction :: Maybe a ~> () -> String
  privateFunction(p) {
    return "private"
  }

  // Maybe.of :: a -> Maybe a
  static of(value) {
    return new Just(value);
  }
}

// Nothing :: () -> Maybe a
class Nothing {

  // Maybe#isNothing :: Maybe a ~> () -> Boolean
  // ::narrow Nothing
  isNothing() {
    return true;
  }

  map(_fn) {
    return new Nothing();
  }

  chain(_fn) {
    return new Nothing();
  }

  getOrElse(defaultValue) {
    return defaultValue;
  }

  match(p) {
    return p.Nothing()
  }

  static of(value) {
    return new Nothing();
  }
}

// of :: a -> Maybe a
const of = (value) => new Just(value);

// fromNullable :: a -> Maybe a
const fromNullable = (value) => value != null ? new Just(value) : new Nothing();

const justFive = new Just(5);
const mapped = justFive.map(x => x + 1);
const chained = justFive.chain(x => new Just(x * 2));
const value = justFive.getOrElse(0);

const nothing = new Nothing();
const ctorNot = nothing.constructor
const mappedNothing = nothing.map(x => x + 1);
const defaultValue = nothing.getOrElse(42);

// maybe :: (b, a -> b, Maybe a) -> b
const maybe = (defaultValue, fn, m) => {
  return m.match({
    Just: a => fn(a),
    Nothing: () => defaultValue
  })
}

module.exports = { Just, Nothing, of, fromNullable, maybe };
