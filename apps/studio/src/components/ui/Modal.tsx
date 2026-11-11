import {useCallback,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import styles from './Modal.module.css';

export type ModalProps={
  title:string;
  onClose:()=>void;
  children:ReactNode;
  size?:'default'|'editor';
  footer?:ReactNode;
  /** Return false to keep the dialog open after a user close request. */
  onBeforeClose?:()=>boolean;
  closeOnBackdrop?:boolean;
};

export function Modal({title,onClose,children,size='default',footer,onBeforeClose,closeOnBackdrop=true}:ModalProps){
  const [phase,setPhase]=useState<'enter'|'open'|'exit'>('enter');
  const titleId=useId();
  const closeRef=useRef<HTMLButtonElement>(null);
  const panelRef=useRef<HTMLElement>(null);
  const closing=useRef(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const onCloseRef=useRef(onClose);
  const onBeforeCloseRef=useRef(onBeforeClose);
  // Editing a draft changes these props frequently. Keep the mounted dialog's
  // focus and animation lifecycle stable while using the latest callbacks.
  onCloseRef.current=onClose;
  onBeforeCloseRef.current=onBeforeClose;

  const requestClose=useCallback(()=>{
    if(closing.current||onBeforeCloseRef.current?.()===false)return;
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
    const before=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const root=document.getElementById('root');
    const wasInert=root?.inert ?? false;
    if(root)root.inert=true;
    closeRef.current?.focus({preventScroll:true});
    const enterFrame=requestAnimationFrame(()=>{
      if(!closing.current)setPhase('open');
    });
    function key(e:KeyboardEvent){
      if(e.defaultPrevented||e.isComposing)return;
      if(e.key==='Escape'){e.preventDefault();requestClose();return;}
      if(e.key!=='Tab')return;
      const items=[...(panelRef.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [])]
        .filter(el=>el.getClientRects().length>0&&el.tabIndex>=0&&!el.closest('[inert]')&&getComputedStyle(el).visibility!=='hidden');
      if(!items.length){e.preventDefault();return;}
      const first=items[0],last=items[items.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
    document.addEventListener('keydown',key);
    return ()=>{
      cancelAnimationFrame(enterFrame);
      document.removeEventListener('keydown',key);
      if(timer.current!==null){
        clearTimeout(timer.current);
        timer.current=null;
      }
      if(root)root.inert=wasInert;
      if(before?.isConnected)before.focus({preventScroll:true});
    };
  },[requestClose]);

  const hasFooter=footer!==undefined&&footer!==null&&footer!==false;
  return createPortal(
    <div className={styles.backdrop} data-state={phase} data-size={size}
      onMouseDown={e=>{if(closeOnBackdrop&&e.currentTarget===e.target)requestClose();}}>
      <section ref={panelRef} className={styles.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className={styles.header}>
          <h2 id={titleId}>{title}</h2>
          <button ref={closeRef} type="button" aria-label="关闭弹窗" onClick={requestClose}><X size={18}/></button>
        </header>
        <div className={styles.body}>{children}</div>
        {hasFooter&&<footer className={styles.footer}>{footer}</footer>}
      </section>
    </div>,document.body
  );
}
