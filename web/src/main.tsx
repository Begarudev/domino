import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { App } from './App.tsx';
import { Theatre } from './theatre/Theatre.tsx';

// ?view=theatre: the full-screen run theatre (mission control) on the same backend and event stream.
const theatre = new URLSearchParams(location.search).get('view') === 'theatre';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {theatre ? <Theatre /> : <App />}
  </StrictMode>,
);
