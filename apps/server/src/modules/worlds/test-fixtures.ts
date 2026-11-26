import { worldPublication } from '../../testing/fixtures.js';
import { ZipFile } from 'yazl';
import { fromBuffer, type Entry, type ZipFile as InputZip } from 'yauzl';

export const worldCardFixture = () => ({
  spec_version: '0.2',
  data: {
    publication: worldPublication(),
    name: '雾港',
    tags: ['冒险'],
    characters: [{ id: 'player', name: '旅人', player_selectable: true }],
    openings: [{ id: 'start', name: '抵达', content: '船靠岸了。' }],
    state: {
      schema_version: 2,
      scopes: { global: { coins: { type: 'number', initial: 3, description: '金币', rules: { coins: '按叙事中的交易变化' } } } },
    },
  },
});

export async function zipBytes(entries: { name: string; data: string | Buffer; mode?: number }[]): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(Buffer.from(chunk)));
    zip.outputStream.on('error', reject);
    zip.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) zip.addBuffer(Buffer.from(entry.data), entry.name, { compress: false, mode: entry.mode });
  zip.end();
  return done;
}

export async function unzipBytes(bytes: Uint8Array): Promise<Record<string, Buffer>> {
  const zip = await new Promise<InputZip>((resolve, reject) => fromBuffer(Buffer.from(bytes),
    { lazyEntries: true }, (error, file) => error ? reject(error) : resolve(file!)));
  return new Promise((resolve, reject) => {
    const files: Record<string, Buffer> = {};
    zip.on('error', reject);
    zip.on('end', () => resolve(files));
    zip.on('entry', (entry: Entry) => {
      zip.openReadStream(entry, (error, stream) => {
        if (error) { zip.close(); reject(error); return; }
        const chunks: Buffer[] = [];
        stream!.on('error', reject);
        stream!.on('data', chunk => chunks.push(Buffer.from(chunk)));
        stream!.on('end', () => { files[entry.fileName] = Buffer.concat(chunks); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}
