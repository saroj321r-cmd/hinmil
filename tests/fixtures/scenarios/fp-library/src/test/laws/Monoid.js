"use strict";

const concat = require ("../../fl/concat");
const empty = require ("../../fl/empty");
const equals = require ("../../fl/equals");

// The Monoid laws of the Fantasy Land specification, as predicates: the
// empty value is neutral on both sides.

// leftIdentity :: (Setoid m, Monoid m) => TypeRep m -> m -> Boolean
const leftIdentity = M => m => equals (m) (concat (m) (empty (M)));

// rightIdentity :: (Setoid m, Monoid m) => TypeRep m -> m -> Boolean
const rightIdentity = M => m => equals (m) (concat (empty (M)) (m));

const monoidLaws = M => ({
  leftIdentity: leftIdentity (M),
  rightIdentity: rightIdentity (M)
});

module.exports = monoidLaws;
