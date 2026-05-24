// Bucket 2 — input void inside a form, opener emitted without /, then
// the form is closed before the orphan </input> arrives.
export const SearchBar = ({ onSubmit }: { onSubmit: (q: string) => void }) => {
  let q = '';
  return (
    <form onSubmit={() => onSubmit(q)}>
      <input type="search" onChange={(e) => (q = e.target.value)}>
      <button type="submit">Go</button>
    </form>
  );
};
