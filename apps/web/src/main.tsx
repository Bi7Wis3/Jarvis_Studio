import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './state';
import { startOptions } from './optionsSync';
import './styles.css';

connect();
void startOptions();
createRoot(document.getElementById('root')!).render(<App />);
