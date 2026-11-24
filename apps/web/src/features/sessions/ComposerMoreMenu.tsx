import {useTranslation} from 'react-i18next';
import {i18n} from '../../i18n/instance.ts';
import {useEffect, useId, useRef, useState} from 'react';
import {Ellipsis, RotateCcw} from 'lucide-react';
import {Button} from '../../components/ui/Button';
import styles from './Sessions.module.css';

export function ComposerMoreMenu({canRegenerate, onRegenerate}: {canRegenerate: boolean; onRegenerate(): void}) {
  useTranslation();
  const [open, setOpen] = useState(false);
  const id = useId(), root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null), item = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    item.current?.focus({preventScroll: true});
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);

  const close = () => { setOpen(false); trigger.current?.focus({preventScroll: true}); };
  return <div ref={root} className={styles.moreActions}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (open && event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); item.current?.focus(); }
    }}>
    <button ref={trigger} type="button" className={styles.collapse} aria-label={i18n.t("sessions:moreActions")} aria-haspopup="menu"
      aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <Ellipsis size={19} aria-hidden="true"/>
    </button>
    {open && <div id={id} role="menu" aria-label={i18n.t("sessions:moreActions")} className={styles.moreMenu}>
      <Button ref={item} role="menuitem" variant="ghost" icon={<RotateCcw size={16}/>} aria-disabled={!canRegenerate}
        onClick={() => { if (canRegenerate) { close(); onRegenerate(); } }}>{i18n.t("sessions:regenerate")}</Button>
    </div>}
  </div>;
}
