import * as React from 'react';

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
