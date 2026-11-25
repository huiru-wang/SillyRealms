import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mosaicGeometry,normalizeMosaicDensity,DEFAULT_MOSAIC_DENSITY} from '../src/features/worlds/cover-mosaic.ts';

test('mosaic crops a wide cover centrally instead of stretching it into a tall card',()=>{
  assert.deepEqual(mosaicGeometry(400,200,100,200,24),{
    sourceX:150,sourceY:0,sourceWidth:100,sourceHeight:200,
    sampleWidth:24,sampleHeight:48,width:100,height:200,
  });
});

test('mosaic crops portrait covers centrally and samples only the visible area',()=>{
  assert.deepEqual(mosaicGeometry(200,400,200,100,24),{
    sourceX:0,sourceY:150,sourceWidth:200,sourceHeight:100,
    sampleWidth:48,sampleHeight:24,width:200,height:100,
  });
});

test('higher density creates more smaller cells, independent of source resolution or device pixels',()=>{
  const coarse=mosaicGeometry(900,1000,180,200,8);
  const fine=mosaicGeometry(900,1000,180,200,64);
  const highResolution=mosaicGeometry(1800,2000,180,200,8,3);
  assert.equal(coarse.sampleWidth,8);assert.equal(fine.sampleWidth,64);
  assert.ok(coarse.width/coarse.sampleWidth>fine.width/fine.sampleWidth);
  assert.equal(highResolution.sampleWidth,coarse.sampleWidth);
  assert.equal(highResolution.sampleHeight,coarse.sampleHeight);
  assert.equal(highResolution.width,coarse.width*3);
  assert.equal(highResolution.height,coarse.height*3);
});

test('invalid and hidden dimensions do not produce drawable geometry',()=>{
  for(const input of [[0,100,100,100],[100,0,100,100],[100,100,0,100],[100,100,100,-1],[NaN,100,100,100]]){
    assert.equal(mosaicGeometry(...input,24),null);
  }
  assert.equal(normalizeMosaicDensity(NaN),DEFAULT_MOSAIC_DENSITY);
  assert.equal(normalizeMosaicDensity(Infinity),DEFAULT_MOSAIC_DENSITY);
  assert.equal(normalizeMosaicDensity(0),8);
  assert.equal(normalizeMosaicDensity(100),64);
  assert.equal(normalizeMosaicDensity(23.7),24);
});
