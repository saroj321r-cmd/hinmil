// Redux Toolkit, typed by ../hm-types/reduxjs-toolkit.hm.  Scoped packages
// ('@reduxjs/toolkit') cannot be conventional stubs — they are wired up via
// the `overrides` entry in ../hinmil.config.json instead.
import { createSlice, configureStore, createAction } from '@reduxjs/toolkit';

const counterSlice = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: {
    increment: (state) => ({ value: state.value + 1 }),
    addBy: (state, action) => ({ value: state.value + action.payload }),
  },
});

// `configureStore({ reducer })` — the slice's state shape flows through:
// `getState().value :: Number`.
export const store = configureStore({ reducer: counterSlice.reducer });

console.log(store.getState().value + 1);

// The generated `actions` record stays polymorphic (HM cannot derive the
// name → creator mapping), so dispatching generated actions type-checks.
store.dispatch(counterSlice.actions.increment());
store.dispatch(counterSlice.actions.addBy(5));

// `createAction` gives a precisely typed creator: payload flows through.
const setTo = createAction('counter/setTo');
export const seven = setTo(7).payload + 0;
