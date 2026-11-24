import React from 'react';
import {I18nextProvider} from 'react-i18next';
import {i18n} from './i18n/instance.ts';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './app/App';
import './styles/reset.css';
import './styles/tokens.css';
import './styles/themes.css';
import {initializeTheme} from './styles/theme';
import './styles/globals.css';

initializeTheme();

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <BrowserRouter><App /></BrowserRouter>
    </I18nextProvider>
  </React.StrictMode>
);

import './features/sessions/composer/roleplay-composer.css';
import './styles/business.css';

import './styles/components.css';
