const { Left, Right } = require("./Either");

const leftie = Left("foemp")
.chain(x => Right(2))
.chain(x => Right(x))
.chain(x => Right(true))
.chain(x => Right(x));

const rightie = Right("foemp").map(x => 2)