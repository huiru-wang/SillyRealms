import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App';
import {AssetOriginProvider} from './world-assets';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/themes.css';
import {initializeTheme} from './styles/theme';
import './styles/globals.css';

initializeTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AssetOriginProvider><App /></AssetOriginProvider>
    </BrowserRouter>
  </React.StrictMode>
);

import './features/sessions/composer/roleplay-composer.css';
import './styles/business.css';

import './styles/components.css';
