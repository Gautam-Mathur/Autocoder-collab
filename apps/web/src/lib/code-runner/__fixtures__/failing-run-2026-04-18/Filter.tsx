export const Filter = ({ onChange }: { onChange: (v: string) => void }) => (
  <select onChange={(e) = /> onChange(e.target.value)}>
    <option>all</option>
    <option>open</option>
  </select>
);
