const { Box } = require('./demo');
import RTask from './RTask';
import { Right } from './Either';
import { Just, Nothing } from './Maybe';
import curriedAdd from './curriedAdd';
import { curry } from './common';

// ::types ./demo
// boxOut :: Box a -> a
const boxOut = box => box.value;

// map :: Functor f => (a -> b) -> f a -> f b
const map = fn => functor => functor.map(fn);

// chain :: Chain m => (a -> m b) -> m a -> m b
const chain = fn => monad => monad.chain(fn);

// concat :: Semigroup s => s -> s -> s 
const concat = a => b => a.concat(b)

// concat2 :: Semigroup (s a) => s a -> s a -> s a
const concat2 = a => b => a.concat(b)


const box1 = Box(1);

const box2 = map(x => "2")(box1);



/* Person :: { 
    name :: String, 
    age :: Number, 
    email :: Maybe String,
    friends :: [Person] } */

// task :: RTask {leader :: Person} e (String | Boolean | Person)
const task = RTask((rej, res, e) => {
  if (1 === 1) {
    res("foemp")
  } else if (2 === 2) {
    // if I remove the signature, e.leader is a string because of res ("foemp") 2 lines earlier.
    // e.leader.friends[0].name does not work
    res(e.leader);
  } else {
    res(true)
  }
})


const res = task.map(x => x + "!").fork(console.log, console.log, {});

const res2 = map(x => x + "!")(task);


const res3 = Right("foemp");


const res4 = map(x => x + "!")(res3);

const res5 = Just(2)

const res6 = map(x => x + "!")(res5);

const res7 = chain(x => Right(x + "!"))(res3);

const { fromPromise } = RTask

const pFn = (x, y) => {
  return Promise.reject(2)
}
const respFn = pFn(2, 2)

// pFn2 :: (Number, (Number | String)) -> Promise e Number
const pFn2 = (x, y) => {
  if (typeof y === "string") {
    return Promise.resolve(x + y)
  }
  return Promise.resolve(x)
}

const res8 = fromPromise(pFn2);

res8(1, 2)

// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = x => typeof x === "number";

// ::narrow Person
// isPerson :: a -> Boolean
const isPerson = x => typeof x === "object" && x !== null && "name" in x && "age" in x && "friends" in x;

// testIsString :: a -> String
const testIsString = x => {
  if (isPerson(x)) {
    return x.name;
  }
  return "foemp"
}

// narrowing :: (Person | Number | String) -> a
const narrowing = x => {
  if (isPerson(x)) {
    return x.name
  }
  return x
}

// run :: [Person] -> ()
const run = (persons) => {
  let text = "";

  let i = 0;
  while (i < 10) {
    text += "The number is " + i + "<br>";
    i++;
  }

  const cars = ["BMW", "Volvo", "Saab", "Ford"];
  let len = cars.length;

  let textCars = "";
  for (let i = 0; i < len; i++) {
    textCars += cars[i] + "<br>";
  }

  persons.forEach(p => {
    text += p.name + " is " + p.age + " years old.<br>";
  })
}

const app = (carName) => {
  return RTask((rej) => {
    rej(Box(carName + " is not a great car!"));
  })
}

const cancel = app("volvo").fork(e => {console.log(e)}, sBox => {
  console.log(sBox)
}, {})



// fn0 :: Number -> [Number]
const fn0 = x => [1]

// fn1 :: Number -> Number
const fn1 = x => 1

// fn2 :: String -> Number
const fn2 = x => 2

// fn3 :: Boolean -> String
const fn3 = x => "foemp";

// args should be of type [a]
// ex1 :: (a, ..., z) -> z
const ex1 = (...args) => args[args.length - 1]

const ex1res = ex1(1, 2, 3, 4, "foemp")

// args should be of type [a]
// ex2 :: (a, b, ..., y, z) -> b
const ex2 = (...args) => args[1]

const ex2res = ex2(1, "foemp", 3, 4, 5)

// args should be of type [a -> b]
// ex3 :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const ex3 = (...args) =>  {
  return args.reduce((acc, fn) => x => fn(acc(x)))
}

const ex3res = ex3(
  fn2,
  fn1,
  fn0
)

// args should be of type [y -> z]
// ex4 :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const ex4 = (...args) =>  {
  return args.reduceRight((acc, fn) => x => fn(acc(x)))
}


const ex4res = ex4(
  fn0,
  fn1,
  fn2,
  fn3
)

// args should be of type [a -> m b]
// ex5 :: Chain m => ((a -> m b), (b -> m c), ..., (y -> m z)) -> a -> m z
const ex5 = (...args) =>  {
  const [first, ...rest] = args;
  return rest.reduce((acc, fn) => x => acc(x).chain(fn), first)
}


const ex5res = ex5(
  x => Right(x + "!"),
  x => Right(x + "?"),
  x => Right(2)
)

// args should be of type [a -> m b]
// ex6 :: Chain m => ((y -> m z), ...,(b -> m c), (a -> m b)) -> a -> m z
const ex6 = (...args) =>  {
  const [first, ...rest] = args;
  return rest.reduce((acc, fn) => x => acc(x).chain(fn), first)
}


const ex6res = ex6(
  // :: String -> Box Boolean
  x => Box(true),
  // :: Number -> Box String
  x => Box(x + "?"),
  // :: String -> Box Number
  x => Box(2)
)

// ex7 :: [a, b, c, ..., d] -> c
const ex7 = (arr) => {
  return arr[arr.length - 1]
}

const ex7res = ex7([1, true, 3, 4, "foemp"])

// ex8 :: [a -> b, b -> c, ..., y -> z] -> a -> z
const ex8 = (arr) => {
  return arr.reduce((acc, fn) => x => fn(acc(x)))
}

const ex8res = ex8([fn3, fn2, fn1, fn0]);

// ex9 :: [y -> z, ..., b -> c, a -> b] -> a -> z
const ex9 = (arr) => {
  return arr.reduceRight((acc, fn) => x => fn(acc(x)))
}

const ex9res = ex9([fn0, fn1, fn2, fn3]);


// args should be of type [a -> m b]
// ex10 :: Chain m => [y -> m z, ...,b -> m c, a -> m b] -> a -> m z
const ex10 = (args) =>  {
  const [first, ...rest] = args;
  return rest.reduce((acc, fn) => x => acc(x).chain(fn), first)
}


const ex10res = ex10([
  // :: String -> Box Boolean 
  x => Box(true),
  // :: Number -> Box String
  x => Box(x + "?"),
  // :: String -> Box Number
  x => Box(2)
])

// args should be of type [a -> m b]
// ex11 :: Chain m => [y -> m z, ...,b -> m c, a -> m b] -> a -> m c
const ex11 = (args) =>  {
  const [first, ...rest] = args;
  return rest.reduce((acc, fn) => x => acc(x).chain(fn), first)
}


const ex11res = ex11([
  // :: String -> Box Boolean
  x => Box(true),
  // :: Number -> Box String
  x => Box(x + "?"),
  // :: String -> Box Number
  x => Box(2)
])



// findProblems :: (a -> b) -> (Number | null) -> Number | null
const findProblems = fn => x => {
  return 2
}

const probsRes = findProblems(x => 2)(2)

const six = curriedAdd(1, 2)(3)


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

const spreadFirstRes = curryEx((a, b, c) => a + b + c)(1)(2)(3)

// memoize :: ((a, b, ...) -> z) -> (a, b, ...) -> z
const memoize = (fn) => {
  const cache = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    if (cache.has(key)) return cache.get(key);
    const result = fn(...args);
    cache.set(key, result);
    return result;
  }
}

const add6 =  curriedAdd(1, 2)(2)

// intellisense only works when assigning to a variable, not []

const convert = curry((toString, x) =>  {
  if (toString) {
    return String(x);
  }
  return x;
})

const converter = convert(false)(2)

// .map is only suggested on the same line as box
const bb = Box(1)
  .map(convert(true))
  .map(x => 2)

const buh =  [1, 2, 3];

[1, 2].map((x, i, b) => x)

// undefinedBox :: Box undefined
export const undefinedBox = Box()

/* Animal :: { 
    name :: String
     } */

// convertAnimalToPerson :: Animal -> Person
const convertAnimalToPerson = animal => ({
  name: animal.name,
  email: Just("foemp"),
  age: 2,
  friends: []
})

// animal :: Animal
const animal = { name: "Fido" }

const person = convertAnimalToPerson(animal)

// convertEmailToPerson :: String -> Person
const convertEmailToPerson = email => ({
  name: "hello",
  email: Just(email),
  age: 2,
  friends: []
})

// traverse :: Applicative f, Traversable t => (TypeRep f, a -> f b, t a) -> f (t b)
const traverse = (tr, fn, traversable) =>  {
  return traversable.traverse(tr, fn)
}

// add :: Number -> Number -> Number
const add = curry((a, b) => a + b)

// identity :: a -> a
const identity = x => x