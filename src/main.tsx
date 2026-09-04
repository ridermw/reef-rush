import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { createAppStore } from './app/appStore';
import './styles/tokens.css';
import './styles/app.css';

const rootElement = document.getElementById('root');

if (rootElement === null) {
  throw new Error('The #root element is missing from index.html.');
}

const store = createAppStore();

createRoot(rootElement).render(
  <StrictMode>
    <App store={store} />
  </StrictMode>,
);
