import { curry } from './common';

// add :: (Number, Number) -> Number
const add = (a, b) => a + b;

// addCurried :: Number -> Number -> Number
const addCurried = a => b=> a + b;

// length :: String -> Number
const length = (s) => s.length;

// map :: ((a -> b), Array a) -> Array b
const map = (f, arr) => arr.map(f)

const numbers = [x => 1, x => 2, x => 3];
const doubled = numbers.map(x => x(1) + 2)
const strings = doubled.map(n=> n + "!");

// identity :: a -> a
const identity = (x) => x;

const result = identity(42);
const greeting = identity("hello");

// Box :: a -> Box a
export const Box = (value) => ({
  // Box#map :: Box a ~> (a -> b) -> Box b
  map: (f) => Box(f(value)),
  // Box#chain :: Box a ~> (a -> Box b) -> Box b
  chain: (f) => f(value),
  // Box#fold :: Box a ~> (a -> b) -> b
  fold: (f) => f(value),
  // Box#value :: Box a ~> a
  value
});


const boxedNumber = Box(5);
const unboxed = boxedNumber.value;
const mapped = boxedNumber.map((n) => n * 2).value;

const chained = Box("hello").map(s => s.length).map(x => true)

// Pair :: (a, b) -> Pair a b
// Pair#snd :: Pair a b ~> b
export const Pair = (fst, snd) => ({ 
  // Pair#fst :: Pair a b ~> a
  fst, 
  snd 
});

const p = Pair(1, "hello");

const first = p.fst;
const second = p.snd;

// Box.fromPair :: Pair a c -> Box c
Box.fromPair = pair => Box(pair.snd);

// Hover over variables and function calls to see inferred types!

const boxFromPair = Box.fromPair(p).map((s) => s).chain(s => Box(2));

// Box.withPair :: Pair a c -> Box (Pair a c)
Box.withPair = pair => Box(pair);

// Hover over variables and function calls to see inferred types!

const boxWithPair = Box.withPair(p).map(p => p.fst)


// closureTest :: Box Number -> ((Pair Number String, Box Number) -> Box String -> Number)
const closureTest = (x) => {
  return function(y, z) {
    return u => z.value
  }
}

// --- Destructuring in function parameters ---

// Object destructuring: extracts fields from the parameter
const getName = ({ name, age }) => name;
const person = { name: "Alice", age: 30 };
const aliceName = getName(person);

// Array destructuring: extracts elements from an array parameter
const head = ([first, second]) => first;
const nums = [10, 20, 30];
const ten = head(nums);

// head2 :: [String, Number] -> String
const head2 = ([first, second]) => first;

const head2Ex = head2(["3", 3])

// head3 :: [String, Number] -> String
const head3 = ([first, second, third]) => first;

// head4 :: [String, ..., Number] -> String
const head4 = ([first, second, third, fourth, fifth, sixth]) => first;
const head4Ex = head4(["3", 2])

// Nested object destructuring
const getStreet = ({ address: { street } }) => street;
const user = { address: { street: "Keizersgracht", city: "Amsterdam" } };
const street = getStreet(user);

// Mixed: regular param + destructured param
const greet = (greeting, { name }) => greeting + " " + name;
const hello = greet("Hallo", person);

// Destructuring in higher-order functions
const people = [{ name: "Bob", age: 25, address: { street: "Keizersgracht" } }, { name: "Eve", age: 31, address: { street: "Keizersgracht" } }];
const names = people.map(({ address: { street }, name }) => name);
const ages = people.map(({ age }) => age + 1);

