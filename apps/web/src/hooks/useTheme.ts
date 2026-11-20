import {useEffect,useState} from 'react';
import {builtinTheme,setTheme,type ThemeMode} from '../styles/theme';
export type Theme=ThemeMode;
export function useTheme(){
 const read=():Theme=>document.documentElement.dataset.theme==='light'?'light':'dark';
 const [theme,update]=useState<Theme>(read);
 useEffect(()=>{const sync=()=>update(read());document.addEventListener('sr:appearance-changed',sync);return()=>document.removeEventListener('sr:appearance-changed',sync);},[]);
 return {theme,toggleTheme:()=>setTheme(builtinTheme(read()==='dark'?'light':'dark'))};
}
