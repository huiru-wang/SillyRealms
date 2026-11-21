import {useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode} from 'react';
import {Info} from 'lucide-react';
import {IconButton} from '../../components/ui/Button';
import styles from './StateBrowser.module.css';

export function StateHelp({label, children}: {label: string; children: ReactNode}) {
  const id = useId(), root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {if (!root.current?.contains(event.target as Node)) setOpen(false);};
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Close this disclosure before the enclosing Modal handles Escape.
      event.preventDefault(); event.stopPropagation();
      setOpen(false); button.current?.focus({preventScroll: true});
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true);};
  }, [open]);
  return <div className={styles.help} ref={root}>
    <IconButton ref={button} aria-label={label} aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><Info size={18}/></IconButton>
    <div id={id} className={styles.helpText} hidden={!open}>{children}</div>
  </div>;
}

type Visit<T> = {data: T; parentLabel: string; scrollTop: number; triggerId: string};

/** Both state browsers keep navigation inside their existing page/dialog scroll owner. */
export function useStateNavigation<T>(resetKey: unknown, scrollSelector: string) {
  const id = useId(), root = useRef<HTMLDivElement>(null);
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width:760px)').matches);
  const [visits, setVisits] = useState<Visit<T>[]>([]);
  const pendingPosition = useRef<{scrollTop: number; focusId: string} | null>(null);
  const current = visits.at(-1);
  const scroller = () => root.current?.closest<HTMLElement>(scrollSelector);
  useEffect(() => {
    const query = window.matchMedia('(max-width:760px)');
    const update = () => setMobile(query.matches);
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {setVisits([]); pendingPosition.current = null;}, [resetKey]);
  useLayoutEffect(() => {
    const position = pendingPosition.current;
    if (!position) return;
    pendingPosition.current = null;
    const scroll = scroller();
    if (scroll) scroll.scrollTop = position.scrollTop;
    document.getElementById(position.focusId)?.focus({preventScroll: true});
  }, [visits]);
  const enter = (data: T, parentLabel: string, triggerId: string) => {
    const visit = {data, parentLabel, triggerId, scrollTop: scroller()?.scrollTop ?? 0};
    pendingPosition.current = {scrollTop: 0, focusId: id + '-detail'};
    setVisits(previous => [...previous, visit]);
  };
  const back = () => {
    if (!current) return;
    pendingPosition.current = {scrollTop: current.scrollTop, focusId: current.triggerId};
    setVisits(previous => previous.slice(0, -1));
  };
  return {id, root, mobile, current, enter, back};
}
