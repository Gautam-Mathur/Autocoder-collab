export const SearchBox = ({ onQuery }: { onQuery: (q: string) => void }) => (
  <input
    type="search"
    onInput={(e) = /> onQuery((e.target as HTMLInputElement).value)}
    placeholder="Search…"
  />
);
