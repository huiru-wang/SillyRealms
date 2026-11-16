import React, {createContext, useContext, type ReactNode} from 'react';
import {resolveSRAssetUrl} from './asset-url.js';

const AssetContext = createContext<string | null>(null);

/** Assets expose a resource URL only, never a world object or privileged transport. */
export function SRAssetProvider({baseUrl, children}: {baseUrl: string | null; children: ReactNode}) {
  return <AssetContext.Provider value={baseUrl}>{children}</AssetContext.Provider>;
}

export function useSRAssetBaseUrl(): string | null {
  return useContext(AssetContext);
}

export function useSRAssetUrl(uri: string | null): string | null {
  return resolveSRAssetUrl(uri, useSRAssetBaseUrl());
}
