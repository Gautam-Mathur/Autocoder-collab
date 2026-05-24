// Bucket 2 — one-off shape: extra `}` at end of file produces
// `Unexpected "}"`. Documented as un-repairable noise (we cannot
// safely guess which brace was the genuine extra one).
export const DataTable = ({ rows }: { rows: { id: string }[] }) => {
  return (
    <table>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <td>{r.id}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}}
