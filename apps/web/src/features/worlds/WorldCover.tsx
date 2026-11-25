import {useLayoutEffect,useRef} from 'react';
import {WorldAssetImage,useWorldAssetBaseUrl} from '../../world-assets';
import {safeImage} from './resources';
import {mosaicGeometry} from './cover-mosaic';

type Props={
  worldId?:string|null;source?:string|null;mosaicEnabled:boolean;density:number;className?:string;
};

/** Only the image layer is replaced. The caller supplies fixed CSS width/height for both modes. */
export function WorldCover({worldId,source,mosaicEnabled,density,className}:Props) {
  const src=safeImage(source,useWorldAssetBaseUrl(worldId));
  if(!mosaicEnabled)return <WorldAssetImage worldId={worldId} source={source} className={className} alt="" loading="lazy"/>;
  return src?<MosaicCover key={src} src={src} density={density} className={className}/>:null;
}

function MosaicCover({src,density,className}:{src:string;density:number;className?:string}) {
  const canvasRef=useRef<HTMLCanvasElement>(null);
  const currentDensity=useRef(density);
  const redraw=useRef<()=>void>(()=>{});
  currentDensity.current=density;
  useLayoutEffect(()=>{
    const canvas=canvasRef.current;
    if(!canvas)return;
    const context=canvas.getContext('2d');
    const sample=canvas.ownerDocument.createElement('canvas');
    const sampling=sample.getContext('2d');
    if(!context||!sampling)return;
    let disposed=false,frame=0,started=false;
    let loaded:HTMLImageElement|null=null;
    const image=new Image();
    image.decoding='async';
    const draw=()=>{
      frame=0;
      if(disposed||!loaded)return;
      const geometry=mosaicGeometry(loaded.naturalWidth,loaded.naturalHeight,
        canvas.clientWidth,canvas.clientHeight,currentDensity.current,window.devicePixelRatio);
      if(!geometry)return;
      canvas.width=geometry.width;canvas.height=geometry.height;
      sample.width=geometry.sampleWidth;sample.height=geometry.sampleHeight;
      try{
        sampling.imageSmoothingEnabled=true;
        sampling.imageSmoothingQuality='high';
        sampling.drawImage(loaded,geometry.sourceX,geometry.sourceY,geometry.sourceWidth,geometry.sourceHeight,
          0,0,sample.width,sample.height);
        context.imageSmoothingEnabled=false;
        // Drawing directly also supports remote covers without reading/exporting their pixels.
        context.drawImage(sample,0,0,canvas.width,canvas.height);
      }catch{
        context.clearRect(0,0,canvas.width,canvas.height);
      }
    };
    const schedule=()=>{if(!disposed&&!frame)frame=requestAnimationFrame(draw);};
    redraw.current=schedule;
    image.onload=()=>{if(!disposed){loaded=image;schedule();}};
    image.onerror=()=>{loaded=null;context.clearRect(0,0,canvas.width,canvas.height);};
    const load=()=>{if(!started&&!disposed){started=true;image.src=src;}};
    const visibility=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{
      if(entries.some(entry=>entry.isIntersecting)){visibility?.disconnect();load();}
    },{rootMargin:'200px'});
    if(visibility)visibility.observe(canvas);else load();
    const resize=new ResizeObserver(schedule);
    resize.observe(canvas);
    window.addEventListener('resize',schedule);
    return()=>{
      disposed=true;
      cancelAnimationFrame(frame);
      visibility?.disconnect();resize.disconnect();
      window.removeEventListener('resize',schedule);
      image.onload=null;image.onerror=null;loaded=null;
      redraw.current=()=>{};
    };
  },[src]);
  useLayoutEffect(()=>{redraw.current();},[density]);
  return <canvas ref={canvasRef} className={className} aria-hidden="true"
    style={{imageRendering:'pixelated',pointerEvents:'none'}}/>;
}
