import React from 'react';
import { useSRAssetUrl } from '@sillyrealms/sdk';

export default function AssetImage({
  src,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const resolvedSrc = useSRAssetUrl(src || null);
  return <img {...props} src={resolvedSrc ?? undefined} />;
}
