import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './app/AppShell';
import './style.css';
import './design-system/tokens.css';
import './design-system/studio.css';
import './design-system/library-filters.css';
import './design-system/editor.css';
import './design-system/immersive-world-cards.css';
import './features/sessions/composer/roleplay-composer.css';

createRoot(document.getElementById('root')!).render(<App/>);
