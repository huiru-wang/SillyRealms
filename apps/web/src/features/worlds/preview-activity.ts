/** Hiding a cached iframe does not suspend its document or author timers. */
export function createPreviewActivity(doc:Document) {
  let hostActive=true,active=true;
  const pause=(media:HTMLMediaElement)=>{try{media.pause();}catch{/* One author element must not block the others. */}};
  const sync=()=>{
    active=hostActive&&!doc.hidden;
    doc.documentElement.toggleAttribute('data-preview-inactive',!active);
    if(!active)doc.querySelectorAll<HTMLMediaElement>('audio,video').forEach(pause);
  };
  const onPlay=(event:Event)=>{
    const target=event.target as HTMLMediaElement|null;
    if(!active&&(target?.tagName==='AUDIO'||target?.tagName==='VIDEO'))pause(target);
  };
  doc.addEventListener('visibilitychange',sync);
  doc.addEventListener('play',onPlay,true);
  sync();
  return {
    get active(){return active;},
    setActive(value:boolean){hostActive=value;sync();},
    dispose(){doc.removeEventListener('visibilitychange',sync);doc.removeEventListener('play',onPlay,true);},
  };
}
