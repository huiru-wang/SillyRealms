import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import {IconButton} from './Button';
import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import styles from './Modal.module.css';
import {activateModal} from './modal-interaction';

export type ModalProps={
  /** Hide the portal while retaining its children; hidden modals own no focus or listeners. */
  open?:boolean;
  title:string;
  onClose:()=>void;
  children:ReactNode;
  size?:'default'|'editor';
  footer?:ReactNode;
  /** Return false to keep the dialog open after a user close request. */
  onBeforeClose?:()=>boolean;
  closeOnBackdrop?:boolean;
  mobileSheet?:boolean;
};

export function Modal({open=true,title,onClose,children,size='default',footer,onBeforeClose,closeOnBackdrop=true,mobileSheet=false}:ModalProps){
  useTranslation();
  const [phase,setPhase]=useState<'enter'|'open'|'exit'>('enter');
  const titleId=useId();
  const closeRef=useRef<HTMLButtonElement>(null);
  const panelRef=useRef<HTMLElement>(null);
  const closing=useRef(false);
  const visible=useRef(open);visible.current=open;
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const onCloseRef=useRef(onClose);
  const onBeforeCloseRef=useRef(onBeforeClose);
  // Editing a draft changes these props frequently. Keep the mounted dialog's
  // focus and animation lifecycle stable while using the latest callbacks.
  onCloseRef.current=onClose;
  onBeforeCloseRef.current=onBeforeClose;

  const requestClose=useCallback(()=>{
    if(!visible.current||closing.current||onBeforeCloseRef.current?.()===false)return;
    closing.current=true;
    setPhase('exit');
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      onCloseRef.current();
      return;
    }
    timer.current=setTimeout(()=>{
      timer.current=null;
      onCloseRef.current();
    },200);
  },[]);

  useEffect(()=>{
    if(!open)return;
    closing.current=false;
    setPhase('enter');
    const deactivate=activateModal(document,()=>panelRef.current,()=>closeRef.current,requestClose);
    const enterFrame=requestAnimationFrame(()=>{
      if(!closing.current)setPhase('open');
    });
    return()=>{
      cancelAnimationFrame(enterFrame);
      if(timer.current!==null){clearTimeout(timer.current);timer.current=null;}
      deactivate();
    };
  },[requestClose,open]);

  const hasFooter=footer!==undefined&&footer!==null&&footer!==false;
  return createPortal(
    <div className={styles.backdrop} hidden={!open} inert={!open} aria-hidden={!open||undefined} data-state={phase} data-size={size} data-mobile-sheet={mobileSheet||undefined}
      onMouseDown={e=>{if(closeOnBackdrop&&e.currentTarget===e.target)requestClose();}}>
      <section ref={panelRef} className={styles.panel} role={open?'dialog':undefined} aria-modal={open?true:undefined} aria-labelledby={open?titleId:undefined}>
        <header className={styles.header}>
          <h2 id={titleId}>{title}</h2>
          <IconButton ref={closeRef} data-modal-close type="button" aria-label={i18n.t("common:closeDialog")} onClick={requestClose}><X size={20}/></IconButton>
        </header>
        <div className={styles.body} data-modal-body>{children}</div>
        {hasFooter&&<footer className={styles.footer}>{footer}</footer>}
      </section>
    </div>,document.body
  );
}
