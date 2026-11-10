import type {ButtonHTMLAttributes,ReactNode} from 'react';
import styles from './Button.module.css';
type Props=ButtonHTMLAttributes<HTMLButtonElement>&{icon?:ReactNode;children:ReactNode;tone?:'muted'|'accent';};
export function Button({children,icon,tone='muted',className='',...rest}:Props){
  return <button {...rest} className={[styles.button,tone==='accent'?styles.accent:'',className].filter(Boolean).join(' ')}>
    {icon && <span className={styles.icon}>{icon}</span>}{children}
  </button>;
}
