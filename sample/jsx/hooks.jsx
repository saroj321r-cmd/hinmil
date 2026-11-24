// React hooks, typed by ../react.hm (wired up via the `overrides` entry in
// ../hinmil.config.json — no node_modules needed).
import { useState, useEffect, useMemo, useCallback, useRef } from 'react';

// `useState(0)` gives `count :: Number` and a setter that accepts a new
// value or an updater function.
// Counter :: { start :: Number } -> ReactElement
const Counter = ({ start }) => {
  const [count, setCount] = useState(start);
  return (
    <div>
      <p>Telling: {count}</p>
      <button onClick={() => setCount(count + 1)}>+1</button>
      <button onClick={() => setCount((c) => c - 1)}>-1</button>
      <button onClick={() => setCount(start)}>reset</button>
    </div>
  );
};

// useRef gives `{ current :: a }`; useEffect takes the callback and an
// optional dependency array; useMemo's result keeps the callback's type.
// Stopwatch :: { label :: String } -> ReactElement
const Stopwatch = ({ label }) => {
  const [seconds, setSeconds] = useState(0);
  const lastSeen = useRef(0);

  useEffect(() => {
    lastSeen.current = seconds;
    return () => {
      lastSeen.current = 0;
    };
  }, [seconds]);

  const pretty = useMemo(() => label + ': ' + seconds + 's', [label, seconds]);
  const restart = useCallback(() => setSeconds(0), []);

  return (
    <p onDoubleClick={restart} title={pretty}>
      {pretty} (vorige: {lastSeen.current})
    </p>
  );
};

export { Counter, Stopwatch };
