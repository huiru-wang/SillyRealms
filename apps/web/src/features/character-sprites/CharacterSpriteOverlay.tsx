import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {safeImage} from '../worlds/resources';
import type {SpriteDisplay} from './controller';
import type {Character} from '../worlds/api/worlds';
import {spriteResource} from './items';
import {layoutSprites} from './layout';
import styles from './CharacterSpriteOverlay.module.css';

function Portrait({src,name,side,raised,enabled}:{src:string;name:string;side:string;raised:boolean;enabled:boolean}){
  const [ready,setReady]=useState<string|null>(null);
  useEffect(()=>{
    if(!enabled)return;
    let current=true;
    const image=new Image();
    image.src=src;
    image.decode().then(()=>{if(current)setReady(src);},()=>{if(current)setReady(null);});
    return()=>{current=false;};
  },[src,enabled]);
  return ready===src?<img key={ready} className={styles.portrait} data-side={side} data-raised={raised}
    src={ready} alt={name} draggable={false}/>:null;
}

export function CharacterSpriteOverlay({display,characters,assetBaseUrl,bottomInset}:{display:SpriteDisplay;characters:readonly Character[];assetBaseUrl:string|null;bottomInset:number}){
  const layer=useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({width:0,height:0});
  const [retained,setRetained]=useState(display.enabled);
  useLayoutEffect(()=>{
    const element=layer.current;
    if(!element)return;
    const observer=new ResizeObserver(([entry])=>{
      const {width,height}=entry.contentRect;
      setSize({width,height});
    });
    observer.observe(element);
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(display.enabled){setRetained(true);return;}
    const timer=setTimeout(()=>setRetained(false),150);
    return()=>clearTimeout(timer);
  },[display.enabled]);
  const figures=display.enabled||retained?layoutSprites(display.frame?.items??[],size.width,size.height):[];
  return <div ref={layer} className={styles.layer} data-enabled={display.enabled} aria-hidden={!display.enabled}
    style={{bottom:bottomInset}}>
    {figures.map(({item,side})=>{
      const {asset,name}=spriteResource(item,characters);
      const src=safeImage(asset,assetBaseUrl);
      return src?<Portrait key={item.characterId} src={src} side={side} enabled={display.enabled}
        raised={item.position.startsWith('top')} name={name}/>:null;
    })}
  </div>;
}
