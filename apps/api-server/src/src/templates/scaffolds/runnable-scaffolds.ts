/**
 * Runnable scaffolds — concrete, working app file-sets ported from the legacy
 * autocoder runnable-templates. Each scaffold is a complete, runnable WebContainer
 * project (Vite + React, or Express + static HTML) that the codegen pipeline can
 * use as a *starting point* instead of always falling through to the generic
 * page-builder.
 *
 * Conventions:
 *   - File paths are relative to project root.
 *   - `language` matches the existing GeneratedFile shape used by the orchestrator.
 *   - Each scaffold function returns a fresh array (no shared references).
 *
 * If you add a new scaffold, register it in `scaffoldRegistry` at the bottom and
 * reference its id from `appArchetypes`.
 */

export interface ScaffoldFile {
  path: string;
  content: string;
  language: string;
}

// =====================================================================
// Shared helpers (mirrors the legacy autocoder runnable-templates helpers)
// =====================================================================

function packageJson(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify(
    {
      name: name.toLowerCase().replace(/\s+/g, '-'),
      version: '1.0.0',
      type: 'module',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
      dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0', ...deps },
      devDependencies: { vite: '^5.1.0', '@vitejs/plugin-react': '^4.2.0' },
    },
    null,
    2,
  );
}

function fullstackPackageJson(name: string, deps: Record<string, string> = {}): string {
  return JSON.stringify(
    {
      name: name.toLowerCase().replace(/\s+/g, '-'),
      version: '1.0.0',
      type: 'module',
      scripts: { dev: 'node server.js', start: 'node server.js' },
      dependencies: { express: '^4.18.2', cors: '^2.8.5', ...deps },
    },
    null,
    2,
  );
}

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0' }
});
`;

const indexHtml = (title: string) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`;

const MAIN_JSX = `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
`;

function viteScaffold(opts: {
  name: string;
  pkgName: string;
  title: string;
  css: string;
  appJsx: string;
  extraDeps?: Record<string, string>;
  extraFiles?: ScaffoldFile[];
}): ScaffoldFile[] {
  return [
    { path: 'package.json', language: 'json', content: packageJson(opts.pkgName, opts.extraDeps) },
    { path: 'vite.config.js', language: 'javascript', content: VITE_CONFIG },
    { path: 'index.html', language: 'html', content: indexHtml(opts.title) },
    { path: 'src/main.jsx', language: 'jsx', content: MAIN_JSX },
    { path: 'src/index.css', language: 'css', content: opts.css },
    { path: 'src/App.jsx', language: 'jsx', content: opts.appJsx },
    ...(opts.extraFiles || []),
  ];
}

// =====================================================================
// COUNTER
// =====================================================================

export function counterScaffold(): ScaffoldFile[] {
  return viteScaffold({
    name: 'Counter App',
    pkgName: 'counter-app',
    title: 'Counter App',
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', system-ui, sans-serif;
  background: linear-gradient(135deg, #0f0f23 0%, #1a1a2e 100%);
  color: #e2e8f0;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.container {
  text-align: center;
  padding: 3rem;
  background: rgba(255,255,255,0.05);
  border-radius: 24px;
  border: 1px solid rgba(255,255,255,0.1);
  backdrop-filter: blur(10px);
}
h1 { font-size: 1.5rem; color: #94a3b8; margin-bottom: 1rem; }
.counter {
  font-size: 6rem;
  font-weight: 700;
  background: linear-gradient(135deg, #6366f1, #a855f7);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 1rem 0;
}
.buttons { display: flex; gap: 1rem; justify-content: center; }
button {
  padding: 1rem 2rem;
  font-size: 1.5rem;
  font-weight: 600;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.decrement { background: #ef4444; color: white; }
.decrement:hover { background: #dc2626; transform: translateY(-2px); }
.increment { background: #6366f1; color: white; }
.increment:hover { background: #4f46e5; transform: translateY(-2px); }
.reset { background: #1f2937; color: #e2e8f0; border: 1px solid #374151; }
.reset:hover { background: #374151; }`,
    appJsx: `import { useState } from 'react';

export default function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="container">
      <h1>Counter</h1>
      <div className="counter">{count}</div>
      <div className="buttons">
        <button className="decrement" onClick={() => setCount(c => c - 1)}>-</button>
        <button className="reset" onClick={() => setCount(0)}>Reset</button>
        <button className="increment" onClick={() => setCount(c => c + 1)}>+</button>
      </div>
    </div>
  );
}
`,
  });
}

// =====================================================================
// TODO LIST (front-end only)
// =====================================================================

export function todoScaffold(): ScaffoldFile[] {
  return viteScaffold({
    name: 'Todo List',
    pkgName: 'todo-app',
    title: 'Todo List',
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', system-ui, sans-serif; background: #0f0f23; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
.container { max-width: 600px; margin: 0 auto; }
h1 { text-align: center; margin-bottom: 2rem; font-size: 2rem; }
.add-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
input { flex: 1; padding: 0.75rem 1rem; border: 1px solid #374151; border-radius: 8px; background: #1a1a2e; color: #e2e8f0; font-size: 1rem; }
input:focus { outline: none; border-color: #6366f1; }
button { padding: 0.75rem 1.5rem; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; transition: all 0.2s; }
.add-btn { background: #6366f1; color: white; }
.add-btn:hover { background: #4f46e5; }
.todo-list { list-style: none; }
.todo-item { display: flex; align-items: center; gap: 1rem; padding: 1rem; background: #1a1a2e; border-radius: 8px; margin-bottom: 0.5rem; border: 1px solid #374151; }
.todo-item.completed span { text-decoration: line-through; color: #6b7280; }
.todo-item span { flex: 1; }
.delete-btn { background: #ef4444; color: white; padding: 0.5rem 1rem; }
.delete-btn:hover { background: #dc2626; }
.checkbox { width: 20px; height: 20px; cursor: pointer; }
.empty { text-align: center; color: #6b7280; padding: 2rem; }`,
    appJsx: `import { useState } from 'react';

export default function App() {
  const [todos, setTodos] = useState([
    { id: 1, text: 'Learn React', completed: false },
    { id: 2, text: 'Build something awesome', completed: false }
  ]);
  const [input, setInput] = useState('');

  const addTodo = (e) => {
    e.preventDefault();
    if (!input.trim()) return;
    setTodos([...todos, { id: Date.now(), text: input, completed: false }]);
    setInput('');
  };

  const toggleTodo = (id) => {
    setTodos(todos.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTodo = (id) => {
    setTodos(todos.filter(t => t.id !== id));
  };

  return (
    <div className="container">
      <h1>Todo List</h1>
      <form className="add-form" onSubmit={addTodo}>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Add a new task..." />
        <button type="submit" className="add-btn">Add</button>
      </form>
      {todos.length === 0 ? (
        <p className="empty">No todos yet. Add one above!</p>
      ) : (
        <ul className="todo-list">
          {todos.map(todo => (
            <li key={todo.id} className={\`todo-item \${todo.completed ? 'completed' : ''}\`}>
              <input type="checkbox" className="checkbox" checked={todo.completed} onChange={() => toggleTodo(todo.id)} />
              <span>{todo.text}</span>
              <button className="delete-btn" onClick={() => deleteTodo(todo.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
`,
  });
}

// =====================================================================
// CALCULATOR (basic; the "scientific" variety is overlaid by a concept)
// =====================================================================

export function calculatorScaffold(): ScaffoldFile[] {
  return viteScaffold({
    name: 'Calculator',
    pkgName: 'calculator-app',
    title: 'Calculator',
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', system-ui, sans-serif; background: #0f0f23; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.calculator { background: #1a1a2e; border-radius: 16px; padding: 1.5rem; border: 1px solid #374151; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5); }
.display { background: #0f0f23; padding: 1.5rem; border-radius: 8px; margin-bottom: 1rem; text-align: right; }
.display .previous { color: #6b7280; font-size: 1rem; min-height: 1.5rem; }
.display .current { color: #e2e8f0; font-size: 2.5rem; font-weight: 600; }
.buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
button { padding: 1.25rem; font-size: 1.25rem; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; transition: all 0.15s; background: #374151; color: #e2e8f0; }
button:hover { background: #4b5563; }
button:active { transform: scale(0.95); }
.operator { background: #6366f1; }
.operator:hover { background: #4f46e5; }
.equals { background: #22c55e; grid-column: span 2; }
.equals:hover { background: #16a34a; }
.clear { background: #ef4444; }
.clear:hover { background: #dc2626; }
.zero { grid-column: span 2; }
.history-panel { margin-top: 1rem; max-height: 150px; overflow-y: auto; padding: 0.75rem; background: #0f0f23; border-radius: 8px; border: 1px solid #374151; }
.history-panel h3 { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; margin-bottom: 0.5rem; }
.history-item { color: #cbd5e1; font-size: 0.875rem; padding: 0.25rem 0; border-bottom: 1px solid #1f2937; cursor: pointer; }
.history-item:hover { color: #e2e8f0; }
.history-item:last-child { border-bottom: none; }`,
    appJsx: `import { useState } from 'react';

export default function App() {
  const [current, setCurrent] = useState('0');
  const [previous, setPrevious] = useState('');
  const [operator, setOperator] = useState(null);

  const handleNumber = (num) => {
    if (current === '0' && num !== '.') setCurrent(num);
    else if (num === '.' && current.includes('.')) return;
    else setCurrent(current + num);
  };

  const handleOperator = (op) => {
    setPrevious(current + ' ' + op);
    setOperator(op);
    setCurrent('0');
  };

  const calculate = () => {
    if (!operator) return;
    const prev = parseFloat(previous);
    const curr = parseFloat(current);
    let result;
    switch (operator) {
      case '+': result = prev + curr; break;
      case '-': result = prev - curr; break;
      case '*': result = prev * curr; break;
      case '/': result = prev / curr; break;
      default: return;
    }
    setCurrent(String(result));
    setPrevious('');
    setOperator(null);
  };

  const clear = () => { setCurrent('0'); setPrevious(''); setOperator(null); };

  return (
    <div className="calculator">
      <div className="display">
        <div className="previous">{previous}</div>
        <div className="current">{current}</div>
      </div>
      <div className="buttons">
        <button className="clear" onClick={clear}>C</button>
        <button onClick={() => setCurrent(current.slice(0, -1) || '0')}>DEL</button>
        <button onClick={() => setCurrent(String(-parseFloat(current)))}>+/-</button>
        <button className="operator" onClick={() => handleOperator('/')}>/</button>
        <button onClick={() => handleNumber('7')}>7</button>
        <button onClick={() => handleNumber('8')}>8</button>
        <button onClick={() => handleNumber('9')}>9</button>
        <button className="operator" onClick={() => handleOperator('*')}>*</button>
        <button onClick={() => handleNumber('4')}>4</button>
        <button onClick={() => handleNumber('5')}>5</button>
        <button onClick={() => handleNumber('6')}>6</button>
        <button className="operator" onClick={() => handleOperator('-')}>-</button>
        <button onClick={() => handleNumber('1')}>1</button>
        <button onClick={() => handleNumber('2')}>2</button>
        <button onClick={() => handleNumber('3')}>3</button>
        <button className="operator" onClick={() => handleOperator('+')}>+</button>
        <button className="zero" onClick={() => handleNumber('0')}>0</button>
        <button onClick={() => handleNumber('.')}>.</button>
        <button className="equals" onClick={calculate}>=</button>
      </div>
    </div>
  );
}
`,
  });
}

// =====================================================================
// WEATHER (mock data; no API key required)
// =====================================================================

export function weatherScaffold(): ScaffoldFile[] {
  return viteScaffold({
    name: 'Weather App',
    pkgName: 'weather-app',
    title: 'Weather App',
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', system-ui, sans-serif; background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%); color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.container { text-align: center; padding: 2rem; }
h1 { margin-bottom: 1.5rem; }
.search-form { display: flex; gap: 0.5rem; justify-content: center; margin-bottom: 2rem; }
input { padding: 0.75rem 1rem; border: 1px solid #374151; border-radius: 8px; background: rgba(255,255,255,0.1); color: white; font-size: 1rem; width: 250px; }
input::placeholder { color: #94a3b8; }
button { padding: 0.75rem 1.5rem; border: none; border-radius: 8px; background: #3b82f6; color: white; font-weight: 600; cursor: pointer; }
button:hover { background: #2563eb; }
.weather-card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 24px; padding: 2rem; border: 1px solid rgba(255,255,255,0.2); max-width: 400px; margin: 0 auto; }
.city { font-size: 1.5rem; margin-bottom: 0.5rem; }
.temp { font-size: 4rem; font-weight: 700; }
.condition { font-size: 1.25rem; color: #94a3b8; }
.details { display: flex; justify-content: center; gap: 2rem; margin-top: 1.5rem; }
.detail { text-align: center; }
.detail-value { font-size: 1.5rem; font-weight: 600; }
.detail-label { font-size: 0.875rem; color: #94a3b8; }`,
    appJsx: `import { useState } from 'react';

const mockWeather = {
  'new york': { temp: 72, condition: 'Sunny', humidity: 45, wind: 12 },
  'london': { temp: 58, condition: 'Cloudy', humidity: 78, wind: 8 },
  'tokyo': { temp: 68, condition: 'Partly Cloudy', humidity: 60, wind: 5 },
  'paris': { temp: 64, condition: 'Rainy', humidity: 82, wind: 10 },
  'sydney': { temp: 78, condition: 'Clear', humidity: 55, wind: 15 },
};

export default function App() {
  const [city, setCity] = useState('');
  const [weather, setWeather] = useState(null);
  const [error, setError] = useState('');

  const handleSearch = (e) => {
    e.preventDefault();
    const key = city.toLowerCase().trim();
    if (mockWeather[key]) {
      setWeather({ city: city, ...mockWeather[key] });
      setError('');
    } else {
      setError('City not found. Try: New York, London, Tokyo, Paris, Sydney');
      setWeather(null);
    }
  };

  return (
    <div className="container">
      <h1>Weather App</h1>
      <form className="search-form" onSubmit={handleSearch}>
        <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Enter city name..." />
        <button type="submit">Search</button>
      </form>
      {error && <p style={{ color: '#f87171' }}>{error}</p>}
      {weather && (
        <div className="weather-card">
          <div className="city">{weather.city}</div>
          <div className="temp">{weather.temp}°F</div>
          <div className="condition">{weather.condition}</div>
          <div className="details">
            <div className="detail">
              <div className="detail-value">{weather.humidity}%</div>
              <div className="detail-label">Humidity</div>
            </div>
            <div className="detail">
              <div className="detail-value">{weather.wind} mph</div>
              <div className="detail-label">Wind</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
`,
  });
}

// =====================================================================
// NOTES (front-end only, localStorage-backed)
// =====================================================================

export function notesScaffold(): ScaffoldFile[] {
  return viteScaffold({
    name: 'Notes',
    pkgName: 'notes-app',
    title: 'Notes',
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', system-ui, sans-serif; background: #0f0f23; color: #e2e8f0; min-height: 100vh; }
.layout { display: grid; grid-template-columns: 280px 1fr; height: 100vh; }
.sidebar { background: #1a1a2e; border-right: 1px solid #374151; padding: 1rem; overflow-y: auto; }
.sidebar h1 { font-size: 1.1rem; margin-bottom: 1rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; }
.new-btn { width: 100%; padding: 0.6rem; background: #6366f1; color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; margin-bottom: 1rem; }
.new-btn:hover { background: #4f46e5; }
.note-link { padding: 0.6rem 0.75rem; border-radius: 6px; cursor: pointer; margin-bottom: 0.25rem; color: #cbd5e1; }
.note-link:hover { background: #0f0f23; }
.note-link.active { background: #312e81; color: #e0e7ff; }
.note-link .preview { font-size: 0.75rem; color: #6b7280; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.editor { padding: 2rem; display: flex; flex-direction: column; gap: 1rem; overflow: hidden; }
.title-input { font-size: 2rem; font-weight: 600; background: transparent; border: none; outline: none; color: #e2e8f0; }
.body-input { flex: 1; background: transparent; border: none; outline: none; color: #cbd5e1; font-size: 1rem; line-height: 1.6; resize: none; font-family: inherit; }
.empty { color: #6b7280; text-align: center; margin-top: 4rem; }`,
    appJsx: `import { useEffect, useState } from 'react';

const STORAGE_KEY = 'notes-app-v1';

function loadNotes() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}

export default function App() {
  const [notes, setNotes] = useState(loadNotes);
  const [activeId, setActiveId] = useState(notes[0]?.id || null);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(notes)); }, [notes]);

  const active = notes.find(n => n.id === activeId);

  const create = () => {
    const note = { id: Date.now(), title: 'Untitled', body: '', updated: Date.now() };
    setNotes([note, ...notes]);
    setActiveId(note.id);
  };

  const update = (patch) => {
    setNotes(notes.map(n => n.id === activeId ? { ...n, ...patch, updated: Date.now() } : n));
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>Notes</h1>
        <button className="new-btn" onClick={create}>+ New Note</button>
        {notes.map(n => (
          <div key={n.id} className={'note-link' + (n.id === activeId ? ' active' : '')} onClick={() => setActiveId(n.id)}>
            <div>{n.title || 'Untitled'}</div>
            <div className="preview">{(n.body || '').slice(0, 40)}</div>
          </div>
        ))}
      </aside>
      <main className="editor">
        {active ? (
          <>
            <input className="title-input" value={active.title} onChange={(e) => update({ title: e.target.value })} placeholder="Title" />
            <textarea className="body-input" value={active.body} onChange={(e) => update({ body: e.target.value })} placeholder="Start writing..." />
          </>
        ) : (
          <div className="empty">Select or create a note to begin.</div>
        )}
      </main>
    </div>
  );
}
`,
  });
}

// =====================================================================
// DASHBOARD (frontend-only with mock metrics)
// =====================================================================

export function dashboardScaffold(): ScaffoldFile[] {
  return viteScaffold({
    name: 'Analytics Dashboard',
    pkgName: 'dashboard-app',
    title: 'Analytics Dashboard',
    css: `* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Inter', system-ui, sans-serif; background: #0f0f23; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
.container { max-width: 1200px; margin: 0 auto; }
h1 { margin-bottom: 0.25rem; }
.subtitle { color: #6b7280; margin-bottom: 2rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
.stat-card { background: #1a1a2e; border: 1px solid #374151; padding: 1.25rem; border-radius: 12px; }
.stat-label { color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
.stat-value { font-size: 1.875rem; font-weight: 700; }
.stat-delta { font-size: 0.875rem; margin-top: 0.25rem; }
.stat-delta.up { color: #22c55e; }
.stat-delta.down { color: #ef4444; }
.chart-card { background: #1a1a2e; border: 1px solid #374151; padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem; }
.chart-card h3 { margin-bottom: 1rem; color: #cbd5e1; }
.bars { display: grid; grid-template-columns: repeat(7, 1fr); gap: 0.5rem; align-items: end; height: 200px; }
.bar { background: linear-gradient(to top, #6366f1, #a855f7); border-radius: 6px 6px 0 0; min-height: 8px; position: relative; }
.bar-label { position: absolute; bottom: -1.5rem; left: 50%; transform: translateX(-50%); font-size: 0.75rem; color: #94a3b8; }
.table { width: 100%; }
.table th, .table td { padding: 0.6rem 0.75rem; text-align: left; border-bottom: 1px solid #374151; }
.table th { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; }`,
    appJsx: `import { useMemo } from 'react';

const STATS = [
  { label: 'Revenue',       value: '$48,210', delta: '+12.5%', up: true  },
  { label: 'Active Users',  value: '8,432',   delta: '+4.2%',  up: true  },
  { label: 'Conversion',    value: '3.41%',   delta: '-0.6%',  up: false },
  { label: 'Avg. Session',  value: '4m 12s',  delta: '+8.0%',  up: true  },
];

const ROWS = [
  { name: 'Jane Cooper',   email: 'jane@example.com',   plan: 'Pro',     status: 'Active'   },
  { name: 'Wade Warren',   email: 'wade@example.com',   plan: 'Free',    status: 'Active'   },
  { name: 'Esther Howard', email: 'esther@example.com', plan: 'Team',    status: 'Trialing' },
  { name: 'Cameron Wms',   email: 'cam@example.com',    plan: 'Pro',     status: 'Cancelled'},
  { name: 'Brooklyn S.',   email: 'brooklyn@ex.com',    plan: 'Team',    status: 'Active'   },
];

export default function App() {
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const heights = useMemo(() => days.map((_, i) => 30 + ((i * 53) % 70)), []);

  return (
    <div className="container">
      <h1>Dashboard</h1>
      <p className="subtitle">Live mock metrics — last 7 days</p>

      <div className="stats">
        {STATS.map(s => (
          <div key={s.label} className="stat-card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value">{s.value}</div>
            <div className={'stat-delta ' + (s.up ? 'up' : 'down')}>{s.delta}</div>
          </div>
        ))}
      </div>

      <div className="chart-card">
        <h3>Daily Active Users</h3>
        <div className="bars">
          {heights.map((h, i) => (
            <div key={i} className="bar" style={{ height: h + '%' }}>
              <span className="bar-label">{days[i]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="chart-card">
        <h3>Recent Customers</h3>
        <table className="table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Plan</th><th>Status</th></tr>
          </thead>
          <tbody>
            {ROWS.map(r => (
              <tr key={r.email}>
                <td>{r.name}</td><td>{r.email}</td><td>{r.plan}</td><td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
`,
  });
}

// =====================================================================
// FULL-STACK TODO (Express + REST + plain-HTML frontend)
// =====================================================================

export function fullstackTodoScaffold(): ScaffoldFile[] {
  return [
    { path: 'package.json', language: 'json', content: fullstackPackageJson('fullstack-todo') },
    {
      path: 'server.js',
      language: 'javascript',
      content: `import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let todos = [
  { id: 1, text: 'Learn Express', completed: false },
  { id: 2, text: 'Build REST API', completed: false }
];
let nextId = 3;

app.get('/api/todos', (_req, res) => res.json(todos));

app.post('/api/todos', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const todo = { id: nextId++, text, completed: false };
  todos.push(todo);
  res.status(201).json(todo);
});

app.put('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const todo = todos.find(t => t.id === id);
  if (!todo) return res.status(404).json({ error: 'Not found' });
  todo.completed = !todo.completed;
  res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  todos = todos.filter(t => t.id !== id);
  res.status(204).send();
});

app.get('*', (_req, res) => res.sendFile(join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(\`Server running at http://localhost:\${PORT}\`));
`,
    },
    {
      path: 'public/index.html',
      language: 'html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Full-Stack Todo</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #0f0f23; color: #e2e8f0; min-height: 100vh; padding: 2rem; }
    .container { max-width: 600px; margin: 0 auto; }
    h1 { text-align: center; margin-bottom: 0.5rem; font-size: 2rem; }
    .subtitle { text-align: center; color: #6b7280; margin-bottom: 2rem; }
    .add-form { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; }
    input { flex: 1; padding: 0.75rem 1rem; border: 1px solid #374151; border-radius: 8px; background: #1a1a2e; color: #e2e8f0; font-size: 1rem; }
    button { padding: 0.75rem 1.5rem; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; background: #6366f1; color: white; }
    button:hover { background: #4f46e5; }
    .todo-list { list-style: none; }
    .todo-item { display: flex; align-items: center; gap: 1rem; padding: 1rem; background: #1a1a2e; border-radius: 8px; margin-bottom: 0.5rem; border: 1px solid #374151; }
    .todo-item.completed span { text-decoration: line-through; color: #6b7280; }
    .todo-item span { flex: 1; }
    .delete-btn { background: #ef4444; padding: 0.5rem 1rem; }
    .delete-btn:hover { background: #dc2626; }
    .empty, .loading { text-align: center; color: #6b7280; padding: 2rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Full-Stack Todo</h1>
    <p class="subtitle">Powered by Express + REST API</p>
    <form class="add-form" id="addForm">
      <input type="text" id="input" placeholder="Add a new task..." />
      <button type="submit">Add</button>
    </form>
    <div id="loading" class="loading">Loading todos...</div>
    <ul class="todo-list" id="todoList"></ul>
  </div>
  <script>
    const API = '/api/todos';
    const todoList = document.getElementById('todoList');
    const addForm = document.getElementById('addForm');
    const input = document.getElementById('input');
    const loading = document.getElementById('loading');

    async function fetchTodos() {
      const res = await fetch(API);
      const todos = await res.json();
      loading.style.display = 'none';
      render(todos);
    }
    function render(todos) {
      if (!todos.length) { todoList.innerHTML = '<li class="empty">No todos yet.</li>'; return; }
      todoList.innerHTML = todos.map(t => \`
        <li class="todo-item \${t.completed ? 'completed' : ''}">
          <input type="checkbox" \${t.completed ? 'checked' : ''} onchange="toggle(\${t.id})" />
          <span>\${t.text}</span>
          <button class="delete-btn" onclick="remove(\${t.id})">Delete</button>
        </li>\`).join('');
    }
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      input.value = '';
      fetchTodos();
    });
    window.toggle = async (id) => { await fetch(API + '/' + id, { method: 'PUT' }); fetchTodos(); };
    window.remove = async (id) => { await fetch(API + '/' + id, { method: 'DELETE' }); fetchTodos(); };
    fetchTodos();
  </script>
</body>
</html>
`,
    },
  ];
}

// =====================================================================
// Registry — id → factory function
// =====================================================================

export type ScaffoldId =
  | 'counter'
  | 'todo'
  | 'calculator'
  | 'weather'
  | 'notes'
  | 'dashboard'
  | 'fullstack-todo';

export const scaffoldRegistry: Record<ScaffoldId, () => ScaffoldFile[]> = {
  counter: counterScaffold,
  todo: todoScaffold,
  calculator: calculatorScaffold,
  weather: weatherScaffold,
  notes: notesScaffold,
  dashboard: dashboardScaffold,
  'fullstack-todo': fullstackTodoScaffold,
};

export function getScaffold(id: string): ScaffoldFile[] | null {
  const fn = (scaffoldRegistry as Record<string, () => ScaffoldFile[]>)[id];
  return fn ? fn() : null;
}
