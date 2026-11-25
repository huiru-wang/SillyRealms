export const MIN_MOSAIC_DENSITY = 8;
export const MAX_MOSAIC_DENSITY = 64;
export const DEFAULT_MOSAIC_DENSITY = 24;

export function normalizeMosaicDensity(value:number):number {
  return Number.isFinite(value)
    ? Math.max(MIN_MOSAIC_DENSITY,Math.min(MAX_MOSAIC_DENSITY,Math.round(value)))
    : DEFAULT_MOSAIC_DENSITY;
}

export type MosaicGeometry = {
  sourceX:number; sourceY:number; sourceWidth:number; sourceHeight:number;
  sampleWidth:number; sampleHeight:number; width:number; height:number;
};

/** Crop like object-fit:cover; density is the cell count on the visible short edge. */
export function mosaicGeometry(
  sourceWidth:number,sourceHeight:number,width:number,height:number,density:number,pixelRatio=1,
):MosaicGeometry|null {
  if(![sourceWidth,sourceHeight,width,height].every(value=>Number.isFinite(value)&&value>0))return null;
  const scale=Math.max(width/sourceWidth,height/sourceHeight);
  const croppedWidth=width/scale,croppedHeight=height/scale;
  const shortEdge=Math.min(width,height),cells=normalizeMosaicDensity(density);
  const ratio=Number.isFinite(pixelRatio)&&pixelRatio>0?pixelRatio:1;
  return {
    sourceX:(sourceWidth-croppedWidth)/2,sourceY:(sourceHeight-croppedHeight)/2,
    sourceWidth:croppedWidth,sourceHeight:croppedHeight,
    sampleWidth:Math.max(1,Math.round(width/shortEdge*cells)),
    sampleHeight:Math.max(1,Math.round(height/shortEdge*cells)),
    width:Math.max(1,Math.round(width*ratio)),height:Math.max(1,Math.round(height*ratio)),
  };
}
