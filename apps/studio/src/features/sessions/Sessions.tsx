import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Link,useParams} from 'react-router-dom';
import {ArrowDown,ArrowLeft,ArrowRight,ChevronDown,ChevronUp,Info,Send,Settings2} from 'lucide-react';
import {Modal} from '../../components/ui/Modal';
import {Button} from '../../components/ui/Button';
import {sessionSamples as samples} from '../../fixtures/sessions';
import styles from './Sessions.module.css';

const drafts:Record<string,string>={};
const additions:Record<string,string[]>={};

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

function DefaultStory(){return <div className={styles.storyColumn}>
  <div className={styles.storyDate}>初入长安 <span>·</span> 故事开始</div>
  <article className={styles.narrative}>
    <div className={styles.messageMeta}><span className={styles.storyMark}>长</span><span>长安风云</span></div>
    <p>暮色正沿着朱雀街缓缓落下。街边的灯笼一盏接一盏亮起来，行人收起摊铺，风里带着一点刚落过雨的凉意。</p>
    <p>你在城门口收到一封没有署名的信。信纸上只有寥寥几字：<em>“今夜戌时，来平康坊。不必带旁人。”</em></p>
    <p>马车停在街角，车夫回头看了你一眼。远处传来几声清脆的梆响，离信上约定的时辰已不剩多久。</p>
  </article>
  <div className={styles.playerRow}><span className={styles.playerBubble}>我收起信，走向平康坊。</span><span className={styles.playerAvatar}>我</span></div>
  <article className={styles.narrative}>
    <div className={styles.messageMeta}><span className={styles.storyMark}>长</span><span>长安风云</span></div>
    <p>坊门前的灯火比别处更亮。你穿过人群，留意到一家茶肆的二楼窗边，有人正将一盏茶推向对面的空座。</p>
    <p>那人抬眼望来，像是早已认出了你。</p>
  </article>
</div>}

function CustomStory(){return <div className={styles.customStory}>
  <div className={styles.sceneImage} role="img" aria-label="雨夜里的霓虹之城"/>
  <div className={styles.sceneContent}>
    <div className={styles.sceneKicker}><span/> NIGHT CITY <b> / </b> 03</div>
    <div className={styles.sceneTitle}><div><span>第三区 · 23:41</span><h2>雨夜重逢</h2></div><span className={styles.sceneWeather}>小雨<br/><strong>街道湿滑</strong></span></div>
    <p className={styles.sceneLead}>雨落在玻璃顶棚上，淹没了街道另一端的脚步声。</p>
    <div className={styles.sceneRule}/>
    <div className={styles.sceneDialogue}><div className={styles.scenePortrait}>岚</div><div><strong>林岚 <small>旧识</small></strong><p>“你还是来了。”她把一枚旧芯片放在桌上，霓虹在金属边缘留下一道蓝光。</p><p>“这次，我们可能没有太多时间。”</p></div></div>
    <div className={styles.sceneFoot}><span>地点　旧城区 / 雨幕酒吧</span><span>故事进行中</span></div>
  </div>
</div>}

export function SessionDetailPage(){
  const {sessionId}=useParams();
  const sample=samples.find(item=>item.id===sessionId);
  const id=sample?.id??'';
  const [draft,setDraft]=useState(()=>drafts[id]??'');
  const [messages,setMessages]=useState(()=>additions[id]??[]);
  const [expanded,setExpanded]=useState(true);
  const [settings,setSettings]=useState(false);
  const [notice,setNotice]=useState(false);
  const [atBottom,setAtBottom]=useState(true);
  const reading=useRef<HTMLDivElement>(null);
  const input=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{setDraft(drafts[id]??'');setMessages(additions[id]??[]);setExpanded(true);setNotice(false);setAtBottom(true);},[id]);
  if(!sample)return <div className={styles.notFound}><h1>找不到这个会话</h1><Link to="/sessions">返回会话列表</Link></div>;
  const updateDraft=(value:string)=>{drafts[id]=value;setDraft(value);setNotice(false);};
  const scrollToLatest=()=>reading.current?.scrollTo({top:reading.current.scrollHeight,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
  const submit=(event?:FormEvent)=>{
    event?.preventDefault();
    if(!draft.trim())return;
    const next=[...(additions[id]??[]),draft.trim()]; additions[id]=next;setMessages(next);updateDraft('');setNotice(true);
    requestAnimationFrame(scrollToLatest);
  };
  return <section className={styles.detail} data-session-detail={id}>
    <header className={styles.topbar}>
      <Link to="/sessions" className={styles.mobileBack} aria-label="返回会话列表"><ArrowLeft size={20}/></Link>
      <div className={styles.identity}><h1 title={sample.title}>{sample.title}</h1><span>{sample.world}</span></div>
      <div className={styles.topActions}><ContextBar/><span className={styles.divider}/><span className={styles.status} title="静态演示"><i/>演示</span><button className={styles.iconButton} type="button" aria-label="会话设置" onClick={()=>setSettings(true)}><Settings2 size={18}/></button></div>
    </header>
    <div className={styles.reading} ref={reading} tabIndex={0} aria-label="故事内容" onScroll={event=>{const el=event.currentTarget;setAtBottom(el.scrollHeight-el.scrollTop-el.clientHeight<48);}}>
      {sample.custom?<CustomStory/>:<DefaultStory/>}
      {messages.length>0&&<div className={styles.storyColumn}>{messages.map((message,index)=><div className={styles.playerRow} key={index}><span className={styles.playerBubble}>{message}</span><span className={styles.playerAvatar}>我</span></div>)}</div>}
    </div>
    {!atBottom&&<button className={styles.latest} type="button" onClick={scrollToLatest}><ArrowDown size={15}/>回到最新</button>}
    <div className={styles.composerArea}>
      <p className={notice?styles.previewNotice:styles.srOnly} role="status">{notice?'已添加到本地预览，不会发送或保存。':''}</p>
      {expanded?<form className={styles.composer} onSubmit={submit}>
        <label className={styles.inputLabel} htmlFor="session-draft">输入消息</label>
        <textarea ref={input} id="session-draft" rows={2} value={draft} placeholder="写下你的回应…" onChange={event=>updateDraft(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)&&!event.nativeEvent.isComposing){event.preventDefault();submit();}}}/>
        <div className={styles.composerFooter}><button type="button" className={styles.collapse} onClick={()=>setExpanded(false)}><ChevronDown size={16}/>收起输入框</button><span className={styles.keyHint}>⌘ / Ctrl + Enter 发送</span><button className={styles.send} type="submit" disabled={!draft.trim()} aria-label="发送消息到本地预览"><Send size={16}/><span>发送</span></button></div>
      </form>:<button type="button" className={styles.expand} onClick={()=>{setExpanded(true);requestAnimationFrame(()=>input.current?.focus());}}><ChevronUp size={16}/>展开输入框</button>}
    </div>
    {settings&&<Modal title="会话设置" onClose={()=>setSettings(false)}><div className={styles.settingRows}><div><span>会话名称</span><strong>{sample.title}</strong></div><div><span>所属世界</span><strong>{sample.world}</strong></div></div><p className={styles.contextNote}><Info size={14}/> 当前为静态视觉样板，设置将在后续完善。</p><Button onClick={()=>setSettings(false)}>完成</Button></Modal>}
  </section>;
}
