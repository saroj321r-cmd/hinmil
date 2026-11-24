// curryEx :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryEx = (fn) => {
  const curried = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => curried(...args, ...next);
  }
  return curried;
}

const curriedAdd = curryEx((a, b, c) => a + b + c)
const partialAdd = curriedAdd(1)
const partialAdd2 = partialAdd(2)
const finalAdd = partialAdd2(3)

// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const memoize = (fn) => {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const r = fn(...args);
    cache.set(key, r);
    return r;
  }
}

const greet = (name, age, address) => name + " is " + age;

const memoGreet = memoize(greet)
const greetRes = memoGreet("Alice", 30, "123 Main St")

// once :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const once = (fn) => {
  let called = false, result;
  return (...args) => {
    if (!called) { called = true; result = fn(...args); }
    return result;
  }
}

// init :: (String, Number) -> Boolean
const init = (name, port) => true;

const initOnce = once(init)
const initRes = initOnce("localhost", 3000)

// tryCatch :: ((a, b, ...) -> z) -> (a, b, ...) -> z | Error
const tryCatch = (fn) => (...args) => {
  try { return fn(...args); }
  catch (e) { return e; }
}

// divide :: (Number, Number) -> Number
const divide = (a, b) => a / b;

const safeDivide = tryCatch(divide)
const divRes = safeDivide(10, 2)

// memoizeCurried :: (a -> b -> ... -> z) -> a -> b -> ... -> z
const memoizeCurried = (fn) => {
  const cache = new Map();

  const memoized = (cacheNode, f) => (arg) => {
    if (cacheNode.has(arg)) {
      return cacheNode.get(arg);
    }

    const result = f(arg);

    // If result is a function, we need to keep currying + memoizing
    if (typeof result === "function") {
      const nextCache = new Map();
      const nextFn = memoized(nextCache, result);
      cacheNode.set(arg, nextFn);
      return nextFn;
    }

    // Final value
    cacheNode.set(arg, result);
    return result;
  };

  return memoized(cache, fn);
};

const greet2 = name => age => name + " is " + age;

const memoGreet2 = memoizeCurried(greet2)
