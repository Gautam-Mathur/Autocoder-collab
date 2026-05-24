// Bucket 2 — JSX void-element promotion. The LLM emitted Input as a
// non-self-closing tag inside a div, then closed the div, leaving an
// orphan </Input> that broke parsing.
//
// Real shape from failing-run-2026-04-18:
//   "Unexpected closing 'Input' tag does not match opening 'div' tag"
import { useState } from 'react';

export const SignInForm = () => {
  const [email, setEmail] = useState('');
  return (
    <div>
      <label>Email</label>
      <Input value={email} onChange={(e) => setEmail(e.target.value)}>
      <button type="submit">Sign in</button>
      </Input>
    </div>
  );
};
