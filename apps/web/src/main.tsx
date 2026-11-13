import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './state';
import './styles.css';

connect();
createRoot(document.getElementById('root')!).render(<App />);
