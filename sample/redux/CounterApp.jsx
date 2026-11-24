// react-redux hooks + Provider, typed by ../hm-types/react-redux.hm
// (conventional stub) — React itself comes from the bundled typings.
import { useState } from 'react';
import { Provider, useSelector, useDispatch } from 'react-redux';
import { store } from './store';

// `useSelector` returns whatever the selector produces; `useDispatch`
// returns the store's dispatch function.
// Counter :: {} -> ReactElement
const Counter = () => {
  const count = useSelector((state) => state.counter);
  const dispatch = useDispatch();
  const [step, setStep] = useState(1);
  return (
    <div style={{ display: 'flex', gap: '8px' }}>
      <p>Count: {count}</p>
      <button onClick={() => dispatch({ type: 'INCREMENT' })}>+{step}</button>
      <button onClick={() => setStep(step + 1)}>bigger steps</button>
    </div>
  );
};

// The Provider receives the (typed) store record as a prop.
// CounterApp :: {} -> ReactElement
export const CounterApp = () => (
  <Provider store={store}>
    <Counter />
  </Provider>
);
