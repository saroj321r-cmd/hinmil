import { curry } from './common';

// add :: (Number, Number, Number) -> Number
const add = (x, y, z) => x + y + z;

export default curry(add);