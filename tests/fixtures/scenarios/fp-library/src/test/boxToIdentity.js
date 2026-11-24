"use strict";

const Id = require ("../Id");

// Interprets a boxed instruction as an Id.
// BoxToIdentity :: { value :: a, ...r } -> Id a
const BoxToIdentity = box => Id (box.value);

module.exports = BoxToIdentity;
