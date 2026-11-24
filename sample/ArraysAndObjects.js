const singleTypeArray = [1, 3]
const tupleTypeArray = [1, "three"]
const tripleTypeArray = [1, "three", true]

const singleTypeObj = { a: Number }
const tupleTypeObj = { a: 2, b: "three"}
const nTypeObj = { a: Number, b: "three", c: {}, d: 2}


// ::narrow Array
// isArray :: a -> Boolean
const isArray = a =>
  Array.isArray(a)

// concat :: ([a], [b]) ->  [a | b]
// concat :: ({a}, {...b}) -> { ...a, ...b } 
const concat = (arr, arr2) => {
  if (isArray(arr)) {
    return arr.concat(arr2)
  }
  return {...arr, ...arr2}
};

// Object#concat :: { a } ~> { b } -> {...a, ...b}
Object.prototype.concat = (obj) => {
  return {...this, ...obj}
};

// concatObjSpread :: ({...a}, {...b}) -> { ...a, ...b } 
const concatObjSpread = (obj, obj2) => {
  return obj.concat(obj2)
};

// Object#concat2 :: {...a} ~> {...b} -> {...a, ...b}
Object.prototype.concat2 = (obj) => {
  return {...this, ...obj}
};

// concatObjExpectDiagnostic :: ({a}, {b}) -> { ...a, ...b } 
const concatObjExpectDiagnostic = (obj1, obj2) => {
  return {}
};


const cs = concat({a: 1},{a: "2", b: 2});

// concatObjects :: ({ [k] :: a }, { [i] :: b }) -> { [k] :: a, [i] :: b }
const concatObjects = (obj, obj2) => {
  return {...obj, ...obj2}
};

const objects = concatObjects({age: 1, likedTypes: ["String"], friends: [{ name: "Jane", likedTypes: [true]}] }, {name: "John", likedTypes: [2], friends: [{name: 16, likedTypes: [1]}]})

// concatObjectsAlt :: ({ [k] :: a }, {...b}) -> { [k] :: a, ...b }
const concatObjectsAlt = (obj, obj2) => {
  return {...obj, ...obj2}
};



// reduce :: ((b, a) -> b, b, { [k] :: a }) -> b
const reduce = (fn, init, obj) => {
    return Object.keys (obj).reduce ((acc, key) => {
      return fn (acc, obj[key]);
    }, init);
};

const concatted = [1].concat([2])

//- c10 :: [{ name :: String, cars :: [a] } | { name :: String, cars :: [b] }]
const c10 = concat([{ name: "test", cars: []}], [{ name: "foemp", cars: []}])

const c11 = concat([{ name: "test", cars: [{ brand: "Mercedes", countries: [{name: "Belgium"}] }]}], [{ name: "foemp", cars: [{ brand: "Toyota", countries: [{name: "Holland"}]}]}])

// syntax highlighting on Test does not work when I put it on the next line

// test1 :: Test
const test1 = { name: "test", cars: []}

// test2 :: Test
const test2 = { name: "foemp", cars: []}

//- perfect
const c12 = concat([test1], [test2])

/* 
  Test :: {
  name :: String,
  cars :: [{ brand :: String }]
} */

// objectOverload :: { nam :: String } -> { nam :: String }
// objectOverload :: Test -> Test
const objectOverload = some => {
  return some
}

// testje :: Test
const testje = { name: "test", cars: []}

// objectOverload(testje)

// testEmpty :: {} -> {}
const testEmpty = emptyObject => {
  return {}
}

testEmpty({})

// values :: { [k] :: a } -> [a]
const values = obj => 
  Object.values(obj)

const vals = values({ a: 2, b: "str"})


// ::constraint Foldable f { f :: { reduce :: f a ~> ((b, a) -> b, b) -> b } }

// givFn :: (Function [a, b] b, [c, ...], { k :: a }) -> c
const givFn = (fn, args) => fn(args)

const g = givFn((a, b) => a, ["d", 2], { k: "dd", b: "d"})

// reduce2 :: Foldable f => ((b, a) -> b, b, f a) -> b
const reduce2 = (fn, init, foldable) =>
  foldable.reduce(fn, init)

const reducedArray = reduce2((acc, item) => acc + item, 0, [1, 2])

// ::narrow Array
// isAlsoArray :: dummy -> a -> Boolean
const isAlsoArray = dummy => a =>
  Array.isArray(a)

const testIsAlsoArray = a => {
  const b = a

  if (isAlsoArray("dummy")(a)) {
    // is array
    a
  }
}

// someStringsAndInts :: (String p, Number x) => (p, x) -> p
const someStringsAndInts = (str, num) => str

const nice = someStringsAndInts("2", 2)