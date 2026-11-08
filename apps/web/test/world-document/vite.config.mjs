import {fileURLToPath} from 'node:url';
// Test HTML is served through /@fs; avoid React Fast Refresh's HTML preamble.
export default {server:{fs:{allow:[fileURLToPath(new URL('../../../..',import.meta.url))]}}};
