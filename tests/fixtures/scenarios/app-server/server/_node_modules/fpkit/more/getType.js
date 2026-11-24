"use strict";

// The runtime type name: a value's own `@@type`, else the built-in tag
// (`[object Array]` gives "Array").
// getType :: a -> String
const getType = candidate => {
  if (candidate && candidate["@@type"]) return candidate["@@type"];
  const tagged = Object.prototype.toString.call (candidate);
  return tagged.substring (8, tagged.length - 1);
};

const money = {
  //::hidden
  "@@type": "Money",
  cents: 1250
};

const moneyType = getType (money);

module.exports = getType;
