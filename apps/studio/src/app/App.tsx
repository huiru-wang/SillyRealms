import {Navigate,Route,Routes} from 'react-router-dom';
import {AppShell} from './AppShell';
import {WorldLibraryPage} from '../features/worlds/WorldLibraryPage';
import {WorldDetailPage} from '../features/worlds/WorldDetailPage';
import {PlaceholderPage} from '../features/placeholder/PlaceholderPage';
import {ColorLabPage} from '../features/lab/ColorLabPage';
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
      <Route path="/models" element={<PlaceholderPage title="模型配置" description="模型配置视觉原型将在第二轮迭代中构建。本 Demo 不保存任何真实密钥。" />}/>
      <Route path="/lab/colors" element={<ColorLabPage/>}/>
      <Route path="/settings" element={<PlaceholderPage title="设置" description="当前是静态 UI 设计应用，不包含服务端设置。" />}/>
      <Route path="*" element={<Navigate to="/worlds" replace/>}/>
    </Route>
  </Routes></PresetProvider>;
}
