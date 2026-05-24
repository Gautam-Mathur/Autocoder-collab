// Real-world LLM output from failing run on 2026-04-18.
// The mangled-arrow `(e) = />` shape appeared inside JSX attribute.
import { useState } from 'react';

export const AuthPage = () => {
  const [email, setEmail] = useState('');
  return (
    <div>
      <input value={email} onChange={(e) = /> setEmail(e.target.value)} />
      <button onClick={(e) = /> console.log('login', email)}>Sign in</button>
    </div>
  );
};
