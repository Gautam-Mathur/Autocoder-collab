// Bucket 2 — one-off shape: stray TS type annotation in JSX expression
// produces `Unexpected ":"`. Documented as un-repairable noise; the
// verify gate must surface it cleanly rather than silently mangling.
export const ConfirmDialog = ({ onConfirm }: { onConfirm: () => void }) => {
  const handleClick: void = onConfirm();
  return <button onClick={handleClick}>Confirm</button>;
};
