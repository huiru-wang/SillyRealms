import {useEffect,useState} from 'react';
import {compileComponents} from '../../../../../packages/sr-ui-compiler/src/index';
import {WorldComponentView} from './WorldComponentView';
import {compileWorldComponents} from './compile-world-components';
import {createPreviewCompiler} from './preview-compilation-cache';
import {createPreviewSourceCache,previewContentIdentity,retainPreview,type PreviewEntry} from './preview-cache';
import type {WorldDetail} from './api/worlds';

const compilePreview=createPreviewCompiler(compileComponents);

export function WorldComponentCache({world,active}:{world:WorldDetail;active:PreviewEntry|null}) {
  // Management revisions and freshly decoded arrays do not change author source.
  const identity=previewContentIdentity(world);
  return <PreviewPool key={identity} world={world} active={active}/>;
}

function PreviewPool({world,active}:{world:WorldDetail;active:PreviewEntry|null}) {
  const [entries,setEntries]=useState<readonly PreviewEntry[]>([]);
  const retained=retainPreview(entries,active);
  if(retained!==entries)setEntries(retained);
  const [source]=useState(()=>createPreviewSourceCache(signal=>
    compileWorldComponents(world,sources=>compilePreview(world.id,sources),signal)));
  useEffect(()=>()=>source.dispose(),[source]);
  return <>{retained.map(item=>{
    const visible=item.id===active?.id;
    return <div key={JSON.stringify([item.id,item.entry])} hidden={!visible} inert={!visible} data-world-preview={item.id}>
      <WorldComponentView worldId={world.id} entry={item.entry} title={item.title} active={visible} load={source.read}/>
    </div>;
  })}</>;
}
