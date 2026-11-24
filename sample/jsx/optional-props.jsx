// Optional props: two conventions.
//
// 1. `Maybe` — an FP-style optional value: the prop is required, but the
//    value can be `Nothing`. Enforceable and explicit at the call site.
// 2. `String | Undefined` — the prop may be omitted entirely; combine with
//    a destructure default for a fallback value.

const { Just, Nothing, fromNullable } = require('../Maybe.js');

// UserBadge :: { name :: String, nickname :: Maybe String } -> ReactElement
const UserBadge = ({ name, nickname }) => (
  <span className="badge">
    {name} ({nickname.getOrElse('geen bijnaam')})
  </span>
);

const withNickname = <UserBadge name="Rafael" nickname={new Just('Raf')} />;
const withoutNickname = <UserBadge name="Ada" nickname={new Nothing()} />;

// fromNullable turns a possibly-null value into a Maybe.
// lookupNickname :: String -> (String | Null)
const lookupNickname = (name) => (name === 'Rafael' ? 'Raf' : null);
const dynamic = <UserBadge name="Rafael" nickname={fromNullable(lookupNickname('Rafael'))} />;

// Convention 2: `| Undefined` makes the prop omittable on the tag itself.
// Tooltip :: { text :: String, delay :: (Number | Undefined) } -> ReactElement
const Tooltip = ({ text, delay = 300 }) => (
  <span data-delay={delay}>{text}</span>
);

const defaultDelay = <Tooltip text="Opslaan" />;
const customDelay = <Tooltip text="Opslaan" delay={1000} />;

export { UserBadge, Tooltip, withNickname, withoutNickname, dynamic, defaultDelay, customDelay };
