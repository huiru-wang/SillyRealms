import {localOrigin} from './local-origin';
import {applyAppearance, applyTheme, builtinTheme, STORY_COLOR_MAP} from './styles/theme';
import './styles/tokens.css';
import './styles/themes.css';
applyTheme(builtinTheme('dark'));
import React from 'react';
import {I18nextProvider,useTranslation} from 'react-i18next';
import {i18n} from './i18n/instance';
import {createModuleLoader} from '../../../packages/sr-ui-compiler/src/loader';
import '@tailwindcss/browser';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as SDK from '@sillyrealms/sdk';
import {StageComposerButtons} from '../../../packages/sr-sdk/src/stage/composer-buttons';
import {StageProvider} from '../../../packages/sr-sdk/src/stage/context';
import {StageRuntime} from '../../../packages/sr-sdk/src/stage/runtime';
import type {SessionEvent, StageSnapshot} from '../../../packages/sr-sdk/src/stage-contract';
import {StoryContext, type MessageComponent, type MessageMatch, type MessageRule} from '../../../packages/sr-sdk/src/story-context';
import {MessageMatcher} from './message-matcher';
import {FrameLocale, StageBridge, stageHostOrigin} from './stage-frame-protocol';
import {DefaultStage} from './default-stage';
import './frame.css';
import '@sillyrealms/sdk/world-story.css';
import '@sillyrealms/sdk/action-suggestions.css';

const bridge = new StageBridge(), runtime = new StageRuntime(bridge.command);
let port: MessagePort | undefined, matcher: MessageMatcher | undefined, locale: FrameLocale | undefined;
const nonce = location.hash.slice(1);
const hostOrigin = stageHostOrigin(location.search, location.origin, import.meta.env.VITE_WEB_ORIGIN ?? localOrigin(location.origin, 5176));
const root = ReactDOMClient.createRoot(document.getElementById('root')!);
const report = (type: 'ui-error' | 'sdk-error' | 'message-error', message: string, component?: string) =>
  port?.postMessage({type, message, ...(component === undefined ? {} : {component})});

function FrameStatus({message}: {message: string}) {
  const {t} = useTranslation('stage');
  return <p>{t(message)}</p>;
}
class Boundary extends React.Component<{children: React.ReactNode}, {error: boolean}> {
  state = {error: false};
  static getDerivedStateFromError() { return {error: true}; }
  componentDidCatch(error: Error) { report('ui-error', error.message); }
  render() { return this.state.error ? <FrameStatus message="frame.pageError"/> : this.props.children; }
}
function Mounted({component: Component}: {component: React.ComponentType}) {
  React.useEffect(() => { port?.postMessage({type: 'page-mounted'}); }, []);
  return <Component/>;
}
function disconnect() {
  locale?.close(); locale = undefined; port = undefined; bridge.disconnect(); matcher?.close(); matcher = undefined; runtime.reset();
}
function appearance(payload: Record<string, any>) {
  if (Number.isFinite(payload.bottomInset) && payload.bottomInset >= 0 && payload.bottomInset <= 800) {
    document.documentElement.style.setProperty('--sr-story-bottom-inset', payload.bottomInset + 'px');
  }
  if (applyAppearance(payload)) {
    for (const [target, source] of Object.entries(STORY_COLOR_MAP)) {
      document.documentElement.style.setProperty('--sr-story-' + target, payload.colors['--' + source]);
    }
  }
  if (Number.isInteger(payload.fontSize) && payload.fontSize >= 13 && payload.fontSize <= 21) {
    window.dispatchEvent(new Event('sr:font-size-will-change'));
    document.documentElement.style.setProperty('--sr-story-font-size', payload.fontSize + 'px');
    window.dispatchEvent(new Event('sr:font-size-changed'));
  }
}
function render(payload: Record<string, any>, buttons: StageComposerButtons) {
  const code = payload.modules?.code ?? {}, errors = payload.modules?.errors ?? {};
  const load = createModuleLoader(code, errors, {
    react: React, 'react-dom/client': ReactDOMClient, 'react/jsx-runtime': JSXRuntime,
    '@sillyrealms/sdk': SDK,
  }, (source, module, require) => new Function('module', 'exports', 'require', 'React', source)(module, module.exports, require, React));
  const custom = typeof payload.main === 'string' && (Object.hasOwn(code, payload.main) || Object.hasOwn(errors, payload.main));
  const Component = custom ? load(payload.main) as React.ComponentType : DefaultStage;
  const rules: MessageRule[] = payload.rules ?? [];
  const components: Record<string, MessageComponent> = Object.create(null);
  const referenced = new Set(rules.flatMap(rule => rule.replacement.type === 'component' ? [rule.replacement.component] : []));
  for (const id of referenced) {
    let resolved = false, component: MessageComponent | undefined;
    Object.defineProperty(components, id, {enumerable: true, get() {
      if (resolved) return component;
      resolved = true;
      try {
        const candidate = load(id) as MessageComponent;
        if (candidate.srDisplay !== undefined && candidate.srDisplay !== 'inline' && candidate.srDisplay !== 'block') throw Error('stage:frame.invalidMessageDisplay');
        component = candidate;
      } catch (error) { report('message-error', error instanceof Error ? error.message : String(error), id); }
      return component;
    }});
  }
  const currentMatcher = matcher!;
  root.render(<I18nextProvider i18n={i18n}><Boundary key={payload.main ?? 'official'}><SDK.SRAssetProvider baseUrl={payload.assetBaseUrl ?? null}>
    <StageProvider runtime={runtime} buttons={buttons}><StoryContext.Provider value={{
      debug: payload.debug === true, components, rules, state: payload.state ?? {},
      ready: () => port?.postMessage({type: 'page-mounted'}),
      match: (text, role) => currentMatcher.match(text, role, rules) as Promise<{matches: MessageMatch[]; warning: boolean}>,
    }}><Mounted component={Component}/></StoryContext.Provider></StageProvider>
  </SDK.SRAssetProvider></Boundary></I18nextProvider>);
}

if (!hostOrigin || !nonce || window.parent === window) {
  root.render(<I18nextProvider i18n={i18n}><FrameStatus message="frame.notConnected"/></I18nextProvider>);
}
window.addEventListener('message', event => {
  if (!hostOrigin || !nonce || window.parent === window || event.source !== window.parent ||
      event.origin !== hostOrigin || event.data?.nonce !== nonce) return;
  if (event.data.type === 'sr-probe') {
    disconnect(); root.render(null);
    window.parent.postMessage({type: 'sr-ready', nonce}, hostOrigin); return;
  }
  if (event.data.type !== 'sr-connect' || port || !event.ports[0]) return;
  const channel = event.ports[0];
  port = channel; bridge.connect(channel); matcher = new MessageMatcher();
  const currentLocale = new FrameLocale(async value => {
    if(i18n.resolvedLanguage!==value)await i18n.changeLanguage(value);
    if (port === channel) document.documentElement.lang = value;
  });
  locale = currentLocale;
  const buttons = new StageComposerButtons(list => {
    if (port === channel) channel.postMessage({type: 'composer-buttons', ...list});
  });
  channel.onmessage = ({data: payload}) => {
    if (port !== channel || !payload || typeof payload !== 'object') return;
    if (bridge.receive(payload)) return;
    try {
      if (payload.type === 'snapshot') runtime.acceptSnapshot(payload.snapshot as StageSnapshot);
      else if (payload.type === 'event') runtime.acceptEvent(payload.event as SessionEvent);
      else if (payload.type === 'appearance') {
        appearance(payload);
        void currentLocale.receive(payload.locale).catch(error => {
          if (port === channel) report('ui-error', error instanceof Error ? error.message : String(error));
        });
      }
      else if (payload.type === 'theme') document.documentElement.dataset.theme = payload.value === 'dark' ? 'dark' : 'light';
      else if (payload.type === 'render') currentLocale.render(() => render(payload, buttons));
      else if (payload.type === 'composer-button-click') {
        void buttons.click(payload.revision, payload.id).catch(error => {
          if (port === channel) report('sdk-error', error instanceof Error ? error.message : String(error));
        });
      }
    } catch (error) {
      report(payload.type === 'render' ? 'ui-error' : 'sdk-error', error instanceof Error ? error.message : String(error));
    }
  };
  channel.start(); channel.postMessage({type: 'ready-ack'});
});
window.addEventListener('pagehide', disconnect);
window.addEventListener('error', event => report('ui-error', event.message || 'stage:frame.runtimeError'));
window.addEventListener('unhandledrejection', event => report('ui-error', event.reason instanceof Error ? event.reason.message : 'stage:frame.unhandledError'));
