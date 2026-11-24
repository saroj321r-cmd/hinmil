// Refs in JSX — useRef(null) DOM idiom, callback refs, forwardRef and
// useImperativeHandle, all typed through react.hm.
import { useRef, useEffect, useImperativeHandle, forwardRef } from 'react';

// FancyInput :: { label :: String } -> ReactElement
const FancyInput = forwardRef((props, ref) => (
  <label>
    {props.label}
    <input ref={ref} className="fancy" />
  </label>
));

// Focusable :: { children :: a } -> ReactElement
const Focusable = forwardRef((props, ref) => {
  const inner = useRef(null);
  useImperativeHandle(ref, () => ({ focus: () => inner.current.focus() }));
  return <div tabIndex={0} ref={inner}>{props.children}</div>;
});

// App :: {} -> ReactElement
const App = () => {
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current.focus(); }, []);
  return (
    <form onSubmit={(e) => e}>
      <FancyInput label="Naam" ref={inputRef} />
      <Focusable ref={(node) => { node; }}>klik mij</Focusable>
      <input ref={inputRef} placeholder="rechtstreeks" />
    </form>
  );
};

export default App;
