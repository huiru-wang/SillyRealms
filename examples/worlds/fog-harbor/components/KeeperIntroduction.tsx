import React from 'react';
import {useSRAssetUrl} from '@sillyrealms/sdk';

// A public character introduction. It has no session API or model-only character content.
export default function KeeperIntroduction() {
  const avatar = useSRAssetUrl('sr-asset://assets/keeper.svg');
  return <article style={{display: 'flex', alignItems: 'center', gap: 16, padding: 8, color: 'var(--text)', lineHeight: 1.8}}>
    {avatar && <img src={avatar} alt="林舟" style={{width: 80, maxWidth: '30%', borderRadius: 12}} />}
    <div style={{minWidth: 0}}>
      <h2 style={{margin: '0 0 6px', fontSize: 18}}>林舟 · 守灯人</h2>
      <p style={{margin: 0, color: 'var(--text-muted)'}}>说话简短的年轻守灯人，熟悉雾港的航道。你可以向他问路，也可以请他看看信封上的印记。</p>
    </div>
  </article>;
}
