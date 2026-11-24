// Regression: an annotation immediately above a destructuring assignment
// (`const { x } = ...`) must attach to the destructured binding `x`, not
// be pushed forward to the next named declaration in the file.

import { InferenceEngine } from '../../src/index';

describe('annotation attachment for destructuring', () => {
  test('object destructuring picks the matching binding name', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(`
      const props = { applicationId: 1 };
      // applicationId :: Number
      const { applicationId } = props;

      export const memberCount = 7;
    `);
    const mismatch = r.diagnostics.find(d =>
      d.message.includes('does not match annotation name'),
    );
    expect(mismatch).toBeUndefined();
  });

  test('object destructuring with renamed binding matches the local name', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(`
      const props = { createdAt: 1 };
      // memberCreatedAt :: Number
      const { createdAt: memberCreatedAt } = props;

      export const otherThing = 7;
    `);
    const mismatch = r.diagnostics.find(d =>
      d.message.includes('does not match annotation name'),
    );
    expect(mismatch).toBeUndefined();
  });

  test('destructuring without matching binding still defaults to first binding (mismatch as before)', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(`
      const props = { foo: 1 };
      // bar :: Number
      const { foo } = props;
    `);
    const mismatch = r.diagnostics.find(d =>
      d.message.includes("Declaration name 'foo' does not match annotation name 'bar'"),
    );
    expect(mismatch).toBeDefined();
  });
});

describe('trailing same-line annotation attachment', () => {
  // Regression: a trailing annotation documenting its OWN statement
  // (`const [filter, setFilter] = useState('x'); // filter :: String`) used
  // to leak forward and produce a spurious name mismatch on the next
  // declaration (now that nested call-initialized bindings attach too).
  test('trailing annotation attaches backward to its own statement', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(`
      const component = () => {
        const filter = "alle"; // filter :: String
        const open = 5;
        return open;
      };
    `);
    const mismatch = r.diagnostics.find(d =>
      d.message.includes('does not match annotation name'),
    );
    expect(mismatch).toBeUndefined();
  });

  test('trailing annotation on a destructured binding attaches backward', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(`
      const pair = ["alle", 1];
      const component = () => {
        const [filter, count] = pair; // filter :: String
        const open = 5;
        return open;
      };
    `);
    const mismatch = r.diagnostics.find(d =>
      d.message.includes('does not match annotation name'),
    );
    expect(mismatch).toBeUndefined();
  });

  test('trailing annotation for a later declaration still attaches forward', () => {
    const engine = new InferenceEngine();
    const r = engine.infer(`
      foo(); // bar :: Number
      const bar = 1;
      const foo = () => 0;
    `);
    const mismatch = r.diagnostics.find(d =>
      d.message.includes('does not match annotation name'),
    );
    expect(mismatch).toBeUndefined();
  });
});
