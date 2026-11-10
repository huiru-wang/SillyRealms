import {useEffect,useState} from 'react';
export type Theme = 'dark'|'light';
function getStoredTheme():Theme {
  try { return localStorage.getItem('sr-studio-theme')==='light'?'light':'dark'; }
  catch { return 'dark'; }
}
export function useTheme(){
  const [theme,setTheme]=useState<Theme>(getStoredTheme);
  useEffect(()=>{
    document.documentElement.dataset.theme=theme;
    try {localStorage.setItem('sr-studio-theme',theme);}catch{}
  },[theme]);
  return {theme,toggleTheme:()=>setTheme(t=>t==='dark'?'light':'dark')};
}
