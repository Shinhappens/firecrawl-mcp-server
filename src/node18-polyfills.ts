import { File } from 'node:buffer';

const globalWithFile = globalThis as typeof globalThis & {
  File?: typeof File;
};

if (!globalWithFile.File) {
  Object.defineProperty(globalWithFile, 'File', {
    configurable: true,
    value: File,
    writable: true,
  });
}
