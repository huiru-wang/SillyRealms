import React from 'react';
import {useSRAssetUrl} from '@sillyrealms/sdk';
import type {MessageComponentProps} from '@sillyrealms/sdk';

// Only these two authored resources can be selected by a message marker.
const scenes = {
  harbor: {asset: 'sr-asset://assets/harbor.svg', title: '雾港 · 码头', caption: '潮声漫过木桩，风灯正在靠岸。'},
  lighthouse: {asset: 'sr-asset://assets/lighthouse.svg', title: '雾港 · 旧灯塔', caption: '有些光，始终替归来的人留着。'},
};

export default function HarborScene({groups}: MessageComponentProps) {
  const key = groups[0];
  const scene = key === 'harbor' || key === 'lighthouse' ? scenes[key] : null;
  const src = useSRAssetUrl(scene?.asset ?? null);
  if (!scene || !src) return null;
  return <figure style={{margin: '0 0 22px', overflow: 'hidden', borderRadius: 12, border: '1px solid var(--sr-story-line, #dce2dd)'}}>
    <img src={src} alt={scene.title + '的原创场景插图'} style={{display: 'block', width: '100%', maxWidth: '100%', height: 'clamp(130px, 20vw, 220px)', objectFit: 'cover', margin: 0, borderRadius: 0}}/>
    <figcaption style={{display: 'flex', flexWrap: 'wrap', gap: '4px 12px', padding: '11px 14px', fontSize: 11, lineHeight: 1.6, color: 'var(--sr-story-muted, #727e80)', background: 'var(--sr-story-surface, #ffffff)'}}>
      <span style={{color: 'var(--sr-story-text, #263138)', fontWeight: 600}}>{scene.title}</span>
      <span>{scene.caption}</span>
    </figcaption>
  </figure>;
}
HarborScene.srDisplay = 'block' as const;
