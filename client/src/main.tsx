import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startApp } from './app';
import './styles.css';

startApp();
createRoot(document.getElementById('root')!).render(<App />);
