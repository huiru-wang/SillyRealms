import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import styles from './Modal.module.css';

type Props={title:string;onClose:()=>void;children:ReactNode;};

export function Modal({title,onClose,children}:Props){
  const [phase,setPhase]=useState<'enter'|'open'|'exit'>('enter');
  const closeRef=useRef<HTMLButtonElement>(null);
  const closing=useRef(false);
  const timer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const onCloseRef=useRef(onClose);
  onCloseRef.current=onClose;

  const requestClose=useCallback(()=>{
    if(closing.current)return;
    closing.current=true;
    setPhase('exit');
    if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){
      onCloseRef.current();
      return;
    }
    timer.current=setTimeout(()=>onCloseRef.current(),200);
  },[]);

  useEffect(()=>{
    const before=document.activeElement instanceof HTMLElement?document.activeElement:null;
    closeRef.current?.focus();
    const enterFrame=requestAnimationFrame(()=>setPhase('open'));
    function key(e:KeyboardEvent){if(e.key==='Escape'){e.preventDefault();requestClose();}}
    document.addEventListener('keydown',key);
    return ()=>{
      cancelAnimationFrame(enterFrame);
      document.removeEventListener('keydown',key);
      if(timer.current!==null)clearTimeout(timer.current);
      before?.focus();
    };
  },[requestClose]);

  return createPortal(
    <div className={styles.backdrop} data-state={phase}
      onMouseDown={e=>{if(e.currentTarget===e.target)requestClose();}}>
      <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="studio-dialog-title">
        <header className={styles.header}>
          <h2 id="studio-dialog-title">{title}</h2>
          <button ref={closeRef} aria-label="关闭弹窗" onClick={requestClose}><X size={18}/></button>
        </header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>,document.body
  );
}
