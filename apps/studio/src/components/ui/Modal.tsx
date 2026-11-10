import {useEffect,useRef,type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {X} from 'lucide-react';
import styles from './Modal.module.css';
type Props={title:string;onClose:()=>void;children:ReactNode;};
export function Modal({title,onClose,children}:Props){
  const closeRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const before=document.activeElement instanceof HTMLElement?document.activeElement:null;
    closeRef.current?.focus();
    function key(e:KeyboardEvent){if(e.key==='Escape')onClose();}
    document.addEventListener('keydown',key);
    return ()=>{document.removeEventListener('keydown',key);before?.focus();};
  },[onClose]);
  return createPortal(
    <div className={styles.backdrop} onMouseDown={e=>{if(e.currentTarget===e.target)onClose();}}>
      <section className={styles.panel} role="dialog" aria-modal="true" aria-labelledby="studio-dialog-title">
        <header className={styles.header}><h2 id="studio-dialog-title">{title}</h2><button ref={closeRef} aria-label="关闭弹窗" onClick={onClose}><X size={18}/></button></header>
        <div className={styles.body}>{children}</div>
      </section>
    </div>,document.body
  );
}
