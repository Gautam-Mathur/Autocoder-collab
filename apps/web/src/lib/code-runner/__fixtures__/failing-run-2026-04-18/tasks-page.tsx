import { useState } from 'react';

export const TasksPage = () => {
  const [filter, setFilter] = useState('');
  return (
    <ul>
      <input onChange={(e) = /> setFilter(e.target.value)} placeholder="search" />
      <li onClick={(e) = /> console.log(e)}>Task 1</li>
    </ul>
  );
};
