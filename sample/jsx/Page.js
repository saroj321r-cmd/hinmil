import { ProfileCard } from "./components";

// Page :: {} -> ReactElement
const Page = () => {
  return (
    <div>
      <ProfileCard name="John Doe" avatarUrl="john-doe.jpg" />
      <p>About John Doe: John is a software engineer with 10 years of experience in web development.</p>
    </div>
  )
};

export default Page;