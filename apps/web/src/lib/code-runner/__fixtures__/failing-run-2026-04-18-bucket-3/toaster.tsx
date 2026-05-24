import * as React from 'react';

type Toast = { id: string; title: string };

export const Toaster = ({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) => {
  return (
    <ul>
      {toasts.map((toast) => (
        <li key={toast.id}>
          <span>{toast.title}</span>
          <button onClick={() => dismiss(toast.id))}>Close</button>
        </li>
      ))}
    </ul>
  );
};
