import {useCallback,useEffect,useLayoutEffect,useRef,useState,type FormEvent} from 'react';
import {Link,useParams} from 'react-router-dom';
import {ArrowLeft,ArrowRight,ChevronDown,ChevronUp,Info,Send,Settings2,Square} from 'lucide-react';
import {trimTrailingEmptyRoleplayLines} from '@sillyrealms/roleplay';
import {RoleplayComposer} from '../../../../web/src/features/sessions/composer/RoleplayComposer';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import {sessionSamples as samples,type SessionSample} from '../../fixtures/sessions';
import {StoryPreviewHost,type StoryPreviewHandle,type PreviewStatus} from './preview/StoryPreviewHost';
import styles from './Sessions.module.css';

// Preview state is intentionally local to this browser document.
const drafts:Record<string,string>={};
const readingSizes:Record<string,number>={};
const initialStatus:PreviewStatus={ready:false,active:false,phase:null,error:null};
const phaseLabels={preparing:'准备中',narrative:'生成中',extensions:'整理中'} as const;

export function SessionListPage(){
  return <section className={styles.listPage}>
    <header className={styles.listHeader}><h1>会话</h1></header>
    <div className={styles.listIntro}><span>最近的故事</span><span>选择一个会话继续</span></div>
    <div className={styles.list}>
      {samples.map(sample=><Link className={styles.listItem} to={'/sessions/'+sample.id} key={sample.id}>
        <img src={sample.cover} alt=""/><span className={styles.listCopy}><strong>{sample.title}</strong><span>{sample.world} · {sample.subtitle}</span><small>{sample.preview}</small></span><ArrowRight size={18} aria-hidden="true"/>
      </Link>)}
    </div>
  </section>;
}

function ContextBar(){
  const [open,setOpen]=useState(false);
  return <><button type="button" className={styles.contextButton} onClick={()=>setOpen(true)} aria-label="查看上下文占比示意" aria-haspopup="dialog">
    <span className={styles.contextLabel}>上下文</span><span className={styles.contextBar} aria-hidden="true"><i/><i/><i/></span>
  </button>{open&&<Modal title="上下文占比" onClose={()=>setOpen(false)}>
    <p>这是最近一次上下文组成的示意，颜色表示各部分的相对占比。</p>
    <div className={styles.contextDetailBar} aria-hidden="true"><i/><i/><i/></div>
    <div className={styles.legend}><span><i/>系统</span><span><i/>摘要</span><span><i/>历史会话</span></div>
    <p className={styles.contextNote}>示例数据 · 结构比例不代表实际 Token 分项。</p>
  </Modal>}</>;
}

export function SessionDetailPage(){
  const {sessionId}=useParams();
  const sample=samples.find(item=>item.id===sessionId);
  if(!sample)return <div className={styles.notFound}><h1>找不到这个会话</h1><Link to="/sessions">返回会话列表</Link></div>;
  return <SessionDetail key={sample.id} sample={sample}/>;
}

function SessionDetail({sample}:{sample:SessionSample}){
  const id=sample.id;
  const [draft,setDraft]=useState(()=>drafts[id]??'');
  const draftRef=useRef(draft),draftRevision=useRef(0);
  const [expanded,setExpanded]=useState(true);
  const [settings,setSettings]=useState(false);
  const [fontSize,setFontSize]=useState(()=>readingSizes[id]??16);
  const fontBeforeSettings=useRef(fontSize);
  const [sendError,setSendError]=useState('');
  const [bottomInset,setBottomInset]=useState(0);
  const [status,setStatus]=useState<PreviewStatus>(initialStatus);
  const statusRef=useRef(status);
  const [sending,setSending]=useState(false);
  const pending=useRef(false),alive=useRef(true);
  const stage=useRef<StoryPreviewHandle>(null);
  const detail=useRef<HTMLElement>(null);
  const composer=useRef<HTMLDivElement>(null);
  const composerOverlay=useRef<HTMLDivElement>(null);
  const stageViewport=useRef<HTMLDivElement>(null);
  const expandButton=useRef<HTMLButtonElement>(null);
  const focusFrame=useRef<number|undefined>(undefined);

  useEffect(()=>{
    alive.current=true;
    const viewport=window.visualViewport;
    const update=()=>{
      const element=detail.current;if(!element)return;
      if(viewport&&window.innerWidth<=760&&viewport.scale===1){
        element.style.setProperty('--session-viewport-height',Math.min(window.innerHeight,viewport.height+viewport.offsetTop)+'px');
      }else element.style.removeProperty('--session-viewport-height');
    };
    update();
    viewport?.addEventListener('resize',update);
    viewport?.addEventListener('scroll',update);
    window.addEventListener('resize',update);
    return()=>{
      alive.current=false;
      if(focusFrame.current!==undefined)cancelAnimationFrame(focusFrame.current);
      viewport?.removeEventListener('resize',update);
      viewport?.removeEventListener('scroll',update);
      window.removeEventListener('resize',update);
    };
  },[]);
  useEffect(()=>{if(!expanded)expandButton.current?.focus();},[expanded]);
  useLayoutEffect(()=>{
    const overlay=composerOverlay.current,viewport=stageViewport.current;
    if(!overlay||!viewport)return;
    let frame:number|undefined;
    const measure=()=>{
      frame=undefined;
      const bounds=viewport.getBoundingClientRect();
      const input=composer.current?.querySelector<HTMLElement>('.sr-composer-editor');
      if(input){
        // Keep the state dialog's close control usable even with a send error
        // and a mobile keyboard. Measure the chrome instead of assuming its height.
        const chrome=overlay.getBoundingClientRect().height-input.getBoundingClientRect().height;
        const room=Math.max(44,Math.floor(bounds.height-96-chrome))+'px';
        if(overlay.style.getPropertyValue('--composer-editor-room')!==room)overlay.style.setProperty('--composer-editor-room',room);
      }
      const inset=Math.max(0,Math.min(800,bounds.height,Math.ceil(bounds.bottom-overlay.getBoundingClientRect().top)));
      setBottomInset(previous=>previous===inset?previous:inset);
    };
    const observer=new ResizeObserver(()=>{if(frame===undefined)frame=requestAnimationFrame(measure);});
    observer.observe(overlay);observer.observe(viewport);measure();
    return()=>{observer.disconnect();if(frame!==undefined)cancelAnimationFrame(frame);};
  },[]);

  const updateDraft=useCallback((value:string)=>{
    if(value===draftRef.current)return;
    draftRevision.current++;
    draftRef.current=value;drafts[id]=value;setDraft(value);setSendError('');
  },[id]);
  const receiveDraft=useCallback((text:string)=>{
    if(!alive.current||text.length>100000)return;
    updateDraft(text);
    setExpanded(true);
  },[updateDraft]);
  const updateStatus=useCallback((value:PreviewStatus)=>{
    if(!alive.current)return;
    statusRef.current=value;
    setStatus(previous=>previous.ready===value.ready&&previous.active===value.active&&previous.phase===value.phase&&previous.error===value.error?previous:value);
  },[]);
  const focusInput=()=>{
    setExpanded(true);
    if(focusFrame.current!==undefined)cancelAnimationFrame(focusFrame.current);
    focusFrame.current=requestAnimationFrame(()=>composer.current?.querySelector<HTMLElement>('.sr-composer-editor')?.focus());
  };
  async function submit(value?:string){
    if(pending.current||statusRef.current.active||!statusRef.current.ready||statusRef.current.error||!stage.current)return;
    const text=trimTrailingEmptyRoleplayLines(value??draftRef.current);
    if(!text.trim()||text.length>100000)return;
    const revision=draftRevision.current;
    pending.current=true;setSending(true);setSendError('');
    try{
      await stage.current.send(text);
      if(!alive.current)return;
      if(revision===draftRevision.current)updateDraft('');
    }catch(error){
      if(alive.current)setSendError(error instanceof Error?error.message:'发送失败，请重试');
    }finally{
      pending.current=false;
      if(alive.current)setSending(false);
    }
  }
  function openSettings(){
    fontBeforeSettings.current=fontSize;
    setSettings(true);
  }
  function cancelSettings(){
    setFontSize(fontBeforeSettings.current);
    setSettings(false);
  }
  function saveSettings(){
    readingSizes[id]=fontSize;
    fontBeforeSettings.current=fontSize;
    setSettings(false);
  }
  const stateLabel=status.error?'舞台异常':status.active?phaseLabels[status.phase??'preparing']:status.ready?'本地演示':'正在加载';
  const disabledSend=sending||!status.ready||!!status.error||!draft.trim()||draft.length>100000;
  const submitForm=(event:FormEvent)=>{event.preventDefault();void submit();};

  return <section ref={detail} className={styles.detail} data-session-detail={id} data-preview-ready={status.ready} data-preview-active={status.active} data-preview-phase={status.phase??'idle'}>
    <header className={styles.topbar}>
      <Link to="/sessions" className={styles.mobileBack} aria-label="返回会话列表"><ArrowLeft size={20}/></Link>
      <div className={styles.identity}><h1 title={sample.title}>{sample.title}</h1><span>{sample.world}</span></div>
      <div className={styles.topActions}>
        <ContextBar/><span className={styles.divider}/>
        <span className={styles.status} data-active={status.active} data-error={!!status.error} title={stateLabel} aria-label={'本地预览，'+stateLabel}><i/><span>演示</span></span>
        <button className={styles.iconButton} type="button" aria-label="会话设置" aria-haspopup="dialog" onClick={openSettings}><Settings2 size={18}/></button>
      </div>
    </header>
    <div ref={stageViewport} className={styles.stageSlot} aria-label="故事舞台">
      <StoryPreviewHost ref={stage} sessionId={id} kind={sample.custom?'composed':'official'} fontSize={fontSize} bottomInset={bottomInset} onSetDraft={receiveDraft} onStatusChange={updateStatus} className={styles.preview}/>
    </div>
    <div ref={composerOverlay} className={styles.composerArea} data-composer-overlay>
      {sendError&&<p className={styles.previewError} data-preview-notice role="alert">{sendError}</p>}
      {expanded?<form className={styles.composer} data-session-composer aria-label="消息输入" onSubmit={submitForm}>
        <button type="button" className={styles.collapse} aria-label="收起输入框" title="收起输入框" onClick={()=>setExpanded(false)}><ChevronDown size={19}/></button>
        <div ref={composer} className={styles.editor}>
          <RoleplayComposer value={draft} disabled={!!status.error} onChange={updateDraft} onSubmit={text=>void submit(text)}/>
        </div>
        {status.active?<button className={styles.send} type="button" aria-label="停止本地预览" title="停止生成" onClick={()=>stage.current?.stop()}><Square size={16}/></button>:
          <button className={styles.send} type="submit" disabled={disabledSend} aria-label="发送消息到本地预览" aria-busy={sending||undefined} title="发送（⌘ / Ctrl + Enter）"><Send size={18}/></button>}
      </form>:<div className={styles.collapsedActions}>
        <button ref={expandButton} type="button" className={styles.expand} aria-label="展开输入框" title="展开输入框" onClick={focusInput}><ChevronUp size={19}/></button>
        {status.active&&<button className={styles.stopCollapsed} type="button" aria-label="停止本地预览" title="停止生成" onClick={()=>stage.current?.stop()}><Square size={16}/></button>}
      </div>}
    </div>
    {settings&&<Modal title="会话设置" onClose={cancelSettings}>
      <div className={styles.settingRows}>
        <div><span>会话名称</span><strong>{sample.title}</strong></div>
        <div><span>所属世界</span><strong>{sample.world}</strong></div>
      </div>
      <div className={styles.readingSetting}>
        <label htmlFor="preview-reading-size">阅读字号 <output htmlFor="preview-reading-size">{fontSize}px</output></label>
        <input id="preview-reading-size" type="range" min={13} max={21} step={1} value={fontSize} onChange={event=>setFontSize(Number(event.target.value))} aria-valuetext={fontSize+' 像素'}/>
        <p style={{fontSize}}>风穿过长街，灯火渐渐亮起。</p>
      </div>
      <p className={styles.contextNote}><Info size={14}/> 本地预览 · 阅读设置只在本次浏览中保留。</p>
      <div className={styles.settingsActions}><Button onClick={cancelSettings}>取消</Button><Button tone="accent" onClick={saveSettings}>保存</Button></div>
    </Modal>}
  </section>;
}
