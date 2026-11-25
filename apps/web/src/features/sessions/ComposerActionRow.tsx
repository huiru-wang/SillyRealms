import {useLayoutEffect,useRef} from 'react';
import {Eye,EyeOff} from 'lucide-react';
import {useTranslation} from 'react-i18next';
import {Button} from '../../components/ui/Button';
import {stackComposerActions} from '../character-sprites/layout';
import type {HostedComposerButton} from '../../stage-host/composer-buttons';
import styles from './Sessions.module.css';

type ToggleProps={enabled:boolean;onToggle:()=>void};
export function SpriteToggle({enabled,onToggle}:ToggleProps){
  const {t}=useTranslation('sessions');
  return <Button size="compact" className={styles.spriteToggle} aria-pressed={enabled} onClick={onToggle}
    icon={enabled?<Eye size={15}/>:<EyeOff size={15}/>}>{t('characterSprites')}</Button>;
}

export function ComposerActionRow({buttons,toggle}:{buttons:HostedComposerButton[];toggle:ToggleProps|null}){
  const {t}=useTranslation('sessions');
  const row=useRef<HTMLDivElement>(null),group=useRef<HTMLDivElement>(null);
  const hasToggle=toggle!==null;
  useLayoutEffect(()=>{
    const root=row.current,actions=group.current,pill=root?.firstElementChild;
    if(!root||!actions||!hasToggle||!pill)return;
    const measure=()=>{
      const children=Array.from(actions.children);
      const gap=parseFloat(getComputedStyle(actions).columnGap)||0;
      const widths=children.map(button=>button.getBoundingClientRect().width);
      root.dataset.stacked=String(stackComposerActions(root.clientWidth,pill.getBoundingClientRect().width,widths,gap));
    };
    measure();
    const observer=new ResizeObserver(measure);
    for(const element of [root,pill,...actions.children])observer.observe(element);
    return()=>{observer.disconnect();delete root.dataset.stacked;};
  },[buttons,hasToggle]);
  if(!toggle&&!buttons.length)return null;
  return <div ref={row} className={styles.actionRow} data-has-toggle={!!toggle}>
    {toggle&&<SpriteToggle {...toggle}/>}
    {buttons.length>0&&<div ref={group} className={styles.composerButtons} role="group" aria-label={t('stageActions')}>
      {buttons.map(button=><Button key={button.id} size="compact" disabled={button.disabled} title={button.label}
        onClick={button.click}>{button.label}</Button>)}
    </div>}
  </div>;
}
