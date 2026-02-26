import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

// Apply saved theme immediately to prevent flash
(function() {
  const t = localStorage.getItem('eo-theme') ||
    (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', t);
})();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
