// Function components with typed props.
//
// A component's props signature uses the built-in `ReactElement` type as its
// result: JSX like `<Badge label="nieuw" />` type-checks as the call
// `Badge({ label: 'nieuw' })`, so a wrong or missing prop is reported exactly
// like a wrong function argument.

// Badge :: { label :: String } -> ReactElement
const Badge = ({ label }) => <span className="badge">{label}</span>;

// Avatar :: { url :: String, size :: Number } -> ReactElement
const Avatar = ({ url, size }) => (
  <img src={url} width={size} height={size} alt="avatar" />
);

// Children arrive as the `children` prop, like in React itself.
// Card :: { title :: String, children :: a } -> ReactElement
const Card = ({ title, children }) => (
  <section className="card">
    <h2>{title}</h2>
    <div className="card-body">{children}</div>
  </section>
);

// Components compose: `<Card>` receives `<Avatar>` and `<Badge>` elements.
// ProfileCard :: { name :: String, avatarUrl :: String } -> ReactElement
const ProfileCard = ({ name, avatarUrl }) => (
  <Card title={name}>
    <Avatar url={avatarUrl} size={64} />
    <Badge label="lid" />
  </Card>
);

// Try it: change `size={64}` to `size="64"` or drop the `label` prop above —
// both produce a type error on the exact attribute.

export { Badge, Avatar, Card, ProfileCard };
