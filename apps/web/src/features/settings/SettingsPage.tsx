import {useEffect,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useOutletContext} from 'react-router-dom';
import {Check,MonitorCog,SlidersHorizontal} from 'lucide-react';
import {Panel} from '../../components/ui/Field';
import {Button} from '../../components/ui/Button';
import {Select} from '../../components/ui/Select';
import {PageHeader} from '../../components/ui/PageHeader';
import type {Theme} from '../../hooks/useTheme';
import {ErrorNotice,Loading} from '../../app/ui';
import {useManagement,type AppSettings} from '../../app/ManagementData';
import {usePagedResource} from '../../data';
import {usePresetStore} from '../presets/PresetStore';
import type {ModelConfig} from '../models/types';
import {DEFAULT_LOCALE,SUPPORTED_LOCALES,isAppLocale,languageNames} from '@sillyrealms/sdk/locale';

type Defaults=Pick<AppSettings,'defaultPresetId'|'defaultApiModelConfigId'|'defaultReplyAssistPresetId'>;
const defaults=(value:AppSettings):Defaults=>({defaultReplyAssistPresetId:value.defaultReplyAssistPresetId,defaultPresetId:value.defaultPresetId,defaultApiModelConfigId:value.defaultApiModelConfigId});
export function SettingsPage(){
 const {t}=useTranslation('settings');
 const {theme,toggleTheme}=useOutletContext<{theme:Theme;toggleTheme:()=>void}>();
 const {settings,saveSettings,saveLocale,localeSaving,modelsRevision}=useManagement();
 const presets=usePresetStore(),models=usePagedResource<ModelConfig>('v1/api-model-configs?limit=100',modelsRevision,true);
 const [baseline,setBaseline]=useState<Defaults|null>(null),[draft,setDraft]=useState<Defaults|null>(null);
 const [saving,setSaving]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState<unknown>(null);
 const pending=useRef(false);
 const dirty=JSON.stringify(baseline)!==JSON.stringify(draft);
 useEffect(()=>{if(settings.value&&!dirty){const value=defaults(settings.value.item);setBaseline(value);setDraft(value);}},[settings.value,dirty]);
 const save=async()=>{
  if(!draft||!baseline||pending.current)return;
  const patch:Partial<Defaults>={};
  if(draft.defaultReplyAssistPresetId!==baseline.defaultReplyAssistPresetId)patch.defaultReplyAssistPresetId=draft.defaultReplyAssistPresetId;
  if(draft.defaultPresetId!==baseline.defaultPresetId)patch.defaultPresetId=draft.defaultPresetId;
  if(draft.defaultApiModelConfigId!==baseline.defaultApiModelConfigId)patch.defaultApiModelConfigId=draft.defaultApiModelConfigId;
  if(!Object.keys(patch).length)return;
  pending.current=true;setSaving(true);setError(null);setSaved(false);
  try{const next=defaults(await saveSettings(patch));setBaseline(next);setDraft(next);setSaved(true);}
  catch(reason){setError(reason);}
  finally{pending.current=false;setSaving(false);}
 };
 const set=(patch:Partial<Defaults>)=>{setDraft(current=>current?{...current,...patch}:current);setSaved(false);};
 const changeLanguage=async(value:string)=>{
  if(!isAppLocale(value)||localeSaving||value===settings.value?.item.locale)return;
  setError(null);setSaved(false);
  try{await saveLocale(value);}catch(reason){setError(reason);}
 };
 return <main className="page settings-page">
  <PageHeader title={t('title')} description={t('description')}/>
  {settings.error&&<ErrorNotice message={settings.error} onRetry={settings.reload}/>}
  {!!error&&<ErrorNotice message={error}/>}
  {saved&&<div className="preset-save-ok" role="status"><Check size={16}/>{t('defaultsSaved')}</div>}
  <div className="settings-stack">
   <Panel className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><MonitorCog size={18}/></span><h2>{t('appearance')}</h2></div>
    <label className="settings-row"><span><strong>{t('language')}</strong><small>{t('languageHint')}</small></span>
     <Select aria-label={t('language')} value={settings.value?.item.locale??DEFAULT_LOCALE} disabled={!settings.value||localeSaving||saving} onChange={event=>void changeLanguage(event.target.value)}>
      {SUPPORTED_LOCALES.map(locale=><option key={locale} value={locale}>{languageNames[locale]}</option>)}
     </Select>
    </label>
    {localeSaving&&<span role="status">{t('savingLanguage')}</span>}
    <label className="settings-row settings-theme-row"><span><strong>{t('theme')}</strong></span><Select aria-label={t('theme')} value={theme} onChange={event=>{if(event.target.value!==theme)toggleTheme();}}><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></Select></label>
   </Panel>
   <Panel className="settings-group"><div className="settings-group-title"><span className="settings-group-icon"><SlidersHorizontal size={18}/></span><div><h2>{t('defaults')}</h2><p>{t('defaultsHint')}</p></div></div>
    {presets.error&&<ErrorNotice message={presets.error} onRetry={presets.reload}/>}
    {presets.replyCatalog.error&&<ErrorNotice message={presets.replyCatalog.error} onRetry={presets.replyCatalog.reload}/>}
    {models.error&&<ErrorNotice message={models.error} onRetry={models.reload}/>}
    {!draft?(settings.loading?<Loading text={t('loading')}/>:null):<div className="settings-rows">
     <label className="settings-row"><span><strong>{t('defaultPreset')}</strong></span><Select aria-label={t('defaultPreset')} disabled={saving||localeSaving} value={draft.defaultPresetId??''} onChange={event=>set({defaultPresetId:event.target.value||null})}>
      <option value="">{t('unset')}</option>{draft.defaultPresetId&&!presets.presets.some(p=>p.id===draft.defaultPresetId)&&<option value={draft.defaultPresetId}>{t('currentPreset')}</option>}{presets.presets.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
     </Select></label>
     <label className="settings-row"><strong>{t('sessions:assistPreset')}</strong>
      <Select aria-label={t('sessions:assistPreset')} value={draft.defaultReplyAssistPresetId??''} disabled={saving||localeSaving} onChange={event=>set({defaultReplyAssistPresetId:event.target.value||null})}>
       <option value="">{t('unset')}</option>{presets.replyPresets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
      </Select></label>
     <label className="settings-row"><span><strong>{t('defaultModel')}</strong></span><Select aria-label={t('defaultModel')} disabled={saving||localeSaving} value={draft.defaultApiModelConfigId??''} onChange={event=>set({defaultApiModelConfigId:event.target.value||null})}>
      <option value="">{t('unset')}</option>{draft.defaultApiModelConfigId&&!models.page?.items.some(m=>m.id===draft.defaultApiModelConfigId)&&<option value={draft.defaultApiModelConfigId}>{t('currentModel')}</option>}{models.page?.items.map(m=><option key={m.id} value={m.id}>{m.name} · {m.modelId}</option>)}
     </Select></label>
     <div className="settings-row settings-row-action"><Button variant="primary" loading={saving} disabled={!dirty||localeSaving} onClick={()=>void save()}>{t('saveDefaults')}</Button></div>
    </div>}
   </Panel>
  </div>
 </main>;
}
