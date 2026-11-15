import {Navigate,Route,Routes} from 'react-router-dom';
import {AppShell} from './AppShell';
import {WorldLibraryPage} from '../features/worlds/WorldLibraryPage';
import {WorldDetailPage} from '../features/worlds/WorldDetailPage';
import {ModelsPage} from '../features/models/ModelsPage';
import {SettingsPage} from '../features/settings/SettingsPage';
import {SetupPage} from '../features/onboarding/SetupPage';
import {MorePage} from '../features/more/MorePage';

import {PresetProvider} from '../features/presets/PresetStore';
import {PresetLibraryPage} from '../features/presets/PresetLibraryPage';
import {SessionDetailPage,SessionListPage} from '../features/sessions/Sessions';
export default function App(){
  return <PresetProvider><Routes>
    <Route element={<AppShell/>}>
      <Route path="/" element={<Navigate to="/worlds" replace/>}/>
      <Route path="/worlds" element={<WorldLibraryPage/>}/>
      <Route path="/worlds/:worldId" element={<WorldDetailPage/>}/>
      <Route path="/sessions" element={<SessionListPage/>}/><Route path="/sessions/:sessionId" element={<SessionDetailPage/>}/>
      <Route path="/presets/:presetId?" element={<PresetLibraryPage/>}/>
      <Route path="/more" element={<MorePage/>}/>
      <Route path="/models/:modelId?" element={<ModelsPage/>}/>
      <Route path="/providers" element={<Navigate to="/models" replace/>}/>
      <Route path="/settings" element={<SettingsPage/>}/>
      <Route path="/setup" element={<SetupPage/>}/>
      <Route path="*" element={<Navigate to="/worlds" replace/>}/>
    </Route>
  </Routes></PresetProvider>;
}
