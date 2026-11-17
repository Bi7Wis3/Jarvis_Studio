import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './state';
import { startOptions } from './optionsSync';
import { startToolbarSync } from './toolbarSync';
import './styles.css';

connect();
void startOptions();
startToolbarSync();
createRoot(document.getElementById('root')!).render(<App />);
