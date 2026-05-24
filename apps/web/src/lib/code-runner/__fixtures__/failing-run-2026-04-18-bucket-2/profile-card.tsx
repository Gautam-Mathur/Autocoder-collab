// Bucket 2 — img void-element with an orphan </img> closer after the
// self-closing form. Verify-gate must drop the orphan.
export const ProfileCard = ({ user }: { user: { name: string; avatar: string } }) => {
  return (
    <article>
      <header>
        <img src={user.avatar} alt={user.name} />
        </img>
        <h2>{user.name}</h2>
      </header>
    </article>
  );
};
