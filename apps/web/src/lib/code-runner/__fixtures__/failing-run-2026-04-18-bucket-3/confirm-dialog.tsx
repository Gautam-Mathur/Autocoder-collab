import * as React from 'react';

export const ConfirmDialog = ({ onConfirm }: { onConfirm: () => void }) => {
  const handleClick: void = onConfirm();
  return <button onClick={handleClick}>Confirm</button>;
};
